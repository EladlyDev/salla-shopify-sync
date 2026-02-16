import axios from 'axios';
import { config } from './config';

const TELEGRAM_TIMEOUT = 10_000;

/**
 * Send a Telegram alert. Fire-and-forget — never throws.
 * Falls back to console.log if Telegram is not configured.
 */
export async function sendAlert(message: string): Promise<void> {
    if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_CHAT_ID) {
        console.log('[ALERT]', message);
        return;
    }

    try {
        await axios.post(
            `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`,
            {
                chat_id: config.TELEGRAM_CHAT_ID,
                text: `🔄 Salla-Shopify Sync\n\n${message}`,
                parse_mode: 'HTML',
            },
            { timeout: TELEGRAM_TIMEOUT }
        );
    } catch (err) {
        console.error('[Telegram] Failed to send alert:', err instanceof Error ? err.message : err);
        console.error('[ALERT]', message);
    }
}

/**
 * Send a critical alert. Always logs to console.error regardless of Telegram success.
 */
export async function sendCritical(message: string): Promise<void> {
    const critical = `🚨 CRITICAL: ${message}`;
    console.error('[CRITICAL]', message);
    await sendAlert(critical);
}

/**
 * Send an informational alert.
 */
export async function sendInfo(message: string): Promise<void> {
    await sendAlert(`ℹ️ ${message}`);
}
