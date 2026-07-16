import { db } from '@union/core';
import type { Ctx } from '../session.js';
import { currentPlayer } from '../player.js';

/**
 * SUPPORT RELAY
 * ═════════════
 *
 * Keeps every conversation in the player's own chat. A player asks a question in
 * their DM; the bot forwards it to the admin group; an admin replies to it there;
 * the bot relays that reply back into the same player DM. No separate chats, and
 * players never see the admin group or each other.
 */

/** Player asked for help — capture their next message as an inquiry. */
export async function supportStart(ctx: Ctx): Promise<void> {
  const p = await currentPlayer(ctx);
  if (!p) return void (await ctx.reply('Send /start to get set up first.'));
  ctx.session.step = { name: 'idle' };
  (ctx.session as any)._support = true;
  await ctx.reply("What can we help with? Type your message and I'll pass it straight to our team — they'll reply right here.");
}

/** A player's inquiry text → into the admin group, mapped for the reply. */
export async function relayInquiryToAdmins(ctx: Ctx, text: string): Promise<void> {
  const sql = db();
  const p = await currentPlayer(ctx);
  if (!p) return;

  (ctx.session as any)._support = false;

  const [cfg] = await sql<{ admin_group_chat_id: number | null }[]>`
    select admin_group_chat_id from config where id`;

  const header = `💬 *Question from ${p.display_name ?? 'a player'}*` +
    `\n_reply to this message and I'll send it back to them_\n\n${text}`;

  if (cfg?.admin_group_chat_id) {
    try {
      const sent = await ctx.api.sendMessage(cfg.admin_group_chat_id, header, { parse_mode: 'Markdown' });
      await sql`insert into support_threads (group_message_id, player_id, player_telegram_id)
                values (${sent.message_id}, ${p.id}::uuid, ${ctx.from!.id}::bigint)`;
      await ctx.reply("✅ Sent to our team — they'll reply here shortly.");
      return;
    } catch (err) {
      console.error('[support] group send failed:', err);
    }
  }

  // No admin group set (or send failed): notify admins individually via the outbox.
  await sql`select notify_admins('support.inquiry', 'player', ${p.id}::uuid,
              ${sql.json({ name: p.display_name, telegram_id: ctx.from!.id, text })}::jsonb)`;
  await ctx.reply("✅ Got it — we'll get back to you here soon.");
}

/**
 * An admin replied in the group to a forwarded inquiry. Relay it to the player.
 * Returns true if this message was a support reply (so the caller stops here).
 */
export async function maybeRelayAdminReply(ctx: Ctx): Promise<boolean> {
  const replyTo = ctx.message?.reply_to_message?.message_id;
  const text = ctx.message?.text;
  if (!replyTo || !text) return false;

  const sql = db();
  // Only admins may reply through the bot.
  const [adm] = await sql<{ id: string }[]>`
    select id from admins where telegram_id = ${ctx.from!.id} and not disabled`;
  if (!adm) return false;

  const [thread] = await sql<{ player_telegram_id: number }[]>`
    select player_telegram_id from support_threads where group_message_id = ${replyTo}
    order by id desc limit 1`;
  if (!thread) return false;

  try {
    await ctx.api.sendMessage(thread.player_telegram_id, `💬 *Our team:*\n\n${text}`, { parse_mode: 'Markdown' });
    await ctx.reply('✅ Sent to the player.', { reply_parameters: { message_id: ctx.message!.message_id } });
  } catch (err) {
    console.error('[support] relay-back failed:', err);
    await ctx.reply("⚠️ Couldn't reach the player (they may have blocked the bot).");
  }
  return true;
}
