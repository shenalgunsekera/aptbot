import type { Ctx } from './session.js';

/**
 * Ask a question, tidying away the PREVIOUS question first so a multi-step flow
 * doesn't turn into a wall of stacked prompts. The player's own answers stay
 * (Telegram keeps their messages), and any confirmations we send with a normal
 * ctx.reply stay too — only the last outstanding question is removed.
 *
 * Works for plain prompts and inline-keyboard prompts alike; the id of whatever
 * we send becomes the new "current question", which in-place edits (multi-selects)
 * then act on.
 */
export async function ask(
  ctx: Ctx,
  text: string,
  extra?: Parameters<Ctx['reply']>[1],
): Promise<void> {
  const prev = ctx.session.lastQ;
  const sent = await ctx.reply(text, extra);
  ctx.session.lastQ = sent.message_id;
  if (prev && ctx.chat) {
    try { await ctx.api.deleteMessage(ctx.chat.id, prev); } catch { /* already gone or too old */ }
  }
}

/** Drop the pending question outright (used when a flow ends). */
export async function clearQuestion(ctx: Ctx): Promise<void> {
  const prev = ctx.session.lastQ;
  ctx.session.lastQ = undefined;
  if (prev && ctx.chat) {
    try { await ctx.api.deleteMessage(ctx.chat.id, prev); } catch { /* already gone */ }
  }
}

/** Forget the pending question WITHOUT deleting it (when it should stay). */
export function keepQuestion(ctx: Ctx): void {
  ctx.session.lastQ = undefined;
}
