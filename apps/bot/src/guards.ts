import { InlineKeyboard } from 'grammy';
import type { Ctx } from './session.js';

/**
 * WHY MONEY COMMANDS ARE DM-ONLY
 * ══════════════════════════════
 *
 * Every player-facing command in this bot prints something that belongs to
 * exactly one person:
 *
 *   /club-info      → their chip stack and wallet balance
 *   /club-deposit   → ANOTHER player's payout handle (crypto address, PayPal
 *                     email) plus the exact amount to send
 *   /club-withdraw  → their own payout handle
 *   /club-confirm   → a payment reference and an amount
 *
 * In a group, `ctx.reply` puts all of that in front of everyone in the room.
 * The deposit case is the serious one: the spec's privacy rule is "reveal a
 * counterparty's handle only after a lock, only to the matched party, minimum
 * needed" — and a group reply breaks that for a withdrawer who never consented
 * to their PayPal address being published to 200 people.
 *
 * It is also a correctness problem, not only a privacy one. grammY keys sessions
 * by chat id by default, so in a group every member would share ONE conversation
 * state: two players running /club-deposit at once would clobber each other's
 * step mid-flow, and one could submit a payment reference against the other's
 * fill. (index.ts overrides the key to be per-user, which fixes the clobbering —
 * but it does not make the replies private, so this guard still stands.)
 *
 * So: groups are for discovery. Money happens in DM.
 */
export async function privateOnly(ctx: Ctx): Promise<boolean> {
  if (ctx.chat?.type === 'private') return true;

  const username = ctx.me?.username;
  const kb = username
    ? new InlineKeyboard().url('💬 Open a private chat', `https://t.me/${username}?start=from_group`)
    : undefined;

  // Reply, don't stay silent: a player typing /club-deposit into a group and
  // getting nothing back assumes the bot is broken and types it again.
  await ctx.reply(
    `🔒 That only works in a private chat with me — it would show your balance ` +
      `(and other people's payment details) to everyone here.\n\n` +
      `Tap below and send the command again.`,
    kb ? { reply_markup: kb } : {},
  );
  return false;
}

/**
 * Wraps a handler so it only runs in DM.
 *
 *   bot.command('club_info', dmOnly(clubInfo))
 */
export function dmOnly(handler: (ctx: Ctx) => Promise<void>) {
  return async (ctx: Ctx): Promise<void> => {
    if (!(await privateOnly(ctx))) return;
    await handler(ctx);
  };
}

/**
 * The group-facing surface. This is ALL the bot does in a group, and that is
 * deliberate — there is nothing else it can say in public without leaking
 * somebody's money.
 *
 * Note the hard Telegram constraint this exists to solve: **a bot cannot start
 * a conversation.** Until a player has DM'd the bot at least once, the bot is
 * physically unable to message them — which means it cannot deliver
 * `fill.confirm_request`, so every payment made to that player would sit
 * unconfirmed until sweep_escalations() dumped it on an admin. Getting players
 * to press Start in DM is not a nicety; it is what makes them reachable.
 */
export async function groupIntro(ctx: Ctx): Promise<void> {
  const username = ctx.me?.username;
  const kb = username
    ? new InlineKeyboard().url('▶️ Start here', `https://t.me/${username}?start=from_group`)
    : undefined;

  await ctx.reply(
    `🃏 *Union settlement*\n\n` +
      `Deposits and withdrawals happen in a *private chat* with me — never here, ` +
      `so nobody sees your balance or anyone's payment details.\n\n` +
      `Tap below, press *Start*, and send me your ClubGG ID.`,
    { parse_mode: 'Markdown', ...(kb ? { reply_markup: kb } : {}) },
  );
}
