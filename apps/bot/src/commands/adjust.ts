import { db, isUserError, userMessage } from '@union/core';
import type { Ctx } from '../session.js';
import { money, parseAmount } from '../words.js';
import { addStart } from './add.js';

/**
 * /add · /remove — an admin corrects a player's OPEN cash-out, right inside the
 * chat where the issue is being sorted out.
 *
 * There's no ID to type: the bot finds the player by the chat this is run in
 * (players.chat_id — the chat that player talks to us in) and adjusts their most
 * recent in-progress cash-out. Every change runs through withdraw_adjust(), so
 * it's ledger-posted, audited, and the player is told automatically.
 *
 * /add is ALSO the player-facing deposit alias, so a non-admin who types /add
 * still gets the deposit flow — the admin behaviour only kicks in for admins.
 */
async function adminFor(ctx: Ctx): Promise<{ id: string } | null> {
  const tg = ctx.from?.id;
  if (!tg) return null;
  const [a] = await db()<{ id: string }[]>`
    select id from admins where telegram_id = ${tg} and not disabled`;
  return a ?? null;
}

async function adjust(ctx: Ctx, sign: 1 | -1): Promise<void> {
  const admin = await adminFor(ctx);

  // Not an admin: preserve the old meaning of /add (deposit) in a DM; /remove
  // isn't a player command, so say nothing useful and stop.
  if (!admin) {
    if (sign > 0 && ctx.chat?.type === 'private') return void (await addStart(ctx));
    return;
  }

  const raw = typeof ctx.match === 'string' ? ctx.match : '';
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  const cents = parseAmount(parts[0] ?? '');
  const reason = parts.slice(1).join(' ') || null;
  const verb = sign > 0 ? 'add' : 'remove';
  if (cents === null || cents <= 0) {
    return void (await ctx.reply(`Usage: \`/${verb} 20 optional reason\``, { parse_mode: 'Markdown' }));
  }

  const sql = db();
  const [pl] = await sql<{ id: string; display_name: string | null }[]>`
    select id, display_name from players where chat_id = ${ctx.chat!.id}`;
  if (!pl) {
    return void (await ctx.reply("No player is linked to this chat, so there's nothing to adjust here."));
  }
  const who = pl.display_name ?? 'this player';

  const [w] = await sql<{ id: string }[]>`
    select id from withdraw_requests
     where player_id = ${pl.id} and status in ('queued', 'partially_filled', 'filled')
     order by created_at desc limit 1`;
  if (!w) {
    return void (await ctx.reply(`${who} has no cash-outs in progress — nothing to adjust.`));
  }

  try {
    const [r] = await sql<{ amount: number; amount_remaining: number; currency: string }[]>`
      select amount, amount_remaining, currency
        from withdraw_adjust(${w.id}::uuid, ${sign * cents}::bigint, ${admin.id}::uuid, ${reason})`;
    await ctx.reply(
      `✅ ${sign > 0 ? 'Added' : 'Removed'} ${money(cents, r!.currency)} ` +
        `${sign > 0 ? 'to' : 'from'} ${who}'s cash-out.\n` +
        `New total: *${money(r!.amount, r!.currency)}* ` +
        `(${money(r!.amount_remaining, r!.currency)} still to pay). The player has been told.`,
      { parse_mode: 'Markdown' },
    );
  } catch (err) {
    if (isUserError(err)) return void (await ctx.reply(`❌ ${userMessage(err)}`));
    throw err;
  }
}

export const adminAdd = (ctx: Ctx): Promise<void> => adjust(ctx, 1);
export const adminRemove = (ctx: Ctx): Promise<void> => adjust(ctx, -1);
