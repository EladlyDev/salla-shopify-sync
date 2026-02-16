import express from 'express';
import path from 'path';
import { config } from './config';
import db, { initDb } from './db';

// ── Raw Body Typing ─────────────────────────────────────

declare global {
    namespace Express {
        interface Request {
            rawBody?: Buffer;
        }
    }
}

// ── App Setup ───────────────────────────────────────────

const app = express();

// Parse JSON with raw body capture for webhook HMAC verification
app.use(
    express.json({
        limit: '5mb',
        verify: (req: express.Request, _res, buf) => {
            req.rawBody = buf;
        },
    })
);

// View engine
app.set('view engine', 'ejs');
app.set('views', path.resolve(__dirname, '..', 'views'));

// ── Routes ──────────────────────────────────────────────

// Webhook routes
import shopifyWebhookRoutes from './webhooks/shopify.routes';
import sallaWebhookRoutes from './webhooks/salla.routes';

app.use('/webhooks/shopify', shopifyWebhookRoutes);
app.use('/webhooks/salla', sallaWebhookRoutes);

// Dashboard placeholder
app.get('/dashboard', (_req, res) => {
    res.send('Dashboard coming soon');
});

// Health check
app.get('/health', (_req, res) => {
    const pendingAdjustments = db
        .prepare('SELECT COUNT(*) as count FROM inventory_adjustments WHERE applied_to_shopify = 0')
        .get() as { count: number };

    res.json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        pendingAdjustments: pendingAdjustments.count,
    });
});

// ── Startup ─────────────────────────────────────────────

// Initialize database
initDb();

// Import side-effects (start workers & cron)
import './queues';
import './cron';

app.listen(config.PORT, () => {
    console.log(`\n🚀 Salla-Shopify Sync server running on port ${config.PORT}`);
    console.log(`   Dashboard: http://localhost:${config.PORT}/dashboard`);
    console.log(`   Health:    http://localhost:${config.PORT}/health`);
    console.log(`   Shopify webhooks: http://localhost:${config.PORT}/webhooks/shopify/*`);
    console.log(`   Salla webhooks:   http://localhost:${config.PORT}/webhooks/salla/*\n`);
});

export default app;
