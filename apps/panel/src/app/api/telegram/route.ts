import { telegramWebhook } from '../../../lib/bot';

/**
 * Telegram webhook. Telegram POSTs every update here; grammY handles it and
 * returns. This replaces long polling on Vercel, where nothing runs forever.
 *
 * Set it up once after deploy:
 *   https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<your-app>.vercel.app/api/telegram&secret_token=<TELEGRAM_WEBHOOK_SECRET>
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(req: Request): Promise<Response> {
  try {
    return await telegramWebhook(req);
  } catch (err) {
    console.error('[telegram] webhook error:', err);
    // Return 200 so Telegram doesn't hammer retries on a bug; we log it instead.
    return new Response('ok', { status: 200 });
  }
}
