import { InlineKeyboard } from 'grammy';
import { db, isUserError, userMessage } from '@union/core';
import type { Ctx } from './session.js';
import { money } from './words.js';
import { editCardFor } from './notifier.js';

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

/** Neutralise legacy-Markdown control chars (_ * ` [ ]) in an interpolated name or
 *  free-text value. Without this, a Telegram name like "APT_Support2" (underscore)
 *  breaks the message's Markdown parse, so editMessageText/Caption is rejected and
 *  the card silently fails to advance — looking "stuck" for that admin only. */
function md(s: string | null | undefined, fallback = 'admin'): string {
  const cleaned = (s ?? '').replace(/[_*`[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || fallback;
}

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
    await ctx.answerCallbackQuery({ text: 'Claimed — it\'s yours.' });
  } catch (err) {
    if (!isUserError(err)) throw err;
    // Already claimed (in the panel, or by someone else) or already done — don't
    // dead-end: tell them, then refresh the card to its real state so it stops
    // looking stuck and the claimer/owner can finish it.
    await ctx.answerCallbackQuery({ text: userMessage(err), show_alert: true });
  }
  await showLoaderStep(ctx, orderId);
}

/** Render a loader order's current step onto the card: the Done/Failed action
 *  (with who claimed it) while pending/claimed, or a done/closed summary. */
async function showLoaderStep(ctx: Ctx, orderId: string): Promise<void> {
  const sql = db();
  const [o] = await sql<{ delta: number; currency: string; player_name: string; platform_uid: string; status: string; claimer: string | null }[]>`
    select o.delta, o.currency, o.player_name, o.platform_uid, o.status, a.display_name as claimer
      from loader_orders o left join admins a on a.id = o.claimed_by where o.id = ${orderId}`;
  if (!o) return void (await editCard(ctx, '↩️ That task no longer exists.'));
  const load = o.delta > 0;
  if (o.status === 'done') return void (await editCard(ctx, `✅ *Done* — ${money(Math.abs(o.delta), o.currency)} ${load ? 'added' : 'taken off'}.`));
  if (o.status === 'cancelled' || o.status === 'failed') return void (await editCard(ctx, `⚠️ *${o.status[0]!.toUpperCase() + o.status.slice(1)}* — ${money(Math.abs(o.delta), o.currency)} ${load ? 'add' : 'take-off'}.`));

  const by = o.claimer ? `_Claimed by ${md(o.claimer)}._ ` : '';
  await editCard(ctx,
    `🎰 *${load ? 'ADD' : 'TAKE OFF'} ${money(Math.abs(o.delta), o.currency)}*\n` +
      `Player: *${md(o.player_name)}*\nID: \`${o.platform_uid}\`\n\n${by}When done, tap the amount you actually ${load ? 'added' : 'took off'}:`,
    load
      ? new InlineKeyboard().text(`✅ Done — added ${money(o.delta, o.currency)}`, `lo:done:${orderId}:${o.delta}`)
                            .text('❌ Failed', `lo:fail:${orderId}`)
      : new InlineKeyboard()
          .text(`✅ All ${money(-o.delta, o.currency)}`, `lo:done:${orderId}:${o.delta}`).row()
          .text('✏️ Different amount', `lo:short:${orderId}`)
          .text('❌ Nothing there', `lo:done:${orderId}:0`),
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
  await editCard(ctx, `✅ *Transaction completed by ${md(ctx.from?.first_name)}*` +
    (actualDelta === 0 ? ' — nothing was available' : ` — ${money(Math.abs(actualDelta))}`));
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

/** Loader taps "Failed" → ask WHY, so the player can be told the reason. */
export async function loaderFail(ctx: Ctx, orderId: string): Promise<void> {
  const admin = await adminFor(ctx);
  if (!admin) return void (await ctx.answerCallbackQuery({ text: 'Admins only.', show_alert: true }));
  await ctx.answerCallbackQuery();
  (ctx.session as any)._loaderFailOrder = orderId;
  await ctx.reply(
    `Reply to THIS message with the reason job \`${orderId.slice(0, 8)}\` failed — the player is told what you write.`,
    { parse_mode: 'Markdown', reply_markup: { force_reply: true } },
  );
}

/** The admin's typed reason → mark it failed and tell the player. */
export async function loaderFailConfirm(ctx: Ctx, orderId: string, reason: string): Promise<void> {
  const admin = await adminFor(ctx);
  if (!admin) return;
  const sql = db();
  try {
    await sql`select loader_order_fail(${orderId}::uuid, ${admin.id}::uuid, ${reason.trim()})`;
  } catch (err) {
    if (isUserError(err)) return void (await ctx.reply(`❌ ${userMessage(err)}`));
    throw err;
  }
  await editCardFor(ctx.api, 'loader_order', orderId,
    `❌ *Failed* · by ${md(ctx.from?.first_name)}\n_${md(reason.trim(), '')}_`);
  await ctx.reply('❌ Marked failed — the player was told the reason.');
}

/** Admin taps "I paid it" on a cash-out → ask for a screenshot of the receipt. */
export async function withdrawPayPrompt(ctx: Ctx, withdrawId: string): Promise<void> {
  const admin = await adminFor(ctx);
  if (!admin) return void (await ctx.answerCallbackQuery({ text: 'Admins only.', show_alert: true }));
  await ctx.answerCallbackQuery();
  (ctx.session as any)._payWithdraw = withdrawId;
  await ctx.reply(
    `Reply to THIS message with a *screenshot* of the payment you sent for cash-out \`${withdrawId.slice(0, 8)}\` — the player gets it as their receipt.\n\n_No screenshot? You can reply with the transaction ID instead._`,
    { parse_mode: 'Markdown', reply_markup: { force_reply: true } },
  );
}

/** The admin's reply → record the payout from float. `image` is a photo file_id
 *  (preferred, forwarded to the player as their receipt); otherwise a text ref. */
export async function withdrawPayConfirm(
  ctx: Ctx, withdrawId: string, value: string, image: boolean,
): Promise<void> {
  const admin = await adminFor(ctx);
  if (!admin) return;
  const sql = db();
  try {
    await sql`select withdraw_club_payout(${withdrawId}::uuid, ${admin.id}::uuid, null,
                                          ${image ? null : value.trim()}, 'paid via telegram',
                                          ${image ? value : null})`;
  } catch (err) {
    if (isUserError(err)) return void (await ctx.reply(`❌ ${userMessage(err)}`));
    throw err;
  }
  await ctx.reply(
    image
      ? '✅ Recorded as paid — the receipt was sent to the player.'
      : `✅ Recorded as paid (ref \`${value.trim()}\`). The player has been told.`,
    { parse_mode: 'Markdown' },
  );
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
  await ctx.editMessageText(`✅ *Sportsbook account created* · by ${md(ctx.from?.first_name)}`, { parse_mode: 'Markdown' });
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
  await ctx.editMessageCaption({ caption: `✅ *Credited* · by ${md(ctx.from?.first_name)}`, parse_mode: 'Markdown' }).catch(() => {});
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
    'When *off*, they\'re told to wait until someone requests a cash-out.\n'];
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
/** Update the card IN PLACE — works whether it's a photo (receipt) card, whose
 *  text lives in the caption, or a plain text card. */
async function editCard(ctx: Ctx, text: string, kb?: InlineKeyboard): Promise<void> {
  const opts = { parse_mode: 'Markdown' as const, ...(kb ? { reply_markup: kb } : {}) };
  try { await ctx.editMessageCaption({ caption: text, ...opts }); }
  catch { try { await ctx.editMessageText(text, opts); } catch { /* gone or unchanged */ } }
}

/**
 * ✅ Verify — the whole thing in ONE message. Verifies & releases the payment
 * (the player is told their money is on its way), then immediately CLAIMS the
 * loader task the release created — locking it to this admin — and turns the
 * same card into the Done/Failed step. No separate "claim" message.
 */
export async function fillVerify(ctx: Ctx, fillId: string): Promise<void> {
  const admin = await adminFor(ctx);
  if (!admin) return void (await ctx.answerCallbackQuery({ text: 'Admins only.', show_alert: true }));
  const sql = db();
  try {
    await sql`select fill_admin_verify(${fillId}::uuid, ${admin.id}::uuid, 'verified via telegram')`;
    await ctx.answerCallbackQuery({ text: 'Verified — money on its way.' });
  } catch (err) {
    if (!isUserError(err)) throw err;
    // Already released/handled — verified in the panel, by another admin, or this
    // card went stale. Don't dead-end: tell them, then refresh the card to the
    // step it's actually at (the loader task) so it stops looking stuck.
    await ctx.answerCallbackQuery({ text: userMessage(err), show_alert: true });
  }
  await advanceToLoaderStep(ctx, admin.id, fillId);
}

/** Turn the verify card into the loader "ADD to table" step (or a done/closed
 *  summary). Safe to call whether we just released the fill or found it already
 *  released — it reflects the loader order's real state and self-heals a stale card. */
async function advanceToLoaderStep(ctx: Ctx, adminId: string, fillId: string): Promise<void> {
  const sql = db();
  const who = md(ctx.from?.first_name);
  const [o] = await sql<{ id: string; delta: number; currency: string; player_name: string; platform_uid: string; status: string }[]>`
    select id, delta, currency, player_name, platform_uid, status from loader_orders
     where ref_type = 'fill' and ref_id = ${fillId} order by created_at desc limit 1`;
  if (!o) return void (await editCard(ctx, `✅ *Verified & released* · by ${who}`));
  if (o.status === 'done') return void (await editCard(ctx, `✅ *Verified & loaded* — ${money(o.delta, o.currency)} added to their table.`));
  if (o.status === 'cancelled' || o.status === 'failed') return void (await editCard(ctx, `✅ *Verified* — loading was ${o.status}.`));

  // Lock the loader task to this admin (mutex, idempotent), and suppress the
  // standalone loader card — this same message now IS the loader step.
  try { await sql`select loader_order_claim(${o.id}::uuid, ${adminId}::uuid)`; } catch { /* raced; fine */ }
  await sql`update notifications set status='skipped'
             where kind='loader.work' and ref_type='loader_order' and ref_id=${o.id} and status='pending'`;
  await editCard(ctx,
    `🎰 *ADD ${money(o.delta, o.currency)}* to their table\n` +
      `Player: *${md(o.player_name)}*\nID: \`${o.platform_uid}\`\n\n_Claimed by ${who}._ Add it on the platform, then:`,
    new InlineKeyboard()
      .text(`✅ Done — added ${money(o.delta, o.currency)}`, `lo:done:${o.id}:${o.delta}`)
      .text('❌ Failed', `lo:fail:${o.id}`),
  );
}

/** 🗑 Discard — the payment didn't land. Silent reject: no credit, no message to
 *  the player; the payee's slice goes back to the queue. */
export async function fillDiscard(ctx: Ctx, fillId: string): Promise<void> {
  const admin = await adminFor(ctx);
  if (!admin) return void (await ctx.answerCallbackQuery({ text: 'Admins only.', show_alert: true }));
  try {
    await db()`select fill_admin_discard(${fillId}::uuid, ${admin.id}::uuid)`;
  } catch (err) {
    if (isUserError(err)) return void (await ctx.answerCallbackQuery({ text: userMessage(err), show_alert: true }));
    throw err;
  }
  await ctx.answerCallbackQuery({ text: 'Payment discarded.' });
  await editCard(ctx, `🗑 *Payment discarded* · by ${md(ctx.from?.first_name)}`);
}
