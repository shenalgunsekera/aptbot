import { db, isUserError, userMessage } from '@union/core';
import type { Ctx } from '../session.js';
import { isAdminGroup } from '../guards.js';
import { money, parseAmount } from '../words.js';

/**
 * ADMIN CASH-OUT CONTROLS — for the admin acting on ONE player's cash-out.
 *
 *   /pausewithdraw   take their cash-out out of the queue so nobody else pays it
 *   /resumewithdraw  put it back at its original place in the queue
 *   /adjust +50      grow what they're owed by $50
 *   /adjust -50      record a $50 payment YOU made (with a screenshot) — reduces
 *                    the cash-out, saves the receipt to their history, completes
 *                    it if it hits $0. Works even while paused.
 *
 * WHICH PLAYER: two ways, so an admin can act wherever the player is in front of
 * them. (1) In the ADMIN GROUP, REPLY to that player's card — their cash-out
 * card, a receipt-to-verify, a loader job, or their support message — and we
 * resolve the player from the message being replied to. (2) In the player's own
 * chat / per-member group, we resolve by that chat (players.chat_id). Every
 * change runs the same audited DB function the panel uses.
 */
async function adminFor(ctx: Ctx): Promise<{ id: string } | null> {
  const tg = ctx.from?.id;
  if (!tg) return null;
  const [a] = await db()<{ id: string }[]>`
    select id from admins where telegram_id = ${tg} and not disabled`;
  return a ?? null;
}

type Target = { player: { id: string; name: string }; withdrawId: string };

/**
 * In the admin group, the player is whoever the replied-to card/message belongs
 * to. A card records its player via its ref (withdraw/deposit/fill/loader/player);
 * a support message via support_threads. Returns null when there's no reply, or
 * the reply isn't a message we can tie to a player.
 */
async function playerFromGroupReply(ctx: Ctx): Promise<{ id: string; display_name: string | null } | null> {
  const mid = ctx.message?.reply_to_message?.message_id;
  if (!mid) return null;
  const sql = db();
  const [row] = await sql<{ id: string; display_name: string | null }[]>`
    select pl.id, pl.display_name
      from players pl
     where pl.id = coalesce(
       (select st.player_id from support_threads st
         where st.group_message_id = ${mid} order by st.id desc limit 1),
       (select case n.ref_type
          when 'withdraw_request' then (select w.player_id from withdraw_requests w where w.id = n.ref_id)
          when 'deposit_request'  then (select d.player_id from deposit_requests d where d.id = n.ref_id)
          when 'fill'             then (select w.player_id from fills f
                                          join withdraw_requests w on w.id = f.withdraw_id where f.id = n.ref_id)
          when 'loader_order'     then (select lo.player_id from loader_orders lo where lo.id = n.ref_id)
          when 'player'           then n.ref_id
          else null end
        from notifications n
        where n.platform = 'telegram'
          and n.sent_message_id = ${String(mid)}
          and n.sent_chat_id = ${String(ctx.chat!.id)}
        order by n.id desc limit 1))`;
  return row ?? null;
}

/** The target player + their latest in-progress cash-out. In the admin group we
 *  resolve from the replied-to card; elsewhere from the chat this runs in. */
async function target(ctx: Ctx): Promise<Target | { error: string } | null> {
  const sql = db();
  let pl: { id: string; display_name: string | null } | undefined;
  if (await isAdminGroup(ctx)) {
    const fromReply = await playerFromGroupReply(ctx);
    if (!fromReply) {
      return { error: "Reply to the player's cash-out card (or their message) with this command, so I know who you mean." };
    }
    pl = fromReply;
  } else {
    [pl] = await sql<{ id: string; display_name: string | null }[]>`
      select id, display_name from players where chat_id = ${ctx.chat!.id}`;
    if (!pl) return { error: "No player is linked to this chat, so there's nothing to do here." };
  }
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
