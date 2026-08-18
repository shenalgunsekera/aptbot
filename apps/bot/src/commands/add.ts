import { InlineKeyboard } from 'grammy';
import {
  db, isUserError, userMessage, uploadReceipt, storageConfigured, peerpayCheckout,
  type PaymentMethod, type Fill, type Platform,
} from '@union/core';
import type { Ctx } from '../session.js';
import { requireActive } from '../player.js';
import { money, whole, parseAmount, amountProblem, receiptInstruction, receiptCount } from '../words.js';
import { resolvePlatform, platformKeyboard } from '../prefs.js';
import { ask, clearQuestion } from '../ask.js';

/**
 * /deposit — add money. (deposit)
 *
 * Flow: platform → method → amount → match → pay → prove. Method comes before
 * amount so Stripe (a fixed payment link where the player types their own amount)
 * can skip the amount step. The bot decides nothing about money; deposit_create()
 * runs the whole match atomically.
 */
export async function addStart(ctx: Ctx): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;

  const platform = await resolvePlatform(p.id);
  if ('ask' in platform) {
    if (platform.ask.length === 0) {
      await ctx.reply("You don't have a confirmed account on any platform yet. /start to set one up.");
      return;
    }
    ctx.session.step = { name: 'add:platform' };
    await ask(ctx, 'Where do you want to add money?', {
      reply_markup: platformKeyboard('add', platform.ask, platform.offerRemember),
    });
    return;
  }
  await afterPlatform(ctx, platform.pick.id);
}

export async function addPickPlatform(ctx: Ctx, platformId: string, remember: boolean): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;
  if (remember) await db()`select prefs_set_platform(${p.id}::uuid, ${platformId}::uuid)`;
  await ctx.answerCallbackQuery();
  try { await ctx.editMessageReplyMarkup(); } catch { /* buttons already gone */ }
  await afterPlatform(ctx, platformId);
}

/** Platform chosen → if the player is in more than one club on it, ask which the
 *  money is going to (one club → set it silently); then on to the method. */
async function afterPlatform(ctx: Ctx, platformId: string): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;
  const sql = db();
  const clubs = await sql<{ id: string; name: string }[]>`
    select c.id, c.name from clubs c join player_clubs pc on pc.club_id = c.id
     where pc.player_id = ${p.id} and c.platform_id = ${platformId} and c.enabled
     order by c.name`;
  if (clubs.length > 1) {
    ctx.session.step = { name: 'add:club', platformId };
    const kb = new InlineKeyboard();
    for (const c of clubs) kb.text(c.name, `add:club:${c.id}`).row();
    await ask(ctx, 'Which club is this going to?', { reply_markup: kb });
    return;
  }
  if (clubs.length === 1) {
    await sql`select player_set_active_club(${p.id}::uuid, ${platformId}::uuid, ${clubs[0]!.id}::uuid)`;
  }
  await askAddMethod(ctx, platformId);
}

export async function addPickClub(ctx: Ctx, platformId: string, clubId: string): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;
  try {
    await db()`select player_set_active_club(${p.id}::uuid, ${platformId}::uuid, ${clubId}::uuid)`;
  } catch (err) {
    if (isUserError(err)) return void (await ctx.answerCallbackQuery({ text: userMessage(err), show_alert: true }));
    throw err;
  }
  await ctx.answerCallbackQuery();
  try { await ctx.editMessageReplyMarkup(); } catch { /* buttons already gone */ }
  await askAddMethod(ctx, platformId);
}

async function askAmount(ctx: Ctx, platformId: string, methodId: string): Promise<void> {
  const sql = db();
  const [cfg] = await sql<{ min_amount: number; max_amount: number; amount_step: number }[]>`
    select min_amount, max_amount, amount_step from config where id`;
  const [pf] = await sql<{ name: string }[]>`select name from platforms where id = ${platformId}`;
  ctx.session.step = { name: 'add:amount', platformId, methodId };
  await ask(ctx,
    `How much do you want to add to *${pf?.name}*?\n\n` +
      `Between ${whole(cfg.min_amount)} and ${whole(cfg.max_amount)}, in multiples of ` +
      `${whole(cfg.amount_step)}. ` +
      `Just send the number, like \`20\` or \`50\`.\n\n/cancel to stop.`,
    { parse_mode: 'Markdown' },
  );
}

export async function addAmount(ctx: Ctx, platformId: string, methodId: string, text: string): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;
  const amount = parseAmount(text);
  if (amount === null) {
    await ctx.reply("That doesn't look like an amount. Try `20` or `50`.", { parse_mode: 'Markdown' });
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

  // Route by tier (BEFORE creating a deposit for the Stripe path). A 'STRIPE' tier
  // on any method — or the Stripe method's own default (anything that isn't a
  // Staff/PeerPay tier) — diverts to the fixed card link. 'STAFF'/'PEERPAY' and
  // real handles fall through to deposit_create + runMatch.
  const [mrow] = await sql0<{ code: string }[]>`select code from payment_methods where id = ${methodId}`;
  const code = mrow?.code ?? '';
  const [tier] = await sql0<{ handle: string | null }[]>`
    select club_handle_for(${methodId}::uuid, ${amount}::bigint) as handle`;
  const h = tier?.handle;
  if (h === 'STRIPE' || (code === 'stripe' && h !== 'STAFF' && h !== 'PEERPAY')) {
    await startStripeDeposit(ctx, platformId, code);
    return;
  }

  await runMatch(ctx, platformId, amount, methodId);
}

// Crypto coins are the irreversible, club-settled methods (BTC, ETH, USDT, …).
// This correctly excludes Zelle (irreversible but P2P) and PayPal (club but
// reversible). Coins are quoted in USD, so currency can't be the signal.
const isCrypto = (m: PaymentMethod) => m.reversibility === 'irreversible' && m.settlement === 'club';

/** The player's chosen deposit methods (from onboarding); all enabled if they
 *  never narrowed it. */
async function preferredDepositMethods(playerId: string): Promise<PaymentMethod[]> {
  return db()<PaymentMethod[]>`
    select m.* from payment_methods m
     where m.enabled and (
       exists (select 1 from player_method_prefs pmp where pmp.player_id = ${playerId} and pmp.method_id = m.id)
       or not exists (select 1 from player_method_prefs pmp where pmp.player_id = ${playerId})
     )
     order by m.sort_order, m.name`;
}

/** The main "how do you want to pay?" keyboard — fiat listed, crypto behind one
 *  button that opens a coins screen. */
function addMethodKb(methods: PaymentMethod[]): InlineKeyboard {
  const coins = methods.filter(isCrypto);
  const fiat = methods.filter((m) => !isCrypto(m));
  const kb = new InlineKeyboard();
  for (const m of fiat) kb.text(m.name, `add:m:${m.id}`).row();
  if (coins.length === 1) kb.text(coins[0]!.name, `add:m:${coins[0]!.id}`).row();
  else if (coins.length > 1) kb.text('🪙 Crypto ›', 'add:crypto').row();
  return kb;
}

/** Ask how to pay (method BEFORE amount). One method → straight through. */
async function askAddMethod(ctx: Ctx, platformId: string): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;
  const methods = await preferredDepositMethods(p.id);
  if (methods.length === 0) {
    await ctx.reply('No payment methods are available right now. Please contact us.');
    ctx.session.step = { name: 'idle' };
    return;
  }
  if (methods.length === 1) return void (await addProceed(ctx, platformId, methods[0]!));

  ctx.session.step = { name: 'add:method', platformId };
  await ask(ctx, `How do you want to pay?`, {
    parse_mode: 'Markdown', reply_markup: addMethodKb(methods),
  });
}

/** After a method is chosen: the Stripe method with NO tiers keeps its fast path
 *  (player types the amount on Stripe's page). Everything else — including a Stripe
 *  method that HAS tiers (e.g. > $249 → Staff) — asks the amount here so the tier
 *  can route it. */
async function addProceed(ctx: Ctx, platformId: string, method: PaymentMethod): Promise<void> {
  const tiers = (method as { handle_tiers?: unknown }).handle_tiers;
  const hasTiers = Array.isArray(tiers) && tiers.length > 0;
  if (method.code === 'stripe' && !hasTiers) return void (await startStripeDeposit(ctx, platformId, 'stripe'));
  await askAmount(ctx, platformId, method.id);
}

/** The "Crypto ›" button → show the coins on the SAME message. */
export async function addPickCrypto(ctx: Ctx): Promise<void> {
  const s = ctx.session.step;
  if (s.name !== 'add:method') return void (await ctx.answerCallbackQuery({ text: 'That expired — /deposit again.' }));
  const p = await requireActive(ctx);
  if (!p) return;
  const coins = (await preferredDepositMethods(p.id)).filter(isCrypto);
  const kb = new InlineKeyboard();
  for (const c of coins) kb.text(c.name, `add:m:${c.id}`).row();
  kb.text('‹ Back', 'add:mback');
  await ctx.answerCallbackQuery();
  try { await ctx.editMessageText('Which coin?', { reply_markup: kb }); } catch { /* unchanged */ }
}

/** "‹ Back" from the coins screen → restore the main method list, in place. */
export async function addMethodBack(ctx: Ctx): Promise<void> {
  const s = ctx.session.step;
  if (s.name !== 'add:method') return void (await ctx.answerCallbackQuery());
  const p = await requireActive(ctx);
  if (!p) return;
  const methods = await preferredDepositMethods(p.id);
  await ctx.answerCallbackQuery();
  try {
    await ctx.editMessageText(`How do you want to pay?`, {
      parse_mode: 'Markdown', reply_markup: addMethodKb(methods),
    });
  } catch { /* unchanged */ }
}

export async function addPickMethod(
  ctx: Ctx, platformId: string, methodId: string, remember: boolean,
): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;
  if (remember) await db()`select prefs_set_method(${p.id}::uuid, ${methodId}::uuid)`;
  const [m] = await db()<PaymentMethod[]>`select * from payment_methods where id = ${methodId}`;
  await ctx.answerCallbackQuery();
  try { await ctx.editMessageReplyMarkup(); } catch { /* buttons already gone */ }
  if (!m) return;
  await addProceed(ctx, platformId, m);
}

// ─── Stripe: one fixed payment link, player types the amount on Stripe ────────
const STRIPE_LINK = () => process.env.STRIPE_PAYMENT_LINK ?? 'https://buy.stripe.com/5kQbJ2gdf2BE9TtbGDc3m07';
// The Stripe payment link caps at $500, so show that ceiling here rather than the
// global deposit max_amount.
const STRIPE_MAX_CENTS = 50000;

async function startStripeDeposit(ctx: Ctx, platformId: string, methodCode = 'stripe'): Promise<void> {
  const [cfg] = await db()<{ min_amount: number; max_amount: number }[]>`
    select min_amount, max_amount from config where id`;
  ctx.session.step = { name: 'add:stripe', platformId };
  await clearQuestion(ctx);
  // Same secure link for both, but tailor the wording: a Cash App deposit routed
  // here pays with Cash App Pay ON the page; a card/Apple Pay deposit doesn't.
  const isCashapp = methodCode === 'cashapp';
  const title = isCashapp ? '💵 *Pay with Cash App Pay*' : '💳 *Pay by Card or Apple Pay*';
  const step1 = isCashapp
    ? 'Tap below, choose *Cash App Pay* on the page, then *enter the amount you want to add* '
    : 'Tap below, then on the page *enter the amount you want to add* ';
  await ctx.reply(
    `${title}\n\n` +
      step1 +
      `(between ${whole(cfg.min_amount)} and ${whole(STRIPE_MAX_CENTS)}) and pay.\n\n` +
      `When you're done, come back here and *send a screenshot of the "Thanks for your payment" screen* ` +
      `so we can confirm it and add your money.`,
    { parse_mode: 'Markdown', reply_markup: new InlineKeyboard().url('💳 Pay now', STRIPE_LINK()) },
  );
}

/** The moment of truth: match, lock the slice, reveal where to pay. Stripe never
 *  reaches here — it's handled by startStripeDeposit. */
async function runMatch(ctx: Ctx, platformId: string, amount: number, methodId: string): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;
  const sql = db();

  let fills: Fill[];
  try {
    const [d] = await sql<{ id: string }[]>`
      select id from deposit_create(${p.id}::uuid, ${platformId}::uuid, ${methodId}::uuid, ${amount}::bigint)`;
    fills = await sql<Fill[]>`select * from fills where deposit_id = ${d.id} order by seq`;
  } catch (err) {
    ctx.session.step = { name: 'idle' };
    if (isUserError(err)) return void (await ctx.reply(`❌ ${userMessage(err)}`));
    console.error('deposit_create failed:', err);
    await ctx.reply('Something went wrong setting that up. Nothing was charged. Try again in a moment.');
    return;
  }

  const [m] = await sql<PaymentMethod[]>`select * from payment_methods where id = ${methodId}`;

  // PeerPay tier: the club fill's handle is the sentinel 'PEERPAY'. Mint a checkout
  // link for this amount instead of showing a static handle. p2p never splits, so a
  // PeerPay deposit is a single club fill.
  if (fills.length === 1 && fills[0]!.payout_handle === 'PEERPAY') {
    await sendPeerpayInstruction(ctx, fills[0]!, m!);
    return;
  }
  // Staff Provide tier: a human sends the handle. Ask staff in the admin group.
  if (fills.length === 1 && fills[0]!.payout_handle === 'STAFF') {
    await sendStaffProvideInstruction(ctx, fills[0]!, m!.name);
    return;
  }

  // We SAY 5 minutes for urgency, but the real window is generous — the p2p slice
  // holds ~25 min and club/crypto deposits hold 24h — so a slow payer never fails.
  const lines: string[] = [`*💸 Send your payment now — you have 5 minutes*\n`];

  if (fills.length > 1) {
    lines.push(`Your ${money(amount)} is split across *${fills.length} people*. Pay *each* separately:\n`);
  }
  for (const [i, f] of fills.entries()) {
    if (fills.length > 1) lines.push(`*── Payment ${i + 1} of ${fills.length} ──*`);
    lines.push(`Send: *${money(f.gross_to_send, f.currency)}*`);
    if (f.gross_to_send !== f.amount) {
      lines.push(`_(${money(f.amount, f.currency)} + ${money(f.gross_to_send - f.amount, f.currency)} ${m!.name} fee, so they get the full amount)_`);
    }
    lines.push(`Address: \`${f.payout_handle}\`  _(tap to copy)_`);
    if (f.payout_name) lines.push(`Name on ${m!.name}: *${f.payout_name}*`);
    lines.push('');
  }
  if (m?.code === 'paypal') lines.push('⚠️ *Make sure to send as Friends & Family* (not Goods & Services).\n');
  lines.push(`Once you've sent it, send ${receiptInstruction(m!.code)} here so we can confirm it.`);
  lines.push('_Changed your mind? /canceldeposit before you pay._');

  // The receipt IS the proof now. Collect it (up to two), submitting proof on the
  // first one. Every locked slice of this deposit is proven together.
  ctx.session.step = { name: 'add:receipt', fillId: fills[0]!.id };
  await clearQuestion(ctx);
  await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
}

/** PeerPay deposit: mint a checkout link for this amount and show a Pay button +
 *  a "rail not available → backup tag" button. The receipt flow is identical to a
 *  normal deposit — the confirmation screenshot IS the proof. */
async function sendPeerpayInstruction(ctx: Ctx, f: Fill, m: PaymentMethod): Promise<void> {
  const url = await peerpayCheckout({ amountCents: f.amount, fillId: f.id, rail: m.code });
  ctx.session.step = { name: 'add:receipt', fillId: f.id };
  await clearQuestion(ctx);

  if (!url) {
    // Minting failed → offer the backup tag straight away if one is set.
    if (await switchToBackup(ctx, f)) return;
    await ctx.reply("We couldn't set up the payment link right now. Please /support and we'll sort it out — nothing was charged.");
    return;
  }

  const kb = new InlineKeyboard()
    .url('💳 Pay now', url).row()
    .text(`⚠️ ${m.name} not available?`, `pp:backup:${f.id}`);
  await ctx.reply(
    `*💸 Pay ${money(f.amount, f.currency)} — you have a few minutes*\n\n` +
      `1. Tap *Pay now*.\n` +
      `2. Choose *${m.name}* on the page and send the payment.\n` +
      `3. Come back and *send a screenshot of the confirmation* here so we can add your money.\n\n` +
      `_${m.name} not showing on the page? Tap the button below for another tag._\n` +
      `_Changed your mind? /canceldeposit before you pay._`,
    { parse_mode: 'Markdown', reply_markup: kb },
  );
}

/** Switch a still-unpaid PeerPay fill to its backup. The backup is either a direct
 *  tag/link (repoint the fill so the admin verifies the real handle) or the
 *  sentinel 'STAFF' (hand off to a staff member). Returns false if none is set. */
async function switchToBackup(ctx: Ctx, f: Fill): Promise<boolean> {
  const sql = db();
  const [b] = await sql<{ backup: string | null }[]>`
    select club_backup_for(${f.method_id}::uuid, ${f.amount}::bigint) as backup`;
  const backup = b?.backup?.trim();
  if (!backup) return false;
  const [m] = await sql<{ name: string }[]>`select name from payment_methods where id = ${f.method_id}`;
  if (backup === 'STAFF') {
    await sendStaffProvideInstruction(ctx, f, m?.name ?? 'the app');
    return true;
  }
  // Only repoint while still unpaid; keep collecting the screenshot on this fill.
  await sql`update fills set payout_handle = ${backup} where id = ${f.id} and status = 'locked'`;
  ctx.session.step = { name: 'add:receipt', fillId: f.id };
  await ctx.reply(
    `No problem — pay *${money(f.amount, f.currency)}* to \`${backup}\` on *${m?.name}* instead ` +
      `_(tap to copy)_, then send a screenshot of the confirmation here.`,
    { parse_mode: 'Markdown' },
  );
  return true;
}

/** Staff Provide: tell the player to hold on, post a request in the admin group,
 *  and record it so a staff member's REPLY there routes the handle back here. */
async function sendStaffProvideInstruction(ctx: Ctx, f: Fill, methodName: string): Promise<void> {
  const sql = db();
  ctx.session.step = { name: 'add:staffwait', fillId: f.id };
  await clearQuestion(ctx);
  await ctx.reply(
    `⏳ *Hold on a moment* — a staff member is getting you a payment handle for ` +
      `*${money(f.amount, f.currency)}*. You'll get it right here shortly.`,
    { parse_mode: 'Markdown' },
  );

  const [cfg] = await sql<{ admin_group_chat_id: string | null }[]>`select admin_group_chat_id from config where id`;
  const adminChat = cfg?.admin_group_chat_id;
  if (!adminChat) {
    await ctx.reply("We couldn't reach a staff member right now. Please /support and we'll help you pay.");
    return;
  }
  const [pl] = await sql<{ name: string | null }[]>`
    select dp.display_name as name from deposit_requests d join players dp on dp.id = d.player_id where d.id = ${f.deposit_id}`;
  const playerName = pl?.name ?? 'A player';
  const sent = await ctx.api.sendMessage(String(adminChat),
    `🙋 *Payment handle needed*\n\n*${playerName}* wants to deposit *${money(f.amount, f.currency)}* via *${methodName}*.\n\n` +
      `↩️ *Reply to this message* with the tag or link to send them.`,
    { parse_mode: 'Markdown' });
  await sql`
    insert into staff_handle_req (fill_id, platform, admin_chat_id, admin_message_id, player_chat_id, amount, currency, method_name, player_name)
    values (${f.id}::uuid, 'telegram', ${String(adminChat)}, ${String(sent.message_id)}, ${String(ctx.chat!.id)},
            ${f.amount}::bigint, ${f.currency}, ${methodName}, ${playerName})
    on conflict (platform, admin_chat_id, admin_message_id) do nothing`;
}

/** A staff member replied in the admin group to a "handle needed" request. Repoint
 *  the fill, relay the tag/link to the player, and put them in receipt-collection.
 *  Returns true if this message was a staff reply we handled. */
export async function handleStaffReply(ctx: Ctx): Promise<boolean> {
  const replyId = ctx.message?.reply_to_message?.message_id;
  if (!replyId || !ctx.chat) return false;
  const sql = db();
  const [req] = await sql<{
    id: string; fill_id: string; player_chat_id: string; amount: string; currency: string; method_name: string | null;
  }[]>`
    select id, fill_id, player_chat_id, amount, currency, method_name
      from staff_handle_req
     where platform = 'telegram' and admin_chat_id = ${String(ctx.chat.id)}
       and admin_message_id = ${String(replyId)} and status = 'pending'`;
  if (!req) return false;

  const handle = (ctx.message?.text ?? '').trim();
  if (!handle) { await ctx.reply('Reply with the tag or link (text) to send the player.'); return true; }

  const [f] = await sql<{ status: string }[]>`select status from fills where id = ${req.fill_id}`;
  if (!f || f.status !== 'locked') {
    await sql`update staff_handle_req set status = 'cancelled' where id = ${req.id}`;
    await ctx.reply('That deposit is no longer waiting (cancelled or already handled).');
    return true;
  }

  await sql`update fills set payout_handle = ${handle} where id = ${req.fill_id} and status = 'locked'`;
  await sql`update staff_handle_req set status = 'provided', provided_handle = ${handle} where id = ${req.id}`;

  const amt = money(Number(req.amount), req.currency);
  const isLink = /^https?:\/\//i.test(handle);
  if (isLink) {
    await ctx.api.sendMessage(req.player_chat_id,
      `✅ *Here's your payment link for ${amt}*\n\nTap below to pay, then send a screenshot of the confirmation here.`,
      { parse_mode: 'Markdown', reply_markup: new InlineKeyboard().url('💳 Pay now', handle) });
  } else {
    await ctx.api.sendMessage(req.player_chat_id,
      `✅ *Pay ${amt} to:*\n\`${handle}\`  _(tap to copy)_\n\n` +
        `via *${req.method_name ?? 'the app'}*. Send a screenshot of the confirmation here once you've paid.`,
      { parse_mode: 'Markdown' });
  }
  // NOTE: we deliberately do NOT touch the player's session here. Sessions are
  // owned by grammY's middleware, which reloads at the start of an update and
  // rewrites at the end — so an out-of-band write from THIS (the staff's) update
  // gets clobbered, especially when the staff member is the same user as the
  // player. Instead the player stays in add:staffwait and that step checks
  // staffProvided() when they send their screenshot (see build.ts).
  await ctx.reply("✅ Sent to the player. They'll pay and send a screenshot to verify.");
  return true;
}

/** Has a staff member handed over the handle for this fill yet? The add:staffwait
 *  step polls this instead of us pushing into the player's session. */
export async function staffProvided(fillId: string): Promise<boolean> {
  const [req] = await db()<{ status: string }[]>`
    select status from staff_handle_req where fill_id = ${fillId} order by created_at desc limit 1`;
  return req?.status === 'provided';
}

/** The player sent a screenshot while in add:staffwait. If the handle has been
 *  provided, treat it as the receipt; otherwise ask them to hold on. */
export async function staffWaitReceipt(ctx: Ctx, fillId: string): Promise<void> {
  if (await staffProvided(fillId)) {
    ctx.session.step = { name: 'add:receipt', fillId };   // our OWN update — safe to set
    await addReceipt(ctx, fillId);
    return;
  }
  await ctx.reply("⏳ Hang tight — we're still getting your payment details. I'll send them here, then you can send your screenshot.");
}

/** "Payment method not available?" button on a PeerPay deposit → reveal backup. */
export async function peerpayBackup(ctx: Ctx, fillId: string): Promise<void> {
  const sql = db();
  const [f] = await sql<Fill[]>`select * from fills where id = ${fillId}`;
  if (!f || f.status !== 'locked') {
    return void (await ctx.answerCallbackQuery({ text: 'That deposit is no longer waiting — /deposit again.', show_alert: true }));
  }
  await ctx.answerCallbackQuery();
  try { await ctx.editMessageReplyMarkup(); } catch { /* buttons already gone */ }
  if (!(await switchToBackup(ctx, f))) {
    await ctx.reply("There's no backup tag set for this one. Please /support and we'll help you pay.");
  }
}

/** Player sent a receipt photo. Upload it, submit proof on the first, allow a
 *  second, then finish. No transaction ID anywhere. */
export async function addReceipt(ctx: Ctx, fillId: string): Promise<void> {
  const sql = db();
  const p = await requireActive(ctx);
  if (!p) return;

  const photo = ctx.message?.photo?.at(-1);
  const doc = ctx.message?.document;
  const fileId = photo?.file_id ?? (doc?.mime_type?.startsWith('image/') || doc?.mime_type === 'application/pdf' ? doc.file_id : undefined);
  if (!fileId) {
    await ctx.reply("That doesn't look like a photo. Send a picture of your receipt.");
    return;
  }

  const [f] = await sql<{ deposit_id: string | null }[]>`
    select deposit_id from fills where id = ${fillId}`;
  const platformId = f?.deposit_id
    ? (await sql<{ platform_id: string }[]>`select platform_id from deposit_requests where id = ${f.deposit_id}`)[0]?.platform_id
    : null;

  try {
    const file = await ctx.api.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const res = await fetch(url);
    const bytes = Buffer.from(await res.arrayBuffer());
    const contentType = doc?.mime_type ?? 'image/jpeg';

    if (storageConfigured()) {
      const stored = await uploadReceipt(bytes, contentType, 'fill', fillId);
      await sql`
        select receipt_add(
          ${p.id}::uuid, 'fill', ${fillId}::uuid, ${stored.storagePath}, ${stored.url},
          ${platformId}::uuid, ${contentType}, ${stored.bytes}::bigint, ${fileId}, ${p.id}::uuid, null)`;
    } else {
      await sql`
        select receipt_add(
          ${p.id}::uuid, 'fill', ${fillId}::uuid, ${'telegram:' + fileId}, ${'telegram:' + fileId},
          ${platformId}::uuid, null, null, ${fileId}, ${p.id}::uuid, null)`;
    }
  } catch (err) {
    console.error('receipt upload failed:', err);
    await ctx.reply("Hmm, that image didn't upload. Please send it again.");
    return;
  }

  // Submit proof for every locked slice on the first receipt (p_notify=false — we
  // send the album ourselves once all needed images are in).
  const locked = await sql<{ id: string }[]>`
    select id from fills where deposit_id = ${f!.deposit_id} and status = 'locked' order by seq`;
  if (locked.length) {
    try {
      for (const lf of locked) await sql`select fill_submit_proof(${lf.id}::uuid, null, null, false)`;
    } catch (err) {
      if (isUserError(err)) { await ctx.reply(`❌ ${userMessage(err)}`); ctx.session.step = { name: 'idle' }; return; }
      throw err;
    }
  }

  // Auto-finalize once we have the images the method needs — no /done to tap.
  const [meth] = await sql<{ code: string }[]>`
    select pm.code from fills fl join payment_methods pm on pm.id = fl.method_id where fl.id = ${fillId}`;
  const needed = receiptCount(meth?.code ?? '');
  const [rc] = await sql<{ n: number }[]>`
    select count(*)::int n from receipts where ref_type='fill' and ref_id=${fillId}`;
  const have = rc?.n ?? 1;

  if (have < needed) {
    await ctx.reply(`✅ Got it. Now send the *other* image (the transaction ID).`, { parse_mode: 'Markdown' });
    return;
  }
  await sendReceiptsToReviewer(fillId);
  ctx.session.step = { name: 'idle' };
  await ctx.reply(finishedMessage());
}

/** /canceldeposit — drop the player's latest un-paid deposit. */
export async function cancelDeposit(ctx: Ctx): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;
  const [d] = await db()<{ id: string }[]>`select id from deposit_cancel_latest(${p.id}::uuid)`;
  ctx.session.step = { name: 'idle' };
  if (!d?.id) {
    await ctx.reply("You don't have a deposit to cancel. (If you already sent a receipt, it's being checked — /support if you need help.)");
    return;
  }
  await ctx.reply('✅ Your deposit was cancelled. If you already sent the money, contact us with /support and we\'ll sort it out.');
}

/** Player sent a receipt for a Stripe (fixed-link) payment. Store it and alert
 *  the admins with the image + a Credit button — they enter the amount that
 *  arrived (which the payment heads-up already told them), and it's credited. */
export async function stripeReceipt(ctx: Ctx, platformId: string): Promise<void> {
  const sql = db();
  const p = await requireActive(ctx);
  if (!p) return;

  const photo = ctx.message?.photo?.at(-1);
  const doc = ctx.message?.document;
  const fileId = photo?.file_id ?? (doc?.mime_type?.startsWith('image/') || doc?.mime_type === 'application/pdf' ? doc.file_id : undefined);
  if (!fileId) {
    await ctx.reply("That doesn't look like a photo. Send a picture of your Stripe receipt.");
    return;
  }

  const [claim] = await sql<{ id: string }[]>`
    insert into stripe_claims (player_id, platform_id, receipt_file_id)
    values (${p.id}::uuid, ${platformId}::uuid, ${fileId}) returning id`;

  let url: string | null = null;
  try {
    const file = await ctx.api.getFile(fileId);
    const res = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (storageConfigured()) {
      const stored = await uploadReceipt(bytes, doc?.mime_type ?? 'image/jpeg', 'stripe_claim', claim!.id);
      url = stored.url;
      await sql`update stripe_claims set receipt_url = ${url} where id = ${claim!.id}`;
    }
  } catch (err) {
    console.error('stripe receipt upload failed:', err);
  }

  // Pull in the amount from the matching webhook payment, so the admin can credit
  // in one tap without typing it.
  const [al] = await sql<{ amt: number | null }[]>`select stripe_claim_autolink(${claim!.id}::uuid) as amt`;

  await sql`select notify_admins('stripe.claim', 'stripe_claim', ${claim!.id}::uuid, ${sql.json({
    claim_id: claim!.id, file_id: fileId, url, name: p.display_name,
    amount: al?.amt ?? null, currency: 'USD',
  })}::jsonb)`;

  ctx.session.step = { name: 'idle' };
  await ctx.reply(
    `✅ *Got your receipt!* We'll confirm the amount and add your money shortly — ` +
      `you'll get a message here the moment it's done.`,
    { parse_mode: 'Markdown' },
  );
}

/** /done or /skip during receipt collection — wrap up. Sends whatever receipts
 *  were attached to admins as one album; if none, submits proof with an alert so
 *  the payment isn't stranded. */
export async function addDone(ctx: Ctx, fillId: string): Promise<void> {
  const sql = db();
  const [f] = await sql<{ deposit_id: string | null }[]>`select deposit_id from fills where id = ${fillId}`;
  const [rc] = await sql<{ n: number }[]>`
    select count(*)::int n from receipts where ref_type='fill' and ref_id=${fillId}`;

  if ((rc?.n ?? 0) > 0) {
    // At least one receipt: proof was already submitted on upload; send the album.
    await sendReceiptsToReviewer(fillId);
  } else if (f?.deposit_id) {
    // No receipt at all: submit proof with an admin alert so nothing is stranded.
    const locked = await sql<{ id: string }[]>`
      select id from fills where deposit_id = ${f.deposit_id} and status = 'locked' order by seq`;
    for (const lf of locked) {
      try { await sql`select fill_submit_proof(${lf.id}::uuid, null, 'no receipt provided', true)`; }
      catch { /* already submitted or expired */ }
    }
  }
  ctx.session.step = { name: 'idle' };
  await ctx.reply(finishedMessage());
}

/** Queue ALL of a fill's receipts to the admin group as one album + Verify. */
async function sendReceiptsToReviewer(fillId: string): Promise<void> {
  const sql = db();
  const [f] = await sql<{
    amount: number; currency: string; payment_ref: string | null;
    method: string; depositor_name: string | null; payout_handle: string | null; payout_name: string | null;
    from_name: string | null; platform: string | null;
  }[]>`
    select f.amount, f.currency, f.payment_ref, pm.name as method,
           f.payout_handle, f.payout_name, dp.display_name as depositor_name,
           pf.name as platform,
           -- The account this deposit funds: ClubGG username (not the numeric ID),
           -- Sportsbook username, else the player's display name — never an ID.
           coalesce(
             case when pf.code = 'clubgg' then pp.platform_username else pp.platform_uid end,
             dp.display_name
           ) as from_name
      from fills f
      join payment_methods pm on pm.id = f.method_id
      left join deposit_requests d on d.id = f.deposit_id
      left join players dp on dp.id = d.player_id
      left join platforms pf on pf.id = d.platform_id
      left join player_platforms pp on pp.player_id = d.player_id and pp.platform_id = d.platform_id
     where f.id = ${fillId}`;
  if (!f) return;

  // Prefer Telegram file_ids (instant re-send, no re-upload); fall back to the
  // stored Firebase URLs.
  const receipts = await sql<{ telegram_file_id: string | null; url: string | null }[]>`
    select telegram_file_id, url from receipts
     where ref_type='fill' and ref_id=${fillId} order by created_at`;
  const fileIds = receipts.map((r) => r.telegram_file_id).filter((x): x is string => !!x);
  const urls = receipts.map((r) => r.url).filter((x): x is string => !!x && !x.startsWith('telegram:'));

  const payload = {
    fill_id: fillId, file_ids: fileIds, urls,
    amount: f.amount, currency: f.currency, payment_ref: f.payment_ref,
    method: f.method, name: f.depositor_name,
    from_name: f.from_name ?? f.depositor_name, platform: f.platform,
    payout_handle: f.payout_handle, payout_name: f.payout_name,
  };
  await sql`select notify_admins('fill.receipt_admin', 'fill', ${fillId}::uuid, ${sql.json(payload)}::jsonb)`;
}

function finishedMessage(): string {
  return (
    `✅ *All set!*\n\nWe'll check your payment and add your money. ` +
    `You'll get a message here the moment it's done. Check anytime with /pending.`
  );
}
