import axios, { AxiosInstance, AxiosError } from 'axios';
import axiosRetry from 'axios-retry';
import Bottleneck from 'bottleneck';
import { config } from '../config';

// ── Rate Limiter ────────────────────────────────────────
// Shopify allows ~2 req/s steady state for REST Admin API
const limiter = new Bottleneck({
    maxConcurrent: 2,
    minTime: 500,
});

// ── Shopify Client ──────────────────────────────────────

class ShopifyClient {
    private client: AxiosInstance;

    constructor() {
        this.client = axios.create({
            baseURL: `https://${config.SHOPIFY_SHOP}/admin/api/${config.SHOPIFY_API_VERSION}`,
            headers: {
                'X-Shopify-Access-Token': config.SHOPIFY_ACCESS_TOKEN,
                'Content-Type': 'application/json',
            },
            timeout: 30_000,
        });

        // Retry on 429 / 5xx / network errors with exponential backoff
        axiosRetry(this.client, {
            retries: 3,
            retryDelay: axiosRetry.exponentialDelay,
            retryCondition: (error: AxiosError) => {
                if (axiosRetry.isNetworkOrIdempotentRequestError(error)) return true;
                const status = error.response?.status;
                return status === 429 || (status !== undefined && status >= 500);
            },
            onRetry: (retryCount, error) => {
                console.warn(
                    `[Shopify] Retry #${retryCount} — ${error.response?.status ?? 'NETWORK'} ${error.config?.method?.toUpperCase()} ${error.config?.url}`
                );
            },
        });
    }

    // ── Products ────────────────────────────────────────

    async getProducts(params?: {
        limit?: number;
        page_info?: string;
        since_id?: number;
    }): Promise<{ products: any[]; nextPageInfo: string | null }> {
        return limiter.schedule(async () => {
            const queryParams: Record<string, string | number> = {
                limit: params?.limit ?? 250,
            };
            if (params?.page_info) queryParams.page_info = params.page_info;
            if (params?.since_id) queryParams.since_id = params.since_id;

            console.debug(`[Shopify] GET /products.json`, queryParams);

            try {
                const response = await this.client.get('/products.json', { params: queryParams });
                const nextPageInfo = this.parseLinkHeader(response.headers['link']);
                return { products: response.data.products, nextPageInfo };
            } catch (error) {
                this.handleError('GET /products.json', error);
                throw error;
            }
        });
    }

    async getProduct(productId: number): Promise<any> {
        return limiter.schedule(async () => {
            console.debug(`[Shopify] GET /products/${productId}.json`);
            try {
                const response = await this.client.get(`/products/${productId}.json`);
                return response.data.product;
            } catch (error) {
                this.handleError(`GET /products/${productId}.json`, error);
                throw error;
            }
        });
    }

    // ── Locations ───────────────────────────────────────

    async getLocations(): Promise<any[]> {
        return limiter.schedule(async () => {
            console.debug(`[Shopify] GET /locations.json`);
            try {
                const response = await this.client.get('/locations.json');
                return response.data.locations;
            } catch (error) {
                this.handleError('GET /locations.json', error);
                throw error;
            }
        });
    }

    // ── Inventory ───────────────────────────────────────

    async getInventoryLevel(
        inventoryItemId: number,
        locationId: number
    ): Promise<{ available: number; inventory_item_id: number; location_id: number }> {
        return limiter.schedule(async () => {
            console.debug(`[Shopify] GET /inventory_levels.json item=${inventoryItemId} loc=${locationId}`);
            try {
                const response = await this.client.get('/inventory_levels.json', {
                    params: {
                        inventory_item_ids: inventoryItemId,
                        location_ids: locationId,
                    },
                });
                return response.data.inventory_levels[0];
            } catch (error) {
                this.handleError('GET /inventory_levels.json', error);
                throw error;
            }
        });
    }

    /**
     * Adjust inventory by a delta amount.
     * CRITICAL: This adjusts by delta (relative), NOT absolute value.
     * Only used for applying Salla order adjustments to Shopify.
     */
    async adjustInventory(
        inventoryItemId: number,
        locationId: number,
        adjustment: number
    ): Promise<any> {
        return limiter.schedule(async () => {
            console.debug(
                `[Shopify] POST /inventory_levels/adjust.json item=${inventoryItemId} loc=${locationId} delta=${adjustment}`
            );
            try {
                const response = await this.client.post('/inventory_levels/adjust.json', {
                    location_id: locationId,
                    inventory_item_id: inventoryItemId,
                    available_adjustment: adjustment,
                });
                return response.data.inventory_level;
            } catch (error) {
                this.handleError('POST /inventory_levels/adjust.json', error);
                throw error;
            }
        });
    }

    /**
     * Batch-fetch inventory levels. Handles batching internally if > 50 IDs.
     * Shopify allows max 50 inventory_item_ids per request.
     */
    async getInventoryLevels(locationId: number, inventoryItemIds: number[]): Promise<any[]> {
        const BATCH_SIZE = 50;
        const results: any[] = [];

        for (let i = 0; i < inventoryItemIds.length; i += BATCH_SIZE) {
            const batch = inventoryItemIds.slice(i, i + BATCH_SIZE);
            const batchResult = await limiter.schedule(async () => {
                const idsParam = batch.join(',');
                console.debug(
                    `[Shopify] GET /inventory_levels.json batch=${Math.floor(i / BATCH_SIZE) + 1} ids=${batch.length} loc=${locationId}`
                );
                try {
                    const response = await this.client.get('/inventory_levels.json', {
                        params: {
                            inventory_item_ids: idsParam,
                            location_ids: locationId,
                        },
                    });
                    return response.data.inventory_levels;
                } catch (error) {
                    this.handleError('GET /inventory_levels.json (batch)', error);
                    throw error;
                }
            });
            results.push(...batchResult);
        }

        return results;
    }

    // ── Webhooks ────────────────────────────────────────

    async registerWebhook(topic: string, address: string): Promise<any> {
        return limiter.schedule(async () => {
            console.debug(`[Shopify] POST /webhooks.json topic=${topic}`);
            try {
                const response = await this.client.post('/webhooks.json', {
                    webhook: { topic, address, format: 'json' },
                });
                return response.data.webhook;
            } catch (error) {
                this.handleError('POST /webhooks.json', error);
                throw error;
            }
        });
    }

    async getWebhooks(): Promise<any[]> {
        return limiter.schedule(async () => {
            console.debug(`[Shopify] GET /webhooks.json`);
            try {
                const response = await this.client.get('/webhooks.json');
                return response.data.webhooks;
            } catch (error) {
                this.handleError('GET /webhooks.json', error);
                throw error;
            }
        });
    }

    // ── Helpers ─────────────────────────────────────────

    /**
     * Parse Shopify's Link header for cursor-based pagination.
     * Format: <https://...?page_info=xxx>; rel="next"
     */
    private parseLinkHeader(linkHeader?: string): string | null {
        if (!linkHeader) return null;

        const nextMatch = linkHeader.match(/<[^>]*\bpage_info=([^>&]+)[^>]*>;\s*rel="next"/);
        return nextMatch ? nextMatch[1] : null;
    }

    private handleError(context: string, error: unknown): void {
        if (axios.isAxiosError(error)) {
            const status = error.response?.status;
            const body = error.response?.data;
            console.error(`[Shopify] Error ${context} — status=${status}`, JSON.stringify(body));
        } else {
            console.error(`[Shopify] Error ${context}`, error);
        }
    }
}

export const shopifyApi = new ShopifyClient();
