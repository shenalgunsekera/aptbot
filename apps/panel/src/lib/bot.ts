import 'server-only';
import { webhookCallback } from 'grammy';
import type { buildBot as BuildBot } from '@union/bot/build';

/**
 * The bot, as a Vercel webhook — not a long-running process.
 *
 * The old bot used long polling: an open connection that lives forever. Vercel
 * has no forever — functions run per request and freeze. So on Vercel the bot is
 * a webhook: Telegram POSTs each update to /api/telegram, the function handles
 * it and returns. The sweepers, which used to be setInterval loops, become
 * Vercel Cron hitting /api/cron.
 *
 * The bot's handlers live in @union/bot. Here we import the configured Bot and
 * hand it to grammY's webhook adapter. One codebase, two runtimes: `pnpm dev`
 * runs it as long polling locally; Vercel runs this webhook.
 */

type BotT = ReturnType<typeof BuildBot>;
let _bot: BotT | undefined;

export async function getBot(): Promise<BotT> {
  if (_bot) return _bot;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not set');

  // The bot's wiring is exported from @union/bot as a factory so it can be
  // driven by either polling (local) or webhook (Vercel) without duplication.
  const { buildBot } = await import('@union/bot/build');
  _bot = buildBot(token);
  await _bot.init();
  return _bot;
}

export async function telegramWebhook(req: Request): Promise<Response> {
  const bot = await getBot();
  // Verify the secret token Telegram echoes back, so nobody can POST fake
  // updates to the public endpoint.
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.headers.get('x-telegram-bot-api-secret-token') !== secret) {
    return new Response('unauthorized', { status: 401 });
  }
  const handler = webhookCallback(bot, 'std/http');
  const res = await handler(req);

  // Drain the notification outbox right here, so messages queued by whatever the
  // player just did (confirming a payment, submitting proof) go out in seconds
  // rather than waiting for the next cron. Most money moves happen through the
  // bot, so this covers the latency-sensitive cases; cron catches the rest
  // (panel actions, retries). Best-effort — never let it break the webhook ack.
  try {
    await drainNotifications(bot, 10);
  } catch (err) {
    console.error('[telegram] inline drain failed:', err);
  }
  return res;
}

/**
 * Deliver a batch of pending notifications. Shared by the webhook (inline, for
 * low latency) and the cron (catch-all). Kept small per call so it never
 * dominates a request.
 */
export async function drainNotifications(bot: BotT, limit = 25): Promise<number> {
  const { db } = await import('@union/core');
  const { renderNotification } = await import('@union/bot/build');
  const sql = db();

  const [cfg] = await sql<{ admin_group_chat_id: number | null }[]>`
    select admin_group_chat_id from config where id`;
  const rows = await sql<any[]>`
    select n.*, coalesce(p.chat_id, p.telegram_id) as player_chat, a.telegram_id as admin_tg
      from notifications n
      left join players p on p.id = n.player_id
      left join admins a on a.id = n.admin_id
     where n.status = 'pending' and n.send_after <= now()
     order by n.id limit ${limit} for update of n skip locked`;

  const { sendRendered } = await import('@union/bot/build');
  let sent = 0;
  for (const n of rows) {
    // Player notifications go to the chat the player actually uses (their group),
    // not their DM — see 0020. Admin rows go to the admin group.
    const chatId = n.audience === 'admins' ? cfg?.admin_group_chat_id : (n.player_chat ?? n.admin_tg);
    const msg = renderNotification(n);
    if (!chatId || !msg) { await sql`update notifications set status='skipped' where id=${n.id}`; continue; }
    try {
      // sendRendered sends a PHOTO when the notification carries a receipt image,
      // else text — so receipts show inline in Telegram from the cron path too.
      await sendRendered(bot, chatId, msg);
      await sql`update notifications set status='sent', sent_at=now() where id=${n.id}`;
      sent++;
    } catch (err) {
      const desc = String((err as any)?.description ?? err);
      const giveUp = /blocked|deactivated|chat not found|kicked/i.test(desc) || n.attempts >= 4;
      await sql`update notifications set status=${giveUp ? 'failed' : 'pending'}, attempts=${n.attempts + 1},
                last_error=${desc.slice(0, 300)}, send_after=now()+interval '2 minutes' where id=${n.id}`;
    }
  }
  return sent;
}
