import { db, isUserError, userMessage, uploadReceipt, storageConfigured } from '@union/core';
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
 * The player named by the message being REPLIED TO — resolved three ways, in order:
 *   1. the author of that message (a player who posted, by their telegram_id),
 *   2. a support message tied to a player (support_threads),
 *   3. a bot card tied to a player via its ref (withdraw/deposit/fill/loader/player).
 * So an admin can reply to the person's own message OR their card. Returns null when
 * there's no reply, or the reply can't be tied to a player.
 */
async function playerFromReply(ctx: Ctx): Promise<{ id: string; display_name: string | null } | null> {
  const reply = ctx.message?.reply_to_message;
  if (!reply) return null;
  const mid = reply.message_id;
  const authorTg = reply.from?.id ?? null;   // who SENT the replied-to message
  const sql = db();
  const [row] = await sql<{ id: string; display_name: string | null }[]>`
    select pl.id, pl.display_name
      from players pl
     where pl.id = coalesce(
       (select p2.id from players p2
         where ${authorTg}::bigint is not null and p2.telegram_id = ${authorTg}::bigint limit 1),
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

/** The target player + their latest in-progress cash-out. A REPLY always wins —
 *  the admin explicitly pointed at someone — so it works in the admin group, a
 *  per-member group, or a shared one. With no reply, fall back to the chat's own
 *  player (a DM / per-member group), or ask for a reply in the admin group. */
async function target(ctx: Ctx): Promise<Target | { error: string } | null> {
  const sql = db();
  let pl: { id: string; display_name: string | null } | undefined;
  const fromReply = await playerFromReply(ctx);
  if (fromReply) {
    pl = fromReply;
  } else if (await isAdminGroup(ctx)) {
    return { error: "Reply to the player's message (or their cash-out card) with this command, so I know who you mean." };
  } else {
    [pl] = await sql<{ id: string; display_name: string | null }[]>`
      select id, display_name from players where chat_id = ${ctx.chat!.id}`;
    if (!pl) return { error: "Reply to the player's message so I know who you mean — no player is linked to this chat." };
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

/**
 * /reversepayment — a payment we ALREADY sent turned out fake. Un-sends it: the
 * amount goes back onto what the player is owed (numerator down, total unchanged),
 * re-opening the cash-out even if this was the final payment. The club absorbs it.
 * Targets the player's most recent released payment (on any cash-out, incl. one
 * that this fake payment just completed — so target()'s in-progress filter is not
 * enough here; we resolve the player, then find the sent fill directly).
 */
export async function reversePayment(ctx: Ctx): Promise<void> {
  const admin = await adminFor(ctx);
  if (!admin) return;
  const sql = db();
  let pl: { id: string; display_name: string | null } | undefined;
  const fromReply = await playerFromReply(ctx);
  if (fromReply) pl = fromReply;
  else if (await isAdminGroup(ctx)) return void (await ctx.reply("Reply to the player's message (or their card) with this command, so I know who you mean."));
  else {
    [pl] = await sql<{ id: string; display_name: string | null }[]>`select id, display_name from players where chat_id = ${ctx.chat!.id}`;
    if (!pl) return void (await ctx.reply("Reply to the player's message so I know who you mean — no player is linked to this chat."));
  }
  const [f] = await sql<{ id: string; amount: number }[]>`
    select f.id, f.amount from fills f join withdraw_requests w on w.id = f.withdraw_id
     where w.player_id = ${pl.id} and f.status = 'released'
     order by f.released_at desc nulls last, f.created_at desc limit 1`;
  if (!f) return void (await ctx.reply(`${pl.display_name ?? 'This player'} has no sent payment to reverse.`));
  try {
    await sql`select fill_reverse(${f.id}::uuid, ${admin.id}::uuid, 'admin reversal')`;
  } catch (err) { if (isUserError(err)) return void (await ctx.reply(`❌ ${userMessage(err)}`)); throw err; }
  const [w] = await sql<{ amount: number; amount_remaining: number }[]>`
    select w.amount, w.amount_remaining from withdraw_requests w join fills f on f.withdraw_id = w.id where f.id = ${f.id}`;
  await ctx.reply(`↩️ Reversed the *${money(f.amount)}* payment to ${pl.display_name ?? 'this player'} — it's back on their cash-out (now ${money(w.amount_remaining)}/${money(w.amount)} to be sent). The club absorbed it and they've been told.`, { parse_mode: 'Markdown' });
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

async function recordPayment(ctx: Ctx, withdrawId: string, amount: number, receiptFileId: string, adminId: string, who: string): Promise<void> {
  // Upload the screenshot to Firebase so the receipt has a permanent, clickable
  // https url in the player's history — a bare Telegram file_id can't be a link.
  // Falls back to the file_id if storage isn't configured (still shows as an image).
  const receipt = await toReceiptUrl(ctx, receiptFileId, withdrawId);
  try {
    await db()`select withdraw_club_payout(${withdrawId}::uuid, ${adminId}::uuid, ${amount}::bigint, null, 'paid via /adjust', ${receipt})`;
  } catch (err) { if (isUserError(err)) return void (await ctx.reply(`❌ ${userMessage(err)}`)); throw err; }
  await ctx.reply(`✅ Recorded *${money(amount)}* paid to ${who} — the receipt was sent to them and their cash-out reduced.`, { parse_mode: 'Markdown' });
}

/** A Telegram file_id → a permanent Firebase https url (clickable in /withdrawalhistory).
 *  Best-effort: on any failure keep the file_id, which still renders as an image. */
export async function toReceiptUrl(ctx: Ctx, fileId: string, refId: string): Promise<string> {
  if (!storageConfigured()) return fileId;
  try {
    const file = await ctx.api.getFile(fileId);
    const res = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const stored = await uploadReceipt(bytes, 'image/jpeg', 'fill', refId);
    return stored.url;
  } catch (err) {
    console.error('[adjust] receipt upload failed, keeping file_id:', err);
    return fileId;
  }
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
