import axios, { AxiosInstance, AxiosError } from 'axios';
import axiosRetry from 'axios-retry';
import Bottleneck from 'bottleneck';
import fs from 'fs';
import path from 'path';
import { config } from '../config';

// ── Rate Limiter ────────────────────────────────────────
const limiter = new Bottleneck({
    maxConcurrent: 2,
    minTime: 500,
});

// ── Salla Client ────────────────────────────────────────

class SallaClient {
    private client: AxiosInstance;
    private accessToken: string;
    private refreshToken: string;
    private tokenExpiresAt: Date;
    private isRefreshing: boolean = false;
    private refreshPromise: Promise<void> | null = null;

    constructor() {
        this.accessToken = config.SALLA_ACCESS_TOKEN;
        this.refreshToken = config.SALLA_REFRESH_TOKEN;
        // Assume current token is valid for 1 hour from startup
        this.tokenExpiresAt = new Date(Date.now() + 60 * 60 * 1000);

        this.client = axios.create({
            baseURL: config.SALLA_BASE_URL,
            headers: {
                'Content-Type': 'application/json',
            },
            timeout: 30_000,
        });

        // Inject current access token before every request
        this.client.interceptors.request.use((reqConfig) => {
            reqConfig.headers['Authorization'] = `Bearer ${this.accessToken}`;
            return reqConfig;
        });

        // Retry on 429 / 5xx / network errors with exponential backoff
        axiosRetry(this.client, {
            retries: 3,
            retryDelay: axiosRetry.exponentialDelay,
            retryCondition: (error: AxiosError) => {
                if (axiosRetry.isNetworkOrIdempotentRequestError(error)) return true;
                const status = error.response?.status;
                // Don't retry 401 here — handled separately with token refresh
                return status === 429 || (status !== undefined && status >= 500);
            },
            onRetry: (retryCount, error) => {
                console.warn(
                    `[Salla] Retry #${retryCount} — ${error.response?.status ?? 'NETWORK'} ${error.config?.method?.toUpperCase()} ${error.config?.url}`
                );
            },
        });
    }

    // ── Token Management ──────────────────────────────

    /**
     * Ensures the access token is valid. If it expires within 5 minutes,
     * triggers a refresh. Uses a shared promise to prevent concurrent refreshes.
     */
    private async ensureValidToken(): Promise<void> {
        const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);

        if (this.tokenExpiresAt > fiveMinutesFromNow) {
            return; // Token is still valid
        }

        // Prevent concurrent refreshes — reuse the existing promise
        if (this.isRefreshing && this.refreshPromise) {
            await this.refreshPromise;
            return;
        }

        this.isRefreshing = true;
        this.refreshPromise = this.doTokenRefresh();

        try {
            await this.refreshPromise;
        } finally {
            this.isRefreshing = false;
            this.refreshPromise = null;
        }
    }

    private async doTokenRefresh(): Promise<void> {
        console.log('[Salla] Refreshing OAuth token...');

        const response = await axios.post(
            'https://accounts.salla.sa/oauth2/token',
            new URLSearchParams({
                grant_type: 'refresh_token',
                client_id: config.SALLA_CLIENT_ID,
                client_secret: config.SALLA_CLIENT_SECRET,
                refresh_token: this.refreshToken,
            }).toString(),
            {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                timeout: 30_000,
            }
        );

        const { access_token, refresh_token, expires_in } = response.data;

        this.accessToken = access_token;
        this.refreshToken = refresh_token;
        this.tokenExpiresAt = new Date(Date.now() + expires_in * 1000);

        console.log(`[Salla] Token refreshed, expires in ${expires_in}s`);

        // Persist tokens to .env so they survive restarts
        this.persistTokensToEnv(access_token, refresh_token);
    }

    /**
     * Update .env file with new tokens. Best-effort — if it fails
     * (e.g. read-only filesystem), log a warning and continue.
     * The in-memory token is what matters for runtime.
     */
    private persistTokensToEnv(accessToken: string, refreshToken: string): void {
        try {
            const envPath = path.resolve(__dirname, '..', '..', '.env');
            let envContent = fs.readFileSync(envPath, 'utf-8');

            envContent = envContent.replace(
                /^SALLA_ACCESS_TOKEN=.*/m,
                `SALLA_ACCESS_TOKEN=${accessToken}`
            );
            envContent = envContent.replace(
                /^SALLA_REFRESH_TOKEN=.*/m,
                `SALLA_REFRESH_TOKEN=${refreshToken}`
            );

            fs.writeFileSync(envPath, envContent, 'utf-8');
            console.log('[Salla] Tokens persisted to .env');
        } catch (err) {
            console.warn('[Salla] Failed to persist tokens to .env — continuing with in-memory tokens', err);
        }
    }

    // ── API Call Wrapper ──────────────────────────────

    /**
     * Wraps an API call with token validation and 401 retry logic.
     * On 401: force-refreshes the token and retries ONCE.
     */
    private async apiCall<T>(fn: () => Promise<T>, context: string): Promise<T> {
        await this.ensureValidToken();

        try {
            return await limiter.schedule(() => fn());
        } catch (error) {
            // On 401: force-refresh token and retry once
            if (axios.isAxiosError(error) && error.response?.status === 401) {
                console.warn(`[Salla] Got 401 on ${context} — forcing token refresh and retrying`);
                this.tokenExpiresAt = new Date(0); // Force refresh
                await this.ensureValidToken();
                try {
                    return await limiter.schedule(() => fn());
                } catch (retryError) {
                    this.handleError(`${context} (after token refresh)`, retryError);
                    throw retryError;
                }
            }

            this.handleError(context, error);
            throw error;
        }
    }

    // ── Products ──────────────────────────────────────

    async getProducts(page?: number, perPage?: number): Promise<any> {
        return this.apiCall(async () => {
            console.debug(`[Salla] GET /products page=${page ?? 1} perPage=${perPage ?? 20}`);
            const response = await this.client.get('/products', {
                params: { page: page ?? 1, per_page: perPage ?? 20 },
            });
            return response.data;
        }, 'GET /products');
    }

    async createProduct(payload: any): Promise<any> {
        return this.apiCall(async () => {
            console.debug(`[Salla] POST /products`);
            const response = await this.client.post('/products', payload);
            return response.data;
        }, 'POST /products');
    }

    async updateProduct(sallaProductId: number, payload: any): Promise<any> {
        return this.apiCall(async () => {
            console.debug(`[Salla] PUT /products/${sallaProductId}`);
            const response = await this.client.put(`/products/${sallaProductId}`, payload);
            return response.data;
        }, `PUT /products/${sallaProductId}`);
    }

    async deleteProduct(sallaProductId: number): Promise<any> {
        return this.apiCall(async () => {
            console.debug(`[Salla] DELETE /products/${sallaProductId}`);
            const response = await this.client.delete(`/products/${sallaProductId}`);
            return response.data;
        }, `DELETE /products/${sallaProductId}`);
    }

    async getProductVariants(sallaProductId: number): Promise<any> {
        return this.apiCall(async () => {
            console.debug(`[Salla] GET /products/${sallaProductId}/variants`);
            const response = await this.client.get(`/products/${sallaProductId}/variants`);
            return response.data;
        }, `GET /products/${sallaProductId}/variants`);
    }

    /**
     * Attach an image to a product by URL using Salla's Attach Image endpoint.
     * This bypasses the inline image URL validation in the product create payload.
     * The endpoint downloads the image from the URL server-side.
     */
    async attachImage(sallaProductId: number, imageUrl: string): Promise<any> {
        return this.apiCall(async () => {
            console.debug(`[Salla] POST /products/${sallaProductId}/images`);
            const response = await this.client.post(`/products/${sallaProductId}/images`, {
                original: imageUrl,
            });
            return response.data;
        }, `POST /products/${sallaProductId}/images`);
    }

    /**
     * Update a variant's stock quantity via Salla's variant update endpoint.
     * Endpoint: PUT /products/variants/{variant_id}
     * Also disables unlimited_quantity so the quantity is respected.
     */
    async updateVariantQuantity(sallaVariantId: number, quantity: number): Promise<any> {
        return this.apiCall(async () => {
            console.debug(`[Salla] PUT /products/variants/${sallaVariantId} qty=${quantity}`);
            const response = await this.client.put(`/products/variants/${sallaVariantId}`, {
                stock_quantity: quantity,
                unlimited_quantity: false,
            });
            return response.data;
        }, `PUT /products/variants/${sallaVariantId}`);
    }

    // ── Stock / Inventory ─────────────────────────────

    /**
     * Update stock quantity for a Salla product.
     * NOTE: This endpoint may need adjustment based on actual Salla API docs.
     * Possible alternatives:
     *   - POST /products/{id}/quantities  { quantity }
     *   - PUT  /products/{id}/stocks      { quantity }
     * Currently implemented as PUT /products/{id}/stocks.
     */
    async updateStock(sallaProductId: number, quantity: number): Promise<any> {
        return this.apiCall(async () => {
            console.debug(`[Salla] PUT /products/${sallaProductId}/stocks qty=${quantity}`);
            const response = await this.client.put(`/products/${sallaProductId}/stocks`, {
                quantity,
            });
            return response.data;
        }, `PUT /products/${sallaProductId}/stocks`);
    }

    async getStock(sallaProductId: number): Promise<{ quantity: number }> {
        return this.apiCall(async () => {
            console.debug(`[Salla] GET /products/${sallaProductId}/stocks`);
            const response = await this.client.get(`/products/${sallaProductId}/stocks`);
            const data = response.data?.data;
            return { quantity: typeof data?.quantity === 'number' ? data.quantity : parseInt(data?.quantity ?? '0', 10) };
        }, `GET /products/${sallaProductId}/stocks`);
    }

    // ── Webhooks ──────────────────────────────────────

    async createWebhook(event: string, url: string): Promise<any> {
        return this.apiCall(async () => {
            console.debug(`[Salla] POST /webhooks event=${event}`);
            const response = await this.client.post('/webhooks', { event, url });
            return response.data;
        }, 'POST /webhooks');
    }

    async getWebhooks(): Promise<any[]> {
        return this.apiCall(async () => {
            console.debug(`[Salla] GET /webhooks`);
            const response = await this.client.get('/webhooks');
            return response.data?.data ?? response.data;
        }, 'GET /webhooks');
    }

    // ── Helpers ───────────────────────────────────────

    private handleError(context: string, error: unknown): void {
        if (axios.isAxiosError(error)) {
            const status = error.response?.status;
            const body = error.response?.data;
            console.error(`[Salla] Error ${context} — status=${status}`, JSON.stringify(body));
        } else {
            console.error(`[Salla] Error ${context}`, error);
        }
    }
}

export const sallaApi = new SallaClient();
