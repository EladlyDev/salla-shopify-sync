import './config'; // ensure env is loaded
import { shopifyApi } from './clients/shopify';
import { sallaApi } from './clients/salla';

// ── Configuration ───────────────────────────────────────

const SHOPIFY_WEBHOOKS: { topic: string; path: string }[] = [
    { topic: 'products/create', path: '/webhooks/shopify/products/create' },
    { topic: 'products/update', path: '/webhooks/shopify/products/update' },
    { topic: 'products/delete', path: '/webhooks/shopify/products/delete' },
    { topic: 'inventory_levels/update', path: '/webhooks/shopify/inventory/update' },
];

const SALLA_WEBHOOKS: { event: string; path: string }[] = [
    { event: 'order.created', path: '/webhooks/salla/order/created' },
    { event: 'order.updated', path: '/webhooks/salla/order/updated' },
];

// ── Main ────────────────────────────────────────────────

async function main() {
    const baseUrl = process.argv[2];

    if (!baseUrl) {
        console.error('Usage: npx ts-node src/register-webhooks.ts <base_url>');
        console.error('Example: npx ts-node src/register-webhooks.ts https://sync.mydomain.com');
        process.exit(1);
    }

    if (!baseUrl.startsWith('https://')) {
        console.error('Error: Base URL must start with https://');
        console.error('Got:', baseUrl);
        process.exit(1);
    }

    const results: { platform: string; topic: string; status: string }[] = [];

    // ── Shopify Webhooks ────────────────────────────────

    console.log('\n═══════════════════════════════════════');
    console.log('  SHOPIFY WEBHOOK REGISTRATION');
    console.log('═══════════════════════════════════════\n');

    try {
        const existingShopify = await shopifyApi.getWebhooks();
        console.log(`Found ${existingShopify.length} existing Shopify webhook(s):`);
        for (const wh of existingShopify) {
            console.log(`  • ${wh.topic} → ${wh.address} (id: ${wh.id})`);
        }
        console.log('');

        for (const { topic, path } of SHOPIFY_WEBHOOKS) {
            const address = `${baseUrl}${path}`;
            try {
                // Check if already registered
                const existing = existingShopify.find((wh: any) => wh.topic === topic);

                if (existing && existing.address === address) {
                    console.log(`✓ ${topic} — already registered at correct address`);
                    results.push({ platform: 'Shopify', topic, status: '✓ Already registered' });
                    continue;
                }

                // Delete if registered with different address
                if (existing) {
                    console.log(`  Removing old webhook for ${topic} (id: ${existing.id})...`);
                    await shopifyApi.deleteWebhook(existing.id);
                }

                // Register new webhook
                const result = await shopifyApi.registerWebhook(topic, address);
                console.log(`✓ ${topic} → ${address} (id: ${result.id})`);
                results.push({ platform: 'Shopify', topic, status: '✓ Registered' });
            } catch (err: any) {
                console.error(`✗ ${topic} — FAILED: ${err.message}`);
                results.push({ platform: 'Shopify', topic, status: `✗ Failed: ${err.message}` });
            }
        }
    } catch (err: any) {
        console.error('Failed to fetch existing Shopify webhooks:', err.message);
    }

    // ── Salla Webhooks ──────────────────────────────────

    console.log('\n═══════════════════════════════════════');
    console.log('  SALLA WEBHOOK REGISTRATION');
    console.log('═══════════════════════════════════════\n');

    try {
        const existingSalla = await sallaApi.getWebhooks();
        console.log(`Found ${Array.isArray(existingSalla) ? existingSalla.length : 0} existing Salla webhook(s):`);
        if (Array.isArray(existingSalla)) {
            for (const wh of existingSalla) {
                console.log(`  • ${wh.name ?? wh.event} → ${wh.url} (id: ${wh.id})`);
            }
        }
        console.log('');

        for (const { event, path } of SALLA_WEBHOOKS) {
            const url = `${baseUrl}${path}`;
            try {
                // Check if already registered
                const existing = Array.isArray(existingSalla)
                    ? existingSalla.find((wh: any) => (wh.name === event || wh.event === event) && wh.url === url)
                    : null;

                if (existing) {
                    console.log(`✓ ${event} — already registered at correct URL`);
                    results.push({ platform: 'Salla', topic: event, status: '✓ Already registered' });
                    continue;
                }

                const result = await sallaApi.createWebhook(event, url);
                console.log(`✓ ${event} → ${url} (id: ${result?.data?.id ?? 'unknown'})`);
                results.push({ platform: 'Salla', topic: event, status: '✓ Registered' });
            } catch (err: any) {
                console.error(`✗ ${event} — FAILED: ${err.message}`);
                results.push({ platform: 'Salla', topic: event, status: `✗ Failed: ${err.message}` });
            }
        }
    } catch (err: any) {
        console.error('Failed to fetch existing Salla webhooks:', err.message);
    }

    // ── Summary ─────────────────────────────────────────

    console.log('\n═══════════════════════════════════════');
    console.log('  REGISTRATION SUMMARY');
    console.log('═══════════════════════════════════════\n');

    const maxTopic = Math.max(...results.map((r) => r.topic.length));
    for (const r of results) {
        console.log(`  [${r.platform.padEnd(7)}] ${r.topic.padEnd(maxTopic + 2)} ${r.status}`);
    }

    const failed = results.filter((r) => r.status.startsWith('✗'));
    if (failed.length > 0) {
        console.log(`\n⚠️  ${failed.length} registration(s) failed!`);
        process.exit(1);
    } else {
        console.log(`\n✅ All ${results.length} webhook(s) registered successfully!`);
    }
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
