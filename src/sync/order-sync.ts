/*
 * INVENTORY ADJUSTMENT CORRECTNESS MODEL
 * =======================================
 *
 * When a Salla order comes in for 2 items:
 *   1. Salla auto-decrements its own stock (Salla: 10→8)
 *   2. We set unsynced_order_delta += -2 (delta: 0→-2)
 *   3. We call Shopify adjust by -2
 *   4. On success: unsynced_order_delta -= -2 (delta: -2→0)
 *
 * If step 3 FAILS:
 *   - delta stays at -2 (correct! Shopify still has old qty)
 *   - BullMQ retries the job
 *   - If a Shopify inventory webhook arrives in the meantime:
 *     syncShopifyInventoryToSalla() will calculate:
 *     target_salla = shopify_qty + (-2) = correct value
 *     So Salla qty stays correct even while Shopify adjust is pending
 *
 * If step 3 succeeds:
 *   - delta goes back to 0
 *   - Shopify will fire inventory_levels/update webhook
 *   - syncShopifyInventoryToSalla() will see:
 *     target_salla = new_shopify_qty + 0 = new_shopify_qty
 *     Which equals current Salla qty → no-op (correct!)
 *
 * NEVER adjust Shopify by absolute value. ALWAYS use delta (adjust endpoint).
 * NEVER set unsynced_order_delta to an absolute value. ALWAYS increment/decrement.
 */

import { Mutex } from 'async-mutex';
import db from '../db';
import { shopifyApi } from '../clients/shopify';
import { sendCritical } from '../telegram';

// ── Mutex (per-item locking) ────────────────────────────
//
// Same pattern as inventory-sync.ts — prevents concurrent
// processing of the same inventory item across overlapping
// order events and inventory webhooks.

const mutexMap = new Map<number, Mutex>();

function getMutex(id: number): Mutex {
    if (!mutexMap.has(id)) mutexMap.set(id, new Mutex());
    return mutexMap.get(id)!;
}

// ── Prepared Statements ─────────────────────────────────

const stmts = {
    findVariant: db.prepare(`
        SELECT vm.*, inv.id as inv_sync_id, inv.shopify_inventory_item_id,
               inv.shopify_location_id, inv.unsynced_order_delta
        FROM variant_mappings vm
        JOIN inventory_sync inv ON inv.variant_mapping_id = vm.id
        WHERE vm.salla_variant_id = ?
    `),

    checkIdempotent: db.prepare(`
        SELECT id FROM inventory_adjustments
        WHERE salla_order_id = ? AND salla_order_item_id = ? AND event_type = ?
    `),

    insertAdjustment: db.prepare(`
        INSERT INTO inventory_adjustments
        (inventory_sync_id, salla_order_id, salla_order_item_id, event_type, delta)
        VALUES (?, ?, ?, ?, ?)
    `),

    incrementDelta: db.prepare(`
        UPDATE inventory_sync
        SET unsynced_order_delta = unsynced_order_delta + ?,
            updated_at = datetime('now')
        WHERE id = ?
    `),

    markApplied: db.prepare(`
        UPDATE inventory_adjustments
        SET applied_to_shopify = 1, applied_at = datetime('now')
        WHERE salla_order_id = ? AND salla_order_item_id = ? AND event_type = ?
    `),

    recordError: db.prepare(`
        UPDATE inventory_adjustments
        SET error_message = ?, retry_count = retry_count + 1
        WHERE salla_order_id = ? AND salla_order_item_id = ? AND event_type = ?
    `),
};

// ── Transactions ────────────────────────────────────────

/**
 * Record the adjustment + increment unsynced_order_delta atomically.
 * After this, the delta correctly reflects that Shopify hasn't been updated yet.
 */
const recordDelta = db.transaction(
    (invSyncId: number, sallaOrderId: number, itemId: number, eventType: string, delta: number) => {
        stmts.insertAdjustment.run(invSyncId, sallaOrderId, itemId, eventType, delta);
        stmts.incrementDelta.run(delta, invSyncId);
    }
);

/**
 * Mark adjustment as applied + revert the delta atomically.
 * Called after successful Shopify adjust — delta goes back toward zero.
 */
const markApplied = db.transaction(
    (sallaOrderId: number, itemId: number, eventType: string, delta: number, invSyncId: number) => {
        stmts.markApplied.run(sallaOrderId, itemId, eventType);
        // Revert: subtract the delta we added (e.g., delta was -2, so we subtract -2 = add 2)
        stmts.incrementDelta.run(-delta, invSyncId);
    }
);

// ── Types ───────────────────────────────────────────────

interface VariantWithSync {
    id: number;
    product_mapping_id: number;
    shopify_variant_id: number;
    shopify_inventory_item_id: number;
    salla_variant_id: number;
    sku: string;
    inv_sync_id: number;
    shopify_location_id: number;
    unsynced_order_delta: number;
}

// ── Main Entry Point ────────────────────────────────────

/**
 * Process a Salla order event and adjust Shopify inventory.
 *
 * Called by the BullMQ order worker. Handles:
 *   - order_created → decrement Shopify stock
 *   - order_cancelled → increment Shopify stock
 *   - order_returned → increment Shopify stock
 *
 * Each item is processed independently — a failure on one item
 * doesn't prevent processing of other items in the same order.
 */
export async function processOrderSyncJob(data: { order: any; eventType: string }): Promise<void> {
    const { order, eventType } = data;
    const orderId = order.id;

    console.log(`[ORDER] Processing Salla order ${orderId} (${eventType})`);

    // Extract items from order
    // Salla order items structure: order.items[] with { id, product_id, quantity, ... }
    const items = order.items || [];

    if (items.length === 0) {
        console.log(`[ORDER] Order ${orderId} has no items, skipping`);
        return;
    }

    for (const item of items) {
        // Determine delta direction
        let delta: number;
        if (eventType === 'order_created') {
            delta = -item.quantity; // SOLD: decrement Shopify
        } else if (eventType === 'order_cancelled' || eventType === 'order_returned') {
            delta = +item.quantity; // RETURNED/CANCELLED: increment Shopify
        } else {
            console.log(`[ORDER] Unknown event type ${eventType}, skipping`);
            return;
        }

        await processOrderItem(orderId, item, eventType, delta);
    }
}

// ── Per-Item Processing ─────────────────────────────────

/**
 * Process a single order line item:
 *   1. Find the variant mapping (Salla → Shopify)
 *   2. Check idempotency (skip if already processed)
 *   3. Record delta in DB (atomic)
 *   4. Adjust Shopify inventory
 *   5. On success: mark applied + revert delta
 *   5. On failure: record error, leave delta (correct!), re-throw for retry
 */
async function processOrderItem(
    sallaOrderId: number,
    item: any,
    eventType: string,
    delta: number
): Promise<void> {
    // ── Step 1: Find variant mapping ──
    //
    // Salla order items may have product.id or product_id depending on webhook version
    const sallaProductId = item.product?.id || item.product_id;
    const itemId = item.id || 0;

    const variant = stmts.findVariant.get(sallaProductId) as VariantWithSync | undefined;

    if (!variant) {
        // CRITICAL: We received an order for a product we don't have mapped.
        // Don't throw — retrying won't help if the mapping doesn't exist.
        await sendCritical(
            `Unmapped Salla product in order!\n` +
            `Order: ${sallaOrderId}\n` +
            `Salla product ID: ${sallaProductId}\n` +
            `Item ID: ${itemId}\n` +
            `Event: ${eventType}\n` +
            `Delta: ${delta}`
        );
        console.error(
            `[ORDER] ❌ No variant mapping for Salla product ${sallaProductId} ` +
            `(order=${sallaOrderId}, item=${itemId})`
        );
        return;
    }

    // ── Step 2: Idempotency check ──
    //
    // The UNIQUE constraint on (salla_order_id, salla_order_item_id, event_type)
    // guarantees we never process the same event twice. Check before acquiring
    // the mutex to avoid unnecessary locking.
    const existing = stmts.checkIdempotent.get(sallaOrderId, itemId, eventType);

    if (existing) {
        console.log(
            `[ORDER] Already processed: order=${sallaOrderId} item=${itemId} ${eventType}`
        );
        return;
    }

    // ── Step 3: Acquire mutex ──
    const mutex = getMutex(variant.shopify_inventory_item_id);
    const release = await mutex.acquire();

    try {
        // ── Step 4: Record adjustment + update delta (atomic) ──
        //
        // After this transaction:
        //   - The adjustment is recorded in the audit trail
        //   - unsynced_order_delta reflects that Shopify hasn't been updated yet
        //   - e.g., delta=-2 means "2 items sold on Salla, Shopify doesn't know yet"
        recordDelta(variant.inv_sync_id, sallaOrderId, itemId, eventType, delta);

        // ── Step 5: Adjust Shopify inventory ──
        //
        // Uses POST /inventory_levels/adjust.json with available_adjustment (DELTA).
        // NEVER set absolute quantity — always adjust by delta.
        try {
            await shopifyApi.adjustInventory(
                variant.shopify_inventory_item_id,
                variant.shopify_location_id,
                delta // e.g., -2 for 2 items sold
            );

            // ── SUCCESS: Mark as applied, revert the delta ──
            //
            // Shopify now has the correct quantity, so the delta
            // for this adjustment is no longer "unsynced".
            markApplied(sallaOrderId, itemId, eventType, delta, variant.inv_sync_id);

            console.log(
                `[ORDER] ✅ Shopify adjusted: item=${variant.shopify_inventory_item_id} ` +
                `delta=${delta} (order=${sallaOrderId})`
            );
        } catch (err: any) {
            // ── FAILURE: DO NOT revert unsynced_order_delta ──
            //
            // The delta correctly reflects that Shopify hasn't been updated.
            // If syncShopifyInventoryToSalla() runs before the retry, it will
            // use the delta to calculate the correct Salla quantity.
            stmts.recordError.run(err.message, sallaOrderId, itemId, eventType);

            await sendCritical(
                `Failed to adjust Shopify inventory!\n` +
                `Order: ${sallaOrderId}\n` +
                `Item: ${variant.shopify_inventory_item_id}\n` +
                `Delta: ${delta}\n` +
                `Error: ${err.message}`
            );

            // RE-THROW so BullMQ retries this job
            throw err;
        }
    } finally {
        // Always release the mutex, even on error
        release();
    }
}
