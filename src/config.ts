import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

// ── Helpers ─────────────────────────────────────────────

function required(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

function requiredInt(name: string, fallback?: number): number {
    const raw = process.env[name];
    if (!raw && fallback !== undefined) return fallback;
    if (!raw) throw new Error(`Missing required environment variable: ${name}`);
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed)) {
        throw new Error(`Environment variable ${name} must be a valid integer, got: "${raw}"`);
    }
    return parsed;
}

function optional(name: string): string | undefined {
    return process.env[name] || undefined;
}

// ── Config ──────────────────────────────────────────────

export const config = {
    PORT: requiredInt('PORT', 3000),

    // Shopify
    SHOPIFY_SHOP: required('SHOPIFY_SHOP'),
    SHOPIFY_ACCESS_TOKEN: required('SHOPIFY_ACCESS_TOKEN'),
    SHOPIFY_WEBHOOK_SECRET: required('SHOPIFY_WEBHOOK_SECRET'),
    SHOPIFY_LOCATION_ID: requiredInt('SHOPIFY_LOCATION_ID'),
    SHOPIFY_API_VERSION: process.env.SHOPIFY_API_VERSION || '2024-10',

    // Salla
    SALLA_BASE_URL: process.env.SALLA_BASE_URL || 'https://api.salla.dev/admin/v2',
    SALLA_CLIENT_ID: required('SALLA_CLIENT_ID'),
    SALLA_CLIENT_SECRET: required('SALLA_CLIENT_SECRET'),
    SALLA_ACCESS_TOKEN: required('SALLA_ACCESS_TOKEN'),
    SALLA_REFRESH_TOKEN: required('SALLA_REFRESH_TOKEN'),
    SALLA_WEBHOOK_SECRET: required('SALLA_WEBHOOK_SECRET'),

    // Redis
    REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',

    // Telegram (optional)
    TELEGRAM_BOT_TOKEN: optional('TELEGRAM_BOT_TOKEN'),
    TELEGRAM_CHAT_ID: optional('TELEGRAM_CHAT_ID'),

    // Dashboard
    DASHBOARD_PASSWORD: process.env.DASHBOARD_PASSWORD || 'admin123',
} as const;

// Re-export mutable Salla tokens — these get updated on token refresh
export const sallaTokens = {
    accessToken: config.SALLA_ACCESS_TOKEN,
    refreshToken: config.SALLA_REFRESH_TOKEN,
};

export type Config = typeof config;
