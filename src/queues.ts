import { Queue, Worker, Job } from 'bullmq';
import { config } from './config';
import { sendCritical } from './telegram';

// ── Redis Connection ────────────────────────────────────
// Use URL config object instead of IORedis instance to avoid version conflicts
// between standalone ioredis and BullMQ's bundled ioredis

function parseRedisUrl(url: string) {
    const parsed = new URL(url);
    return {
        host: parsed.hostname || '127.0.0.1',
        port: parseInt(parsed.port || '6379', 10),
        password: parsed.password || undefined,
        maxRetriesPerRequest: null,
    };
}

const connection = parseRedisUrl(config.REDIS_URL);

// ── Queues ──────────────────────────────────────────────

export const productQueue = new Queue('product-sync', {
    connection,
    defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 2000 },
    },
});

export const inventoryQueue = new Queue('inventory-sync', {
    connection,
    defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 3000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 2000 },
    },
});

export const orderQueue = new Queue('order-sync', {
    connection,
    defaultJobOptions: {
        attempts: 10, // More retries — critical (money!)
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 2000 },
    },
});

// ── Workers ─────────────────────────────────────────────

// Product sync worker
const productWorker = new Worker(
    'product-sync',
    async (job: Job) => {
        const { syncProductToSalla, deleteProductFromSalla } = await import('./sync/product-sync');

        if (job.name === 'create' || job.name === 'update') {
            await syncProductToSalla(job.data.shopifyProduct);
        } else if (job.name === 'delete') {
            await deleteProductFromSalla(job.data.shopifyProductId);
        } else {
            console.warn(`[WORKER] Unknown product job name: ${job.name}`);
        }
    },
    {
        connection,
        concurrency: 1,
        limiter: { max: 2, duration: 1000 },
    }
);

productWorker.on('completed', (job) => {
    console.log(`[WORKER] Product job ${job.id} (${job.name}) completed`);
});

productWorker.on('failed', (job, err) => {
    if (!job) return;
    console.error(`[WORKER] Product job ${job.id} (${job.name}) failed attempt ${job.attemptsMade}/${job.opts.attempts}:`, err.message);

    if (job.attemptsMade >= (job.opts.attempts ?? 5)) {
        sendCritical(
            `Product sync failed permanently!\n` +
            `Job: ${job.name} (${job.id})\n` +
            `Product ID: ${job.data.shopifyProduct?.id ?? job.data.shopifyProductId}\n` +
            `Error: ${err.message}`
        );
    }
});

console.log('[WORKER] Product sync worker started');

// Inventory sync worker
const inventoryWorker = new Worker(
    'inventory-sync',
    async (job: Job) => {
        const { syncShopifyInventoryToSalla } = await import('./sync/inventory-sync');
        await syncShopifyInventoryToSalla(job.data.shopifyInventoryItemId, job.data.shopifyLocationId);
    },
    {
        connection,
        concurrency: 1, // CRITICAL: must be 1 to work with mutexes
    }
);

inventoryWorker.on('completed', (job) => {
    console.log(`[WORKER] Inventory job ${job.id} completed`);
});

inventoryWorker.on('failed', (job, err) => {
    if (!job) return;
    console.error(`[WORKER] Inventory job ${job.id} failed attempt ${job.attemptsMade}/${job.opts.attempts}:`, err.message);

    if (job.attemptsMade >= (job.opts.attempts ?? 5)) {
        sendCritical(
            `Inventory sync failed permanently!\n` +
            `Job: ${job.id}\n` +
            `Inventory Item: ${job.data.shopifyInventoryItemId}\n` +
            `Location: ${job.data.shopifyLocationId}\n` +
            `Error: ${err.message}`
        );
    }
});

console.log('[WORKER] Inventory sync worker started');

// Order sync worker
const orderWorker = new Worker(
    'order-sync',
    async (job: Job) => {
        const { processOrderSyncJob } = await import('./sync/order-sync');
        await processOrderSyncJob(job.data);
    },
    {
        connection,
        concurrency: 1, // CRITICAL: must be 1 to work with mutexes
    }
);

orderWorker.on('completed', (job) => {
    console.log(`[WORKER] Order job ${job.id} (${job.name}) completed`);
});

orderWorker.on('failed', (job, err) => {
    if (!job) return;
    console.error(`[WORKER] Order job ${job.id} failed attempt ${job.attemptsMade}/${job.opts.attempts}:`, err.message);

    // Orders are money — alert on every failure, critical on final
    if (job.attemptsMade >= (job.opts.attempts ?? 10)) {
        sendCritical(
            `⚠️ ORDER SYNC FAILED — ALL RETRIES EXHAUSTED!\n` +
            `Job: ${job.name} (${job.id})\n` +
            `Order ID: ${job.data.order?.id}\n` +
            `Event: ${job.data.eventType}\n` +
            `Items: ${JSON.stringify(job.data.order?.items?.map((i: any) => i.sku))}\n` +
            `Error: ${err.message}\n` +
            `This requires manual intervention!`
        );
    }
});

console.log('[WORKER] Order sync worker started');

// ── Helpers ─────────────────────────────────────────────

/**
 * Enqueue an inventory sync job with debouncing.
 * If a job for the same inventory item is already waiting/delayed, remove it
 * and add a new one with a 2-second delay (debounce window).
 */
export async function enqueueInventorySync(
    shopifyInventoryItemId: number,
    shopifyLocationId: number
): Promise<void> {
    const jobId = `inv-${shopifyInventoryItemId}`;

    // Debounce: remove existing delayed/waiting job for same item
    try {
        const existing = await inventoryQueue.getJob(jobId);
        if (existing) {
            const state = await existing.getState();
            if (state === 'waiting' || state === 'delayed') {
                await existing.remove();
            }
        }
    } catch {
        // Job doesn't exist or already processing, fine
    }

    // Add with 2-second delay (debounce window)
    await inventoryQueue.add('sync',
        { shopifyInventoryItemId, shopifyLocationId },
        {
            jobId,
            delay: 2000,
            attempts: 5,
            backoff: { type: 'exponential', delay: 3000 },
        }
    );
}

// Keep references to prevent GC
void productWorker;
void inventoryWorker;
void orderWorker;
