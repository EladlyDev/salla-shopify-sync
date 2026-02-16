import { Router, Request } from 'express';
import crypto from 'crypto';
import { config } from '../config';
import db from '../db';
import { orderQueue } from '../queues';

const router = Router();

// ── Signature Verification ──────────────────────────────

function verifySallaWebhook(req: Request): boolean {
    const signature = req.headers['x-salla-signature'] as string;
    if (!signature || !req.rawBody) return false;

    const hash = crypto
        .createHmac('sha256', config.SALLA_WEBHOOK_SECRET)
        .update(req.rawBody)
        .digest('hex');

    try {
        return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(hash));
    } catch {
        return false;
    }
}

// ── Helpers ─────────────────────────────────────────────

const CANCELLATION_STATUSES = ['canceled', 'cancelled', 'refunded', 'restored'];
const RETURN_STATUSES = ['returned', 'returned_partially'];

function isDuplicate(eventId: string | undefined): boolean {
    if (!eventId) return false;
    const existing = db
        .prepare('SELECT id FROM webhook_log WHERE source = ? AND event_id = ?')
        .get('salla', eventId);
    return !!existing;
}

function logWebhook(eventType: string, eventId: string | undefined, payload: any): void {
    db.prepare(
        'INSERT INTO webhook_log (source, event_type, event_id, payload) VALUES (?, ?, ?, ?)'
    ).run('salla', eventType, eventId ?? null, JSON.stringify(payload));
}

/**
 * Determine the sync event type from a Salla order status update.
 * Returns null if the status is not one we need to act on.
 */
function resolveOrderEventType(order: any): string | null {
    const statusSlug = order?.status?.slug ?? order?.status?.customized?.slug ?? '';

    if (CANCELLATION_STATUSES.includes(statusSlug)) return 'order_cancelled';
    if (RETURN_STATUSES.includes(statusSlug)) return 'order_returned';

    return null;
}

// ── Order Webhooks ──────────────────────────────────────

router.post('/order/created', async (req, res) => {
    res.status(200).send('OK');

    try {
        if (!verifySallaWebhook(req)) {
            console.warn('[WEBHOOK] Invalid Salla signature for order.created');
            return;
        }

        const eventId = req.body.event_id ?? req.body.id?.toString();

        if (isDuplicate(eventId)) {
            console.log(`[WEBHOOK] Duplicate Salla webhook ${eventId}, skipping`);
            return;
        }

        logWebhook('order.created', eventId, req.body);

        const order = req.body.data;

        await orderQueue.add('process', {
            order,
            eventType: 'order_created',
        }, {
            attempts: 10,
            backoff: { type: 'exponential', delay: 2000 },
        });

        console.log(`[WEBHOOK] Salla order.created enqueued for order ${order?.id}`);
    } catch (err: any) {
        console.error('[WEBHOOK] Error processing Salla order.created:', err.message);
    }
});

router.post('/order/updated', async (req, res) => {
    res.status(200).send('OK');

    try {
        if (!verifySallaWebhook(req)) {
            console.warn('[WEBHOOK] Invalid Salla signature for order.updated');
            return;
        }

        const eventId = req.body.event_id ?? req.body.id?.toString();

        if (isDuplicate(eventId)) {
            console.log(`[WEBHOOK] Duplicate Salla webhook ${eventId}, skipping`);
            return;
        }

        logWebhook('order.updated', eventId, req.body);

        const order = req.body.data;
        const eventType = resolveOrderEventType(order);

        if (!eventType) {
            console.log(`[WEBHOOK] Salla order.updated — status "${order?.status?.slug}" not actionable, skipping`);
            return;
        }

        await orderQueue.add('process', {
            order,
            eventType,
        }, {
            attempts: 10,
            backoff: { type: 'exponential', delay: 2000 },
        });

        console.log(`[WEBHOOK] Salla order.updated (${eventType}) enqueued for order ${order?.id}`);
    } catch (err: any) {
        console.error('[WEBHOOK] Error processing Salla order.updated:', err.message);
    }
});

router.post('/order/status/updated', async (req, res) => {
    res.status(200).send('OK');

    try {
        if (!verifySallaWebhook(req)) {
            console.warn('[WEBHOOK] Invalid Salla signature for order.status.updated');
            return;
        }

        const eventId = req.body.event_id ?? req.body.id?.toString();

        if (isDuplicate(eventId)) {
            console.log(`[WEBHOOK] Duplicate Salla webhook ${eventId}, skipping`);
            return;
        }

        logWebhook('order.status.updated', eventId, req.body);

        const order = req.body.data;
        const eventType = resolveOrderEventType(order);

        if (!eventType) {
            console.log(`[WEBHOOK] Salla order.status.updated — status "${order?.status?.slug}" not actionable, skipping`);
            return;
        }

        await orderQueue.add('process', {
            order,
            eventType,
        }, {
            attempts: 10,
            backoff: { type: 'exponential', delay: 2000 },
        });

        console.log(`[WEBHOOK] Salla order.status.updated (${eventType}) enqueued for order ${order?.id}`);
    } catch (err: any) {
        console.error('[WEBHOOK] Error processing Salla order.status.updated:', err.message);
    }
});

export default router;
