import { InlineKeyboard } from 'grammy';
import {
  db, isUserError, userMessage, uploadReceipt, storageConfigured,
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

  // Cash App: $250+ goes straight to our $cashtag; under $250 must go through the
  // card link using Cash App Pay.
  const [mm] = await sql0<PaymentMethod[]>`select * from payment_methods where id = ${methodId}`;
  if (mm?.code === 'cashapp' && amount < 25000) {
    await ctx.reply(
      `💵 For Cash App *under $250*, pay through our secure link and choose *Cash App Pay* on the page.`,
      { parse_mode: 'Markdown' },
    );
    await startStripeDeposit(ctx, platformId);
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

/** After a method is chosen: Stripe → fixed link (player types the amount on
 *  Stripe's page); everything else → ask the amount here. */
async function addProceed(ctx: Ctx, platformId: string, method: PaymentMethod): Promise<void> {
  if (method.code === 'stripe') return void (await startStripeDeposit(ctx, platformId));
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

async function startStripeDeposit(ctx: Ctx, platformId: string): Promise<void> {
  const [cfg] = await db()<{ min_amount: number; max_amount: number }[]>`
    select min_amount, max_amount from config where id`;
  ctx.session.step = { name: 'add:stripe', platformId };
  await clearQuestion(ctx);
  await ctx.reply(
    `💳 *Pay by Card, Apple Pay, or Cash App Pay*\n\n` +
      `Tap below, then on the page *enter the amount you want to add* ` +
      `(between ${whole(cfg.min_amount)} and ${whole(cfg.max_amount)}) and pay.\n\n` +
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
    if (f.withdraw_id !== null) lines.push(`_This is another player's ${m!.name}._`);
    lines.push('');
  }
  if (m?.code === 'paypal') lines.push('⚠️ *Make sure to send as Friends & Family* (not Goods & Services).\n');
  lines.push(`Once you've sent it, *send ${receiptInstruction(m!.code)}* here so we can confirm it.`);
  lines.push('_Changed your mind? /canceldeposit before you pay._');

  // The receipt IS the proof now. Collect it (up to two), submitting proof on the
  // first one. Every locked slice of this deposit is proven together.
  ctx.session.step = { name: 'add:receipt', fillId: fills[0]!.id };
  await clearQuestion(ctx);
  await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
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
    method: string; depositor_name: string | null;
  }[]>`
    select f.amount, f.currency, f.payment_ref, pm.name as method,
           dp.display_name as depositor_name
      from fills f
      join payment_methods pm on pm.id = f.method_id
      left join deposit_requests d on d.id = f.deposit_id
      left join players dp on dp.id = d.player_id
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
  };
  await sql`select notify_admins('fill.receipt_admin', 'fill', ${fillId}::uuid, ${sql.json(payload)}::jsonb)`;
}

function finishedMessage(): string {
  return (
    `✅ *All set!*\n\nWe'll check your payment and add your money. ` +
    `You'll get a message here the moment it's done. Check anytime with /pending.`
  );
}
