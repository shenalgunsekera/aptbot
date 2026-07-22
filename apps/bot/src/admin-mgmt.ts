import { db, isUserError, userMessage } from '@union/core';
import type { Ctx } from './session.js';

/**
 * /setadmin — the owner adds an admin by tagging them and giving an email.
 *
 * Getting a Telegram user's numeric id is the tricky part: a plain @username in
 * text carries no id (bots can't resolve it). So we accept, in order:
 *   1. a REPLY to the person's message   → most reliable, use the replied user
 *   2. a text_mention entity (tap-select) → carries the user object
 *   3. an explicit numeric id in the text
 *
 * Usage (in the admin group):
 *   reply to their message with:  /setadmin their@email.com
 *   or:                           /setadmin 123456789 their@email.com
 *   or (owner too):               /setadmin their@email.com owner
 */
export async function setAdmin(ctx: Ctx): Promise<void> {
  const sql = db();

  const [owner] = await sql<{ id: string; role: string }[]>`
    select id, role from admins where telegram_id = ${ctx.from!.id} and not disabled`;
  if (!owner || owner.role !== 'owner') {
    await ctx.reply('Only the owner can add admins.');
    return;
  }

  const text = ctx.message?.text ?? '';
  const emailMatch = text.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
  const email = emailMatch?.[0];
  const wantsOwner = /\bowner\b/i.test(text.replace(email ?? '', ''));

  if (!email) {
    await ctx.reply(
      'Give me their email so they can sign in to the site:\n\n' +
        '• *Reply* to their message with `/setadmin their@email.com`\n' +
        '• or `/setadmin 123456789 their@email.com`',
      { parse_mode: 'Markdown' },
    );
    return;
  }

  // Resolve the target Telegram user.
  let targetId: number | undefined;
  let targetName: string | undefined;

  const reply = ctx.message?.reply_to_message;
  if (reply?.from && !reply.from.is_bot) {
    targetId = reply.from.id;
    targetName = [reply.from.first_name, reply.from.last_name].filter(Boolean).join(' ') || reply.from.username;
  }
  if (!targetId) {
    const mention = ctx.message?.entities?.find((e) => e.type === 'text_mention');
    if (mention && 'user' in mention && mention.user) {
      targetId = mention.user.id;
      targetName = [mention.user.first_name, mention.user.last_name].filter(Boolean).join(' ') || mention.user.username;
    }
  }
  if (!targetId) {
    const idMatch = text.replace(email, '').match(/\b(\d{5,})\b/);
    if (idMatch) targetId = Number(idMatch[1]);
  }

  if (!targetId) {
    await ctx.reply(
      "I couldn't tell who to make an admin. Easiest way: *reply* to one of their " +
        'messages with `/setadmin their@email.com`.\n\n' +
        '(A plain @username has no ID I can use — Telegram limitation. A reply, a ' +
        'tap-mention, or their numeric ID all work.)',
      { parse_mode: 'Markdown' },
    );
    return;
  }

  try {
    const [a] = await sql<{ email: string; role: string; display_name: string | null }[]>`
      select email, role, display_name from admin_upsert(
        ${targetId}::bigint, ${targetName ?? null}, ${email}, ${wantsOwner ? 'owner' : 'admin'}, ${owner.id}::uuid)`;
    await ctx.reply(
      `✅ *${a.display_name ?? 'They'}* are now ${a.role === 'owner' ? 'an owner' : 'an admin'}.\n\n` +
        `They can act in this group right away. To use the website, they sign in with ` +
        `Google using *${a.email}* — it links automatically.`,
      { parse_mode: 'Markdown' },
    );
  } catch (err) {
    if (isUserError(err)) return void (await ctx.reply(`❌ ${userMessage(err)}`));
    throw err;
  }
}

/** Approve a player from the group button. Links EVERY platform they've given an
 *  id for — not just this one claim — so a player who picked both ClubGG and
 *  Sportsbook is fully set up from a single tap. */
export async function approvePlayer(ctx: Ctx, ppId: string): Promise<void> {
  const sql = db();
  const [adm] = await sql<{ id: string }[]>`
    select id from admins where telegram_id = ${ctx.from!.id} and not disabled`;
  if (!adm) return void (await ctx.answerCallbackQuery({ text: 'Admins only.', show_alert: true }));

  const [pp] = await sql<{ player_id: string }[]>`
    select player_id from player_platforms where id = ${ppId}`;
  if (!pp) return void (await ctx.answerCallbackQuery({ text: 'That request no longer exists.', show_alert: true }));

  let linked = 0;
  try {
    [{ linked }] = await sql<{ linked: number }[]>`
      select player_link_all(${pp.player_id}::uuid, ${adm.id}::uuid) as linked`;
  } catch (err) {
    if (isUserError(err)) return void (await ctx.answerCallbackQuery({ text: userMessage(err), show_alert: true }));
    throw err;
  }
  await ctx.answerCallbackQuery({ text: linked > 0 ? 'Approved!' : 'Already approved.' });
  const what = linked > 1 ? `${linked} accounts linked` : linked === 1 ? 'account linked' : 'already linked';
  await ctx.editMessageText(
    `✅ *Approved* by ${ctx.from?.first_name ?? 'admin'} — ${what}, the player has been told.`,
    { parse_mode: 'Markdown' },
  );
}
