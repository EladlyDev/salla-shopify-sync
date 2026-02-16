import { Router, Request } from 'express';
import crypto from 'crypto';
import { config } from '../config';
import db from '../db';
import { productQueue, enqueueInventorySync } from '../queues';

const router = Router();

// ── Signature Verification ──────────────────────────────

function verifyShopifyWebhook(req: Request): boolean {
    const hmac = req.headers['x-shopify-hmac-sha256'] as string;
    if (!hmac || !req.rawBody) return false;

    const hash = crypto
        .createHmac('sha256', config.SHOPIFY_WEBHOOK_SECRET)
        .update(req.rawBody)
        .digest('base64');

    try {
        return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(hash));
    } catch {
        return false;
    }
}

// ── Helpers ─────────────────────────────────────────────

function isDuplicate(webhookId: string | undefined): boolean {
    if (!webhookId) return false;
    const existing = db
        .prepare('SELECT id FROM webhook_log WHERE source = ? AND event_id = ?')
        .get('shopify', webhookId);
    return !!existing;
}

function logWebhook(eventType: string, webhookId: string | undefined, payload: any): void {
    db.prepare(
        'INSERT INTO webhook_log (source, event_type, event_id, payload) VALUES (?, ?, ?, ?)'
    ).run('shopify', eventType, webhookId ?? null, JSON.stringify(payload));
}

// ── Product Webhooks ────────────────────────────────────

router.post('/products/create', async (req, res) => {
    res.status(200).send('OK');

    try {
        if (!verifyShopifyWebhook(req)) {
            console.warn('[WEBHOOK] Invalid Shopify signature for products/create');
            return;
        }

        const webhookId = req.headers['x-shopify-webhook-id'] as string;

        if (isDuplicate(webhookId)) {
            console.log(`[WEBHOOK] Duplicate Shopify webhook ${webhookId}, skipping`);
            return;
        }

        logWebhook('products/create', webhookId, req.body);

        await productQueue.add('create', { shopifyProduct: req.body }, {
            attempts: 5,
            backoff: { type: 'exponential', delay: 5000 },
        });

        console.log(`[WEBHOOK] Shopify products/create enqueued for product ${req.body.id}`);
    } catch (err: any) {
        console.error('[WEBHOOK] Error processing Shopify products/create:', err.message);
    }
});

router.post('/products/update', async (req, res) => {
    res.status(200).send('OK');

    try {
        if (!verifyShopifyWebhook(req)) {
            console.warn('[WEBHOOK] Invalid Shopify signature for products/update');
            return;
        }

        const webhookId = req.headers['x-shopify-webhook-id'] as string;

        if (isDuplicate(webhookId)) {
            console.log(`[WEBHOOK] Duplicate Shopify webhook ${webhookId}, skipping`);
            return;
        }

        logWebhook('products/update', webhookId, req.body);

        await productQueue.add('update', { shopifyProduct: req.body }, {
            attempts: 5,
            backoff: { type: 'exponential', delay: 5000 },
        });

        console.log(`[WEBHOOK] Shopify products/update enqueued for product ${req.body.id}`);
    } catch (err: any) {
        console.error('[WEBHOOK] Error processing Shopify products/update:', err.message);
    }
});

router.post('/products/delete', async (req, res) => {
    res.status(200).send('OK');

    try {
        if (!verifyShopifyWebhook(req)) {
            console.warn('[WEBHOOK] Invalid Shopify signature for products/delete');
            return;
        }

        const webhookId = req.headers['x-shopify-webhook-id'] as string;

        if (isDuplicate(webhookId)) {
            console.log(`[WEBHOOK] Duplicate Shopify webhook ${webhookId}, skipping`);
            return;
        }

        logWebhook('products/delete', webhookId, req.body);

        await productQueue.add('delete', { shopifyProductId: req.body.id }, {
            attempts: 5,
            backoff: { type: 'exponential', delay: 5000 },
        });

        console.log(`[WEBHOOK] Shopify products/delete enqueued for product ${req.body.id}`);
    } catch (err: any) {
        console.error('[WEBHOOK] Error processing Shopify products/delete:', err.message);
    }
});

// ── Inventory Webhooks ──────────────────────────────────

router.post('/inventory/update', async (req, res) => {
    res.status(200).send('OK');

    try {
        if (!verifyShopifyWebhook(req)) {
            console.warn('[WEBHOOK] Invalid Shopify signature for inventory/update');
            return;
        }

        const webhookId = req.headers['x-shopify-webhook-id'] as string;

        if (isDuplicate(webhookId)) {
            console.log(`[WEBHOOK] Duplicate Shopify webhook ${webhookId}, skipping`);
            return;
        }

        logWebhook('inventory_levels/update', webhookId, req.body);

        await enqueueInventorySync(req.body.inventory_item_id, req.body.location_id);

        console.log(`[WEBHOOK] Shopify inventory/update enqueued for item ${req.body.inventory_item_id}`);
    } catch (err: any) {
        console.error('[WEBHOOK] Error processing Shopify inventory/update:', err.message);
    }
});

export default router;
