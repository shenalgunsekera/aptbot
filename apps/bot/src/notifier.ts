import { Bot, InlineKeyboard } from 'grammy';
import { db, type Notification } from '@union/core';
import type { Ctx } from './session.js';
import { money } from './words.js';

/**
 * Drains the notifications outbox to Telegram.
 *
 * The outbox exists because a money move and "tell someone" must commit
 * together. Delivery can't be transactional — Telegram is a network call — so
 * this runs after the fact, retries, and records failures.
 *
 * A FAILED DELIVERY IS DATA, NOT AN ERROR: a player who blocked the bot becomes
 * a 'failed' row, which is exactly what lets sweep_escalations tell an admin
 * "this person is unreachable" instead of the fill rotting forever.
 *
 * ADMIN AUDIENCE: an `audience='admins'` row goes to the admin GROUP if one is
 * configured (one message, inline actions), and otherwise fans out to each admin
 * individually. The group is where loaders and admins do the work — every
 * money-moving job arrives here as buttons.
 */
export class Notifier {
  private running = false;
  private timer?: NodeJS.Timeout;

  constructor(private bot: Bot<Ctx>, private pollMs = 3000) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try { await this.tick(); } catch (err) { console.error('[notify] tick failed:', err); }
      if (this.running) this.timer = setTimeout(loop, this.pollMs);
    };
    void loop();
  }
  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  async tick(): Promise<number> {
    const sql = db();
    const [cfg] = await sql<{ admin_group_chat_id: number | null }[]>`
      select admin_group_chat_id from config where id`;

    const rows = await sql<(Notification & { player_chat: number | null; admin_tg: number | null })[]>`
      select n.*, coalesce(p.chat_id, p.telegram_id) as player_chat, a.telegram_id as admin_tg
        from notifications n
        left join players p on p.id = n.player_id
        left join admins  a on a.id = n.admin_id
       where n.status = 'pending' and n.send_after <= now()
       order by n.id limit 20
         for update of n skip locked`;

    let sent = 0;
    for (const n of rows) {
      // Resolve the destination chat.
      let chatId: number | null = null;
      if (n.audience === 'admins') {
        chatId = cfg?.admin_group_chat_id ?? null;
        // No group set: fall back to fanning out to each linked admin.
        if (!chatId) { await this.fanOutToAdmins(n); continue; }
      } else {
        chatId = n.player_chat ?? n.admin_tg;
      }
      if (!chatId) { await sql`update notifications set status='skipped' where id=${n.id}`; continue; }

      const msg = renderNotification(n);
      if (!msg) { await sql`update notifications set status='skipped' where id=${n.id}`; continue; }

      await this.deliver(n, chatId, msg);
      sent++;
    }
    return sent;
  }

  private async fanOutToAdmins(n: Notification): Promise<void> {
    const sql = db();
    const admins = await sql<{ telegram_id: number }[]>`
      select telegram_id from admins where not disabled and telegram_id is not null`;
    const msg = renderNotification(n);
    if (!msg || admins.length === 0) {
      await sql`update notifications set status='skipped' where id=${n.id}`;
      return;
    }
    let ok = false;
    for (const a of admins) {
      try { await sendRendered(this.bot, a.telegram_id, msg); ok = true; } catch { /* try the rest */ }
    }
    await sql`update notifications set status=${ok ? 'sent' : 'failed'}, sent_at=now() where id=${n.id}`;
  }

  private async deliver(n: Notification, chatId: number, msg: Rendered): Promise<void> {
    const sql = db();
    try {
      await sendRendered(this.bot, chatId, msg);
      await sql`update notifications set status='sent', sent_at=now() where id=${n.id}`;
    } catch (err) {
      const description = String((err as { description?: string })?.description ?? err);
      const blocked = /blocked|deactivated|chat not found|kicked/i.test(description);
      const attempts = n.attempts + 1;
      const giveUp = blocked || attempts >= 5;
      await sql`
        update notifications
           set status = ${giveUp ? 'failed' : 'pending'}, attempts = ${attempts},
               last_error = ${description.slice(0, 500)},
               send_after = now() + make_interval(secs => ${Math.min(60 * attempts, 600)})
         where id = ${n.id}`;
      if (giveUp) console.warn(`[notify] giving up on ${n.kind} → ${chatId}: ${description}`);
    }
  }
}

interface Rendered { text: string; keyboard?: InlineKeyboard; photo?: string; photos?: string[] }

/**
 * Send a rendered notification — as a PHOTO when it carries one (so a receipt
 * image shows inline in Telegram, not just a link), otherwise as text. Shared by
 * the live notifier and the cron drain so both behave identically.
 *
 * `photo` is a Telegram file_id (preferred — instant, no re-upload) or a public
 * URL (Firebase Storage). Telegram caption max is 1024 chars, so the text is
 * clipped for the caption case.
 */
export async function sendRendered(bot: Bot<Ctx>, chatId: number, msg: Rendered): Promise<void> {
  const opts = { parse_mode: 'Markdown' as const, ...(msg.keyboard ? { reply_markup: msg.keyboard } : {}) };

  // Multiple images → ONE album (media group), so several receipts arrive as a
  // single grouped message, not one message per image. Albums can't carry an
  // inline keyboard, so the action button follows in a short message.
  if (msg.photos && msg.photos.length > 1) {
    await bot.api.sendMediaGroup(chatId, msg.photos.slice(0, 10).map((media, i) => ({
      type: 'photo' as const,
      media,
      ...(i === 0 ? { caption: msg.text.slice(0, 1024), parse_mode: 'Markdown' as const } : {}),
    })));
    if (msg.keyboard) {
      await bot.api.sendMessage(chatId, '👆 Receipts above — verify when you\'ve checked them.', { reply_markup: msg.keyboard });
    }
    return;
  }

  const single = msg.photo ?? msg.photos?.[0];
  if (single) {
    await bot.api.sendPhoto(chatId, single, { caption: msg.text.slice(0, 1024), ...opts });
  } else {
    await bot.api.sendMessage(chatId, msg.text, opts);
  }
}

export function renderNotification(n: Notification): Rendered | null {
  const p = n.payload as Record<string, any>;
  const m = (v: unknown, c?: unknown) => money(Number(v ?? 0), String(c ?? 'USD'));

  switch (n.kind) {
    // ── Player-facing ──
    // Players no longer confirm payments (admins do). Kept as a plain heads-up in
    // case any pre-change rows are still in the outbox — no dead buttons.
    case 'fill.confirm_request':
    case 'fill.receipt_payee':
      return { text: `*💰 A payment of ${m(p.amount, p.currency)} is on the way to you.* We'll confirm it and let you know.` };

    // The receipt IMAGE(S), sent to the admin group as one album. Admins are the
    // only confirmers: one tap on Verify releases the money, P2P or club-mediated.
    case 'fill.receipt_admin': {
      const imgs: string[] = (Array.isArray(p.file_ids) && p.file_ids.length ? p.file_ids
        : Array.isArray(p.urls) ? p.urls : [p.file_id || p.url]).filter(Boolean);
      const text = `*🏦 Payment to verify — receipt${imgs.length > 1 ? 's' : ''} attached*\n\n` +
        `${p.name ? 'From: *' + p.name + '*\n' : ''}` +
        `Amount: *${m(p.amount, p.currency)}* (${p.method})` +
        (p.payment_ref ? `\nReference: \`${p.payment_ref}\`` : '') +
        `\n\nCheck it landed, then release.`;
      const keyboard = new InlineKeyboard().text('✅ Verify & release', `fl:verify:${p.fill_id}`);
      return imgs.length > 1 ? { photos: imgs, text, keyboard } : { photo: imgs[0], text, keyboard };
    }
    case 'fill.released':
      return { text: `✅ *${m(p.credit, p.currency)} is on its way to your table.*` };
    case 'fill.settled':
      return { text: `✅ *${m(p.amount, p.currency)} — that part of your cash out is done.*` };
    case 'fill.confirmed_pending_hold':
      return { text: `✅ Confirmed! Their money releases after a short hold.` };
    case 'fill.lock_expired':
      return { text: `⏱ *Your payment timed out.*\n\nThe ${m(p.amount, p.currency)} went back in the queue — no proof arrived in time. If you already sent it, message us now.` };
    case 'withdraw.queued':
      return {
        text: (p.short
          ? `✅ We got *${m(p.amount, p.currency)}* off your table (that's what was there of the ${m(p.requested, p.currency)} you asked for). You're in line to be paid.`
          : `✅ *${m(p.amount, p.currency)}* is ready and you're in line to be paid.`) +
          `\n\nChanged your mind? You can cancel below while it's still waiting.`,
        keyboard: new InlineKeyboard().text('✖️ Cancel this cash out', `wd:retract:${n.ref_id}`),
      };
    case 'onboarding.resume':
      return {
        text: `✅ *Your Sportsbook account is ready!* Let's finish setting you up.`,
        keyboard: new InlineKeyboard().text('▶️ Continue setup', 'ob:resume'),
      };
    case 'withdraw.completed':
      return { text: `🎉 *Cash out complete!* ${m(p.amount, p.currency)} — all done.` };
    case 'withdraw.cancelled':
      return { text: `Your cash out was cancelled and everything's back where it was.` };
    case 'withdraw.paid':
      return { text: `💸 *You've been paid ${m(p.amount, p.currency)}!*` + (p.payment_ref ? `\nReference: \`${p.payment_ref}\`` : '') };
    case 'withdraw.nothing_available':
      return { text: `We couldn't find anything on your table to cash out right now. Nothing was taken.` };
    case 'value.added':
      return { text: `🎰 *${m(p.delta, p.currency)} added to your account!*` };
    case 'value.taken':
      return { text: `📤 *${m(-Number(p.delta), p.currency)} taken off your table.*` };
    case 'player.linked':
      return { text: `🎉 *You're all set!*\n\nYour ${p.platform} account (${p.uid}) is confirmed. Use /add to add money or /cashout to cash out.` };
    case 'player.status_changed':
      return { text: p.status === 'active' ? `✅ Your account is active again.` : `Your account is now *${p.status}*.` + (p.reason ? `\n\n${p.reason}` : '') };
    case 'dispute.resolved':
      return { text: `⚖️ *Your case is resolved.*\n\n` +
        (p.resolution === 'release_to_depositor' ? 'The payment checked out. It has been released.'
          : p.resolution === 'refund_to_payee' ? 'We couldn\'t confirm the payment, so your cash out is back in the queue.'
          : 'We split it between both sides.') + `\n\n/me for details.` };

    // ── Admin group ──
    case 'loader.work': {
      const load = Number(p.delta) > 0;
      return {
        text: `🎰 *${load ? 'ADD' : 'TAKE OFF'} ${m(Math.abs(Number(p.delta)), p.currency)}*\n` +
          `Player: *${p.player_name}*\nID: \`${p.platform_uid}\`\nClub: ${p.club}\nReason: ${p.reason}`,
        keyboard: new InlineKeyboard().text('✋ Claim', `lo:claim:${n.ref_id}`),
      };
    }
    case 'fill.confirm_request_expired':
    case 'fill.needs_review':
      return {
        text: `⏰ *Needs a look*\n${m(p.amount, p.currency)} — ref \`${p.payment_ref}\`\n_${p.cause ?? 'awaiting review'}_`,
        keyboard: new InlineKeyboard()
          .text('✅ Verify & release', `fl:verify:${n.ref_id}`)
          .text('👁 Open in panel', `noop`),
      };
    case 'fill.club_review':
      return {
        text: `🏦 *Money to verify* (${p.method})\n${m(p.amount, p.currency)} — ref \`${p.payment_ref}\`\nCheck it landed, then verify.`,
        keyboard: new InlineKeyboard().text('✅ Verify & release', `fl:verify:${n.ref_id}`),
      };
    case 'dispute.opened':
      return { text: `🚩 *Dispute*\n${m(p.amount, p.currency)} — ref \`${p.payment_ref}\`\n_${p.reason}_\n\nHandle it in the panel.` };
    case 'fill.reversed':
      return { text: `🔴 *Payment reversed after release*\n${m(p.amount, p.currency)}\n_${p.reason}_\n\nBooked as a loss; depositor paused.` };
    case 'player.registered':
      return { text: `👤 *New player* — ${p.name ?? (p.username ? '@'+p.username : p.telegram_id)}\nWaiting to add their account.` };
    case 'player.claim':
      return {
        text: `👤 *${p.name}* wants to link ${p.platform}: \`${p.uid_claimed}\`\n\n` +
          `Check the ID against the roster, then approve.`,
        keyboard: p.pp_id
          ? new InlineKeyboard().text('✅ Approve', `pl:approve:${p.pp_id}`)
          : undefined,
      };
    case 'player.needs_club':
      return { text: `📍 *${p.name}* (${p.platform} ${p.uid}) is approved but not assigned to a club yet.` };
    case 'payment.detected':
      return p.matched
        ? {
            text: `💚 *Payment received — ${p.approx ? '≈ ' : ''}${m(p.amount, p.currency)} via ${p.method}*` +
              (p.name ? `\nFrom: *${p.name}*` : '') +
              (p.ref ? `\nRef: \`${p.ref}\`` : '') +
              (p.approx ? `\n_(matched by live price — confirm the exact amount)_` : '') +
              `\n\n_Auto-detected. Check the receipt card above, then Verify & release._`,
          }
        : {
            text: `💳 *Payment received* — ${m(p.amount, p.currency)} via ${p.method}` +
              (p.ref ? `\nRef: \`${p.ref}\`` : '') +
              `\n\n_Match it to the player's receipt, then credit them._`,
          };
    case 'stripe.claim':
      return {
        photo: p.file_id || p.url,
        text: `🍎 *Card / Apple Pay receipt — from ${p.name ?? 'a player'}*\n\n` +
          `They paid on the Stripe link. Check the amount from the "Payment received" alert, then tap Credit.`,
        keyboard: new InlineKeyboard().text('💵 Credit', `st:credit:${p.claim_id}`),
      };
    case 'sportsbook.create':
      return {
        text: `🆕 *Create a Sportsbook account*\n\nFor: *${p.name}*\n` +
          `Username: \`${p.username}\`\nPassword: \`${p.password}\`\n\n` +
          `Create it on APT Sports with these exact details, then tap below — the player is told automatically.`,
        keyboard: new InlineKeyboard().text('✅ Account created', `sb:made:${p.player_id}`),
      };
    case 'withdraw.needs_payout':
      return {
        text: `💸 *Cash out to pay* (${p.method})\n\n${p.name ? 'To: *' + p.name + '*\n' : ''}` +
          `Amount: *${m(p.amount, p.currency)}*\nSend to: \`${p.handle}\`\n\n` +
          `Pay it, then tap below and send the transaction ID.`,
        keyboard: new InlineKeyboard().text('✅ I paid it', `wd:pay:${p.withdraw_id}`),
      };
    case 'loader.delivery_failed':
      return { text: `⚠️ *Couldn't add value* to ${p.player_name} (\`${p.platform_uid}\`)\n${m(p.delta, p.currency)}\n_${p.reason}_\n\nNeeds a human.` };
    default:
      return null;
  }
}
