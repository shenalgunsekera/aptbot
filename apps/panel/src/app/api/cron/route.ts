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

/** Resolve with `fallback` if `p` doesn't settle within `ms`. A slow detector
 *  (a hung chain API, a slow inbox) must never push the whole cron past Vercel's
 *  function limit — that's what was returning 504 and piling up. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
}

export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get('authorization');
  if (secret && auth !== `Bearer ${secret}`) {
    return new Response('unauthorized', { status: 401 });
  }

  try {
    const [swept] = await db()<{ swept_locks: number; swept_holds: number; escalated: number }[]>`
      select * from sweep_all()`;

    // Poll stablecoin addresses for incoming payments (matched exactly by amount,
    // then queued as an admin heads-up). Best-effort — never break the cron.
    let cryptoPolled = 0;
    let cryptoDisabled: string[] = [];
    try {
      const { detectCryptoPayments } = await import('../../../lib/crypto-watch');
      const r = await withTimeout(detectCryptoPayments(), 20000, { polled: 0, disabled: [] as string[] });
      cryptoPolled = r.polled;
      cryptoDisabled = r.disabled;
      // A crypto method is ENABLED but can't be watched (missing chain API key).
      // Never let that stay silent — alert admins (at most once every 6h).
      if (cryptoDisabled.length) await alertCryptoDown(cryptoDisabled);
    } catch (err) { console.error('[cron] crypto poll failed:', err); }

    // NOTE: PayPal / Cash App email detection is handled by the INSTANT push
    // webhook (/api/webhooks/email) — the single source of truth. The old IMAP
    // poll here double-recorded the same emails (duplicate alerts) and its slow
    // Gmail connect kept timing this cron out (→ 504), so it's retired.
    const paypalSeen = 0;
    const emailBreakdown: Record<string, { found: number; parsed: number }> = {};
    const emailError: string | null = null;
    const emailConfigured = false;

    const bot = await getBot();
    const delivered = await drainNotifications(bot, 40);

    // Self-heal the webhook. Running the bot locally in polling mode (or any
    // stray deleteWebhook) silently kills production. Rather than let the bot
    // stay dead until someone notices, re-assert the webhook whenever it's
    // missing or pointing somewhere else — so an outage repairs itself within
    // one cron cycle.
    const webhookFixed = await ensureWebhook(bot, req);

    return Response.json({ ok: true, ...swept, delivered, cryptoPolled, cryptoDisabled, paypalSeen, emailBreakdown, emailConfigured, emailError, webhookFixed });
  } catch (err) {
    console.error('[cron] failed:', err);
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

/** Enabled crypto methods can't be watched (missing chain API key) → tell admins,
 *  loudly, on BOTH platforms — but at most once every 6h so it doesn't spam. */
async function alertCryptoDown(methods: string[]): Promise<void> {
  try {
    const sql = db();
    const [recent] = await sql<{ x: number }[]>`
      select 1 x from notifications
       where kind = 'crypto.detection_down' and created_at > now() - interval '6 hours' limit 1`;
    if (recent) return;
    for (const platform of ['telegram', 'discord'] as const) {
      await sql`insert into notifications (audience, kind, ref_type, ref_id, payload, platform)
        values ('admins', 'crypto.detection_down', 'config', gen_random_uuid(),
                ${sql.json({ methods })}::jsonb, ${platform})`;
    }
  } catch (err) { console.error('[cron] crypto-down alert failed:', err); }
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
