import { db } from '@union/core';
import { getBot, drainNotifications } from '../../../lib/bot';

/**
 * The sweepers + notification drain, as a scheduled target.
 *
 * On Vercel Hobby, Vercel's own cron only runs daily (a backstop). The real
 * cadence comes from GitHub Actions (.github/workflows/cron.yml) hitting this
 * endpoint every few minutes. Either way it runs the same thing.
 *
 * WITHOUT THIS RUNNING FREQUENTLY, MONEY SILENTLY STICKS: a depositor who takes
 * a handle and never pays would hold the slice forever, and holds would never
 * release. The cron is the clock.
 *
 * Protected by CRON_SECRET so only your scheduler can trigger it.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get('authorization');
  if (secret && auth !== `Bearer ${secret}`) {
    return new Response('unauthorized', { status: 401 });
  }

  try {
    const [swept] = await db()<{ swept_locks: number; swept_holds: number; escalated: number }[]>`
      select * from sweep_all()`;
    const bot = await getBot();
    const delivered = await drainNotifications(bot, 40);

    // Self-heal the webhook. Running the bot locally in polling mode (or any
    // stray deleteWebhook) silently kills production. Rather than let the bot
    // stay dead until someone notices, re-assert the webhook whenever it's
    // missing or pointing somewhere else — so an outage repairs itself within
    // one cron cycle.
    const webhookFixed = await ensureWebhook(bot, req);

    return Response.json({ ok: true, ...swept, delivered, webhookFixed });
  } catch (err) {
    console.error('[cron] failed:', err);
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

async function ensureWebhook(bot: Awaited<ReturnType<typeof getBot>>, req: Request): Promise<boolean> {
  try {
    // WHERE the webhook must point. Order matters:
    //   1. WEBHOOK_URL — an explicit, stable target. Set this in Vercel to the
    //      production alias and the guesswork below never runs.
    //   2. Otherwise the host this request arrived on — BUT never a Vercel
    //      auto-generated deployment URL. Those (…-<team>-projects.vercel.app,
    //      and the per-deploy <proj>-<hash>-<team>.vercel.app) are gated by
    //      Vercel deployment protection and answer Telegram with 401 — which is
    //      EXACTLY how the bot kept dying: the daily Vercel cron fires on such a
    //      URL, self-heal repoints the webhook to it, and every update 401s.
    //      A stable production alias is not protected, so only those are safe.
    const explicit = process.env.WEBHOOK_URL;
    const host = req.headers.get('x-forwarded-host') ?? new URL(req.url).host;
    const isProtectedDeployHost =
      host.endsWith('-projects.vercel.app') || /\.vusercontent\.net$/.test(host);

    const want = explicit ?? (isProtectedDeployHost ? null : `https://${host}/api/telegram`);
    if (!want) return false;   // no safe target we can prove — leave the webhook alone

    const info = await bot.api.getWebhookInfo();
    if (info.url === want) return false;   // already correct

    await bot.api.setWebhook(want, {
      secret_token: process.env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ['message', 'callback_query', 'my_chat_member'],
    });
    console.warn(`[cron] webhook was "${info.url || 'EMPTY'}" — restored to ${want}`);
    return true;
  } catch (err) {
    console.error('[cron] webhook check failed:', err);
    return false;
  }
}
