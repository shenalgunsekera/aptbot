import { InlineKeyboard } from 'grammy';
import { db, isUserError, userMessage } from '@union/core';
import type { Ctx } from './session.js';
import { money } from './words.js';

/**
 * ADMIN GROUP ACTIONS
 * ═══════════════════
 *
 * "everything that can be done on the website should be doable in the Telegram
 *  group, and it saves to the website too."
 *
 * Money-moving actions as inline buttons in the admin group. The person who taps
 * must be an enabled admin — checked on every tap by their telegram_id, because
 * a group is a shared space and a button is visible to everyone in it. Every
 * action calls the SAME DB function the panel does, so it is identically
 * audited and instantly reflected on the site. There is no separate "telegram
 * path" for money — just a second doorway to the one path.
 */

async function adminFor(ctx: Ctx): Promise<{ id: string; role: string } | null> {
  const tg = ctx.from?.id;
  if (!tg) return null;
  const [a] = await db()<{ id: string; role: string }[]>`
    select id, role from admins where telegram_id = ${tg} and not disabled`;
  return a ?? null;
}

/** Claim a loader job, then swap the message to show do/short/fail actions. */
export async function loaderClaim(ctx: Ctx, orderId: string): Promise<void> {
  const admin = await adminFor(ctx);
  if (!admin) return void (await ctx.answerCallbackQuery({ text: 'Admins only.', show_alert: true }));

  const sql = db();
  try {
    await sql`select loader_order_claim(${orderId}::uuid, ${admin.id}::uuid)`;
  } catch (err) {
    if (isUserError(err)) return void (await ctx.answerCallbackQuery({ text: userMessage(err), show_alert: true }));
    throw err;
  }

  const [o] = await sql<{ delta: number; currency: string; player_name: string; platform_uid: string }[]>`
    select delta, currency, player_name, platform_uid from loader_orders where id = ${orderId}`;
  const load = o.delta > 0;

  await ctx.answerCallbackQuery({ text: 'Claimed — it\'s yours.' });
  await ctx.editMessageText(
    `🎰 *${load ? 'ADD' : 'TAKE OFF'} ${money(Math.abs(o.delta), o.currency)}*\n` +
      `Player: *${o.player_name}*\nID: \`${o.platform_uid}\`\n\n_Claimed by ${ctx.from?.first_name ?? 'admin'}._ ` +
      `When done, tap the amount you actually ${load ? 'added' : 'took off'}:`,
    {
      parse_mode: 'Markdown',
      reply_markup: load
        // For a load, the amount is fixed (we owe it), so one Done button.
        ? new InlineKeyboard().text(`✅ Done — added ${money(o.delta, o.currency)}`, `lo:done:${orderId}:${o.delta}`)
                              .text('❌ Failed', `lo:fail:${orderId}`)
        // For a take-off, the loader reports what was actually there.
        : new InlineKeyboard()
            .text(`✅ All ${money(-o.delta, o.currency)}`, `lo:done:${orderId}:${o.delta}`).row()
            .text('✏️ Different amount', `lo:short:${orderId}`)
            .text('❌ Nothing there', `lo:done:${orderId}:0`),
    },
  );
}

export async function loaderDone(ctx: Ctx, orderId: string, actualDelta: number): Promise<void> {
  const admin = await adminFor(ctx);
  if (!admin) return void (await ctx.answerCallbackQuery({ text: 'Admins only.', show_alert: true }));

  const sql = db();
  try {
    await sql`select loader_order_complete(${orderId}::uuid, ${admin.id}::uuid, ${actualDelta}::bigint, 'via telegram')`;
  } catch (err) {
    if (isUserError(err)) return void (await ctx.answerCallbackQuery({ text: userMessage(err), show_alert: true }));
    throw err;
  }
  await ctx.answerCallbackQuery({ text: 'Done — saved.' });
  await ctx.editMessageText(`✅ *Done* — ${actualDelta === 0 ? 'nothing was available' : money(Math.abs(actualDelta))} · by ${ctx.from?.first_name ?? 'admin'}`, { parse_mode: 'Markdown' });
}

/** Loader taps "different amount" → we ask them to type it. */
export async function loaderShort(ctx: Ctx, orderId: string): Promise<void> {
  const admin = await adminFor(ctx);
  if (!admin) return void (await ctx.answerCallbackQuery({ text: 'Admins only.', show_alert: true }));
  // Stash the order id in session keyed to this admin, then read their next number.
  ctx.session.step = { name: 'idle' };  // group flows are stateless; use a reply prompt
  await ctx.answerCallbackQuery();
  await ctx.reply(
    `Reply to THIS message with the amount you actually took off (e.g. \`30\`), for job \`${orderId.slice(0, 8)}\`.`,
    { parse_mode: 'Markdown', reply_markup: { force_reply: true } },
  );
  // The reply is caught in index.ts by matching the force_reply prompt text.
  (ctx.session as any)._loaderShortOrder = orderId;
}

export async function loaderFail(ctx: Ctx, orderId: string): Promise<void> {
  const admin = await adminFor(ctx);
  if (!admin) return void (await ctx.answerCallbackQuery({ text: 'Admins only.', show_alert: true }));
  const sql = db();
  try {
    await sql`select loader_order_fail(${orderId}::uuid, ${admin.id}::uuid, 'marked failed via telegram')`;
  } catch (err) {
    if (isUserError(err)) return void (await ctx.answerCallbackQuery({ text: userMessage(err), show_alert: true }));
    throw err;
  }
  await ctx.answerCallbackQuery({ text: 'Marked failed.' });
  await ctx.editMessageText(`❌ *Failed* · by ${ctx.from?.first_name ?? 'admin'}`, { parse_mode: 'Markdown' });
}

/** Admin taps "I paid it" on a club-mediated cash out → ask for the tx id. */
export async function withdrawPayPrompt(ctx: Ctx, withdrawId: string): Promise<void> {
  const admin = await adminFor(ctx);
  if (!admin) return void (await ctx.answerCallbackQuery({ text: 'Admins only.', show_alert: true }));
  await ctx.answerCallbackQuery();
  (ctx.session as any)._payWithdraw = withdrawId;
  await ctx.reply(
    `Reply to THIS message with the transaction ID / reference of the payment you sent for cash out \`${withdrawId.slice(0, 8)}\`.`,
    { parse_mode: 'Markdown', reply_markup: { force_reply: true } },
  );
}

/** The admin's reply with the tx id → record the payout from float. */
export async function withdrawPayConfirm(ctx: Ctx, withdrawId: string, ref: string): Promise<void> {
  const admin = await adminFor(ctx);
  if (!admin) return;
  const sql = db();
  try {
    await sql`select withdraw_club_payout(${withdrawId}::uuid, ${admin.id}::uuid, null, ${ref.trim()}, 'paid via telegram')`;
  } catch (err) {
    if (isUserError(err)) return void (await ctx.reply(`❌ ${userMessage(err)}`));
    throw err;
  }
  await ctx.reply(`✅ Recorded as paid (ref \`${ref.trim()}\`). The player has been told.`, { parse_mode: 'Markdown' });
}

/** Admin taps "Account created" on a Sportsbook creation request → activate the
 *  account and auto-resume the player's onboarding. */
export async function sbCreated(ctx: Ctx, playerId: string): Promise<void> {
  const admin = await adminFor(ctx);
  if (!admin) return void (await ctx.answerCallbackQuery({ text: 'Admins only.', show_alert: true }));
  const sql = db();
  const [sb] = await sql<{ id: string }[]>`select id from platforms where code = 'sportsbook'`;
  if (!sb) return void (await ctx.answerCallbackQuery({ text: 'Sportsbook platform missing.', show_alert: true }));
  try {
    await sql`select sb_mark_created(${playerId}::uuid, ${sb.id}::uuid, ${admin.id}::uuid, null)`;
  } catch (err) {
    if (isUserError(err)) return void (await ctx.answerCallbackQuery({ text: userMessage(err), show_alert: true }));
    throw err;
  }
  await ctx.answerCallbackQuery({ text: 'Created — the player has been told.' });
  await ctx.editMessageText(`✅ *Sportsbook account created* · by ${ctx.from?.first_name ?? 'admin'}`, { parse_mode: 'Markdown' });
}

/** Admin taps "Credit" on a Stripe receipt → ask for the amount that was paid. */
export async function stripeCreditPrompt(ctx: Ctx, claimId: string): Promise<void> {
  const admin = await adminFor(ctx);
  if (!admin) return void (await ctx.answerCallbackQuery({ text: 'Admins only.', show_alert: true }));
  await ctx.answerCallbackQuery();
  (ctx.session as any)._stripeClaim = claimId;
  await ctx.reply(
    `Reply to THIS message with the amount that was paid (e.g. \`50\` or \`23.50\`) for Stripe receipt \`${claimId.slice(0, 8)}\`.`,
    { parse_mode: 'Markdown', reply_markup: { force_reply: true } },
  );
}

/** One-tap: credit the amount already matched from the webhook — no typing. */
export async function stripeCreditOk(ctx: Ctx, claimId: string): Promise<void> {
  const admin = await adminFor(ctx);
  if (!admin) return void (await ctx.answerCallbackQuery({ text: 'Admins only.', show_alert: true }));
  try {
    await db()`select stripe_claim_credit(${claimId}::uuid, ${admin.id}::uuid, null)`;
  } catch (err) {
    if (isUserError(err)) return void (await ctx.answerCallbackQuery({ text: userMessage(err), show_alert: true }));
    throw err;
  }
  await ctx.answerCallbackQuery({ text: 'Credited — the player has been told.' });
  await ctx.editMessageCaption({ caption: `✅ *Credited* · by ${ctx.from?.first_name ?? 'admin'}`, parse_mode: 'Markdown' }).catch(() => {});
}

/** The admin's reply with the amount → credit the player through the normal path. */
export async function stripeCreditConfirm(ctx: Ctx, claimId: string, amountText: string): Promise<void> {
  const admin = await adminFor(ctx);
  if (!admin) return;
  const n = parseFloat(amountText.trim());
  if (!Number.isFinite(n) || n <= 0) return void (await ctx.reply('Send just the amount, e.g. `50`.', { parse_mode: 'Markdown' }));
  const cents = Math.round(n * 100);
  try {
    await db()`select stripe_claim_credit(${claimId}::uuid, ${admin.id}::uuid, ${cents}::bigint)`;
  } catch (err) {
    if (isUserError(err)) return void (await ctx.reply(`❌ ${userMessage(err)}`));
    throw err;
  }
  await ctx.reply(`✅ Credited *${money(cents)}*. The player has been told and their table is being loaded.`, { parse_mode: 'Markdown' });
}

/** /p2p — admins manage the Venmo/Zelle backstop handle (the one shown to a
 *  depositor when nobody is queued), or switch to "wait for a withdrawal" mode. */
export async function p2pStatus(ctx: Ctx): Promise<void> {
  const admin = await adminFor(ctx);
  if (!admin) return void (await ctx.reply('Admins only.'));
  const sql = db();
  const methods = await sql<{ code: string; name: string; club_handle: string | null; backstop_handle: string | null }[]>`
    select code, name, club_handle, backstop_handle from payment_methods where code in ('venmo', 'zelle') order by name`;
  const kb = new InlineKeyboard();
  const lines = ['*P2P backstop*\n', 'When *on*, a depositor with no match pays your handle directly.',
    'When *off*, they\'re told to wait until someone requests a cash out.\n'];
  for (const m of methods) {
    const on = !!m.club_handle;
    lines.push(`*${m.name}*: ${on ? 'ON → `' + m.club_handle + '`' : 'OFF (wait mode)'}`);
    kb.text(`✏️ ${m.name} handle`, `p2p:set:${m.code}`);
    if (on) kb.text(`⏸ ${m.name} wait mode`, `p2p:wait:${m.code}`).row();
    else if (m.backstop_handle) kb.text(`▶️ ${m.name} on (${m.backstop_handle})`, `p2p:on:${m.code}`).row();
    else kb.row();
  }
  await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown', reply_markup: kb });
}

export async function p2pWait(ctx: Ctx, code: string): Promise<void> {
  const admin = await adminFor(ctx);
  if (!admin) return void (await ctx.answerCallbackQuery({ text: 'Admins only.', show_alert: true }));
  await db()`select p2p_set_backstop(${code}, ${''}, ${admin.id}::uuid)`;
  await ctx.answerCallbackQuery({ text: 'Now in wait mode.' });
  await ctx.editMessageText(`⏸ *${code}* is now in *wait mode* — depositors are told to wait for a cash-out request.`, { parse_mode: 'Markdown' });
}

export async function p2pOn(ctx: Ctx, code: string): Promise<void> {
  const admin = await adminFor(ctx);
  if (!admin) return void (await ctx.answerCallbackQuery({ text: 'Admins only.', show_alert: true }));
  const sql = db();
  const [m] = await sql<{ backstop_handle: string | null }[]>`select backstop_handle from payment_methods where code = ${code}`;
  if (!m?.backstop_handle) return void (await ctx.answerCallbackQuery({ text: 'No saved handle — set one first.', show_alert: true }));
  await sql`select p2p_set_backstop(${code}, ${m.backstop_handle}, ${admin.id}::uuid)`;
  await ctx.answerCallbackQuery({ text: 'Direct deposits on.' });
  await ctx.editMessageText(`▶️ *${code}* is on — depositors can pay \`${m.backstop_handle}\` directly.`, { parse_mode: 'Markdown' });
}

export async function p2pSetPrompt(ctx: Ctx, code: string): Promise<void> {
  const admin = await adminFor(ctx);
  if (!admin) return void (await ctx.answerCallbackQuery({ text: 'Admins only.', show_alert: true }));
  await ctx.answerCallbackQuery();
  (ctx.session as any)._p2pSet = code;
  await ctx.reply(`Reply to THIS message with the ${code} handle depositors should pay (e.g. \`@yourhandle\`).`,
    { parse_mode: 'Markdown', reply_markup: { force_reply: true } });
}

export async function p2pSetConfirm(ctx: Ctx, code: string, handle: string): Promise<void> {
  const admin = await adminFor(ctx);
  if (!admin) return;
  await db()`select p2p_set_backstop(${code}, ${handle.trim()}, ${admin.id}::uuid)`;
  await ctx.reply(`✅ ${code} depositors will now pay \`${handle.trim()}\` when nobody's queued.`, { parse_mode: 'Markdown' });
}

/** Verify a fill (release money) from the group. */
export async function fillVerify(ctx: Ctx, fillId: string): Promise<void> {
  const admin = await adminFor(ctx);
  if (!admin) return void (await ctx.answerCallbackQuery({ text: 'Admins only.', show_alert: true }));
  const sql = db();
  try {
    await sql`select fill_admin_verify(${fillId}::uuid, ${admin.id}::uuid, 'verified via telegram')`;
  } catch (err) {
    if (isUserError(err)) return void (await ctx.answerCallbackQuery({ text: userMessage(err), show_alert: true }));
    throw err;
  }
  await ctx.answerCallbackQuery({ text: 'Verified & released.' });
  await ctx.editMessageText(`✅ *Verified & released* · by ${ctx.from?.first_name ?? 'admin'}`, { parse_mode: 'Markdown' });
}
