import { db, isUserError, userMessage } from '@union/core';
import type { Ctx } from '../session.js';
import { money, parseAmount } from '../words.js';

/**
 * ADMIN CASH-OUT CONTROLS — run inside the chat the player talks to us in.
 *
 *   /pausewithdraw   take their cash-out out of the queue so nobody else pays it
 *   /resumewithdraw  put it back at its original place in the queue
 *   /adjust +50      grow what they're owed by $50
 *   /adjust -50      record a $50 payment YOU made (with a screenshot) — reduces
 *                    the cash-out, saves the receipt to their history, completes
 *                    it if it hits $0. Works even while paused.
 *
 * The player is found by the chat this is run in (players.chat_id). Every change
 * runs the same audited DB function the panel uses.
 */
async function adminFor(ctx: Ctx): Promise<{ id: string } | null> {
  const tg = ctx.from?.id;
  if (!tg) return null;
  const [a] = await db()<{ id: string }[]>`
    select id from admins where telegram_id = ${tg} and not disabled`;
  return a ?? null;
}

type Target = { player: { id: string; name: string }; withdrawId: string };

/** The player whose chat this is + their latest in-progress cash-out (or a msg). */
async function target(ctx: Ctx): Promise<Target | { error: string } | null> {
  const sql = db();
  const [pl] = await sql<{ id: string; display_name: string | null }[]>`
    select id, display_name from players where chat_id = ${ctx.chat!.id}`;
  if (!pl) return { error: "No player is linked to this chat, so there's nothing to do here." };
  const [w] = await sql<{ id: string }[]>`
    select id from withdraw_requests
     where player_id = ${pl.id} and status in ('queued', 'partially_filled', 'filled')
     order by created_at desc limit 1`;
  if (!w) return { error: `${pl.display_name ?? 'This player'} has no cash-out in progress.` };
  return { player: { id: pl.id, name: pl.display_name ?? 'this player' }, withdrawId: w.id };
}

export async function pauseWithdraw(ctx: Ctx): Promise<void> {
  const admin = await adminFor(ctx);
  if (!admin) return;
  const r = await target(ctx);
  if (!r) return;
  if ('error' in r) return void (await ctx.reply(r.error));
  try {
    await db()`select withdraw_pause(${r.withdrawId}::uuid, ${admin.id}::uuid)`;
  } catch (err) { if (isUserError(err)) return void (await ctx.reply(`❌ ${userMessage(err)}`)); throw err; }
  await ctx.reply(`⏸ Paused ${r.player.name}'s cash-out — it's out of the queue, so no one else will pay it. Adjust or pay it, then /resumewithdraw when you're done.`);
}

export async function resumeWithdraw(ctx: Ctx): Promise<void> {
  const admin = await adminFor(ctx);
  if (!admin) return;
  const r = await target(ctx);
  if (!r) return;
  if ('error' in r) return void (await ctx.reply(r.error));
  try {
    await db()`select withdraw_resume(${r.withdrawId}::uuid, ${admin.id}::uuid)`;
  } catch (err) { if (isUserError(err)) return void (await ctx.reply(`❌ ${userMessage(err)}`)); throw err; }
  await ctx.reply(`▶️ Resumed ${r.player.name}'s cash-out — it's back in the queue at its original place.`);
}

/** "+50" / "-50" / "50" → signed cents (default +). */
function parseSigned(raw: string): number | null {
  const s = raw.trim();
  const sign = s.startsWith('-') ? -1 : 1;
  const cents = parseAmount(s.replace(/^[+-]/, ''));
  if (cents === null || cents <= 0) return null;
  return sign * cents;
}

/** /adjust +X grows the cash-out; /adjust -X records a payment you made (needs a
 *  receipt — attached to this message, or sent as the next reply). */
export async function adjustCommand(ctx: Ctx, argsRaw: string, receiptFileId?: string): Promise<void> {
  const admin = await adminFor(ctx);
  if (!admin) return;
  const signed = parseSigned(argsRaw);
  if (signed === null) {
    return void (await ctx.reply(
      'Usage: `/adjust +50` to add to their cash-out, or `/adjust -50` (with a payment screenshot) to record a payment you made.',
      { parse_mode: 'Markdown' }));
  }
  const r = await target(ctx);
  if (!r) return;
  if ('error' in r) return void (await ctx.reply(r.error));

  if (signed > 0) {
    try {
      const [row] = await db()<{ amount: number; amount_remaining: number; currency: string }[]>`
        select amount, amount_remaining, currency
          from withdraw_adjust(${r.withdrawId}::uuid, ${signed}::bigint, ${admin.id}::uuid, 'admin /adjust')`;
      await ctx.reply(
        `✅ Added *${money(signed, row!.currency)}* to ${r.player.name}'s cash-out — now *${money(row!.amount, row!.currency)}* ` +
          `(*${money(row!.amount_remaining, row!.currency)}* still to pay). The player was told.`,
        { parse_mode: 'Markdown' });
    } catch (err) { if (isUserError(err)) return void (await ctx.reply(`❌ ${userMessage(err)}`)); throw err; }
    return;
  }

  // -X: record a payment you made. Needs a receipt image.
  const amt = -signed;
  if (!receiptFileId) {
    (ctx.session as unknown as { _adjustPay?: { withdrawId: string; amount: number } })._adjustPay = { withdrawId: r.withdrawId, amount: amt };
    return void (await ctx.reply(
      `Reply to THIS message with a *screenshot* of the ${money(amt)} payment you sent — it's saved as ${r.player.name}'s receipt.`,
      { parse_mode: 'Markdown', reply_markup: { force_reply: true } }));
  }
  await recordPayment(ctx, r.withdrawId, amt, receiptFileId, admin.id, r.player.name);
}

async function recordPayment(ctx: Ctx, withdrawId: string, amount: number, receipt: string, adminId: string, who: string): Promise<void> {
  try {
    await db()`select withdraw_club_payout(${withdrawId}::uuid, ${adminId}::uuid, ${amount}::bigint, null, 'paid via /adjust', ${receipt})`;
  } catch (err) { if (isUserError(err)) return void (await ctx.reply(`❌ ${userMessage(err)}`)); throw err; }
  await ctx.reply(`✅ Recorded *${money(amount)}* paid to ${who} — the receipt was sent to them and their cash-out reduced.`, { parse_mode: 'Markdown' });
}

/** The admin's screenshot reply after a text `/adjust -X`. */
export async function adjustPayReply(ctx: Ctx, receiptFileId: string): Promise<void> {
  const admin = await adminFor(ctx);
  const s = ctx.session as unknown as { _adjustPay?: { withdrawId: string; amount: number } };
  const pend = s._adjustPay;
  if (!admin || !pend) return;
  s._adjustPay = undefined;
  await recordPayment(ctx, pend.withdrawId, pend.amount, receiptFileId, admin.id, 'the player');
}
