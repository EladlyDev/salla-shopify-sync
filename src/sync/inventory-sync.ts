import { Mutex } from 'async-mutex';
import db from '../db';
import { shopifyApi } from '../clients/shopify';
import { sallaApi } from '../clients/salla';

// ── Mutex (per-item locking) ────────────────────────────
//
// Prevents concurrent processing of the same inventory item.
// Without this, two overlapping webhook events could cause a race
// condition (read-modify-write on the same inventory_sync row).

const mutexMap = new Map<number, Mutex>();

function getMutex(inventoryItemId: number): Mutex {
    if (!mutexMap.has(inventoryItemId)) {
        mutexMap.set(inventoryItemId, new Mutex());
    }
    return mutexMap.get(inventoryItemId)!;
}

// ── Prepared Statements ─────────────────────────────────

const stmts = {
    getInvSync: db.prepare(
        'SELECT * FROM inventory_sync WHERE shopify_inventory_item_id = ?'
    ),
    getVariant: db.prepare(
        'SELECT salla_variant_id FROM variant_mappings WHERE id = ?'
    ),
    updateInvSync: db.prepare(`
        UPDATE inventory_sync SET
            last_known_shopify_qty = ?,
            last_synced_to_salla_qty = ?,
            last_sync_at = datetime('now'),
            updated_at = datetime('now')
        WHERE id = ?
    `),
};

// ── Types ───────────────────────────────────────────────

interface InventorySyncRow {
    id: number;
    variant_mapping_id: number;
    shopify_inventory_item_id: number;
    shopify_location_id: number;
    last_known_shopify_qty: number | null;
    last_synced_to_salla_qty: number | null;
    unsynced_order_delta: number;
    last_sync_at: string | null;
    updated_at: string | null;
}

interface VariantRow {
    salla_variant_id: number | null;
}

// ── Shopify → Salla Inventory Sync ──────────────────────
//
// THE INVENTORY MODEL:
//
//   correct_salla_qty = current_shopify_qty + unsynced_order_delta
//
// Where:
//   - current_shopify_qty: fetched LIVE from Shopify API
//     (NEVER trust webhook payload — it may be stale or out of order)
//   - unsynced_order_delta: sum of Salla order deltas NOT YET applied to Shopify
//     * Negative when items sold on Salla (pending Shopify decrement)
//     * Positive when items returned on Salla (pending Shopify increment)
//     * Zero when everything is in sync
//
// CORRECTNESS NOTES:
//   - We ALWAYS fetch live Shopify qty, never trust webhook payload or cached values
//   - The unsynced_order_delta accounts for Salla orders not yet reflected in Shopify
//   - This function does NOT modify unsynced_order_delta — only order processing does
//   - If unsynced_order_delta is -3 (3 items sold on Salla), and Shopify shows 10,
//     the correct Salla qty is 7 (10 - 3)

/**
 * Sync a Shopify inventory level change to Salla.
 *
 * Called when Shopify fires an `inventory_levels/update` webhook.
 * Uses per-item mutex locking for correctness under concurrent events.
 */
export async function syncShopifyInventoryToSalla(
    shopifyInventoryItemId: number,
    shopifyLocationId: number
): Promise<void> {
    const mutex = getMutex(shopifyInventoryItemId);

    // Acquire mutex — prevents concurrent processing of the same item
    const release = await mutex.acquire();

    try {
        // ── Step 1: Fetch CURRENT Shopify inventory (NEVER trust webhook payload) ──
        const shopifyLevel = await shopifyApi.getInventoryLevel(
            shopifyInventoryItemId,
            shopifyLocationId
        );
        const currentShopifyQty = shopifyLevel.available;

        // ── Step 2: Load inventory_sync record ──
        const invSync = stmts.getInvSync.get(shopifyInventoryItemId) as InventorySyncRow | undefined;

        if (!invSync) {
            console.error(
                `[INV] No inventory_sync record for item ${shopifyInventoryItemId} — skipping`
            );
            return;
        }

        // ── Step 3: Calculate target Salla quantity ──
        //
        // correct_salla_qty = current_shopify_qty + unsynced_order_delta
        // Math.max(0, ...) prevents negative quantities in Salla
        const targetSallaQty = Math.max(0, currentShopifyQty + invSync.unsynced_order_delta);

        // ── Step 4: Check if update is needed ──
        const qtyChanged = targetSallaQty !== invSync.last_synced_to_salla_qty;
        const shopifyQtyChanged = currentShopifyQty !== invSync.last_known_shopify_qty;

        if (!qtyChanged && !shopifyQtyChanged) {
            // No change — nothing to do
            return;
        }

        // ── Step 5: Get the Salla variant ID ──
        const variant = stmts.getVariant.get(invSync.variant_mapping_id) as VariantRow | undefined;

        if (!variant?.salla_variant_id) {
            console.error(
                `[INV] No salla_variant_id for variant_mapping ${invSync.variant_mapping_id} — skipping`
            );
            return;
        }

        // ── Step 6: Update Salla stock (only if quantity actually changed) ──
        if (qtyChanged) {
            await sallaApi.updateVariantQuantity(variant.salla_variant_id, targetSallaQty);
        }

        // ── Step 7: Update tracking record ──
        // Always update even if only shopify qty changed (keeps tracking accurate)
        stmts.updateInvSync.run(currentShopifyQty, targetSallaQty, invSync.id);

        console.log(
            `[INV] Shopify→Salla: item=${shopifyInventoryItemId} ` +
            `shopify_qty=${currentShopifyQty} delta=${invSync.unsynced_order_delta} ` +
            `→ salla_qty=${targetSallaQty}` +
            (qtyChanged ? '' : ' [no Salla update needed]')
        );
    } finally {
        // Always release the mutex, even on error
        release();
    }
}
