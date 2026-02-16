import { config } from './config';
import db, { initDb } from './db';
import { shopifyApi } from './clients/shopify';
import { sallaApi } from './clients/salla';
import { sendAlert } from './telegram';

async function test() {
    console.log('--- Testing Config ---');
    console.log('Shopify shop:', config.SHOPIFY_SHOP);
    console.log('Salla base URL:', config.SALLA_BASE_URL);

    console.log('\n--- Testing Database ---');
    initDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    console.log('Tables:', tables.map((t: any) => t.name));

    console.log('\n--- Testing Shopify API ---');
    try {
        const locations = await shopifyApi.getLocations();
        console.log('Shopify locations:', locations.map((l: any) => ({ id: l.id, name: l.name })));

        const { products } = await shopifyApi.getProducts({ limit: 2 });
        console.log(`Shopify products (first 2):`, products.map((p: any) => ({ id: p.id, title: p.title })));
    } catch (err: any) {
        console.error('Shopify error:', err.message);
    }

    console.log('\n--- Testing Salla API ---');
    try {
        const sallaProducts = await sallaApi.getProducts(1, 2);
        console.log('Salla products:', JSON.stringify(sallaProducts.data?.slice(0, 2).map((p: any) => ({ id: p.id, name: p.name })), null, 2));
    } catch (err: any) {
        console.error('Salla error:', err.message);
    }

    console.log('\n--- Testing Telegram ---');
    await sendAlert('Test alert from sync app setup ✅');
    console.log('Telegram alert sent (check your chat)');

    console.log('\n--- All tests passed! ---');
}

test().catch(console.error);
