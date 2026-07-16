import { db, type Player } from '@union/core';
import type { Ctx } from './session.js';

export async function currentPlayer(ctx: Ctx): Promise<Player | null> {
  const tgId = ctx.from?.id;
  if (!tgId) return null;
  const sql = db();
  const [p] = await sql<Player[]>`select * from players where telegram_id = ${tgId}`;
  return p ?? null;
}

/**
 * Gate for anything that moves money. Returns the player only if active;
 * otherwise replies in plain language and returns null.
 */
export async function requireActive(ctx: Ctx): Promise<Player | null> {
  const p = await currentPlayer(ctx);

  if (!p) {
    await ctx.reply('Send /start to get set up first.');
    return null;
  }

  switch (p.status) {
    case 'active':
      return p;
    case 'pending':
      await ctx.reply(
        "You're almost ready — we just need someone to confirm your account. " +
          "You'll get a message here the moment that's done.",
      );
      return null;
    case 'frozen':
      await ctx.reply(
        "Your account is on hold while we take a look at something. Your money is safe. " +
          "Someone will be in touch.",
      );
      return null;
    case 'banned':
      await ctx.reply('This account has been closed. Reach out if you think that’s a mistake.');
      return null;
  }
}
