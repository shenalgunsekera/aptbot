import { InlineKeyboard } from 'grammy';
import { db, isUserError, userMessage, type Platform, type PaymentMethod } from '@union/core';
import type { Ctx, OnboardingPlan } from '../session.js';
import { currentPlayer } from '../player.js';

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
    await ctx.reply(
      `👋 Welcome! Let's get you set up.\n\nFirst — what's your *full name*? ` +
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
      await ctx.reply(
        `⏳ Thanks! We've sent your Sportsbook account details to our team to set up. ` +
          `You'll get a message here the moment it's ready, and we'll pick up right where we left off.`,
      );
      return;
    }
    if (!r || (!r.platform_uid_claimed && !r.platform_uid)) {
      if (plan.sbHasAccount === undefined) {
        ctx.session.step = { name: 'ob:sb_hasacct' };
        await ctx.reply('Do you already have an *APT Sports* account?', {
          parse_mode: 'Markdown',
          reply_markup: new InlineKeyboard()
            .text('✅ Yes, I have one', 'ob:sb:yes')
            .text("🆕 No, make me one", 'ob:sb:no'),
        });
        return;
      }
      if (plan.sbHasAccount) {
        ctx.session.step = { name: 'ob:sb_username' };
        await ctx.reply('Great — what is your *APT Sports username*?', { parse_mode: 'Markdown' });
        return;
      }
      ctx.session.step = { name: 'ob:sb_user' };
      await ctx.reply(
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
      await ctx.reply(
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

async function askPlatforms(ctx: Ctx): Promise<void> {
  ctx.session.step = { name: 'ob:platforms' };
  const sql = db();
  const platforms = await sql<Platform[]>`select * from platforms where enabled order by sort_order`;
  const sel = ctx.session.ob?.platforms ?? [];
  const kb = new InlineKeyboard();
  for (const pf of platforms) {
    const on = sel.includes(pf.id);
    kb.text(`${on ? '☑️' : '⬜'} ${pf.name}`, `ob:pf:${pf.id}`).row();
  }
  if (sel.length) kb.text('✅ Done', 'ob:pfdone');
  await ctx.reply(
    'Which platform(s) will you be using? Tap to select — you can pick *both*.',
    { parse_mode: 'Markdown', reply_markup: kb },
  );
}

async function askDepositMethods(ctx: Ctx): Promise<void> {
  ctx.session.step = { name: 'ob:dep_methods' };
  if (!ctx.session.ob) ctx.session.ob = { platforms: [] };
  const methods = await depositMethodChoices();
  const sel = ctx.session.ob.depSel ?? [];
  const kb = new InlineKeyboard();
  for (const m of methods) {
    const on = sel.includes(m.id);
    kb.text(`${on ? '☑️' : '⬜'} ${m.label}`, `ob:dm:${m.id}`).row();
  }
  if (sel.length) kb.text('✅ Done', 'ob:dmdone');
  await ctx.reply(
    'Which payment methods do you want to use to *add money*? Pick all that apply — ' +
      "later we'll only show you these.",
    { parse_mode: 'Markdown', reply_markup: kb },
  );
}

async function askWithdrawMethod(ctx: Ctx): Promise<void> {
  ctx.session.step = { name: 'ob:wd_method' };
  const methods = await db()<PaymentMethod[]>`select * from payment_methods where enabled order by sort_order, name`;
  const kb = new InlineKeyboard();
  for (const m of methods) kb.text(m.name, `ob:wm:${m.id}`).row();
  await ctx.reply(
    'Last thing — how do you want to *get paid* when you cash out? Pick one.',
    { parse_mode: 'Markdown', reply_markup: kb },
  );
}

/**
 * Deposit-method choices with crypto collapsed into one "Crypto" entry. Returns
 * synthetic rows: a crypto row whose id is the literal string 'crypto' expands
 * later, real methods carry their uuid.
 */
async function depositMethodChoices(): Promise<{ id: string; label: string }[]> {
  const methods = await db()<PaymentMethod[]>`select * from payment_methods where enabled order by sort_order, name`;
  const out: { id: string; label: string }[] = [];
  let hasCrypto = false;
  for (const m of methods) {
    if (m.reversibility === 'irreversible' && m.settlement === 'club') { hasCrypto = true; continue; }
    out.push({ id: m.id, label: m.name });
  }
  if (hasCrypto) out.unshift({ id: 'crypto', label: '🪙 Crypto (all coins)' });
  return out;
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
  await ctx.reply(
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
  await sql`select prefs_set_withdraw_method(${p.id}::uuid, ${methodId}::uuid)`;
  await sql`select payout_handle_remember(${p.id}::uuid, ${methodId}::uuid, ${text.trim()})`;
  if (ctx.session.ob?.mode === 'payout') {
    ctx.session.ob = undefined;
    ctx.session.step = { name: 'idle' };
    await ctx.reply(`✅ Updated — we'll send your cash-outs to \`${text.trim()}\` via ${m?.name}.`, { parse_mode: 'Markdown' });
    return;
  }
  await advance(ctx, p.id);
}

// ─── Callback answers ────────────────────────────────────────────────────────

export async function obTogglePlatform(ctx: Ctx, platformId: string): Promise<void> {
  if (!ctx.session.ob) ctx.session.ob = { platforms: [] };
  const sel = ctx.session.ob.platforms;
  const i = sel.indexOf(platformId);
  if (i >= 0) sel.splice(i, 1); else sel.push(platformId);
  await ctx.answerCallbackQuery();
  await askPlatforms(ctx);   // re-render with the new ticks
}

export async function obPlatformsDone(ctx: Ctx): Promise<void> {
  const p = await currentPlayer(ctx);
  if (!p) return;
  if (!ctx.session.ob?.platforms.length) {
    return void (await ctx.answerCallbackQuery({ text: 'Pick at least one platform.' }));
  }
  await ctx.answerCallbackQuery();
  await advance(ctx, p.id);
}

export async function obSbHasAccount(ctx: Ctx, has: boolean): Promise<void> {
  const p = await currentPlayer(ctx);
  if (!p) return;
  if (!ctx.session.ob) ctx.session.ob = { platforms: [] };
  ctx.session.ob.sbHasAccount = has;
  await ctx.answerCallbackQuery();
  await advance(ctx, p.id);
}

export async function obToggleDepMethod(ctx: Ctx, methodId: string): Promise<void> {
  if (!ctx.session.ob) ctx.session.ob = { platforms: [] };
  const sel = ctx.session.ob.depSel ?? (ctx.session.ob.depSel = []);
  const i = sel.indexOf(methodId);
  if (i >= 0) sel.splice(i, 1); else sel.push(methodId);
  await ctx.answerCallbackQuery();
  await askDepositMethods(ctx);
}

export async function obDepMethodsDone(ctx: Ctx): Promise<void> {
  const p = await currentPlayer(ctx);
  if (!p) return;
  const sel = ctx.session.ob?.depSel ?? [];
  if (!sel.length) return void (await ctx.answerCallbackQuery({ text: 'Pick at least one.' }));

  // Expand the synthetic 'crypto' choice into every crypto method id.
  const sql = db();
  const ids = new Set<string>();
  for (const id of sel) {
    if (id === 'crypto') {
      const coins = await sql<{ id: string }[]>`
        select id from payment_methods where enabled and reversibility='irreversible' and settlement='club'`;
      for (const c of coins) ids.add(c.id);
    } else ids.add(id);
  }
  await sql`select prefs_set_deposit_methods(${p.id}::uuid, ${sql.array([...ids])}::uuid[])`;
  await ctx.answerCallbackQuery();
  if (ctx.session.ob?.mode === 'methods') {
    ctx.session.ob = undefined;
    ctx.session.step = { name: 'idle' };
    await ctx.reply('✅ Updated the payment methods you add money with.');
    return;
  }
  await advance(ctx, p.id);
}

export async function obPickWithdrawMethod(ctx: Ctx, methodId: string): Promise<void> {
  const p = await currentPlayer(ctx);
  if (!p) return;
  const sql = db();
  const [m] = await sql<PaymentMethod[]>`select * from payment_methods where id = ${methodId}`;
  await ctx.answerCallbackQuery();
  ctx.session.step = { name: 'ob:wd_handle', methodId };
  await ctx.reply(
    `Where should we send your ${m?.name} when you cash out?\n\nSend ${m?.handle_hint ?? `your ${m?.name} details`}.\n\n` +
      `⚠️ Double-check it — money sent to the wrong place can't come back. We'll save it so you never re-type it.`,
  );
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
