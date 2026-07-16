import { InlineKeyboard } from 'grammy';
import {
  db, isUserError, userMessage, uploadReceipt, storageConfigured,
  type PaymentMethod, type Fill, type Platform,
} from '@union/core';
import type { Ctx } from '../session.js';
import { requireActive } from '../player.js';
import { money, parseAmount } from '../words.js';
import {
  resolvePlatform, resolveMethod, platformKeyboard, methodKeyboard,
} from '../prefs.js';

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
  const [cfg] = await sql<{ min_amount: number; max_amount: number }[]>`
    select min_amount, max_amount from config where id`;
  ctx.session.step = { name: 'add:amount', platformId: platform.id };
  await ctx.reply(
    `How much do you want to add to *${platform.name}*?\n\n` +
      `Between ${money(cfg.min_amount)} and ${money(cfg.max_amount)}. ` +
      `Just send the number, like \`50\` or \`127.50\`.\n\n/cancel to stop.`,
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
    await ctx.reply("That doesn't look like an amount. Try `50` or `127.50`.", { parse_mode: 'Markdown' });
    return;
  }

  const method = await resolveMethod(p.id);
  if ('ask' in method) {
    if (method.ask.length === 0) {
      await ctx.reply('No payment methods are available right now. Please contact us.');
      ctx.session.step = { name: 'idle' };
      return;
    }
    ctx.session.step = { name: 'add:method', platformId, amount };
    await ctx.reply(`Adding *${money(amount)}* — how do you want to pay?`, {
      parse_mode: 'Markdown',
      reply_markup: methodKeyboard('add', method.ask, method.offerRemember),
    });
    return;
  }
  await runMatch(ctx, platformId, amount, method.pick.id);
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
  lines.push('When you have paid, send me the *transaction ID / reference*.');
  lines.push('_Then send a photo of your receipt — it protects you if anything goes wrong._');

  ctx.session.step = { name: 'add:txid', fillId: fills[0]!.id };
  await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
}

/** Player sent a transaction ID for the current fill. */
export async function addTxid(ctx: Ctx, fillId: string, ref: string): Promise<void> {
  const sql = db();
  try {
    await sql`select fill_submit_proof(${fillId}::uuid, ${ref}, null)`;
  } catch (err) {
    if (isUserError(err)) {
      await ctx.reply(`❌ ${userMessage(err)}`);
      ctx.session.step = { name: 'idle' };
      return;
    }
    throw err;
  }

  // More slices to pay?
  const [f] = await sql<Fill[]>`select * from fills where id = ${fillId}`;
  const [next] = await sql<Fill[]>`
    select * from fills where deposit_id = ${f.deposit_id} and status = 'locked' order by seq limit 1`;

  if (next) {
    ctx.session.step = { name: 'add:txid', fillId: next.id };
    await ctx.reply(
      `✅ Got it.\n\nNow the next one — send the transaction ID for *${money(next.gross_to_send, next.currency)}* to \`${next.payout_handle}\`.`,
      { parse_mode: 'Markdown' },
    );
    return;
  }

  // All slices have a ref. Offer the receipt upload.
  ctx.session.step = { name: 'add:receipt', fillId };
  await ctx.reply(
    `✅ *Payment recorded.*\n\n📸 Now send a *photo of your receipt* — it's your proof if anything goes wrong. ` +
      `Or tap /skip if you don't have one.`,
    { parse_mode: 'Markdown' },
  );
}

/** Player sent a receipt photo. Download from Telegram, push to Storage. */
export async function addReceipt(ctx: Ctx, fillId: string): Promise<void> {
  const sql = db();
  const p = await requireActive(ctx);
  if (!p) return;

  const photo = ctx.message?.photo?.at(-1);
  const doc = ctx.message?.document;
  const fileId = photo?.file_id ?? (doc?.mime_type?.startsWith('image/') || doc?.mime_type === 'application/pdf' ? doc.file_id : undefined);
  if (!fileId) {
    await ctx.reply("That doesn't look like a photo. Send a picture of your receipt, or /skip.");
    return;
  }

  const [f] = await sql<{ deposit_id: string | null; withdraw_id: string | null }[]>`
    select deposit_id, withdraw_id from fills where id = ${fillId}`;
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
      // Storage not set up — keep the Telegram file_id so nothing is lost.
      await sql`
        select receipt_add(
          ${p.id}::uuid, 'fill', ${fillId}::uuid, ${'telegram:' + fileId}, ${'telegram:' + fileId},
          ${platformId}::uuid, null, null, ${fileId}, ${p.id}::uuid, null)`;
    }
  } catch (err) {
    console.error('receipt upload failed:', err);
    await ctx.reply('Saved your payment, but the receipt image failed to upload. That’s okay — the transaction ID is what matters most.');
    ctx.session.step = { name: 'idle' };
    return;
  }

  // Push the receipt IMAGE to whoever needs to act on it, so they see the actual
  // proof in Telegram — not just a reference. Payee for a P2P fill, the admin
  // group for a club-mediated one. Queued to the outbox (drains on this webhook).
  await sendReceiptToReviewer(fillId, fileId);

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

  // The admin group ALWAYS gets the receipt image + a verify button — admins
  // oversee and can confirm any payment, P2P or club-mediated.
  await sql`select notify_admins('fill.receipt_admin', 'fill', ${fillId}::uuid, ${sql.json(payload)}::jsonb)`;

  // For a P2P payment the payee also gets it, since it is their money and their
  // confirmation that normally releases it.
  if (f.withdraw_id && f.payee_id) {
    await sql`select notify_player(${f.payee_id}::uuid, 'fill.receipt_payee', 'fill', ${fillId}::uuid, ${sql.json(payload)}::jsonb)`;
  }
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
