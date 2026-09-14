import { InlineKeyboard } from 'grammy';
import { db, isUserError, userMessage, type Platform, type WithdrawRequest } from '@union/core';
import type { Ctx } from '../session.js';
import { requireActive } from '../player.js';
import { money, whole, parseAmount, amountProblem, shortHandle } from '../words.js';
import { resolvePlatform } from '../prefs.js';
import { ask, clearQuestion } from '../ask.js';

/**
 * /withdraw2 — a SPLIT cash-out across two payout methods (e.g. Venmo + Zelle).
 *
 * One cash-out for the total, taken off the table once, then fillable by EITHER
 * method's depositors against one shared pool: whoever pays first fills the next
 * slice, up to the total, and the total can never be overpaid. See migration
 * 0113 (withdraw_create_split / deposit_match). The bot side only gathers the two
 * methods + saved handles and the amount; the DB does all the money logic.
 *
 * Flow: (gate) → platform → pick two methods (auto if exactly two) → amount.
 */

interface Eligible { id: string; name: string; code: string; handle: string }

/** Split-eligible payout methods the player has a SAVED handle for. That saved
 *  handle is what a split pays to, so "eligible" means genuinely ready to use. */
async function eligibleMethods(playerId: string): Promise<Eligible[]> {
  return db()<Eligible[]>`
    select distinct on (m.id) m.id, m.name, m.code,
           first_value(h.handle) over (partition by m.id
             order by h.last_used_at desc nulls last, h.created_at desc) as handle
      from payout_handles h
      join payment_methods m on m.id = h.method_id
     where h.player_id = ${playerId}
       and m.enabled and m.payout_enabled and m.split_eligible
     order by m.id`;
}

const NEED_TWO =
  "🔀 */withdraw2* pays a single cash-out across *two* methods (like Venmo and Zelle) — " +
  "whoever pays you first fills it, up to the total.\n\n" +
  "You need *two* of those set up with a saved payout handle. Add one with /editwithdraw, then try again.";

export async function withdraw2Start(ctx: Ctx): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;
  const sql = db();

  const [cfg] = await sql<{ on: boolean }[]>`select split_cashout_enabled as on from config where id`;
  if (!cfg?.on) {
    await ctx.reply("Split cash-outs aren't available right now. Use /withdraw instead.");
    return;
  }

  const elig = await eligibleMethods(p.id);
  if (elig.length < 2) {
    await ctx.reply(NEED_TWO, { parse_mode: 'Markdown' });
    return;
  }

  const platform = await resolvePlatform(p.id);
  if ('ask' in platform) {
    if (platform.ask.length === 0) {
      await ctx.reply("You don't have a confirmed account on any platform yet. /start to set one up.");
      return;
    }
    ctx.session.step = { name: 'out2:platform' };
    await ask(ctx, 'Where do you want to cash-out from?', {
      reply_markup: platformKeyboardW2(platform.ask),
    });
    return;
  }
  await afterPlatform2(ctx, platform.pick.id);
}

/** Own keyboard so the callbacks route to the split flow (w2:pf:*). */
function platformKeyboardW2(platforms: Platform[]) {
  const kb = new InlineKeyboard();
  for (const p of platforms) kb.text(p.name, `w2:pf:${p.id}`).row();
  return kb;
}

export async function withdraw2PickPlatform(ctx: Ctx, platformId: string): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;
  await ctx.answerCallbackQuery();
  try { await ctx.editMessageReplyMarkup(); } catch { /* gone */ }
  await afterPlatform2(ctx, platformId);
}

async function afterPlatform2(ctx: Ctx, platformId: string): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;
  const elig = await eligibleMethods(p.id);
  if (elig.length < 2) return void (await ctx.reply(NEED_TWO, { parse_mode: 'Markdown' }));

  // Exactly two → use both, straight to the amount. More than two → pick two.
  if (elig.length === 2) {
    await askAmount2(ctx, platformId, elig[0]!.id, elig[1]!.id);
    return;
  }
  ctx.session.step = { name: 'out2:pickA', platformId };
  const kb = new InlineKeyboard();
  for (const m of elig) kb.text(m.name, `w2:a:${m.id}`).row();
  await ask(ctx, 'Pick the *first* method for your split:', { parse_mode: 'Markdown', reply_markup: kb });
}

export async function withdraw2PickA(ctx: Ctx, methodA: string): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;
  const s = ctx.session.step;
  if (s.name !== 'out2:pickA') return void (await ctx.answerCallbackQuery({ text: 'That expired — /withdraw2 again.' }));
  await ctx.answerCallbackQuery();
  try { await ctx.editMessageReplyMarkup(); } catch { /* gone */ }
  const elig = await eligibleMethods(p.id);
  const rest = elig.filter((m) => m.id !== methodA);
  ctx.session.step = { name: 'out2:pickB', platformId: s.platformId, methodA };
  const kb = new InlineKeyboard();
  for (const m of rest) kb.text(m.name, `w2:b:${m.id}`).row();
  await ask(ctx, 'And the *second* method:', { parse_mode: 'Markdown', reply_markup: kb });
}

export async function withdraw2PickB(ctx: Ctx, methodB: string): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;
  const s = ctx.session.step;
  if (s.name !== 'out2:pickB') return void (await ctx.answerCallbackQuery({ text: 'That expired — /withdraw2 again.' }));
  await ctx.answerCallbackQuery();
  try { await ctx.editMessageReplyMarkup(); } catch { /* gone */ }
  await askAmount2(ctx, s.platformId, s.methodA, methodB);
}

/** The step/min/max for a split = the STRICTER of the two methods (mirrors the DB). */
async function splitLimits(methodA: string, methodB: string) {
  const [r] = await db()<{ min_amount: number; max_amount: number; amount_step: number }[]>`
    select greatest(coalesce(a.min_amount, c.min_amount), coalesce(b.min_amount, c.min_amount)) as min_amount,
           least(coalesce(a.max_amount, c.max_amount), coalesce(b.max_amount, c.max_amount)) as max_amount,
           greatest(coalesce(a.amount_step, c.amount_step), coalesce(b.amount_step, c.amount_step)) as amount_step
      from config c, payment_methods a, payment_methods b
     where a.id = ${methodA} and b.id = ${methodB}`;
  return r!;
}

async function askAmount2(ctx: Ctx, platformId: string, methodA: string, methodB: string): Promise<void> {
  const sql = db();
  const [names] = await sql<{ a: string; b: string }[]>`
    select a.name as a, b.name as b from payment_methods a, payment_methods b where a.id = ${methodA} and b.id = ${methodB}`;
  const lim = await splitLimits(methodA, methodB);
  ctx.session.step = { name: 'out2:amount', platformId, methodA, methodB };
  await ask(ctx,
    `Splitting your cash-out between *${names!.a}* and *${names!.b}*.\n\n` +
      `How much *in total*? Between ${whole(lim.min_amount)} and ${whole(lim.max_amount)}, in multiples of ` +
      `${whole(lim.amount_step)}. Send the number, like \`100\`. ` +
      `We'll take it off your table, then whoever pays first — on either method — fills it, up to the total.\n\n/stop to cancel.`,
    { parse_mode: 'Markdown' },
  );
}

export async function withdraw2Amount(
  ctx: Ctx, platformId: string, methodA: string, methodB: string, text: string,
): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;
  const amount = parseAmount(text);
  if (amount === null) return void (await ctx.reply("That doesn't look like an amount. Try `100`.", { parse_mode: 'Markdown' }));

  const sql = db();
  const lim = await splitLimits(methodA, methodB);
  const problem = amountProblem(amount, { min: lim.min_amount, max: lim.max_amount, step: lim.amount_step });
  if (problem) return void (await ctx.reply(problem));

  // Most-recent saved handle for each method (eligibility already proved they exist).
  const handleFor = async (methodId: string) => {
    const [h] = await sql<{ handle: string }[]>`
      select handle from payout_handles where player_id = ${p.id} and method_id = ${methodId}
       order by last_used_at desc nulls last, created_at desc limit 1`;
    return h?.handle ?? '';
  };
  const handleA = await handleFor(methodA);
  const handleB = await handleFor(methodB);
  if (!handleA || !handleB) {
    ctx.session.step = { name: 'idle' };
    return void (await ctx.reply(NEED_TWO, { parse_mode: 'Markdown' }));
  }

  let w: WithdrawRequest;
  try {
    [w] = await sql<WithdrawRequest[]>`
      select * from withdraw_create_split(
        ${p.id}::uuid, ${platformId}::uuid,
        ${methodA}::uuid, ${handleA}, ${methodB}::uuid, ${handleB}, ${amount}::bigint)`;
  } catch (err) {
    ctx.session.step = { name: 'idle' };
    if (isUserError(err)) return void (await ctx.reply(`❌ ${userMessage(err)}`));
    console.error('withdraw_create_split failed:', err);
    return void (await ctx.reply('Something went wrong. Nothing was taken from your account. Try again shortly.'));
  }

  ctx.session.step = { name: 'idle' };
  await clearQuestion(ctx);

  const [names] = await sql<{ a: string; b: string }[]>`
    select a.name as a, b.name as b from payment_methods a, payment_methods b where a.id = ${methodA} and b.id = ${methodB}`;
  const amt = money(w.requested_amount, w.currency);
  await ctx.reply(
    `✅ *Cashing out ${amt} — split between ${names!.a} and ${names!.b}.*\n\n` +
      `We're taking it off your table now. Whoever pays you first fills it — via ` +
      `*${names!.a}* (${shortHandle(handleA)}) or *${names!.b}* (${shortHandle(handleB)}) — up to *${amt}* total. ` +
      `While one side is being paid, the other holds only what's left, and we never pay more than ${amt}.\n\n` +
      `Track it with /pending.`,
    { parse_mode: 'Markdown' },
  );
}
