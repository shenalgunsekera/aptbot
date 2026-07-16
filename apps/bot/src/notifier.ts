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

    const rows = await sql<(Notification & { player_tg: number | null; admin_tg: number | null })[]>`
      select n.*, p.telegram_id as player_tg, a.telegram_id as admin_tg
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
        chatId = n.player_tg ?? n.admin_tg;
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
      try {
        await this.bot.api.sendMessage(a.telegram_id, msg.text, { parse_mode: 'Markdown', ...(msg.keyboard ? { reply_markup: msg.keyboard } : {}) });
        ok = true;
      } catch { /* try the rest */ }
    }
    await sql`update notifications set status=${ok ? 'sent' : 'failed'}, sent_at=now() where id=${n.id}`;
  }

  private async deliver(n: Notification, chatId: number, msg: Rendered): Promise<void> {
    const sql = db();
    try {
      await this.bot.api.sendMessage(chatId, msg.text, { parse_mode: 'Markdown', ...(msg.keyboard ? { reply_markup: msg.keyboard } : {}) });
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

interface Rendered { text: string; keyboard?: InlineKeyboard }

export function renderNotification(n: Notification): Rendered | null {
  const p = n.payload as Record<string, any>;
  const m = (v: unknown, c?: unknown) => money(Number(v ?? 0), String(c ?? 'USD'));

  switch (n.kind) {
    // ── Player-facing ──
    case 'fill.confirm_request':
      return {
        text: `*💰 Someone says they paid you*\n\nAmount: *${m(p.amount, p.currency)}*\n` +
          `Transaction ID: \`${p.payment_ref}\`\n\nCheck your ${p.method}, then confirm below.` +
          (p.hold_until ? `\n\n🕒 Short hold on this one before it fully releases.` : ''),
        keyboard: new InlineKeyboard()
          .text('✅ Yes, I got it', `cf:yes:${n.ref_id}`)
          .text("❌ Didn't arrive", `cf:no:${n.ref_id}`),
      };
    case 'fill.released':
      return { text: `✅ *${m(p.credit, p.currency)} is on its way to your table.*` };
    case 'fill.settled':
      return { text: `✅ *${m(p.amount, p.currency)} — that part of your cash out is done.*` };
    case 'fill.confirmed_pending_hold':
      return { text: `✅ Confirmed! Their money releases after a short hold.` };
    case 'fill.lock_expired':
      return { text: `⏱ *Your payment timed out.*\n\nThe ${m(p.amount, p.currency)} went back in the queue — no proof arrived in time. If you already sent it, message us now.` };
    case 'withdraw.queued':
      return { text: p.short
        ? `✅ We got *${m(p.amount, p.currency)}* off your table (that's what was there of the ${m(p.requested, p.currency)} you asked for). You're in line to be paid.`
        : `✅ *${m(p.amount, p.currency)}* is ready and you're in line to be paid.` };
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
      return { text: `👤 *${p.name}* wants to link ${p.platform}: \`${p.uid_claimed}\`\n\nConfirm in the panel.` };
    case 'player.needs_club':
      return { text: `📍 *${p.name}* (${p.platform} ${p.uid}) is approved but not assigned to a club yet.` };
    case 'loader.delivery_failed':
      return { text: `⚠️ *Couldn't add value* to ${p.player_name} (\`${p.platform_uid}\`)\n${m(p.delta, p.currency)}\n_${p.reason}_\n\nNeeds a human.` };
    default:
      return null;
  }
}
