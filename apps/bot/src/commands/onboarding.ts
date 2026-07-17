import { InlineKeyboard } from 'grammy';
import { db, isUserError, userMessage, type Platform, type PaymentMethod } from '@union/core';
import type { Ctx, OnboardingPlan } from '../session.js';
import { currentPlayer } from '../player.js';
import { ask, clearQuestion } from '../ask.js';
import { withdrawHandlePrompt } from '../words.js';

/**
 * GUIDED ONBOARDING
 * ═════════════════
 *
 * One guided sequence collects everything before a player's first move:
 *
 *   full name
 *   → which platform(s): ClubGG, Sportsbook, or both
 *   → (Sportsbook only) already have an APT Sports account?
 *        yes → their username
 *        no  → pick a username + password; we PAUSE, an admin creates it on APT
 *              Sports, taps a button, and we resume automatically
 *   → account IDs (ClubGG id, Sportsbook username)
 *   → preferred deposit methods (choose several)
 *   → preferred cash-out method + where to send it (saved, never re-typed)
 *   → done
 *
 * The whole thing runs IN THE SAME CHAT it was started in — a DM or a member's
 * own group — and never bounces the player elsewhere. Progress is held in the
 * (durable) session, so the Sportsbook pause survives a wait of any length.
 */

const CHANNEL_URL = 'https://t.me/AmateurPokerTour';
const SB_MAX = 10;

async function platformByCode(code: string): Promise<Platform | null> {
  const [pf] = await db()<Platform[]>`select * from platforms where code = ${code} and enabled`;
  return pf ?? null;
}

/** Has this player finished the guided setup? */
export async function isOnboarded(playerId: string): Promise<boolean> {
  const [r] = await db()<{ onboarded_at: string | null }[]>`
    select onboarded_at from player_prefs where player_id = ${playerId}`;
  return !!r?.onboarded_at;
}

/** Kick off setup for a brand-new (or unfinished) player. */
export async function startOnboarding(ctx: Ctx): Promise<void> {
  const sql = db();
  // Ensure a shell row + prefs row exist.
  await sql`select player_register(${ctx.from!.id}::bigint, ${ctx.from?.username ?? null}, null)`;
  const p = await currentPlayer(ctx);
  if (!p) return;
  ctx.session.ob = { platforms: [] };
  await advance(ctx, p.id);
}

/**
 * The driver. Works out the next thing to ask from what's already stored, then
 * renders it. Called after every answered step, and by the resume button — which
 * is what makes onboarding pick up exactly where it paused.
 */
export async function advance(ctx: Ctx, playerId: string): Promise<void> {
  const sql = db();
  const [p] = await sql<{ display_name: string | null }[]>`
    select display_name from players where id = ${playerId}`;
  const plan: OnboardingPlan = ctx.session.ob ?? { platforms: [] };

  // 1 — Name.
  if (!p?.display_name || !p.display_name.trim()) {
    ctx.session.step = { name: 'ob:name' };
    await ask(ctx,
      `👋 Welcome! Let's get you set up.\n\nFirst — what's your *name*? ` +
        `This is how our team will know you, so use the name you actually go by.`,
      { parse_mode: 'Markdown' },
    );
    return;
  }

  // 2 — Platform selection.
  if (!plan.platforms || plan.platforms.length === 0) {
    await askPlatforms(ctx);
    return;
  }

  const sb = await platformByCode('sportsbook');
  const cg = await platformByCode('clubgg');
  const rows = await sql<{ platform_id: string; platform_uid: string | null; platform_uid_claimed: string | null; needs_creation: boolean }[]>`
    select platform_id, platform_uid, platform_uid_claimed, needs_creation
      from player_platforms where player_id = ${playerId}`;
  const rowFor = (id?: string) => rows.find((r) => r.platform_id === id);

  // 3 — Sportsbook branch.
  if (sb && plan.platforms.includes(sb.id)) {
    const r = rowFor(sb.id);
    if (r?.needs_creation && !r.platform_uid) {
      ctx.session.step = { name: 'ob:sb_wait' };
      await ask(ctx,
        `⏳ Thanks! We've sent your Sportsbook account details to our team to set up. ` +
          `You'll get a message here the moment it's ready, and we'll pick up right where we left off.`,
      );
      return;
    }
    if (!r || (!r.platform_uid_claimed && !r.platform_uid)) {
      if (plan.sbHasAccount === undefined) {
        ctx.session.step = { name: 'ob:sb_hasacct' };
        await ask(ctx, 'Do you already have an *APT Sports* account?', {
          parse_mode: 'Markdown',
          reply_markup: new InlineKeyboard()
            .text('✅ Yes, I have one', 'ob:sb:yes')
            .text("🆕 No, make me one", 'ob:sb:no'),
        });
        return;
      }
      if (plan.sbHasAccount) {
        ctx.session.step = { name: 'ob:sb_username' };
        await ask(ctx, 'Great — what is your *APT Sports username*?', { parse_mode: 'Markdown' });
        return;
      }
      ctx.session.step = { name: 'ob:sb_user' };
      await ask(ctx,
        `Let's create your APT Sports account.\n\nWhat *username* would you like? ` +
          `Max ${SB_MAX} characters. Choose carefully — it can't easily be changed later.`,
        { parse_mode: 'Markdown' },
      );
      return;
    }
  }

  // 4 — ClubGG id.
  if (cg && plan.platforms.includes(cg.id)) {
    const r = rowFor(cg.id);
    if (!r || (!r.platform_uid_claimed && !r.platform_uid)) {
      ctx.session.step = { name: 'ob:clubgg_id' };
      await ask(ctx,
        `What's your *ClubGG ID*? Copy it exactly — money gets sent using this.`,
        { parse_mode: 'Markdown' },
      );
      return;
    }
  }

  // Adding a platform later is done the moment its account is collected — the
  // rest of setup (methods, cash-out) is already on file.
  if (plan.mode === 'addplatform') {
    ctx.session.ob = undefined;
    ctx.session.step = { name: 'idle' };
    await ctx.reply('✅ Added! Our team will confirm the new account shortly, then you can use it.');
    return;
  }

  // 5 — Preferred deposit methods.
  const [dm] = await sql<{ n: number }[]>`
    select count(*)::int n from player_method_prefs where player_id = ${playerId}`;
  if (!dm || dm.n === 0) {
    await askDepositMethods(ctx);
    return;
  }

  // 6 — Preferred cash-out method (+ handle).
  const [pref] = await sql<{ default_withdraw_method_id: string | null }[]>`
    select default_withdraw_method_id from player_prefs where player_id = ${playerId}`;
  if (!pref?.default_withdraw_method_id) {
    await askWithdrawMethod(ctx);
    return;
  }

  // 7 — Done.
  await finish(ctx, playerId);
}

// ─── Prompts (multi-select ones) ─────────────────────────────────────────────

async function platformKb(ctx: Ctx): Promise<InlineKeyboard> {
  const platforms = await db()<Platform[]>`select * from platforms where enabled order by sort_order`;
  const sel = ctx.session.ob?.platforms ?? [];
  const kb = new InlineKeyboard();
  for (const pf of platforms) {
    kb.text(`${sel.includes(pf.id) ? '✅' : '⬜'} ${pf.name}`, `ob:pf:${pf.id}`).row();
  }
  if (sel.length) kb.text('➡️ Done', 'ob:pfdone');
  return kb;
}

async function askPlatforms(ctx: Ctx): Promise<void> {
  ctx.session.step = { name: 'ob:platforms' };
  await ask(ctx,
    'Which platform(s) will you be using? Tap to tick — you can pick *both* — then tap Done.',
    { parse_mode: 'Markdown', reply_markup: await platformKb(ctx) },
  );
}

const isCoin = (m: PaymentMethod) => m.reversibility === 'irreversible' && m.settlement === 'club';

/** Build the deposit-method picker for whichever screen is showing. Crypto coins
 *  live behind one "Crypto" button that opens a second screen of coin checkboxes,
 *  so the top level stays short. Everything edits the same message in place. */
async function depKb(ctx: Ctx): Promise<{ text: string; kb: InlineKeyboard }> {
  const methods = await db()<PaymentMethod[]>`select * from payment_methods where enabled order by sort_order, name`;
  const coins = methods.filter(isCoin);
  const fiat = methods.filter((m) => !isCoin(m));
  const sel = ctx.session.ob?.depSel ?? [];
  const kb = new InlineKeyboard();

  if (ctx.session.ob?.depView === 'crypto') {
    for (const c of coins) kb.text(`${sel.includes(c.id) ? '✅' : '⬜'} ${c.name}`, `ob:dm:${c.id}`).row();
    kb.text('‹ Back', 'ob:dmback');
    return { text: 'Tap the coins you want to use, then Back.', kb };
  }

  for (const f of fiat) kb.text(`${sel.includes(f.id) ? '✅' : '⬜'} ${f.name}`, `ob:dm:${f.id}`).row();
  if (coins.length) {
    const n = coins.filter((c) => sel.includes(c.id)).length;
    kb.text(`🪙 Crypto${n ? ` — ${n} chosen` : ''} ›`, 'ob:dmcrypto').row();
  }
  if (sel.length) kb.text('➡️ Done', 'ob:dmdone');
  return {
    text: 'Which methods do you want to use to *add money*? Tap all that apply, then Done. ' +
      "We'll only show you these later.",
    kb,
  };
}

async function askDepositMethods(ctx: Ctx): Promise<void> {
  ctx.session.step = { name: 'ob:dep_methods' };
  if (!ctx.session.ob) ctx.session.ob = { platforms: [] };
  ctx.session.ob.depView = 'main';
  const { text, kb } = await depKb(ctx);
  await ask(ctx, text, { parse_mode: 'Markdown', reply_markup: kb });
}

/** Cash-out method picker — same shape as the deposit one: multi-select, with
 *  crypto behind a dropdown. Everything edits the same message in place. */
async function wdKb(ctx: Ctx): Promise<{ text: string; kb: InlineKeyboard }> {
  const methods = await db()<PaymentMethod[]>`select * from payment_methods where enabled and payout_enabled order by sort_order, name`;
  const coins = methods.filter(isCoin);
  const fiat = methods.filter((m) => !isCoin(m));
  const sel = ctx.session.ob?.wdSel ?? [];
  const kb = new InlineKeyboard();

  if (ctx.session.ob?.wdView === 'crypto') {
    for (const c of coins) kb.text(`${sel.includes(c.id) ? '✅' : '⬜'} ${c.name}`, `ob:wm:${c.id}`).row();
    kb.text('‹ Back', 'ob:wmback');
    return { text: 'Tap the coins you want to get paid in, then Back.', kb };
  }

  for (const f of fiat) kb.text(`${sel.includes(f.id) ? '✅' : '⬜'} ${f.name}`, `ob:wm:${f.id}`).row();
  if (coins.length) {
    const n = coins.filter((c) => sel.includes(c.id)).length;
    kb.text(`🪙 Crypto${n ? ` — ${n} chosen` : ''} ›`, 'ob:wmcrypto').row();
  }
  if (sel.length) kb.text('➡️ Done', 'ob:wmdone');
  return {
    text: 'How do you want to *get paid* when you cash out? Tap all that apply, then Done — ' +
      "we'll save where to send each so you never re-type it.",
    kb,
  };
}

async function askWithdrawMethod(ctx: Ctx): Promise<void> {
  ctx.session.step = { name: 'ob:wd_method' };
  if (!ctx.session.ob) ctx.session.ob = { platforms: [] };
  ctx.session.ob.wdView = 'main';
  const { text, kb } = await wdKb(ctx);
  await ask(ctx, text, { parse_mode: 'Markdown', reply_markup: kb });
}

/** After the multi-select, collect a destination handle for each chosen method,
 *  one at a time. */
async function askNextWdHandle(ctx: Ctx): Promise<void> {
  const q = ctx.session.ob?.wdQueue ?? [];
  const p = await currentPlayer(ctx);
  if (!p) return;
  if (q.length === 0) {
    // All handles collected.
    if (ctx.session.ob?.mode === 'payout') {
      ctx.session.ob = undefined;
      ctx.session.step = { name: 'idle' };
      await ctx.reply('✅ Updated how you get paid.');
      return;
    }
    await advance(ctx, p.id);
    return;
  }
  const methodId = q[0]!;
  const [m] = await db()<PaymentMethod[]>`select * from payment_methods where id = ${methodId}`;
  ctx.session.step = { name: 'ob:wd_handle', methodId };
  const left = q.length > 1 ? `\n\n_(${q.length} more after this)_` : '';
  await ask(ctx, withdrawHandlePrompt(m!.code, m!.name, m!.club_handle) + left, { parse_mode: 'Markdown' });
}

// ─── Text answers ────────────────────────────────────────────────────────────

export async function obName(ctx: Ctx, text: string): Promise<void> {
  const sql = db();
  const p = await currentPlayer(ctx);
  if (!p) return void (await startOnboarding(ctx));
  try {
    await sql`select player_set_name(${p.id}::uuid, ${text}, null)`;
  } catch (err) {
    if (isUserError(err)) return void (await ctx.reply(userMessage(err)));
    throw err;
  }
  await advance(ctx, p.id);
}

export async function obSbUser(ctx: Ctx, text: string): Promise<void> {
  const u = text.trim();
  if (!u || u.length > SB_MAX) {
    await ctx.reply(`Please send a username of at most ${SB_MAX} characters.`);
    return;
  }
  ctx.session.step = { name: 'ob:sb_pass', username: u };
  await ask(ctx,
    `Got it — *${u}*.\n\nNow pick a *password*. Max ${SB_MAX} characters. ` +
      `Type it carefully.`,
    { parse_mode: 'Markdown' },
  );
}

export async function obSbPass(ctx: Ctx, username: string, text: string): Promise<void> {
  const pass = text.trim();
  if (!pass || pass.length > SB_MAX) {
    await ctx.reply(`Please send a password of at most ${SB_MAX} characters.`);
    return;
  }
  const p = await currentPlayer(ctx);
  const sb = await platformByCode('sportsbook');
  if (!p || !sb) return;
  try {
    await db()`select sb_request_creation(${p.id}::uuid, ${sb.id}::uuid, ${username}, ${pass})`;
  } catch (err) {
    if (isUserError(err)) return void (await ctx.reply(userMessage(err)));
    throw err;
  }
  await advance(ctx, p.id);   // → sb_wait
}

export async function obSbUsername(ctx: Ctx, text: string): Promise<void> {
  const p = await currentPlayer(ctx);
  const sb = await platformByCode('sportsbook');
  if (!p || !sb) return;
  try {
    await db()`select player_claim_platform(${p.id}::uuid, ${sb.id}::uuid, ${text})`;
  } catch (err) {
    if (isUserError(err)) return void (await ctx.reply(userMessage(err)));
    throw err;
  }
  await advance(ctx, p.id);
}

export async function obClubggId(ctx: Ctx, text: string): Promise<void> {
  const p = await currentPlayer(ctx);
  const cg = await platformByCode('clubgg');
  if (!p || !cg) return;
  try {
    await db()`select player_claim_platform(${p.id}::uuid, ${cg.id}::uuid, ${text})`;
  } catch (err) {
    if (isUserError(err)) return void (await ctx.reply(userMessage(err)));
    throw err;
  }
  await advance(ctx, p.id);
}

export async function obWdHandle(ctx: Ctx, methodId: string, text: string): Promise<void> {
  const p = await currentPlayer(ctx);
  if (!p) return;
  const sql = db();
  const [m] = await sql<PaymentMethod[]>`select * from payment_methods where id = ${methodId}`;
  if (m?.handle_pattern) {
    let ok = true;
    try { ok = new RegExp(m.handle_pattern).test(text.trim()); } catch { ok = true; }
    if (!ok) return void (await ctx.reply(`That doesn't look right for ${m.name}. Send it again.`));
  }
  // First method chosen becomes the default; every one gets its handle saved.
  const [pref] = await sql<{ mid: string | null }[]>`
    select default_withdraw_method_id as mid from player_prefs where player_id = ${p.id}`;
  if (!pref?.mid) await sql`select prefs_set_withdraw_method(${p.id}::uuid, ${methodId}::uuid)`;
  await sql`select payout_handle_remember(${p.id}::uuid, ${methodId}::uuid, ${text.trim()})`;
  await ctx.reply(`✅ Saved your *${m?.name}* — \`${text.trim()}\`.`, { parse_mode: 'Markdown' });

  // Move to the next chosen method that still needs a handle.
  if (ctx.session.ob) ctx.session.ob.wdQueue = (ctx.session.ob.wdQueue ?? []).filter((id) => id !== methodId);
  await askNextWdHandle(ctx);
}

// ─── Callback answers ────────────────────────────────────────────────────────

export async function obTogglePlatform(ctx: Ctx, platformId: string): Promise<void> {
  if (!ctx.session.ob) ctx.session.ob = { platforms: [] };
  const sel = ctx.session.ob.platforms;
  const i = sel.indexOf(platformId);
  if (i >= 0) sel.splice(i, 1); else sel.push(platformId);
  await ctx.answerCallbackQuery();
  // Update the ticks IN PLACE — no new message per tap.
  try { await ctx.editMessageReplyMarkup({ reply_markup: await platformKb(ctx) }); } catch { /* unchanged */ }
}

export async function obPlatformsDone(ctx: Ctx): Promise<void> {
  const p = await currentPlayer(ctx);
  if (!p) return;
  if (!ctx.session.ob?.platforms.length) {
    return void (await ctx.answerCallbackQuery({ text: 'Pick at least one platform.' }));
  }
  await ctx.answerCallbackQuery();
  try { await ctx.editMessageReplyMarkup(); } catch { /* buttons already gone */ }
  const sql = db();
  const names = await sql<{ name: string }[]>`
    select name from platforms where id = any(${sql.array(ctx.session.ob.platforms)}::uuid[]) order by sort_order`;
  await ctx.reply(`✅ Playing on: *${names.map((n) => n.name).join(', ')}*`, { parse_mode: 'Markdown' });
  await advance(ctx, p.id);
}

export async function obSbHasAccount(ctx: Ctx, has: boolean): Promise<void> {
  const p = await currentPlayer(ctx);
  if (!p) return;
  if (!ctx.session.ob) ctx.session.ob = { platforms: [] };
  ctx.session.ob.sbHasAccount = has;
  await ctx.answerCallbackQuery();
  try { await ctx.editMessageReplyMarkup(); } catch { /* buttons already gone */ }
  await advance(ctx, p.id);
}

export async function obToggleDepMethod(ctx: Ctx, methodId: string): Promise<void> {
  if (!ctx.session.ob) ctx.session.ob = { platforms: [] };
  const sel = ctx.session.ob.depSel ?? (ctx.session.ob.depSel = []);
  const i = sel.indexOf(methodId);
  if (i >= 0) sel.splice(i, 1); else sel.push(methodId);
  await ctx.answerCallbackQuery();
  try { await ctx.editMessageReplyMarkup({ reply_markup: (await depKb(ctx)).kb }); } catch { /* unchanged */ }
}

/** Switch between the main method list and the crypto-coins screen, in place. */
export async function obDepView(ctx: Ctx, view: 'main' | 'crypto'): Promise<void> {
  if (!ctx.session.ob) ctx.session.ob = { platforms: [] };
  ctx.session.ob.depView = view;
  await ctx.answerCallbackQuery();
  const { text, kb } = await depKb(ctx);
  try { await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: kb }); } catch { /* unchanged */ }
}

export async function obDepMethodsDone(ctx: Ctx): Promise<void> {
  const p = await currentPlayer(ctx);
  if (!p) return;
  const sel = ctx.session.ob?.depSel ?? [];
  if (!sel.length) return void (await ctx.answerCallbackQuery({ text: 'Pick at least one.' }));

  // depSel already holds real method ids (coins are ticked individually now).
  const sql = db();
  await sql`select prefs_set_deposit_methods(${p.id}::uuid, ${sql.array(sel)}::uuid[])`;
  await ctx.answerCallbackQuery();
  try { await ctx.editMessageReplyMarkup(); } catch { /* buttons already gone */ }
  const names = await sql<{ name: string }[]>`
    select name from payment_methods where id = any(${sql.array(sel)}::uuid[]) order by sort_order, name`;
  const label = `✅ You'll add money with: *${names.map((n) => n.name).join(', ')}*`;
  if (ctx.session.ob?.mode === 'methods') {
    ctx.session.ob = undefined;
    ctx.session.step = { name: 'idle' };
    await clearQuestion(ctx);
    await ctx.reply(label, { parse_mode: 'Markdown' });
    return;
  }
  await ctx.reply(label, { parse_mode: 'Markdown' });
  await advance(ctx, p.id);
}

export async function obToggleWdMethod(ctx: Ctx, methodId: string): Promise<void> {
  if (!ctx.session.ob) ctx.session.ob = { platforms: [] };
  const sel = ctx.session.ob.wdSel ?? (ctx.session.ob.wdSel = []);
  const i = sel.indexOf(methodId);
  if (i >= 0) sel.splice(i, 1); else sel.push(methodId);
  await ctx.answerCallbackQuery();
  try { await ctx.editMessageReplyMarkup({ reply_markup: (await wdKb(ctx)).kb }); } catch { /* unchanged */ }
}

export async function obWdView(ctx: Ctx, view: 'main' | 'crypto'): Promise<void> {
  if (!ctx.session.ob) ctx.session.ob = { platforms: [] };
  ctx.session.ob.wdView = view;
  await ctx.answerCallbackQuery();
  const { text, kb } = await wdKb(ctx);
  try { await ctx.editMessageText(text, { parse_mode: 'Markdown', reply_markup: kb }); } catch { /* unchanged */ }
}

export async function obWdMethodsDone(ctx: Ctx): Promise<void> {
  const p = await currentPlayer(ctx);
  if (!p) return;
  const sel = ctx.session.ob?.wdSel ?? [];
  if (!sel.length) return void (await ctx.answerCallbackQuery({ text: 'Pick at least one.' }));
  await ctx.answerCallbackQuery();
  try { await ctx.editMessageReplyMarkup(); } catch { /* buttons already gone */ }
  // Now collect a destination for each chosen method, one at a time.
  if (ctx.session.ob) ctx.session.ob.wdQueue = [...sel];
  await askNextWdHandle(ctx);
}

/** The resume button on the "your Sportsbook account is ready" message. */
export async function obResume(ctx: Ctx): Promise<void> {
  const p = await currentPlayer(ctx);
  if (!p) return;
  await ctx.answerCallbackQuery();
  // Rebuild the plan if the session was reset while paused.
  if (!ctx.session.ob || !ctx.session.ob.platforms.length) {
    const rows = await db()<{ platform_id: string }[]>`
      select platform_id from player_platforms where player_id = ${p.id}`;
    ctx.session.ob = { platforms: rows.map((r) => r.platform_id), sbHasAccount: false };
  }
  await advance(ctx, p.id);
}

// ─── Update commands (used after setup is already done) ──────────────────────

/** /methods — change which payment methods you add money with. */
export async function updateMethods(ctx: Ctx): Promise<void> {
  const p = await currentPlayer(ctx);
  if (!p || !(await isOnboarded(p.id))) return void (await ctx.reply('Finish setup first with /start.'));
  ctx.session.ob = { platforms: [], depSel: [], mode: 'methods' };
  await askDepositMethods(ctx);
}

/** /payout — change how (and where) you get paid when you cash out. */
export async function updatePayout(ctx: Ctx): Promise<void> {
  const p = await currentPlayer(ctx);
  if (!p || !(await isOnboarded(p.id))) return void (await ctx.reply('Finish setup first with /start.'));
  ctx.session.ob = { platforms: [], mode: 'payout' };
  await askWithdrawMethod(ctx);
}

/** /addplatform — add ClubGG or Sportsbook to an account that has the other. */
export async function addPlatform(ctx: Ctx): Promise<void> {
  const p = await currentPlayer(ctx);
  if (!p || !(await isOnboarded(p.id))) return void (await ctx.reply('Finish setup first with /start.'));
  const rows = await db()<{ platform_id: string }[]>`
    select platform_id from player_platforms where player_id = ${p.id}`;
  ctx.session.ob = { platforms: rows.map((r) => r.platform_id), mode: 'addplatform' };
  await askPlatforms(ctx);
}

// ─── Completion ──────────────────────────────────────────────────────────────

async function finish(ctx: Ctx, playerId: string): Promise<void> {
  await db()`select player_finish_onboarding(${playerId}::uuid)`;
  ctx.session.step = { name: 'idle' };
  ctx.session.ob = undefined;
  await clearQuestion(ctx);   // tidy the last prompt; the completion message stays
  await ctx.reply(
    `🎉 *Thank you for joining! Your account setup is now complete.*\n\n` +
      `Some of your accounts may still need a quick confirmation from our team — ` +
      `you'll get a message here the moment they're live.\n\n` +
      `Join our official Telegram channel to stay updated with promotions, announcements, and news:\n` +
      `${CHANNEL_URL}\n\n` +
      `We look forward to having you as part of the community!\n\n` +
      `When you're ready:\n💵 /add — add money\n💸 /cashout — cash out\n📋 /me — your account`,
    { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } },
  );
}
