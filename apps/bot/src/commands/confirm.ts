import { InlineKeyboard } from 'grammy';
import { db, isUserError, userMessage, type Fill } from '@union/core';
import type { Ctx } from '../session.js';
import { requireActive } from '../player.js';
import { money } from '../words.js';

/**
 * /confirm — the payee's side: "did the money arrive?"
 *
 * The single most consequential button a player presses. Confirming releases
 * money to the payer, so the copy is blunt about what it means.
 */
export async function confirmList(ctx: Ctx): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;

  const sql = db();
  const pending = await sql<(Fill & { method_name: string })[]>`
    select f.*, pm.name as method_name
      from fills f
      join withdraw_requests w on w.id = f.withdraw_id
      join payment_methods pm on pm.id = f.method_id
     where w.player_id = ${p.id} and f.status = 'awaiting_confirmation' and f.payee_confirmed_at is null
     order by f.submitted_at`;

  if (!pending.length) {
    await ctx.reply('Nothing waiting on you right now. 👍');
    return;
  }
  for (const f of pending) await sendConfirmCard(ctx, f, f.method_name);
}

export async function sendConfirmCard(ctx: Ctx, f: Fill, methodName: string): Promise<void> {
  const kb = new InlineKeyboard()
    .text('✅ Yes, I got it', `cf:yes:${f.id}`)
    .text("❌ Didn't arrive", `cf:no:${f.id}`);

  await ctx.reply(
    `*💰 Someone says they paid you*\n\n` +
      `Amount: *${money(f.amount, f.currency)}*\n` +
      `Method: ${methodName}\n` +
      `Sent to: \`${f.payout_handle}\`\n` +
      `Transaction ID: \`${f.payment_ref}\`\n\n` +
      `*Check your ${methodName} before you answer.*\n` +
      `Saying yes releases their money — it can't be undone.` +
      (f.hold_until
        ? `\n\n🕒 There's a short hold on this one in case the payment bounces, ` +
          `so their money releases a bit later even after you confirm.`
        : ''),
    { parse_mode: 'Markdown', reply_markup: kb },
  );
}

export async function handleConfirm(ctx: Ctx, fillId: string): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;

  const sql = db();
  try {
    await sql`select fill_confirm(${fillId}::uuid, ${p.id}::uuid)`;
  } catch (err) {
    if (isUserError(err)) return void (await ctx.answerCallbackQuery({ text: userMessage(err), show_alert: true }));
    throw err;
  }

  const [f] = await sql<Fill[]>`select * from fills where id = ${fillId}`;
  await ctx.answerCallbackQuery({ text: 'Confirmed — thank you!' });
  await ctx.editMessageText(
    f.status === 'released'
      ? `✅ *Confirmed!* ${money(f.amount, f.currency)} — all done.`
      : `✅ *Confirmed!* Their money releases after a short hold. Nothing more you need to do.`,
    { parse_mode: 'Markdown' },
  );
}

export async function handleDidntArrive(ctx: Ctx, fillId: string): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;
  ctx.session.step = { name: 'dispute:reason', fillId };
  await ctx.answerCallbackQuery();
  await ctx.reply(
    `Sorry to hear that. Let's sort it out.\n\n` +
      `Everything's paused while we look — nobody's money moves until we check.\n\n` +
      `Tell me in one message what happened: did *nothing* arrive, or was it the *wrong amount*?`,
    { parse_mode: 'Markdown' },
  );
}

export async function disputeReason(ctx: Ctx, fillId: string, reason: string): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;

  const sql = db();
  try {
    await sql`select dispute_open(${fillId}::uuid, ${reason}, ${p.id}::uuid, null, '[]'::jsonb)`;
  } catch (err) {
    ctx.session.step = { name: 'idle' };
    if (isUserError(err)) return void (await ctx.reply(`❌ ${userMessage(err)}`));
    throw err;
  }

  ctx.session.step = { name: 'idle' };
  await ctx.reply(
    `🚩 *Got it — we're on it.*\n\nEverything's paused while our team checks the payment. ` +
      `If you have a screenshot, send it now and it'll go on the case.`,
    { parse_mode: 'Markdown' },
  );
}
