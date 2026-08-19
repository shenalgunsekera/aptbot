import { InlineKeyboard } from 'grammy';
import {
  db, isUserError, userMessage,
  type PaymentMethod, type Platform, type WithdrawRequest,
} from '@union/core';
import type { Ctx } from '../session.js';
import { requireActive } from '../player.js';
import { money, whole, parseAmount, amountProblem, shortHandle, withdrawHandlePrompt, cashoutConfirm } from '../words.js';
import { resolvePlatform, resolveMethod, platformKeyboard, methodKeyboard } from '../prefs.js';
import { ask, clearQuestion } from '../ask.js';
import { editCardFor } from '../notifier.js';

/**
 * /withdraw — cash-out. (withdraw)
 *
 * Flow: platform → amount → method → where to get paid → queue.
 * No available-balance check anywhere: we don't know what's on the tables. The
 * player asks, a loader takes off whatever is actually there, and that is what
 * they get paid for.
 */
export async function cashoutStart(ctx: Ctx): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;

  const platform = await resolvePlatform(p.id);
  if ('ask' in platform) {
    if (platform.ask.length === 0) {
      await ctx.reply("You don't have a confirmed account on any platform yet. /start to set one up.");
      return;
    }
    ctx.session.step = { name: 'out:platform' };
    await ask(ctx, 'Where do you want to cash-out from?', {
      reply_markup: platformKeyboard('out', platform.ask, platform.offerRemember),
    });
    return;
  }
  await afterPlatform(ctx, platform.pick);
}

/** Platform chosen → if the player is in more than one club on it, ask which
 *  they're cashing out from (one club → set it silently); then on to the amount. */
async function afterPlatform(ctx: Ctx, platform: Platform): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;
  const sql = db();
  const clubs = await sql<{ id: string; name: string }[]>`
    select c.id, c.name from clubs c join player_clubs pc on pc.club_id = c.id
     where pc.player_id = ${p.id} and c.platform_id = ${platform.id} and c.enabled
     order by c.name`;
  if (clubs.length > 1) {
    ctx.session.step = { name: 'out:club', platformId: platform.id };
    const kb = new InlineKeyboard();
    for (const c of clubs) kb.text(c.name, `out:club:${c.id}`).row();
    await ask(ctx, 'Which club are you cashing out from?', { reply_markup: kb });
    return;
  }
  if (clubs.length === 1) {
    await sql`select player_set_active_club(${p.id}::uuid, ${platform.id}::uuid, ${clubs[0]!.id}::uuid)`;
  }
  await askAmount(ctx, platform);
}

export async function cashoutPickClub(ctx: Ctx, platformId: string, clubId: string): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;
  const sql = db();
  try {
    await sql`select player_set_active_club(${p.id}::uuid, ${platformId}::uuid, ${clubId}::uuid)`;
  } catch (err) {
    if (isUserError(err)) return void (await ctx.answerCallbackQuery({ text: userMessage(err), show_alert: true }));
    throw err;
  }
  const [pf] = await sql<Platform[]>`select * from platforms where id = ${platformId}`;
  await ctx.answerCallbackQuery();
  try { await ctx.editMessageReplyMarkup(); } catch { /* buttons already gone */ }
  await askAmount(ctx, pf!);
}

async function askAmount(ctx: Ctx, platform: Platform): Promise<void> {
  const sql = db();
  const [cfg] = await sql<{ min_amount: number; max_amount: number; amount_step: number }[]>`
    select min_amount, max_amount, amount_step from config where id`;
  ctx.session.step = { name: 'out:amount', platformId: platform.id };
  await ask(ctx,
    `How much do you want to cash-out from *${platform.name}*?\n\n` +
      `Between ${whole(cfg.min_amount)} and ${whole(cfg.max_amount)}, in multiples of ` +
      `${whole(cfg.amount_step)}. Send the number, like \`50\`. ` +
      `We'll take that much off your table if it's there.\n\n/stop to cancel.`,
    { parse_mode: 'Markdown' },
  );
}

export async function cashoutPickPlatform(ctx: Ctx, platformId: string, remember: boolean): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;
  const sql = db();
  if (remember) await sql`select prefs_set_platform(${p.id}::uuid, ${platformId}::uuid)`;
  const [pf] = await sql<Platform[]>`select * from platforms where id = ${platformId}`;
  await ctx.answerCallbackQuery();
  try { await ctx.editMessageReplyMarkup(); } catch { /* buttons already gone */ }
  await afterPlatform(ctx, pf!);
}

export async function cashoutAmount(ctx: Ctx, platformId: string, text: string): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;
  const amount = parseAmount(text);
  if (amount === null) {
    await ctx.reply("That doesn't look like an amount. Try `50`.", { parse_mode: 'Markdown' });
    return;
  }
  const sql0 = db();
  const [cfg0] = await sql0<{ min_amount: number; max_amount: number; amount_step: number }[]>`
    select min_amount, max_amount, amount_step from config where id`;
  const problem = amountProblem(amount, { min: cfg0.min_amount, max: cfg0.max_amount, step: cfg0.amount_step });
  if (problem) {
    await ctx.reply(problem);
    return;
  }

  // The methods the player has already saved a destination for. One → use it;
  // several → let them PICK which; none → fall through to the normal chooser.
  const saved = await sql0<{ id: string; name: string; handle: string }[]>`
    select distinct on (m.id) m.id, m.name,
           first_value(h.handle) over (partition by m.id order by h.last_used_at desc nulls last, h.created_at desc) as handle
      from payout_handles h
      join payment_methods m on m.id = h.method_id
     where h.player_id = ${p.id} and m.enabled and m.payout_enabled
     order by m.id`;
  if (saved.length === 1) {
    await cashoutHandle(ctx, platformId, amount, saved[0]!.id, saved[0]!.handle);
    return;
  }
  if (saved.length > 1) {
    ctx.session.step = { name: 'out:method', platformId, amount };
    const kb = new InlineKeyboard();
    for (const s of saved) kb.text(s.name, `out:sm:${s.id}`).row();
    await ask(ctx, `Cashing out *${whole(amount)}* — which method?`, { parse_mode: 'Markdown', reply_markup: kb });
    return;
  }

  const method = await resolveMethod(p.id);
  if ('ask' in method) {
    if (method.ask.length === 0) {
      await ctx.reply('No payment methods are available right now. Please contact us.');
      ctx.session.step = { name: 'idle' };
      return;
    }
    ctx.session.step = { name: 'out:method', platformId, amount };
    await ask(ctx, `Cashing out *${whole(amount)}* — how do you want to be paid?`, {
      parse_mode: 'Markdown',
      reply_markup: methodKeyboard('out', method.ask, method.offerRemember),
    });
    return;
  }
  await askHandle(ctx, platformId, amount, method.pick);
}

/** Player picked one of their SAVED cash-out methods → use its saved handle. */
export async function cashoutSavedMethod(ctx: Ctx, methodId: string, platformId: string, amount: number): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;
  const sql = db();
  const [h] = await sql<{ handle: string }[]>`
    select handle from payout_handles where player_id = ${p.id} and method_id = ${methodId}
     order by last_used_at desc nulls last, created_at desc limit 1`;
  await ctx.answerCallbackQuery();
  try { await ctx.editMessageReplyMarkup(); } catch { /* buttons already gone */ }
  if (!h) {
    const [m] = await sql<PaymentMethod[]>`select * from payment_methods where id = ${methodId}`;
    if (m) await askHandle(ctx, platformId, amount, m);   // no saved handle → ask for one
    return;
  }
  await cashoutHandle(ctx, platformId, amount, methodId, h.handle);
}

export async function cashoutPickMethod(
  ctx: Ctx, platformId: string, amount: number, methodId: string, remember: boolean,
): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;
  const sql = db();
  if (remember) await sql`select prefs_set_method(${p.id}::uuid, ${methodId}::uuid)`;
  const [m] = await sql<PaymentMethod[]>`select * from payment_methods where id = ${methodId}`;
  await ctx.answerCallbackQuery();
  try { await ctx.editMessageReplyMarkup(); } catch { /* buttons already gone */ }
  await askHandle(ctx, platformId, amount, m!);
}

async function askHandle(ctx: Ctx, platformId: string, amount: number, m: PaymentMethod): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;
  const sql = db();

  // Club-mediated methods (PayPal): we don't ask for a stranger's handle — the
  // club pays them. But we still record where the club should send it.
  const saved = await sql<{ id: string; handle: string; label: string | null }[]>`
    select id, handle, label from payout_handles_for(${p.id}::uuid, ${m.id}::uuid)`;

  if (saved.length) {
    const kb = new InlineKeyboard();
    for (const h of saved) kb.text(`✓ ${h.label ? h.label + ' — ' : ''}${shortHandle(h.handle)}`, `out:h:${h.id}`).row();
    kb.text('➕ Use a different one', `out:h:new`);
    ctx.session.step = { name: 'out:handle', platformId, amount, methodId: m.id };
    await ask(ctx, `Where should we send your ${m.name}? Pick one you've used, or add new.`, { reply_markup: kb });
    return;
  }

  ctx.session.step = { name: 'out:handle', platformId, amount, methodId: m.id };
  await ask(ctx,
    withdrawHandlePrompt(m.code, m.name, m.club_handle) + `\n\n_We'll remember it for next time._`,
    { parse_mode: 'Markdown' },
  );
}

export async function cashoutSavedHandle(
  ctx: Ctx, handleId: string, platformId: string, amount: number, methodId: string,
): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;

  if (handleId === 'new') {
    const sql = db();
    const [m] = await sql<PaymentMethod[]>`select * from payment_methods where id = ${methodId}`;
    await ctx.answerCallbackQuery();
    try { await ctx.editMessageReplyMarkup(); } catch { /* buttons already gone */ }
    if (m) await ask(ctx, withdrawHandlePrompt(m.code, m.name, m.club_handle), { parse_mode: 'Markdown' });
    return;
  }

  const sql = db();
  const [h] = await sql<{ handle: string }[]>`
    select handle from payout_handles where id = ${handleId}::uuid and player_id = ${p.id}`;
  if (!h) {
    await ctx.answerCallbackQuery();
    await ctx.reply('That one is gone — send your payment details instead.');
    return;
  }
  await ctx.answerCallbackQuery();
  try { await ctx.editMessageReplyMarkup(); } catch { /* buttons already gone */ }
  await cashoutHandle(ctx, platformId, amount, methodId, h.handle);
}

export async function cashoutHandle(
  ctx: Ctx, platformId: string, amount: number, methodId: string, handle: string,
): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;
  const sql = db();

  const [m] = await sql<PaymentMethod[]>`select * from payment_methods where id = ${methodId}`;
  if (m?.handle_pattern) {
    let ok = true;
    try { ok = new RegExp(m.handle_pattern).test(handle.trim()); } catch { ok = true; }
    if (!ok) {
      await ctx.reply(`That doesn't look right for ${m.name}. Send it again, or /stop.`);
      return;
    }
  }

  let w: WithdrawRequest;
  try {
    [w] = await sql<WithdrawRequest[]>`
      select * from withdraw_create(${p.id}::uuid, ${platformId}::uuid, ${methodId}::uuid, ${amount}::bigint, ${handle.trim()})`;
  } catch (err) {
    ctx.session.step = { name: 'idle' };
    if (isUserError(err)) return void (await ctx.reply(`❌ ${userMessage(err)}`));
    console.error('withdraw_create failed:', err);
    await ctx.reply('Something went wrong. Nothing was taken from your account. Try again shortly.');
    return;
  }

  ctx.session.step = { name: 'idle' };
  await clearQuestion(ctx);

  const amt = money(w.requested_amount, w.currency);
  const body = cashoutConfirm(m?.code ?? '', m?.name ?? 'payment', w.payout_handle, amt, m?.club_handle);
  await ctx.reply(
    body,
    { parse_mode: 'Markdown' },
  );
}

/** Player taps "Take some back" → ask how much to return. */
export async function cashoutReducePrompt(ctx: Ctx, withdrawId: string): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;
  const sql = db();
  const [w] = await sql<{ amount_remaining: number; currency: string; status: string }[]>`
    select amount_remaining, currency, status from withdraw_requests where id = ${withdrawId} and player_id = ${p.id}`;
  if (!w || !['queued', 'partially_filled'].includes(w.status)) {
    return void (await ctx.answerCallbackQuery({ text: "That can't be changed anymore.", show_alert: true }));
  }
  await ctx.answerCallbackQuery();
  (ctx.session as any)._reduceWd = withdrawId;
  await ctx.reply(
    `How much of this cash-out do you want *back* on your table? ` +
      `(up to ${money(w.amount_remaining - 1, w.currency)} — to take it all, use Cancel instead)\n\nJust send the number.`,
    { parse_mode: 'Markdown', reply_markup: { force_reply: true } },
  );
}

/** Player's reply with the amount to take back → lower the request. */
export async function cashoutReduceConfirm(ctx: Ctx, withdrawId: string, text: string): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;
  const amount = parseAmount(text);
  if (amount === null) return void (await ctx.reply('Send just the number, e.g. `20`.', { parse_mode: 'Markdown' }));
  try {
    await db()`select withdraw_reduce(${withdrawId}::uuid, ${amount}::bigint, null)`;
  } catch (err) {
    if (isUserError(err)) return void (await ctx.reply(`❌ ${userMessage(err)}`));
    throw err;
  }
  await ctx.reply(`✅ Done — *${money(amount)}* is coming back to your table. The rest is still on its way.`, { parse_mode: 'Markdown' });
}

/**
 * Player retracts a cash-out. Whatever hasn't been handed to someone else yet
 * comes straight back; any part already being paid stays in flight and finishes.
 * If it's already fully claimed or paid, it can't be pulled back.
 */
/** /cancelwithdraw — cancel a cash-out that hasn't been paid. One → cancel it;
 *  several → show a pick list (reuses the wd:retract buttons). */
/** How much of a cash-out can still be pulled back: the whole request before any
 *  chips come off, else only the un-matched remaining part. */
function cancellableOf(w: { status: string; requested_amount: number; amount_remaining: number }): number {
  return w.status === 'pending_unload' ? w.requested_amount : w.amount_remaining;
}

/** /cancelwithdraw — one → offer Full/Partial; several → pick which first. */
export async function cashoutCancel(ctx: Ctx): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;
  const outs = await db()<{ id: string; requested_amount: number; amount_remaining: number; currency: string; status: string }[]>`
    select id, requested_amount, amount_remaining, currency, status from withdraw_requests
     where player_id = ${p.id} and status in ('pending_unload','queued','partially_filled')
     order by created_at desc`;
  const live = outs.filter((o) => cancellableOf(o) > 0);
  if (!live.length) {
    return void (await ctx.reply("You don't have a cash-out to cancel. (Anything already being paid can't be cancelled — use /support if you need help.)"));
  }
  if (live.length === 1) return void (await offerCancelOptions(ctx, live[0]!.id));
  const kb = new InlineKeyboard();
  for (const o of live) kb.text(`${money(cancellableOf(o), o.currency)} — ${o.status === 'pending_unload' ? 'not started' : 'in queue'}`, `wc:pick:${o.id}`).row();
  await ctx.reply('Which cash-out do you want to cancel?', { reply_markup: kb });
}

async function offerCancelOptions(ctx: Ctx, withdrawId: string): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;
  const [w] = await db()<{ requested_amount: number; amount_remaining: number; currency: string; status: string }[]>`
    select requested_amount, amount_remaining, currency, status from withdraw_requests where id = ${withdrawId} and player_id = ${p.id}`;
  if (!w) return void (await ctx.reply("Can't find that cash-out."));
  const c = cancellableOf(w);
  if (c <= 0) return void (await ctx.reply('That cash-out is already being paid — nothing left to cancel.'));
  await ctx.reply(
    `Cancel this cash-out? *${money(c, w.currency)}* can be cancelled.` +
      (w.status !== 'pending_unload' ? '\n_An admin will re-load whatever you cancel back onto your table._' : ''),
    {
      parse_mode: 'Markdown',
      reply_markup: new InlineKeyboard()
        .text(`✖️ Cancel it all (${money(c, w.currency)})`, `wc:full:${withdrawId}`).row()
        .text('➖ Cancel part of it', `wc:part:${withdrawId}`),
    },
  );
}

/** wc:pick — chose which cash-out (multi case). */
export async function cashoutCancelPick(ctx: Ctx, withdrawId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  try { await ctx.editMessageReplyMarkup(); } catch { /* gone */ }
  await offerCancelOptions(ctx, withdrawId);
}

/** wc:full — cancel the whole cancellable amount. */
export async function cashoutCancelFull(ctx: Ctx, withdrawId: string): Promise<void> {
  await ctx.answerCallbackQuery();
  try { await ctx.editMessageReplyMarkup(); } catch { /* gone */ }
  await doCancel(ctx, withdrawId, Number.MAX_SAFE_INTEGER);
}

/** wc:part — ask how much to cancel. */
export async function cashoutCancelPartPrompt(ctx: Ctx, withdrawId: string): Promise<void> {
  ctx.session.step = { name: 'out:cancel_amount', withdrawId };
  await ctx.answerCallbackQuery();
  try { await ctx.editMessageReplyMarkup(); } catch { /* gone */ }
  await ctx.reply('How much do you want to cancel? Send the number, e.g. `20`.', { parse_mode: 'Markdown' });
}

export async function cashoutCancelAmount(ctx: Ctx, withdrawId: string, text: string): Promise<void> {
  const amount = parseAmount(text);
  if (amount === null || amount <= 0) return void (await ctx.reply('Send just the number, e.g. `20`.', { parse_mode: 'Markdown' }));
  ctx.session.step = { name: 'idle' };
  await doCancel(ctx, withdrawId, amount);
}

/** The heart: run the DB cancel, then update the admin card in place and tell the
 *  player what happens next (no new admin spam for the pending case). */
async function doCancel(ctx: Ctx, withdrawId: string, amount: number): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;
  const sql = db();
  let j: { scenario: string; order_id: string; full: boolean; cancelled: number; new_amount?: number };
  try {
    [{ j }] = await sql<{ j: typeof j }[]>`select withdraw_player_cancel(${withdrawId}::uuid, ${amount}::bigint, null) as j`;
  } catch (err) {
    if (isUserError(err)) return void (await ctx.reply(`❌ ${userMessage(err)}`));
    throw err;
  }

  if (j.scenario === 'pending_full') {
    await editCardFor(ctx.api, 'loader_order', j.order_id, '↩️ *Cash-out cancelled by the player* — nothing to take off.');
    return void (await ctx.reply('✅ Your cash-out was cancelled. Nothing was taken off your table.'));
  }
  if (j.scenario === 'pending_partial') {
    const [o] = await sql<{ delta: number; currency: string; player_name: string; platform_uid: string }[]>`
      select delta, currency, player_name, platform_uid from loader_orders where id = ${j.order_id}`;
    if (o) {
      await editCardFor(ctx.api, 'loader_order', j.order_id,
        `🎰 *TAKE OFF ${money(Math.abs(Number(o.delta)), o.currency)}* _(reduced by the player)_\n` +
          `Player: *${o.player_name}*\nID: \`${o.platform_uid}\``,
        new InlineKeyboard().text('✋ Claim', `lo:claim:${j.order_id}`));
    }
    return void (await ctx.reply(`✅ Reduced — we'll take off *${money(Number(j.new_amount ?? 0))}* instead. Your line stays.`, { parse_mode: 'Markdown' }));
  }
  // reload: the admin re-load card was raised automatically; player is confirmed once it's re-loaded.
  await ctx.reply(
    `✅ Cancellation requested. An admin will re-load *${money(Number(j.cancelled))}* back onto your table — ` +
      `you'll get a confirmation here the moment it's back.` + (j.full ? '' : '\n_The rest stays in your queue._'),
    { parse_mode: 'Markdown' },
  );
}

// ─── /addtowithdraw — add to an existing, queued cash-out ────────────────────
/**
 * Increase a cash-out that's already waiting in the queue, WITHOUT losing the
 * player's place in line. The extra is taken off the tables by a loader — the
 * same "TAKE OFF" card admins already work — and then escrowed onto the SAME
 * cash-out row (so created_at / queued_at, and therefore the queue spot, never
 * change). See withdraw_topup / withdraw_topup_apply (migration 0077).
 */
// A live cash-out plus how much of it is ALREADY PAID (released fills). What's
// still owed to the player is (amount - paid) — that's the number an add-on grows.
type TopupOut = { id: string; amount: number | null; paid: number; currency: string; method: string };

export async function addToWithdrawStart(ctx: Ctx): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;
  const outs = await db()<TopupOut[]>`
    select w.id, w.amount, w.currency, pm.name as method,
           coalesce((select sum(f.amount) from fills f where f.withdraw_id = w.id and f.status = 'released'), 0) as paid
      from withdraw_requests w join payment_methods pm on pm.id = w.method_id
     where w.player_id = ${p.id} and w.status in ('queued','partially_filled')
       and w.cancel_requested_at is null
     order by w.created_at desc`;
  if (!outs.length) {
    await ctx.reply(
      "You don't have a cash-out in the queue to add to. Start one with /withdraw " +
        "(you can add to it once it's waiting to be paid).",
    );
    return;
  }
  if (outs.length === 1) return void (await askTopupAmount(ctx, outs[0]!));
  const kb = new InlineKeyboard();
  for (const o of outs) {
    const total = Number(o.amount ?? 0), paid = Number(o.paid);
    const label = paid > 0
      ? `${money(total, o.currency)} via ${o.method} (${money(total - paid, o.currency)} still to pay)`
      : `${money(total, o.currency)} via ${o.method}`;
    kb.text(label, `wt:pick:${o.id}`).row();
  }
  await ctx.reply('Which cash-out do you want to add to?', { reply_markup: kb });
}

/** wt:pick — chose which cash-out to add to (multi case). */
export async function addToWithdrawPick(ctx: Ctx, withdrawId: string): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;
  const [w] = await db()<TopupOut[]>`
    select w.id, w.amount, w.currency, pm.name as method,
           coalesce((select sum(f.amount) from fills f where f.withdraw_id = w.id and f.status = 'released'), 0) as paid
      from withdraw_requests w join payment_methods pm on pm.id = w.method_id
     where w.id = ${withdrawId} and w.player_id = ${p.id}
       and w.status in ('queued','partially_filled') and w.cancel_requested_at is null`;
  await ctx.answerCallbackQuery();
  try { await ctx.editMessageReplyMarkup(); } catch { /* buttons already gone */ }
  if (!w) return void (await ctx.reply('That cash-out can no longer be added to.'));
  await askTopupAmount(ctx, w);
}

async function askTopupAmount(ctx: Ctx, w: TopupOut): Promise<void> {
  const [cfg] = await db()<{ amount_step: number }[]>`select amount_step from config where id`;
  ctx.session.step = { name: 'out:topup_amount', withdrawId: w.id };
  // Be accurate about a partially-PAID cash-out: what's already paid (released)
  // vs. what's still owed. An add-on grows the "still to pay" — so $20 left + $20
  // added = $40 still to pay.
  const total = Number(w.amount ?? 0);
  const paid = Number(w.paid);
  const toPay = total - paid;
  const state = paid > 0
    ? `You have *${money(toPay, w.currency)}* still to be paid on your ${w.method} cash-out ` +
      `(*${money(paid, w.currency)}* of the *${money(total, w.currency)}* is already paid).`
    : `Your ${w.method} cash-out is currently *${money(total, w.currency)}*, all still to be paid.`;
  await ask(ctx,
    `${state}\n\n` +
      `How much do you want to *add*? Send the number, like \`20\`, in multiples of ${whole(cfg.amount_step)} — ` +
      `it's added on top of what's still owed (so ${money(toPay, w.currency)} + $20 = ${money(toPay + 2000, w.currency)} still to pay). ` +
      `We take it off your table and add it to this same cash-out, so you keep your place in line.\n\n/stop to cancel.`,
    { parse_mode: 'Markdown' },
  );
}

export async function addToWithdrawAmount(ctx: Ctx, withdrawId: string, text: string): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;
  const amount = parseAmount(text);
  if (amount === null || amount <= 0) {
    return void (await ctx.reply("That doesn't look like an amount. Try `20`.", { parse_mode: 'Markdown' }));
  }
  const [cfg] = await db()<{ amount_step: number }[]>`select amount_step from config where id`;
  if (cfg.amount_step > 0 && amount % cfg.amount_step !== 0) {
    return void (await ctx.reply(`Please add in whole multiples of ${whole(cfg.amount_step)} — no cents.`));
  }

  try {
    // The DB does the full check (still queued, not cancelling, one add-on at a
    // time, method cap, daily cap) and raises the extra take-off card for admins.
    await db()`select withdraw_topup(${withdrawId}::uuid, ${amount}::bigint)`;
  } catch (err) {
    ctx.session.step = { name: 'idle' };
    if (isUserError(err)) return void (await ctx.reply(`❌ ${userMessage(err)}`));
    console.error('withdraw_topup failed:', err);
    await ctx.reply('Something went wrong. Nothing was taken from your account. Try again shortly.');
    return;
  }

  ctx.session.step = { name: 'idle' };
  await clearQuestion(ctx);
  await ctx.reply(
    `✅ *Got it — adding ${money(amount)} to your cash-out.*\n\n` +
      `We're taking that much more off your table now. It joins this same cash-out, so ` +
      `you *keep your place in line* — you'll just be paid the larger amount.`,
    { parse_mode: 'Markdown' },
  );
}

export async function cashoutRetract(ctx: Ctx, withdrawId: string): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;
  const sql = db();

  const [w] = await sql<{ status: string; amount: number | null; amount_remaining: number; requested_amount: number; currency: string }[]>`
    select status, amount, amount_remaining, requested_amount, currency
      from withdraw_requests where id = ${withdrawId} and player_id = ${p.id}`;
  if (!w) return void (await ctx.answerCallbackQuery({ text: "Can't find that cash-out.", show_alert: true }));
  if (['completed', 'cancelled'].includes(w.status)) {
    return void (await ctx.answerCallbackQuery({ text: `That cash-out is already ${w.status}.`, show_alert: true }));
  }

  const returned = w.status === 'pending_unload' ? (w.requested_amount) : w.amount_remaining;
  const assigned = (w.amount ?? 0) - w.amount_remaining;

  try {
    await sql`select withdraw_cancel(${withdrawId}::uuid, null, 'retracted by player')`;
  } catch (err) {
    if (isUserError(err)) return void (await ctx.answerCallbackQuery({ text: userMessage(err), show_alert: true }));
    throw err;
  }

  // If money had already come off the player's table, an admin has to re-load it.
  // (pending_unload = nothing was taken yet, so no reimbursement needed.)
  if (w.status !== 'pending_unload' && returned > 0) {
    await sql`select notify_admins('withdraw.retracted', 'withdraw_request', ${withdrawId}::uuid, ${sql.json({
      name: p.display_name, amount: returned, currency: w.currency,
    })}::jsonb)`;
  }

  await ctx.answerCallbackQuery({ text: 'Cash-out cancelled.' });
  if (w.status !== 'pending_unload' && assigned > 0) {
    await ctx.reply(
      `✅ Cancelled. We put *${money(returned, w.currency)}* back for you. ` +
        `The *${money(assigned, w.currency)}* already being paid will still complete.`,
      { parse_mode: 'Markdown' },
    );
  } else {
    await ctx.reply(`✅ Cancelled. If any amount was taken from your account, it will be reimbursed.`, { parse_mode: 'Markdown' });
  }
}
