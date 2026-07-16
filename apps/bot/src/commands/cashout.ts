import { InlineKeyboard } from 'grammy';
import {
  db, isUserError, userMessage,
  type PaymentMethod, type Platform, type WithdrawRequest,
} from '@union/core';
import type { Ctx } from '../session.js';
import { requireActive } from '../player.js';
import { money, parseAmount, shortHandle } from '../words.js';
import { resolvePlatform, resolveMethod, platformKeyboard, methodKeyboard } from '../prefs.js';

/**
 * /cashout — cash out. (withdraw)
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
    await ctx.reply('Where do you want to cash out from?', {
      reply_markup: platformKeyboard('out', platform.ask, platform.offerRemember),
    });
    return;
  }
  await askAmount(ctx, platform.pick);
}

async function askAmount(ctx: Ctx, platform: Platform): Promise<void> {
  ctx.session.step = { name: 'out:amount', platformId: platform.id };
  await ctx.reply(
    `How much do you want to cash out from *${platform.name}*?\n\n` +
      `Send the number, like \`50\`. We'll take that much off your table if it's there.\n\n/cancel to stop.`,
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
  await askAmount(ctx, pf!);
}

export async function cashoutAmount(ctx: Ctx, platformId: string, text: string): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;
  const amount = parseAmount(text);
  if (amount === null) {
    await ctx.reply("That doesn't look like an amount. Try `50`.", { parse_mode: 'Markdown' });
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
    await ctx.reply(`Cashing out *${money(amount)}* — how do you want to be paid?`, {
      parse_mode: 'Markdown',
      reply_markup: methodKeyboard('out', method.ask, method.offerRemember),
    });
    return;
  }
  await askHandle(ctx, platformId, amount, method.pick);
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
    await ctx.reply(`Where should we send your ${m.name}? Pick one you've used, or add new.`, { reply_markup: kb });
    return;
  }

  ctx.session.step = { name: 'out:handle', platformId, amount, methodId: m.id };
  await ctx.reply(
    `Where should we send your money?\n\nSend ${m.handle_hint ?? `your ${m.name} details`}.\n\n` +
      `⚠️ Double-check it — money sent to the wrong place can't come back. I'll remember it for next time.`,
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
    await ctx.reply(`Send ${m?.handle_hint ?? 'your payment details'}.\n\n⚠️ Money sent to the wrong place can't come back.`);
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
      await ctx.reply(`That doesn't look right for ${m.name}. Send it again, or /cancel.`);
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
  await ctx.reply(
    `✅ *Cash out started!*\n\nWe're getting *${money(w.requested_amount, w.currency)}* ready to send to \`${w.payout_handle}\`.\n\n` +
      `We'll take that off your table and then pay you — you'll get a message here at each step. ` +
      `Sometimes it comes in a few pieces from different people; that's normal, and we track every part.`,
    { parse_mode: 'Markdown' },
  );
}
