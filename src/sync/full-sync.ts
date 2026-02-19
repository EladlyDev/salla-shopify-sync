import { config } from '../config';
import db, { initDb } from '../db';
import { shopifyApi } from '../clients/shopify';
import { sallaApi } from '../clients/salla';
import { syncProductToSalla, deleteProductFromSalla } from './product-sync';
import { sendAlert, sendInfo } from '../telegram';

// ── Types ───────────────────────────────────────────────

interface SyncReport {
    started: Date;
    finished?: Date;
    productsCreated: number;
    productsUpdated: number;
    productsHidden: number;
    productsErrored: number;
    inventorySynced: number;
    errors: Array<{ shopifyProductId: number; error: string }>;
}

interface ProductMapping {
    id: number;
    shopify_product_id: number;
    salla_product_id: number | null;
    sync_status: string;
}

interface InventorySyncRow {
    id: number;
    shopify_inventory_item_id: number;
    shopify_location_id: number;
    salla_variant_id: number;
}

// ── Full Sync ───────────────────────────────────────────

export async function runFullSync(): Promise<SyncReport> {
    const report: SyncReport = {
        started: new Date(),
        productsCreated: 0,
        productsUpdated: 0,
        productsHidden: 0,
        productsErrored: 0,
        inventorySynced: 0,
        errors: [],
    };

    await sendInfo('🔄 Full sync started...');

    // ── 1. Verify Shopify location ──────────────────────

    console.log('\n════════════════════════════════════════');
    console.log('  STEP 1: Verifying Shopify Location');
    console.log('════════════════════════════════════════\n');

    const locations = await shopifyApi.getLocations();
    const targetLocation = locations.find(
        (loc: any) => loc.id === config.SHOPIFY_LOCATION_ID
    );

    if (!targetLocation) {
        const msg = `Shopify location ${config.SHOPIFY_LOCATION_ID} not found. Available: ${locations.map((l: any) => `${l.name} (${l.id})`).join(', ')}`;
        await sendAlert(`❌ Full sync aborted: ${msg}`);
        throw new Error(msg);
    }

    console.log(`✓ Location verified: ${targetLocation.name} (ID: ${targetLocation.id})`);

    // ── 2. Fetch ALL Shopify products ───────────────────

    console.log('\n════════════════════════════════════════');
    console.log('  STEP 2: Fetching Shopify Products');
    console.log('════════════════════════════════════════\n');

    const allProducts: any[] = [];
    let pageInfo: string | null = null;

    do {
        const { products, nextPageInfo } = await shopifyApi.getProducts({
            limit: 250,
            page_info: pageInfo ?? undefined,
        });
        allProducts.push(...products);
        pageInfo = nextPageInfo;
        console.log(`  Fetched ${allProducts.length} products so far...`);
    } while (pageInfo);

    console.log(`\n✓ Total Shopify products: ${allProducts.length}`);

    // ── 3. Sync each product ────────────────────────────

    console.log('\n════════════════════════════════════════');
    console.log('  STEP 3: Syncing Products to Salla');
    console.log('════════════════════════════════════════\n');

    const shopifyProductIds = new Set<number>();

    for (let i = 0; i < allProducts.length; i++) {
        const product = allProducts[i];
        shopifyProductIds.add(product.id);

        // Check if mapping already exists (to determine created vs updated)
        const existingMapping = db
            .prepare('SELECT salla_product_id FROM product_mappings WHERE shopify_product_id = ?')
            .get(product.id) as { salla_product_id: number | null } | undefined;

        const isUpdate = !!existingMapping?.salla_product_id;

        try {
            await syncProductToSalla(product);

            if (isUpdate) {
                report.productsUpdated++;
            } else {
                report.productsCreated++;
            }
        } catch (err: any) {
            report.productsErrored++;
            report.errors.push({
                shopifyProductId: product.id,
                error: err.message,
            });
            // Continue to next product — don't stop the entire sync
        }

        // Progress log every 10 products
        if ((i + 1) % 10 === 0 || i === allProducts.length - 1) {
            console.log(
                `  Synced ${i + 1}/${allProducts.length} products ` +
                `(${report.productsCreated} created, ${report.productsUpdated} updated, ${report.productsErrored} errors)`
            );
        }

        // Rate limiting: 500ms between products
        if (i < allProducts.length - 1) {
            await new Promise((r) => setTimeout(r, 500));
        }
    }

    // ── 4. Handle orphaned products ─────────────────────

    console.log('\n════════════════════════════════════════');
    console.log('  STEP 4: Cleaning Up Orphaned Products');
    console.log('════════════════════════════════════════\n');

    const allMappings = db
        .prepare("SELECT * FROM product_mappings WHERE sync_status != 'deleted'")
        .all() as ProductMapping[];

    let orphanCount = 0;
    for (const mapping of allMappings) {
        if (!shopifyProductIds.has(mapping.shopify_product_id)) {
            try {
                await deleteProductFromSalla(mapping.shopify_product_id);
                report.productsHidden++;
                orphanCount++;
            } catch (err: any) {
                console.error(
                    `  Error hiding orphaned product ${mapping.shopify_product_id}: ${err.message}`
                );
            }

            await new Promise((r) => setTimeout(r, 300));
        }
    }

    console.log(orphanCount > 0
        ? `✓ Hidden ${orphanCount} orphaned product(s) in Salla`
        : '✓ No orphaned products found'
    );

    // ── 5. Sync inventory for all mapped variants ───────

    console.log('\n════════════════════════════════════════');
    console.log('  STEP 5: Syncing Inventory');
    console.log('════════════════════════════════════════\n');

    const invRecords = db.prepare(`
        SELECT inv.*, vm.salla_variant_id
        FROM inventory_sync inv
        JOIN variant_mappings vm ON vm.id = inv.variant_mapping_id
        WHERE vm.salla_variant_id IS NOT NULL
    `).all() as InventorySyncRow[];

    console.log(`  Found ${invRecords.length} variant(s) to sync inventory for`);

    for (let i = 0; i < invRecords.length; i++) {
        const inv = invRecords[i];
        try {
            const level = await shopifyApi.getInventoryLevel(
                inv.shopify_inventory_item_id,
                inv.shopify_location_id
            );
            const qty = Math.max(0, level.available);

            await sallaApi.updateStock(inv.salla_variant_id, qty);

            db.prepare(`
                UPDATE inventory_sync SET
                    last_known_shopify_qty = ?, last_synced_to_salla_qty = ?,
                    unsynced_order_delta = 0, last_sync_at = datetime('now'),
                    updated_at = datetime('now')
                WHERE id = ?
            `).run(qty, qty, inv.id);

            report.inventorySynced++;
        } catch (err: any) {
            console.error(
                `  Error syncing inventory for item ${inv.shopify_inventory_item_id}: ${err.message}`
            );
        }

        // Progress log every 25 items
        if ((i + 1) % 25 === 0 || i === invRecords.length - 1) {
            console.log(`  Inventory synced: ${i + 1}/${invRecords.length}`);
        }

        // Rate limiting: 300ms between items
        if (i < invRecords.length - 1) {
            await new Promise((r) => setTimeout(r, 300));
        }
    }

    // ── 6. Summary ──────────────────────────────────────

    report.finished = new Date();
    const durationSec = Math.round(
        (report.finished.getTime() - report.started.getTime()) / 1000
    );

    console.log('\n════════════════════════════════════════');
    console.log('  FULL SYNC SUMMARY');
    console.log('════════════════════════════════════════');
    console.log(`  Created:          ${report.productsCreated}`);
    console.log(`  Updated:          ${report.productsUpdated}`);
    console.log(`  Hidden/deleted:   ${report.productsHidden}`);
    console.log(`  Errors:           ${report.productsErrored}`);
    console.log(`  Inventory synced: ${report.inventorySynced}`);
    console.log(`  Duration:         ${durationSec}s`);
    console.log('════════════════════════════════════════\n');

    // Telegram summary
    const summary =
        `✅ Full sync complete!\n` +
        `Created: ${report.productsCreated}\n` +
        `Updated: ${report.productsUpdated}\n` +
        `Hidden: ${report.productsHidden}\n` +
        `Errors: ${report.productsErrored}\n` +
        `Inventory synced: ${report.inventorySynced}\n` +
        `Duration: ${durationSec}s`;

    await sendInfo(summary);

    // Send error details if any
    if (report.errors.length > 0) {
        const errorDetails = report.errors
            .slice(0, 20) // Cap at 20 to avoid message too long
            .map((e) => `• Product ${e.shopifyProductId}: ${e.error}`)
            .join('\n');

        await sendAlert(
            `⚠️ Full sync had ${report.errors.length} error(s):\n${errorDetails}` +
            (report.errors.length > 20 ? `\n... and ${report.errors.length - 20} more` : '')
        );
    }

    return report;
}

// ── Standalone execution ────────────────────────────────

if (require.main === module) {
    initDb();
    runFullSync()
        .then((report) => {
            console.log('\n=== FULL SYNC COMPLETE ===');
            console.log(JSON.stringify(report, null, 2));
            process.exit(0);
        })
        .catch((err) => {
            console.error('Full sync failed:', err);
            process.exit(1);
        });
}
