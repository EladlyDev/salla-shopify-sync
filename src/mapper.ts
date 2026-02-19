// NOTE: Salla API payload structure may need adjustment based on actual API version.
// Test with a single product first and adjust field names as needed.

// ── Status Mapping ──────────────────────────────────────

/**
 * Map Shopify product status to Salla product status.
 *
 * Shopify statuses: 'active', 'draft', 'archived'
 * Salla statuses:   'sale', 'hidden', 'out', 'deleted'
 *
 * - active   → sale   (publicly visible)
 * - draft    → hidden (not visible to customers)
 * - archived → hidden (not visible to customers)
 */
export function mapSallaStatus(shopifyStatus: string): string {
    switch (shopifyStatus) {
        case 'active':
            return 'sale';
        case 'draft':
        case 'archived':
            return 'hidden';
        default:
            return 'hidden';
    }
}

// ── Weight Unit Mapping ─────────────────────────────────

/**
 * Map Shopify weight unit to Salla weight type.
 * Both platforms use the same unit abbreviations.
 */
function mapWeightUnit(shopifyUnit: string): string {
    const unitMap: Record<string, string> = {
        kg: 'kg',
        g: 'g',
        lb: 'lb',
        oz: 'oz',
    };
    return unitMap[shopifyUnit?.toLowerCase()] ?? 'kg';
}

// ── Option Display Type ─────────────────────────────────

/**
 * Determine the Salla display_type for a Shopify product option.
 *
 * NOTE: Salla's "color" display_type requires a `display_value` (hex code)
 * on every option value. Since Shopify doesn't provide hex color values,
 * we default to "text" for all options. This can be enhanced later with
 * a color name → hex lookup table if needed.
 */
function getOptionDisplayType(_optionName: string): string {
    return 'text';
}

// ── Image URL Sanitization ──────────────────────────────

/**
 * Sanitize a Shopify image URL for Salla compatibility.
 *
 * We strip query parameters (Salla's URL validator sometimes chokes on
 * ?v=123456 timestamps). We keep the original file extension — changing
 * it (e.g. .webp → .jpg) would break the actual CDN download.
 */
export function sanitizeImageUrl(url: string): string {
    if (!url) return url;

    try {
        const parsed = new URL(url);
        // Strip query params (version hashes, etc.)
        parsed.search = '';
        return parsed.toString();
    } catch {
        return url;
    }
}

// ── Description Cleanup ─────────────────────────────────

/**
 * Clean up Shopify HTML description for Salla.
 * - Remove Shopify-specific data attributes and classes
 * - Preserve the core HTML structure (Salla supports HTML)
 * - Return empty string if null/undefined
 */
function cleanDescription(html: string | null | undefined): string {
    if (!html) return '';

    return html
        // Remove Shopify-specific data attributes
        .replace(/\s*data-mce-[a-z-]+="[^"]*"/gi, '')
        .replace(/\s*data-shopify="[^"]*"/gi, '')
        // Remove empty style attributes
        .replace(/\s*style=""/gi, '')
        // Trim whitespace
        .trim();
}

// ── Product Mapping ─────────────────────────────────────

/**
 * Map a full Shopify product to Salla's create/update payload.
 *
 * Key mapping decisions:
 * - Uses the FIRST variant for price/sku/weight/quantity on simple products
 * - Price logic:
 *     • If compare_at_price > price → regular_price = compare_at_price, sale_price = price
 *     • Otherwise → price = variant.price, no sale_price
 * - Images sorted by position
 * - HTML descriptions are kept as-is (Salla supports HTML)
 * - Quantity is set for initial state but will be managed by inventory sync
 */
export function mapShopifyProductToSalla(shopifyProduct: any): any {
    const variants = shopifyProduct.variants ?? [];
    const firstVariant = variants[0] ?? {};

    const price = parseFloat(firstVariant.price) || 0;
    const compareAtPrice = parseFloat(firstVariant.compare_at_price) || 0;

    // Build price fields
    const priceFields: Record<string, number> = {};
    if (compareAtPrice > 0 && compareAtPrice > price) {
        // Product is on sale: regular_price is the original, sale_price is discounted
        priceFields.price = compareAtPrice;
        priceFields.regular_price = compareAtPrice;
        priceFields.sale_price = price;
    } else {
        // No sale — just the regular price
        priceFields.price = price;
    }

    // Build the Salla product payload
    const sallaProduct: Record<string, any> = {
        name: shopifyProduct.title,
        description: cleanDescription(shopifyProduct.body_html),
        product_type: 'product',
        status: mapSallaStatus(shopifyProduct.status ?? 'active'),
        ...priceFields,
        sku: firstVariant.sku ?? '',
        weight: firstVariant.weight ?? 0,
        weight_type: mapWeightUnit(firstVariant.weight_unit ?? 'kg'),
        quantity: firstVariant.inventory_quantity ?? 0,
        unlimited_quantity: false,
    };

    // Add options for multi-variant products
    const options = mapShopifyVariantsToSallaOptions(shopifyProduct);
    if (options && options.length > 0) {
        sallaProduct.options = options;
    }

    // NOTE: Images are NOT included in the create payload.
    // They are uploaded separately via the Salla Attach Image endpoint
    // (sallaApi.attachImage) after product creation, because Salla's
    // inline image URL validation rejects some Shopify CDN URLs.

    return sallaProduct;
}

// ── Variant / Options Mapping ───────────────────────────

/**
 * Map Shopify product variants + options to Salla's option format.
 *
 * Returns null for simple products (1 or 0 variants).
 *
 * For multi-variant products, maps Shopify options (e.g. Size, Color) to
 * Salla's option structure, matching each option value to its corresponding
 * variant to extract price, sku, and quantity.
 *
 * Shopify uses option1/option2/option3 fields on variants to denote which
 * option values apply. Salla expects options as an array of objects,
 * each containing a values array with price/sku/quantity per value.
 *
 * NOTE: This works well for simple single-option products. Multi-option
 * products (e.g. Size + Color) may need additional handling depending
 * on how Salla treats option combinations.
 */
export function mapShopifyVariantsToSallaOptions(shopifyProduct: any): any[] | null {
    const variants = shopifyProduct.variants ?? [];
    const options = shopifyProduct.options ?? [];

    // Simple product — no options needed
    if (variants.length <= 1) {
        return null;
    }

    return options.map((option: any, optionIndex: number) => {
        const optionKey = `option${optionIndex + 1}` as 'option1' | 'option2' | 'option3';

        const values = (option.values ?? []).map((valueName: string) => {
            // Find the first variant that matches this option value
            const matchingVariant = variants.find(
                (v: any) => v[optionKey] === valueName
            );

            const variantPrice = parseFloat(matchingVariant?.price) || 0;

            return {
                name: valueName,
                price: variantPrice,
                sku: matchingVariant?.sku ?? '',
                quantity: matchingVariant?.inventory_quantity ?? 0,
            };
        });

        return {
            name: option.name,
            display_type: getOptionDisplayType(option.name),
            values,
        };
    });
}
