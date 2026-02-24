import cron from 'node-cron';
import db from './db';
import { shopifyApi } from './clients/shopify';
import { sallaApi } from './clients/salla';
import { sendAlert, sendCritical } from './telegram';

// ══════════════════════════════════════════════════════════
// Job 1: Full Inventory Reconciliation (every 4 hours)
// ══════════════════════════════════════════════════════════
//
// The safety net — catches any sync drift by comparing live
// Shopify and Salla quantities against the delta model.
// Fixes mismatches and resets stuck deltas.

async function runReconciliation(): Promise<void> {
    console.log('[RECON] Starting inventory reconciliation...');
    const startTime = Date.now();
    let checked = 0;
    let mismatches = 0;
    let errors = 0;
    let stuckDeltasFixed = 0;

    // Get ALL inventory_sync records with their Salla variant IDs
    const records = db.prepare(`
        SELECT inv.*, vm.salla_variant_id, vm.sku
        FROM inventory_sync inv
        JOIN variant_mappings vm ON vm.id = inv.variant_mapping_id
        WHERE vm.salla_variant_id IS NOT NULL
    `).all() as any[];

    for (const record of records) {
        try {
            // 1. Fetch LIVE Shopify inventory
            const shopifyLevel = await shopifyApi.getInventoryLevel(
                record.shopify_inventory_item_id,
                record.shopify_location_id
            );
            const currentShopifyQty = shopifyLevel.available;

            // 2. Calculate what Salla SHOULD be
            const expectedSallaQty = Math.max(0, currentShopifyQty + record.unsynced_order_delta);

            // 3. Fetch LIVE Salla stock
            let actualSallaQty: number;
            try {
                const sallaStock = await sallaApi.getVariantStock(record.salla_variant_id);
                actualSallaQty = sallaStock.quantity;
            } catch (err: any) {
                // If we can't read Salla stock, skip but log
                console.error(
                    `[RECON] Can't read Salla stock for variant ${record.salla_variant_id}: ${err.message}`
                );
                errors++;
                continue;
            }

            // 4. Fix mismatch
            if (actualSallaQty !== expectedSallaQty) {
                console.warn(
                    `[RECON] MISMATCH: item=${record.shopify_inventory_item_id} sku=${record.sku} ` +
                    `shopify=${currentShopifyQty} delta=${record.unsynced_order_delta} ` +
                    `expected_salla=${expectedSallaQty} actual_salla=${actualSallaQty} → FIXING`
                );

                await sallaApi.updateVariantQuantity(record.salla_variant_id, expectedSallaQty);
                mismatches++;
            }

            // 5. Update tracking record
            db.prepare(`
                UPDATE inventory_sync SET
                    last_known_shopify_qty = ?,
                    last_synced_to_salla_qty = ?,
                    last_sync_at = datetime('now'),
                    updated_at = datetime('now')
                WHERE id = ?
            `).run(currentShopifyQty, expectedSallaQty, record.id);

            // 6. Check for stuck deltas with no pending adjustments
            if (record.unsynced_order_delta !== 0) {
                const pendingCount = db.prepare(`
                    SELECT COUNT(*) as cnt FROM inventory_adjustments
                    WHERE inventory_sync_id = ? AND applied_to_shopify = 0
                `).get(record.id) as any;

                if (pendingCount.cnt === 0) {
                    // Delta is non-zero but nothing is pending — data inconsistency
                    console.error(
                        `[RECON] STUCK DELTA: item=${record.shopify_inventory_item_id} ` +
                        `delta=${record.unsynced_order_delta} with 0 pending adjustments → RESETTING`
                    );

                    db.prepare(`
                        UPDATE inventory_sync SET unsynced_order_delta = 0, updated_at = datetime('now')
                        WHERE id = ?
                    `).run(record.id);

                    // Re-sync Salla with clean Shopify qty
                    await sallaApi.updateVariantQuantity(
                        record.salla_variant_id,
                        Math.max(0, currentShopifyQty)
                    );
                    stuckDeltasFixed++;
                }
            }

            checked++;

            // Rate limiting: 300ms between API calls
            await new Promise(r => setTimeout(r, 300));
        } catch (err: any) {
            console.error(
                `[RECON] Error checking item ${record.shopify_inventory_item_id}: ${err.message}`
            );
            errors++;
        }
    }

    const duration = Math.round((Date.now() - startTime) / 1000);
    const summary =
        `Reconciliation complete: checked=${checked} mismatches=${mismatches} ` +
        `stuckFixed=${stuckDeltasFixed} errors=${errors} duration=${duration}s`;
    console.log(`[RECON] ${summary}`);

    // Only alert if there were issues
    if (mismatches > 0 || stuckDeltasFixed > 0 || errors > 0) {
        await sendAlert(`📊 ${summary}`);
    }
}

// ══════════════════════════════════════════════════════════
// Job 2: Stuck Adjustments Check (every 10 minutes)
// ══════════════════════════════════════════════════════════
//
// Finds inventory adjustments that haven't been applied to
// Shopify after 10 minutes and alerts on them.

async function checkStuckAdjustments(): Promise<void> {
    // Find adjustments that haven't been applied after 10 minutes
    const stuck = db.prepare(`
        SELECT ia.*, inv.shopify_inventory_item_id, vm.sku
        FROM inventory_adjustments ia
        JOIN inventory_sync inv ON inv.id = ia.inventory_sync_id
        JOIN variant_mappings vm ON vm.id = inv.variant_mapping_id
        WHERE ia.applied_to_shopify = 0
        AND ia.created_at < datetime('now', '-10 minutes')
    `).all() as any[];

    if (stuck.length === 0) return;

    // Check if any have exceeded max retries
    const critical = stuck.filter((s: any) => s.retry_count >= 8);
    const warning = stuck.filter((s: any) => s.retry_count < 8);

    if (critical.length > 0) {
        await sendCritical(
            `${critical.length} inventory adjustments FAILED after max retries!\n\n` +
            critical
                .map(
                    (s: any) =>
                        `• Order ${s.salla_order_id} | SKU: ${s.sku} | Delta: ${s.delta} | ` +
                        `Retries: ${s.retry_count} | Error: ${s.error_message}`
                )
                .join('\n')
        );
    }

    if (warning.length > 0) {
        await sendAlert(
            `⏳ ${warning.length} inventory adjustments pending > 10min\n\n` +
            warning
                .map(
                    (s: any) =>
                        `• Order ${s.salla_order_id} | SKU: ${s.sku} | Delta: ${s.delta} | ` +
                        `Retries: ${s.retry_count}`
                )
                .join('\n')
        );
    }
}

// ══════════════════════════════════════════════════════════
// Job 3: Database Cleanup (daily at 3 AM)
// ══════════════════════════════════════════════════════════
//
// Removes stale data to keep the database trim:
//   - Webhook logs older than 7 days
//   - Applied inventory adjustments older than 30 days

async function cleanupOldData(): Promise<void> {
    // Delete webhook logs older than 7 days
    const webhooksDeleted = db.prepare(`
        DELETE FROM webhook_log WHERE created_at < datetime('now', '-7 days')
    `).run();

    // Delete applied inventory adjustments older than 30 days
    const adjDeleted = db.prepare(`
        DELETE FROM inventory_adjustments
        WHERE applied_to_shopify = 1 AND created_at < datetime('now', '-30 days')
    `).run();

    console.log(
        `[CLEANUP] Deleted ${webhooksDeleted.changes} old webhooks, ` +
        `${adjDeleted.changes} old adjustments`
    );

    // Vacuum the database to reclaim space
    db.pragma('wal_checkpoint(TRUNCATE)');
}

// ══════════════════════════════════════════════════════════
// Job 4: Heartbeat (every 30 minutes)
// ══════════════════════════════════════════════════════════
//
// Logs system health stats. Alerts if there are product
// sync errors.

async function heartbeat(): Promise<void> {
    const stats = {
        products: db.prepare(
            "SELECT COUNT(*) as c FROM product_mappings WHERE sync_status = ?"
        ).get('synced') as any,
        errors: db.prepare(
            "SELECT COUNT(*) as c FROM product_mappings WHERE sync_status = ?"
        ).get('error') as any,
        pendingAdj: db.prepare(
            'SELECT COUNT(*) as c FROM inventory_adjustments WHERE applied_to_shopify = 0'
        ).get() as any,
        nonZeroDeltas: db.prepare(
            'SELECT COUNT(*) as c FROM inventory_sync WHERE unsynced_order_delta != 0'
        ).get() as any,
    };

    console.log(
        `[HEARTBEAT] Products synced: ${stats.products.c} | Errors: ${stats.errors.c} | ` +
        `Pending adj: ${stats.pendingAdj.c} | Non-zero deltas: ${stats.nonZeroDeltas.c}`
    );

    // Alert if there are product sync errors
    if (stats.errors.c > 0) {
        const errorProducts = db.prepare(`
            SELECT shopify_product_id, sku, last_error
            FROM product_mappings WHERE sync_status = 'error' LIMIT 5
        `).all();

        await sendAlert(
            `⚠️ ${stats.errors.c} products have sync errors:\n` +
            errorProducts
                .map((p: any) => `• Shopify ${p.shopify_product_id} (${p.sku}): ${p.last_error}`)
                .join('\n')
        );
    }
}

// ══════════════════════════════════════════════════════════
// Schedule all cron jobs
// ══════════════════════════════════════════════════════════

cron.schedule('0 */4 * * *', () => {
    runReconciliation().catch(err => {
        console.error('[RECON] Fatal:', err);
        sendCritical(`Reconciliation job crashed: ${err.message}`).catch(() => { });
    });
});

cron.schedule('*/10 * * * *', () => {
    checkStuckAdjustments().catch(err => {
        console.error('[STUCK-CHECK] Fatal:', err);
        sendCritical(`Stuck adjustments check crashed: ${err.message}`).catch(() => { });
    });
});

cron.schedule('0 3 * * *', () => {
    cleanupOldData().catch(err => {
        console.error('[CLEANUP] Fatal:', err);
        sendAlert(`Cleanup job crashed: ${err.message}`).catch(() => { });
    });
});

cron.schedule('*/30 * * * *', () => {
    heartbeat().catch(err => {
        console.error('[HEARTBEAT] Fatal:', err);
    });
});

console.log('[CRON] All cron jobs scheduled');
console.log('[CRON]   Reconciliation: every 4 hours');
console.log('[CRON]   Stuck check: every 10 minutes');
console.log('[CRON]   Cleanup: daily at 3 AM');
console.log('[CRON]   Heartbeat: every 30 minutes');

// Export for manual triggering from dashboard/scripts
export { runReconciliation };
