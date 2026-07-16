import { db } from '@union/core';
import type { Ctx } from './session.js';

/**
 * WHERE PLAYER FLOWS RUN
 * ══════════════════════
 *
 * The model: each member has their own chat with the bot — a DM, or a private
 * per-member group the admins set up so they can help. The bot runs the whole
 * flow IN THAT CHAT, wherever /start was used, and never bounces the player to a
 * separate chat.
 *
 * The one exception is the ADMIN GROUP (set via /setadmingroup). That chat is
 * for admin work — jobs, verifications, alerts — so player flows are not run
 * there.
 *
 * ⚠️ PRIVACY: because a flow now runs in whatever chat it's used, sensitive
 * details (a payout handle, an amount) appear in that chat. That is fine for a
 * DM or a private per-member group — the intended use — but a member should not
 * run these in a shared/public group. That is the member's chat to keep private.
 *
 * ⚠️ TELEGRAM: for the bot to read a member's typed replies (name, amount,
 * transaction id) inside a GROUP, the bot's Group Privacy must be OFF in
 * BotFather. In a DM it always works. In a group with privacy ON, the bot only
 * receives slash-commands, not the free-text answers the flow needs.
 */

// admin_group_chat_id changes rarely; cache it briefly to avoid a query per msg.
let _adminGroupId: number | null | undefined;
let _fetchedAt = 0;

async function adminGroupId(): Promise<number | null> {
  if (_adminGroupId !== undefined && Date.now() - _fetchedAt < 30_000) {
    return _adminGroupId ?? null;
  }
  const [c] = await db()<{ admin_group_chat_id: number | null }[]>`
    select admin_group_chat_id from config where id`;
  _adminGroupId = c?.admin_group_chat_id ?? null;
  _fetchedAt = Date.now();
  return _adminGroupId;
}

/** True only for the one designated admin group. */
export async function isAdminGroup(ctx: Ctx): Promise<boolean> {
  if (ctx.chat?.type === 'private') return false;
  const gid = await adminGroupId();
  return gid !== null && ctx.chat?.id === gid;
}

/**
 * Wraps a player-facing handler so it runs anywhere EXCEPT the admin group.
 * DMs and per-member groups both work; the admin group stays silent to players.
 */
export function playerOnly(handler: (ctx: Ctx) => Promise<void>) {
  return async (ctx: Ctx): Promise<void> => {
    if (await isAdminGroup(ctx)) return;
    await handler(ctx);
  };
}

// Kept for compatibility with any remaining callers — now an alias, since a
// player flow may run in a group too.
export const dmOnly = playerOnly;
