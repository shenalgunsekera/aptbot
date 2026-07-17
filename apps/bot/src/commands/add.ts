import { InlineKeyboard } from 'grammy';
import {
  db, isUserError, userMessage, uploadReceipt, storageConfigured,
  type PaymentMethod, type Fill, type Platform,
} from '@union/core';
import type { Ctx } from '../session.js';
import { requireActive } from '../player.js';
import { money, parseAmount, amountProblem } from '../words.js';
import { resolvePlatform, platformKeyboard } from '../prefs.js';

/**
 * /add — add money. (deposit)
 *
 * Flow: platform → amount → method → match → pay → prove.
 * The bot decides nothing about money; deposit_create() runs the whole match
 * atomically. This file asks questions and renders what came back — in plain
 * language, never "deposit" or "load".
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
    await ctx.reply('Where do you want to add money?', {
      reply_markup: platformKeyboard('add', platform.ask, platform.offerRemember),
    });
    return;
  }
  await askAmount(ctx, platform.pick);
}

async function askAmount(ctx: Ctx, platform: Platform): Promise<void> {
  const sql = db();
  const [cfg] = await sql<{ min_amount: number; max_amount: number; amount_step: number }[]>`
    select min_amount, max_amount, amount_step from config where id`;
  ctx.session.step = { name: 'add:amount', platformId: platform.id };
  await ctx.reply(
    `How much do you want to add to *${platform.name}*?\n\n` +
      `Between ${money(cfg.min_amount)} and ${money(cfg.max_amount)}, in multiples of ` +
      `${money(cfg.amount_step).replace(/\.00$/, '')}. ` +
      `Just send the number, like \`20\` or \`50\`.\n\n/cancel to stop.`,
    { parse_mode: 'Markdown' },
  );
}

export async function addPickPlatform(ctx: Ctx, platformId: string, remember: boolean): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;
  const sql = db();
  if (remember) await sql`select prefs_set_platform(${p.id}::uuid, ${platformId}::uuid)`;
  const [pf] = await sql<Platform[]>`select * from platforms where id = ${platformId}`;
  await ctx.answerCallbackQuery();
  await askAmount(ctx, pf!);
}

export async function addAmount(ctx: Ctx, platformId: string, text: string): Promise<void> {
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

  await askAddMethod(ctx, platformId, amount);
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

/** Ask how to pay — fiat methods listed, crypto collapsed under one button. */
async function askAddMethod(ctx: Ctx, platformId: string, amount: number): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;
  const methods = await preferredDepositMethods(p.id);
  if (methods.length === 0) {
    await ctx.reply('No payment methods are available right now. Please contact us.');
    ctx.session.step = { name: 'idle' };
    return;
  }
  if (methods.length === 1) return void (await runMatch(ctx, platformId, amount, methods[0]!.id));

  const coins = methods.filter(isCrypto);
  const fiat = methods.filter((m) => !isCrypto(m));
  ctx.session.step = { name: 'add:method', platformId, amount };
  const kb = new InlineKeyboard();
  for (const m of fiat) kb.text(m.name, `add:m:${m.id}`).row();
  if (coins.length === 1) kb.text(coins[0]!.name, `add:m:${coins[0]!.id}`).row();
  else if (coins.length > 1) kb.text('🪙 Crypto', 'add:crypto').row();
  await ctx.reply(`Adding *${money(amount)}* — how do you want to pay?`, {
    parse_mode: 'Markdown', reply_markup: kb,
  });
}

/** The "Crypto" button → expand to every crypto coin. */
export async function addPickCrypto(ctx: Ctx): Promise<void> {
  const s = ctx.session.step;
  if (s.name !== 'add:method') return void (await ctx.answerCallbackQuery({ text: 'That expired — /add again.' }));
  const p = await requireActive(ctx);
  if (!p) return;
  const coins = (await preferredDepositMethods(p.id)).filter(isCrypto);
  const kb = new InlineKeyboard();
  for (const c of coins) kb.text(c.name, `add:m:${c.id}`).row();
  await ctx.answerCallbackQuery();
  await ctx.reply('Which coin?', { reply_markup: kb });
}

export async function addPickMethod(
  ctx: Ctx, platformId: string, amount: number, methodId: string, remember: boolean,
): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;
  if (remember) await db()`select prefs_set_method(${p.id}::uuid, ${methodId}::uuid)`;
  await ctx.answerCallbackQuery();
  await runMatch(ctx, platformId, amount, methodId);
}

/** The moment of truth: match, lock the slice, reveal where to pay. */
async function runMatch(ctx: Ctx, platformId: string, amount: number, methodId: string): Promise<void> {
  const p = await requireActive(ctx);
  if (!p) return;
  const sql = db();

  let fills: Fill[];
  let cfg: { match_timeout_seconds: number };
  try {
    const [d] = await sql<{ id: string }[]>`
      select id from deposit_create(${p.id}::uuid, ${platformId}::uuid, ${methodId}::uuid, ${amount}::bigint)`;
    fills = await sql<Fill[]>`select * from fills where deposit_id = ${d.id} order by seq`;
    [cfg] = await sql<{ match_timeout_seconds: number }[]>`select match_timeout_seconds from config where id`;
  } catch (err) {
    ctx.session.step = { name: 'idle' };
    if (isUserError(err)) return void (await ctx.reply(`❌ ${userMessage(err)}`));
    console.error('deposit_create failed:', err);
    await ctx.reply('Something went wrong setting that up. Nothing was charged. Try again in a moment.');
    return;
  }

  const [m] = await sql<PaymentMethod[]>`select * from payment_methods where id = ${methodId}`;
  const mins = Math.round(cfg.match_timeout_seconds / 60);
  const lines: string[] = [`*💸 Send your payment now — you have ${mins} minutes*\n`];

  if (fills.length > 1) {
    lines.push(`Your ${money(amount)} is split across *${fills.length} people*. Pay *each* separately:\n`);
  }
  for (const [i, f] of fills.entries()) {
    if (fills.length > 1) lines.push(`*── Payment ${i + 1} of ${fills.length} ──*`);
    lines.push(`Send: *${money(f.gross_to_send, f.currency)}*`);
    if (f.gross_to_send !== f.amount) {
      lines.push(`_(${money(f.amount, f.currency)} + ${money(f.gross_to_send - f.amount, f.currency)} ${m!.name} fee, so they get the full amount)_`);
    }
    lines.push(`To: \`${f.payout_handle}\``);
    lines.push(f.withdraw_id === null ? `_This one goes to us._` : `_This is another player's ${m!.name}._`);
    lines.push('');
  }
  lines.push('When you have paid, *send a photo of your receipt* — that\'s all we need. ');
  lines.push('_You can send up to two images. No transaction ID to type._');

  // The receipt IS the proof now. Collect it (up to two), submitting proof on the
  // first one. Every locked slice of this deposit is proven together.
  ctx.session.step = { name: 'add:receipt', fillId: fills[0]!.id };
  await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
}

const MAX_RECEIPTS = 2;

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

  // First receipt for this deposit → submit proof for every locked slice, and
  // push the receipt image + Verify button to the admins (p_notify=false so the
  // DB doesn't ALSO alert — the image card is the one that matters).
  const locked = await sql<{ id: string }[]>`
    select id from fills where deposit_id = ${f!.deposit_id} and status = 'locked' order by seq`;
  if (locked.length) {
    try {
      for (const lf of locked) await sql`select fill_submit_proof(${lf.id}::uuid, null, null, false)`;
    } catch (err) {
      if (isUserError(err)) { await ctx.reply(`❌ ${userMessage(err)}`); ctx.session.step = { name: 'idle' }; return; }
      throw err;
    }
    await sendReceiptToReviewer(fillId, fileId);
  }

  // Count receipts on this fill so far; allow a second, then wrap up.
  const [rc] = await sql<{ n: number }[]>`
    select count(*)::int n from receipts where ref_type='fill' and ref_id=${fillId}`;
  if ((rc?.n ?? 1) < MAX_RECEIPTS) {
    await ctx.reply('✅ Receipt saved. Send *one more* image if you have it, or tap /done.', { parse_mode: 'Markdown' });
    return;
  }
  ctx.session.step = { name: 'idle' };
  await ctx.reply(finishedMessage());
}

/** /done or /skip during receipt collection — wrap up. If the player never sent
 *  a receipt, still submit proof (with an admin alert) so their payment isn't
 *  stranded; an admin can follow up. */
export async function addDone(ctx: Ctx, fillId: string): Promise<void> {
  const sql = db();
  const [f] = await sql<{ deposit_id: string | null }[]>`select deposit_id from fills where id = ${fillId}`;
  if (f?.deposit_id) {
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

/** Queue the receipt image + action buttons to the right reviewer. */
async function sendReceiptToReviewer(fillId: string, fileId: string): Promise<void> {
  const sql = db();
  const [f] = await sql<{
    withdraw_id: string | null; amount: number; currency: string;
    payment_ref: string | null; method: string; payee_id: string | null;
    depositor_name: string | null; url: string | null;
  }[]>`
    select f.withdraw_id, f.amount, f.currency, f.payment_ref,
           pm.name as method, w.player_id as payee_id, dp.display_name as depositor_name,
           (select r.url from receipts r where r.ref_type='fill' and r.ref_id=f.id order by r.created_at desc limit 1) as url
      from fills f
      join payment_methods pm on pm.id = f.method_id
      left join withdraw_requests w on w.id = f.withdraw_id
      left join deposit_requests d on d.id = f.deposit_id
      left join players dp on dp.id = d.player_id
     where f.id = ${fillId}`;
  if (!f) return;

  const payload = {
    fill_id: fillId, file_id: fileId, url: f.url,
    amount: f.amount, currency: f.currency, payment_ref: f.payment_ref,
    method: f.method, name: f.depositor_name,
  };

  // The admin group gets the receipt image + a Verify button. Admins are the ONLY
  // confirmers now — one tap releases the money, for P2P and club alike. The payee
  // is not asked to confirm anything.
  await sql`select notify_admins('fill.receipt_admin', 'fill', ${fillId}::uuid, ${sql.json(payload)}::jsonb)`;
}

export async function addSkipReceipt(ctx: Ctx): Promise<void> {
  ctx.session.step = { name: 'idle' };
  await ctx.reply(finishedMessage());
}

function finishedMessage(): string {
  return (
    `✅ *All set!*\n\nWe'll check your payment and add your money. ` +
    `You'll get a message here the moment it's done. Check anytime with /me.`
  );
}
