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
  const { buildBot, syncCommands } = await import('@union/bot/build');
  // Build into a LOCAL first and only cache once init() succeeds. If init throws
  // (a transient getMe hiccup on a cold start), we must NOT leave a half-built,
  // uninitialised bot in `_bot` — that would poison every later request on this
  // warm instance (they'd short-circuit on `if (_bot)` and skip init forever).
  const bot = buildBot(token);
  await bot.init();
  _bot = bot;
  // Push the "/" command menu to Telegram once per cold start — the webhook
  // runtime never runs index.ts, so this is where a renamed/added command
  // actually reaches Telegram after a deploy. Fire-and-forget; never block.
  void syncCommands(bot).catch((e) => console.error('[bot] syncCommands failed:', e));
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
  // grammY's webhook aborts the handler after 10s by DEFAULT and (onTimeout
  // 'throw') throws — on Vercel that means a cold start landing on a suspended
  // Neon compute (scale-to-zero takes a few seconds to wake) can blow the 10s
  // budget on the very first request, the handler is aborted, and the reply is
  // silently lost while Telegram still gets a 200 (so nothing shows as pending
  // or errored — exactly the "bot didn't respond, then it's fine again" symptom).
  // Give the handler real headroom (Vercel maxDuration here is 30s) so the first
  // request after idle actually finishes and replies, and 'return' cleanly on the
  // rare genuine timeout instead of throwing.
  const handler = webhookCallback(bot, 'std/http', {
    timeoutMilliseconds: 25_000,
    onTimeout: 'return',
  });
  const res = await handler(req);

  // Drain the notification outbox right here, so messages queued by whatever the
  // player just did (confirming a payment, submitting proof) go out in seconds
  // rather than waiting for the next cron. Most money moves happen through the
  // bot, so this covers the latency-sensitive cases; cron catches the rest
  // (panel actions, retries). Best-effort — never let it break the webhook ack.
  try {
    // Never let a broadcast slow a player's own webhook — announcements are
    // delivered by the cron / panel send instead.
    await drainNotifications(bot, 10, { announcements: false });
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
export async function drainNotifications(
  bot: BotT, limit = 25, opts: { announcements?: boolean } = {},
): Promise<number> {
  const { db } = await import('@union/core');
  const { renderNotification } = await import('@union/bot/build');
  const sql = db();
  const withAnnouncements = opts.announcements !== false;

  const [cfg] = await sql<{ admin_group_chat_id: number | null; payments_channel_chat_id: number | null; escalation_channel_chat_id: number | null }[]>`
    select admin_group_chat_id, payments_channel_chat_id, escalation_channel_chat_id from config where id`;
  // Atomically LEASE the batch (push send_after out) so this drain and the bot's
  // webhook drain can't both grab a row and send it twice — `for update skip
  // locked` alone doesn't prevent that once the SELECT autocommits. See notifier.ts.
  const rows = await sql<any[]>`
    with c as (
      select id from notifications
       where status = 'pending' and send_after <= now() and platform = 'telegram'
         ${withAnnouncements ? sql`` : sql`and kind <> 'announcement'`}
       -- Announcements always queue BEHIND real messages: a 500-player blast must
       -- never delay a payment alert or a player's "money on its way".
       order by (kind = 'announcement'), id limit ${limit}
         for update skip locked
    )
    update notifications n set send_after = now() + interval '90 seconds'
      from c where n.id = c.id
    returning n.*`;
  const chats = rows.length
    ? await sql<{ id: number; player_chat: number | null; admin_tg: number | null }[]>`
        select n.id, coalesce(p.chat_id, p.telegram_id) as player_chat, a.telegram_id as admin_tg
          from notifications n
          left join players p on p.id = n.player_id
          left join admins a on a.id = n.admin_id
         where n.id = any(${sql.array(rows.map((r) => Number(r.id)))}::bigint[])`
    : [];
  const chatMap = new Map(chats.map((c) => [Number(c.id), c]));

  const { sendRendered, sendAnnouncement } = await import('@union/bot/build');
  let sent = 0;
  for (const n of rows) {
    const cm = chatMap.get(Number(n.id));
    // Player notifications go to the chat the player actually uses (their group),
    // not their DM — see 0020. Admin rows go to the admin group.
    // Escalation posts go ONLY to the escalation channel (never the admin group);
    // the money-in feed to the payments channel; everything else to the admin group.
    const chatId = n.audience === 'admins'
      ? (n.kind === 'escalation.item'
          ? cfg?.escalation_channel_chat_id
          : ((n.kind === 'payment.detected' ? cfg?.payments_channel_chat_id : null) ?? cfg?.admin_group_chat_id))
      : (cm?.player_chat ?? cm?.admin_tg);
    // A loader "Claim" card is suppressed the instant a Verify tap claims the task
    // inline. If a concurrent drain reached this row first, the task is no longer
    // pending — don't post a stale, clickable Claim button (the "random Claim button
    // after Verify" bug).
    if (n.kind === 'loader.work') {
      const [o] = await sql<{ status: string }[]>`select status from loader_orders where id = ${n.ref_id}`;
      if (o && o.status !== 'pending') { await sql`update notifications set status='skipped' where id=${n.id}`; continue; }
    }
    const isAnnouncement = n.kind === 'announcement';
    const msg = isAnnouncement ? null : renderNotification(n);
    if (!chatId || (!isAnnouncement && !msg)) { await sql`update notifications set status='skipped' where id=${n.id}`; continue; }
    try {
      // sendRendered sends a PHOTO when the notification carries a receipt image,
      // else text — so receipts show inline in Telegram from the cron path too.
      const mid = isAnnouncement
        ? await sendAnnouncement(bot, Number(chatId), n.payload)
        : await sendRendered(bot, chatId, msg!);
      await sql`update notifications set status='sent', sent_at=now(),
                sent_chat_id=${String(chatId)}, sent_message_id=${mid != null ? String(mid) : null}
                where id=${n.id}`;
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

/**
 * Broadcast pump for announcements (0123): delivers queued Telegram announcement
 * rows for up to `budgetMs`, paced under Telegram's ~30 msg/s bot limit (an album
 * of N photos counts as N), and honours a 429's retry_after instead of hammering.
 * Called right after a panel send (first wave out immediately) and by every cron
 * run (the rest), so a 400-player blast finishes in a couple of minutes without
 * ever delaying a money message (those go first in drainNotifications).
 */
export async function drainAnnouncements(bot: BotT, budgetMs: number): Promise<number> {
  const { db } = await import('@union/core');
  const { sendAnnouncement } = await import('@union/bot/build');
  const sql = db();
  const deadline = Date.now() + budgetMs;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const [cfg] = await sql<{ admin_group_chat_id: number | null }[]>`select admin_group_chat_id from config where id`;
  let sent = 0;

  while (Date.now() < deadline - 3_000) {
    const rows = await sql<any[]>`
      with c as (
        select id from notifications
         where status = 'pending' and send_after <= now() and platform = 'telegram' and kind = 'announcement'
         order by id limit 20
           for update skip locked
      )
      update notifications n set send_after = now() + interval '90 seconds'
        from c where n.id = c.id
      returning n.*`;
    if (!rows.length) break;
    const chats = await sql<{ id: number; chat: number | null }[]>`
      select n.id, coalesce(p.chat_id, p.telegram_id) as chat
        from notifications n left join players p on p.id = n.player_id
       where n.id = any(${sql.array(rows.map((r) => Number(r.id)))}::bigint[])`;
    const chatFor = new Map(chats.map((c) => [Number(c.id), c.chat]));

    for (let i = 0; i < rows.length; i++) {
      const n = rows[i];
      if (Date.now() > deadline - 2_000) {
        // Out of time — hand the rest straight back so the next run takes them.
        const left = rows.slice(i).map((r) => Number(r.id));
        await sql`update notifications set send_after = now() where id = any(${sql.array(left)}::bigint[])`;
        return sent;
      }
      const chatId = n.audience === 'admins' ? cfg?.admin_group_chat_id : chatFor.get(Number(n.id));
      if (!chatId) { await sql`update notifications set status='skipped' where id=${n.id}`; continue; }
      const imgs = Array.isArray(n.payload?.images) ? n.payload.images.length : 0;
      try {
        const mid = await sendAnnouncement(bot, Number(chatId), n.payload);
        await sql`update notifications set status='sent', sent_at=now(),
                  sent_chat_id=${String(chatId)}, sent_message_id=${mid != null ? String(mid) : null}
                  where id=${n.id}`;
        sent++;
      } catch (err) {
        const retry = Number((err as any)?.parameters?.retry_after ?? 0);
        if (retry > 0) {
          // Rate limited: back off for exactly as long as Telegram asks; no attempt burned.
          await sql`update notifications set send_after = now() + make_interval(secs => ${retry}) where id=${n.id}`;
          await sleep(Math.min(retry * 1000, Math.max(0, deadline - Date.now() - 2_000)));
          continue;
        }
        const desc = String((err as any)?.description ?? err);
        const giveUp = /blocked|deactivated|chat not found|kicked|not enough rights|have no rights/i.test(desc) || n.attempts >= 4;
        await sql`update notifications set status=${giveUp ? 'failed' : 'pending'}, attempts=${n.attempts + 1},
                  last_error=${desc.slice(0, 300)}, send_after=now()+interval '2 minutes' where id=${n.id}`;
      }
      // ~20 message-units/sec: an album of N photos is N messages, plus its text.
      await sleep(50 * (Math.max(1, imgs) + 1));
    }
  }
  return sent;
}
