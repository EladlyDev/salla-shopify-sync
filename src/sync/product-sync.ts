import db from '../db';
import { sallaApi } from '../clients/salla';
import { mapShopifyProductToSalla, sanitizeImageUrl } from '../mapper';
import { enqueueInventorySync } from '../queues';
import { config } from '../config';

// ── Types ───────────────────────────────────────────────

interface ProductMapping {
    id: number;
    shopify_product_id: number;
    salla_product_id: number | null;
    sku: string | null;
    sync_status: string;
}

interface VariantMapping {
    id: number;
    product_mapping_id: number;
    shopify_variant_id: number;
    shopify_inventory_item_id: number;
    salla_variant_id: number | null;
    sku: string | null;
}

// ── Prepared Statements ─────────────────────────────────

const stmts = {
    getMapping: db.prepare(
        'SELECT * FROM product_mappings WHERE shopify_product_id = ?'
    ),
    insertMapping: db.prepare(`
        INSERT INTO product_mappings (shopify_product_id, salla_product_id, sku, sync_status, last_synced_at)
        VALUES (?, ?, ?, 'synced', datetime('now'))
    `),
    updateMappingSynced: db.prepare(`
        UPDATE product_mappings
        SET salla_product_id = ?, sku = ?, sync_status = 'synced',
            last_error = NULL, last_synced_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
    `),
    updateMappingError: db.prepare(`
        UPDATE product_mappings
        SET sync_status = 'error', last_error = ?, updated_at = datetime('now')
        WHERE shopify_product_id = ?
    `),
    updateMappingDeleted: db.prepare(`
        UPDATE product_mappings
        SET sync_status = 'deleted', last_synced_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
    `),
    insertMappingPending: db.prepare(`
        INSERT OR IGNORE INTO product_mappings (shopify_product_id, sync_status)
        VALUES (?, 'pending')
    `),
    getVariantMappings: db.prepare(
        'SELECT * FROM variant_mappings WHERE product_mapping_id = ?'
    ),
    insertVariant: db.prepare(`
        INSERT OR IGNORE INTO variant_mappings
            (product_mapping_id, shopify_variant_id, shopify_inventory_item_id, salla_variant_id, sku)
        VALUES (?, ?, ?, ?, ?)
    `),
    updateVariantSalla: db.prepare(`
        UPDATE variant_mappings SET salla_variant_id = ?, sku = ? WHERE id = ?
    `),
    insertInventorySync: db.prepare(`
        INSERT OR IGNORE INTO inventory_sync
            (variant_mapping_id, shopify_inventory_item_id, shopify_location_id, unsynced_order_delta)
        VALUES (?, ?, ?, 0)
    `),
    getInventorySync: db.prepare(
        'SELECT id FROM inventory_sync WHERE variant_mapping_id = ?'
    ),
};

// ── Product Sync ────────────────────────────────────────

/**
 * Sync a Shopify product to Salla (create or update).
 * Called by the product-sync BullMQ worker.
 *
 * Upsert logic:
 * - If a product_mapping exists with a salla_product_id → UPDATE
 * - Otherwise → CREATE
 */
export async function syncProductToSalla(shopifyProduct: any): Promise<void> {
    const shopifyId = shopifyProduct.id;
    const title = shopifyProduct.title;

    try {
        // Map Shopify data to Salla format
        const sallaPayload = mapShopifyProductToSalla(shopifyProduct);

        // Check for existing mapping
        const mapping = stmts.getMapping.get(shopifyId) as ProductMapping | undefined;

        if (mapping?.salla_product_id) {
            // ── UPDATE existing Salla product ───────────
            await sallaApi.updateProduct(mapping.salla_product_id, sallaPayload);

            // Upload images separately (Salla rejects some URLs inline)
            await uploadProductImages(shopifyProduct, mapping.salla_product_id);

            // Sync variant mappings for any added/removed variants
            await syncVariantMappings(shopifyProduct, mapping.id, null);

            // Set stock quantities via PUT /products/variants/{variant_id}
            await syncInitialStock(shopifyProduct, mapping.salla_product_id);

            // Mark as synced
            stmts.updateMappingSynced.run(
                mapping.salla_product_id,
                shopifyProduct.variants?.[0]?.sku ?? null,
                mapping.id
            );

            console.log(
                `[PRODUCT] Synced: Shopify ${shopifyId} (${title}) → Salla ${mapping.salla_product_id} [updated]`
            );
        } else {
            // ── CREATE new Salla product ────────────────
            const response = await sallaApi.createProduct(sallaPayload);

            // NOTE: Salla API response structure may vary.
            // The product ID might be in response.data.id or response.id
            const sallaProductId = response?.data?.id ?? response?.id;

            if (!sallaProductId) {
                throw new Error(`Salla create response missing product ID: ${JSON.stringify(response)}`);
            }

            // Ensure product_mapping row exists
            if (!mapping) {
                stmts.insertMappingPending.run(shopifyId);
            }

            const currentMapping = stmts.getMapping.get(shopifyId) as ProductMapping;

            // Update mapping with Salla product ID
            stmts.updateMappingSynced.run(
                sallaProductId,
                shopifyProduct.variants?.[0]?.sku ?? null,
                currentMapping.id
            );

            // Upload images separately (Salla rejects some URLs inline)
            await uploadProductImages(shopifyProduct, sallaProductId);

            // Sync variant mappings
            await syncVariantMappings(shopifyProduct, currentMapping.id, response);

            // Set stock quantities via PUT /products/variants/{variant_id}
            await syncInitialStock(shopifyProduct, sallaProductId);

            console.log(
                `[PRODUCT] Synced: Shopify ${shopifyId} (${title}) → Salla ${sallaProductId} [created]`
            );
        }
    } catch (err: any) {
        console.error(`[PRODUCT] Error syncing product ${shopifyId}: ${err.message}`);

        // Update mapping with error status (create row if it doesn't exist)
        stmts.insertMappingPending.run(shopifyId);
        stmts.updateMappingError.run(err.message, shopifyId);

        throw err; // Re-throw so BullMQ retries
    }
}

// ── Delete / Hide ───────────────────────────────────────

/**
 * Handle Shopify product deletion by hiding the product in Salla.
 * We hide instead of delete — safer and recoverable.
 */
export async function deleteProductFromSalla(shopifyProductId: number): Promise<void> {
    const mapping = stmts.getMapping.get(shopifyProductId) as ProductMapping | undefined;

    if (!mapping?.salla_product_id) {
        console.log(`[PRODUCT] No Salla mapping for Shopify product ${shopifyProductId}, nothing to delete`);
        return;
    }

    try {
        // Hide instead of delete — safer, recoverable
        await sallaApi.updateProduct(mapping.salla_product_id, { status: 'hidden' });

        stmts.updateMappingDeleted.run(mapping.id);

        console.log(
            `[PRODUCT] Deleted/hidden: Shopify ${shopifyProductId} → Salla ${mapping.salla_product_id}`
        );
    } catch (err: any) {
        console.error(`[PRODUCT] Error hiding Salla product ${mapping.salla_product_id}: ${err.message}`);
        stmts.updateMappingError.run(err.message, shopifyProductId);
        throw err;
    }
}

// ── Image Upload ────────────────────────────────────────

/**
 * Upload product images to Salla via the Attach Image endpoint.
 * Images are uploaded individually by URL — Salla downloads them server-side.
 * Errors are logged but non-fatal: the product sync still succeeds.
 */
async function uploadProductImages(shopifyProduct: any, sallaProductId: number): Promise<void> {
    const images = (shopifyProduct.images ?? [])
        .sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0));

    if (images.length === 0) return;

    let uploaded = 0;
    let failed = 0;

    for (const img of images) {
        const imageUrl = sanitizeImageUrl(img.src);
        if (!imageUrl) continue;

        try {
            await sallaApi.attachImage(sallaProductId, imageUrl);
            uploaded++;
        } catch (err: any) {
            failed++;
            console.warn(
                `[PRODUCT] Failed to attach image to Salla product ${sallaProductId}: ${err.message}`
            );
        }

        // Rate limit between image uploads
        await new Promise((r) => setTimeout(r, 300));
    }

    if (uploaded > 0 || failed > 0) {
        console.log(
            `[PRODUCT] Images for Salla ${sallaProductId}: ${uploaded} uploaded, ${failed} failed`
        );
    }
}

// ── Stock Sync ──────────────────────────────────────────

/**
 * Set stock quantities in Salla for each variant.
 *
 * Uses PUT /products/variants/{variant_id} with stock_quantity — the
 * correct Salla endpoint discovered from their official docs.
 *
 * For multi-variant products: fetches Salla variant IDs via
 * getProductVariants(), matches each to a Shopify variant by option
 * value name, then sets the quantity.
 *
 * For simple products (1 variant): uses the Salla product's single
 * variant ID to set stock.
 */
async function syncInitialStock(shopifyProduct: any, sallaProductId: number): Promise<void> {
    const shopifyVariants = shopifyProduct.variants ?? [];
    if (shopifyVariants.length === 0) return;

    // Fetch the actual Salla variant IDs (they differ from option value IDs)
    let sallaVariants: any[] = [];
    try {
        const variantResponse = await sallaApi.getProductVariants(sallaProductId);
        sallaVariants = variantResponse?.data ?? [];
    } catch {
        console.warn(`[PRODUCT] Could not fetch Salla variants for ${sallaProductId}`);
        return;
    }

    let synced = 0;
    let failed = 0;

    for (const sv of shopifyVariants) {
        const qty = Math.max(0, sv.inventory_quantity ?? 0);

        // Match Salla variant by name (option value name matches Shopify option value)
        let sallaVariant: any = null;

        if (sallaVariants.length === 1 && shopifyVariants.length === 1) {
            // Simple product — direct match
            sallaVariant = sallaVariants[0];
        } else {
            // Multi-variant — match by option value name
            const shopifyOptionValue = sv.option1 ?? sv.title ?? '';
            sallaVariant = sallaVariants.find(
                (sv2: any) => sv2.name === shopifyOptionValue
            );
        }

        if (!sallaVariant?.id) {
            console.warn(`[PRODUCT] No Salla variant match for Shopify variant ${sv.id} (${sv.option1})`);
            continue;
        }

        // Update variant_mappings with the CORRECT Salla variant ID
        // (syncVariantMappings may have stored option value IDs instead)
        stmts.updateVariantSalla.run(sallaVariant.id, sv.sku ?? '',
            (stmts.getVariantMappings.all(
                (stmts.getMapping.get(shopifyProduct.id) as any)?.id
            ) as VariantMapping[]).find(m => m.shopify_variant_id === sv.id)?.id ?? 0
        );

        try {
            await sallaApi.updateVariantQuantity(sallaVariant.id, qty);
            synced++;
        } catch (err: any) {
            failed++;
            console.warn(
                `[PRODUCT] Failed to set stock for Salla variant ${sallaVariant.id}: ${err.message}`
            );
        }

        await new Promise(r => setTimeout(r, 300));
    }

    if (synced > 0 || failed > 0) {
        console.log(
            `[PRODUCT] Stock sync: ${synced} updated, ${failed} failed`
        );
    }
}

// ── Variant Mapping Sync ────────────────────────────────

/**
 * Sync variant mappings between Shopify and Salla.
 *
 * For each Shopify variant:
 *  1. Check if a variant_mapping already exists (by shopify_variant_id)
 *  2. If not, create one — try to match the Salla variant by SKU first, then by index
 *  3. Ensure an inventory_sync record exists for each variant
 *  4. Enqueue initial inventory sync
 *
 * NOTE: Salla's API response for created products may include variant IDs in
 * different locations depending on product type:
 * - response.data.variants (array)
 * - response.data.options[0].values (array with id field)
 * This may need adjustment based on actual API version.
 */
async function syncVariantMappings(
    shopifyProduct: any,
    productMappingId: number,
    sallaCreateResponse: any
): Promise<void> {
    const shopifyVariants = shopifyProduct.variants ?? [];
    const locationId = config.SHOPIFY_LOCATION_ID;

    // Get existing variant mappings for this product
    const existingMappings = stmts.getVariantMappings.all(productMappingId) as VariantMapping[];

    // Try to extract Salla variants from create response or fetch them
    let sallaVariants: any[] = [];

    if (sallaCreateResponse) {
        // From create response — try multiple possible locations
        sallaVariants =
            sallaCreateResponse?.data?.variants ??
            sallaCreateResponse?.data?.options?.[0]?.values ??
            sallaCreateResponse?.variants ??
            [];
    } else if (existingMappings.length > 0 && existingMappings[0].salla_variant_id) {
        // Product already exists — try to fetch current Salla variants
        try {
            const mapping = stmts.getMapping.get(shopifyProduct.id) as ProductMapping;
            if (mapping?.salla_product_id) {
                const variantResponse = await sallaApi.getProductVariants(mapping.salla_product_id);
                sallaVariants = variantResponse?.data ?? variantResponse ?? [];
            }
        } catch {
            // OK — we'll just skip matching
        }
    }

    // Use a transaction for atomicity
    const syncVariants = db.transaction(() => {
        for (let i = 0; i < shopifyVariants.length; i++) {
            const sv = shopifyVariants[i];
            const shopifyVariantId = sv.id;
            const shopifyInvItemId = sv.inventory_item_id;
            const sku = sv.sku ?? '';

            // Check if mapping already exists
            const existingVariant = existingMappings.find(
                (m) => m.shopify_variant_id === shopifyVariantId
            );

            if (existingVariant) {
                // Already mapped — skip (or update SKU if changed)
                if (existingVariant.sku !== sku) {
                    stmts.updateVariantSalla.run(existingVariant.salla_variant_id, sku, existingVariant.id);
                }
            } else {
                // New variant — try to match Salla variant
                let sallaVariantId: number | null = null;

                if (shopifyVariants.length <= 1) {
                    // Simple product — use the Salla product ID as variant ID
                    const productMapping = stmts.getMapping.get(shopifyProduct.id) as ProductMapping;
                    sallaVariantId = productMapping?.salla_product_id ?? null;
                } else {
                    // Multi-variant — match by SKU first, then by index
                    const skuMatch = sallaVariants.find(
                        (sv: any) => sv.sku && sv.sku === sku
                    );

                    if (skuMatch) {
                        sallaVariantId = skuMatch.id;
                    } else if (i < sallaVariants.length) {
                        sallaVariantId = sallaVariants[i]?.id ?? null;
                    }

                    if (!sallaVariantId) {
                        console.warn(
                            `[PRODUCT] Could not match Salla variant for Shopify variant ${shopifyVariantId} (SKU: ${sku})`
                        );
                    }
                }

                // Insert variant mapping
                const result = stmts.insertVariant.run(
                    productMappingId,
                    shopifyVariantId,
                    shopifyInvItemId,
                    sallaVariantId,
                    sku
                );

                // Insert inventory_sync record if variant was actually inserted
                if (result.changes > 0) {
                    const variantMappingId = result.lastInsertRowid as number;
                    stmts.insertInventorySync.run(
                        variantMappingId,
                        shopifyInvItemId,
                        locationId
                    );
                }
            }

            // Ensure inventory_sync record exists for pre-existing variants too
            const variantRow = existingVariant ??
                (stmts.getVariantMappings.all(productMappingId) as VariantMapping[])
                    .find((m) => m.shopify_variant_id === shopifyVariantId);

            if (variantRow && !stmts.getInventorySync.get(variantRow.id)) {
                stmts.insertInventorySync.run(
                    variantRow.id,
                    shopifyInvItemId,
                    locationId
                );
            }
        }
    });

    syncVariants();

    // Enqueue initial inventory sync for all variants (outside transaction)
    for (const sv of shopifyVariants) {
        try {
            await enqueueInventorySync(sv.inventory_item_id, locationId);
        } catch (err: any) {
            console.warn(
                `[PRODUCT] Failed to enqueue inventory sync for item ${sv.inventory_item_id}: ${err.message}`
            );
        }
    }
}
