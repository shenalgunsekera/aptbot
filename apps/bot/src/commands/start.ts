import { InlineKeyboard } from 'grammy';
import { db, isUserError, userMessage, type Platform } from '@union/core';
import type { Ctx } from '../session.js';
import { currentPlayer } from '../player.js';
import { money, friendlyStatus } from '../words.js';

/**
 * /start — registration.
 *
 * v2 takes the NAME first, because the name is the identifier — unique across
 * the union and what every human sees. Then which platform (ClubGG / Sportsbook)
 * they play on and their id there. An admin confirms it before they can transact.
 */
export async function start(ctx: Ctx): Promise<void> {
  const sql = db();
  const p = await currentPlayer(ctx);

  if (p?.status === 'active') {
    await ctx.reply(
      `Welcome back${p.display_name ? ', ' + p.display_name : ''}!\n\n` +
        `💵 /add — add money\n` +
        `💸 /cashout — cash out\n` +
        `📋 /me — your account\n` +
        `✅ /confirm — confirm a payment you got`,
    );
    return;
  }

  if (p && p.status === 'pending') {
    // Resume registration wherever it stalled — a session lost mid-flow must
    // never leave a player stuck. No name yet → ask for it. Name but no platform
    // account claimed → ask that. Otherwise they really are waiting on an admin.
    if (!p.display_name || !p.display_name.trim()) {
      ctx.session.step = { name: 'register:name' };
      await ctx.reply(
        `👋 Welcome back — let's finish setting you up.\n\nWhat name should we know you by?`,
      );
      return;
    }
    const [claim] = await sql<{ n: number }[]>`
      select count(*)::int as n from player_platforms where player_id = ${p.id}`;
    if (!claim || claim.n === 0) {
      const platforms = await sql<Platform[]>`select * from platforms where enabled order by sort_order`;
      const kb = new InlineKeyboard();
      for (const pf of platforms) kb.text(pf.name, `reg:pf:${pf.id}`).row();
      ctx.session.step = { name: 'idle' };
      await ctx.reply(`Almost there, ${p.display_name}! Where do you play?`, { reply_markup: kb });
      return;
    }
    await ctx.reply(
      "You're all registered! We just need someone to confirm your account. " +
        "You'll get a message here the moment that's done.",
    );
    return;
  }

  // New player. Register a shell row and ask for their name.
  await sql`select player_register(${ctx.from!.id}::bigint, ${ctx.from?.username ?? null}, null)`;
  ctx.session.step = { name: 'register:name' };
  await ctx.reply(
    `👋 Welcome!\n\nWhat name should we know you by? This is how our team will ` +
      `find you, so use the name you actually go by.`,
  );
}

export async function registerName(ctx: Ctx, text: string): Promise<void> {
  const sql = db();
  const p = await currentPlayer(ctx);
  if (!p) return void (await start(ctx));

  try {
    await sql`select player_set_name(${p.id}::uuid, ${text}, null)`;
  } catch (err) {
    if (isUserError(err)) {
      await ctx.reply(userMessage(err));
      return;
    }
    throw err;
  }

  // Ask which platform they play on.
  const platforms = await sql<Platform[]>`select * from platforms where enabled order by sort_order`;
  const kb = new InlineKeyboard();
  for (const pf of platforms) kb.text(pf.name, `reg:pf:${pf.id}`).row();

  ctx.session.step = { name: 'idle' };
  await ctx.reply(
    `Nice to meet you, ${text}!\n\nWhere do you play?`,
    { reply_markup: kb },
  );
}

export async function registerPickPlatform(ctx: Ctx, platformId: string): Promise<void> {
  const sql = db();
  const [pf] = await sql<Platform[]>`select * from platforms where id = ${platformId}`;
  ctx.session.step = { name: 'register:platform_uid', platformId };
  await ctx.answerCallbackQuery();
  await ctx.reply(
    `What's your ${pf?.name} ID? Copy it exactly — money gets sent using this, ` +
      `and there's no getting it back if it's wrong.`,
  );
}

export async function registerUid(ctx: Ctx, platformId: string, uid: string): Promise<void> {
  const sql = db();
  const p = await currentPlayer(ctx);
  if (!p) return;

  try {
    await sql`select player_claim_platform(${p.id}::uuid, ${platformId}::uuid, ${uid})`;
  } catch (err) {
    if (isUserError(err)) {
      await ctx.reply(userMessage(err));
      return;
    }
    throw err;
  }

  ctx.session.step = { name: 'idle' };
  await ctx.reply(
    `✅ Got it — *${uid}*.\n\nSomeone on our team will confirm your account shortly. ` +
      `You'll get a message here the moment you're good to go.`,
    { parse_mode: 'Markdown' },
  );
}

/**
 * /me — the player's account. NO available balance: that number does not exist.
 * Only what is actually in motion.
 */
export async function me(ctx: Ctx): Promise<void> {
  const sql = db();
  const p = await currentPlayer(ctx);
  if (!p) return void (await ctx.reply('Send /start to get set up first.'));

  const lines: string[] = [`*${p.display_name ?? 'Your account'}*\n`];

  if (p.status !== 'active') {
    lines.push(p.status === 'pending'
      ? '⏳ Waiting for an admin to confirm your account.\n'
      : `Status: ${p.status}\n`);
  }

  // Linked platforms
  const platforms = await sql<{ name: string; platform_uid: string | null; platform_uid_claimed: string | null }[]>`
    select pf.name, pp.platform_uid, pp.platform_uid_claimed
      from player_platforms pp join platforms pf on pf.id = pp.platform_id
     where pp.player_id = ${p.id} order by pf.sort_order`;
  if (platforms.length) {
    lines.push('*Your accounts*');
    for (const pl of platforms) {
      lines.push(`  ${pl.name}: ${pl.platform_uid ?? pl.platform_uid_claimed}${pl.platform_uid ? ' ✓' : ' (pending)'}`);
    }
    lines.push('');
  }

  const [sum] = await sql<{ awaiting_payment: number; being_confirmed: number }[]>`
    select awaiting_payment, being_confirmed from v_player_summary where player_id = ${p.id}`;
  if (sum && (sum.awaiting_payment > 0 || sum.being_confirmed > 0)) {
    lines.push('*Money coming to you*');
    if (sum.awaiting_payment > 0) lines.push(`  ${money(sum.awaiting_payment)} — waiting to be paid`);
    if (sum.being_confirmed > 0) lines.push(`  ${money(sum.being_confirmed)} — being checked`);
    lines.push('');
  }

  // Open requests
  const deps = await sql<{ amount: number; currency: string; status: string }[]>`
    select amount, currency, status from deposit_requests
     where player_id = ${p.id} and status in ('matching','awaiting_payment','awaiting_confirmation')
     order by created_at`;
  const outs = await sql<{ requested_amount: number; amount: number | null; currency: string; status: string }[]>`
    select requested_amount, amount, currency, status from withdraw_requests
     where player_id = ${p.id} and status in ('pending_unload','queued','partially_filled','filled')
     order by created_at`;

  if (deps.length || outs.length) {
    lines.push('*In progress*');
    for (const d of deps) lines.push(`  ↓ Adding ${money(d.amount, d.currency)} — ${friendlyStatus('deposit', d.status)}`);
    for (const o of outs) lines.push(`  ↑ Cashing out ${money(o.amount ?? o.requested_amount, o.currency)} — ${friendlyStatus('withdraw', o.status)}`);
    lines.push('');
  }

  const toConfirm = await sql<{ id: string }[]>`
    select f.id from fills f join withdraw_requests w on w.id = f.withdraw_id
     where w.player_id = ${p.id} and f.status = 'awaiting_confirmation' and f.payee_confirmed_at is null`;
  if (toConfirm.length) {
    lines.push(`⚠️ You have ${toConfirm.length} payment(s) to confirm — /confirm`);
  }

  await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
}
