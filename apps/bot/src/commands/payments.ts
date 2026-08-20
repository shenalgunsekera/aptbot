import { db } from '@union/core';
import type { Ctx } from '../session.js';
import { currentPlayer } from '../player.js';
import { money, friendlyStatus } from '../words.js';

/**
 * /withdrawalhistory — money the player RECEIVED (their cash-outs), with receipts.
 * /deposithistory    — money the player ADDED (their deposits), with receipts.
 *
 * A $100 cash-out paid as 50 + 25 + 25 by three different people is three
 * payments, and the player must be able to see each one AND its receipt any time.
 *
 * SECURITY: player_payments/player_deposits are scoped to this player's id, and
 * currentPlayer() resolves it from the verified user — a player never sees
 * another player's history or receipts.
 */
const ONGOING_WD = new Set(['pending_unload', 'queued', 'partially_filled', 'filled']);
const ONGOING_DEP = new Set(['matching', 'awaiting_payment', 'awaiting_confirmation']);

/** /withdrawalhistory — the cash-outs the player has been (or is being) paid. */
export async function withdrawalHistory(ctx: Ctx): Promise<void> {
  const p = await currentPlayer(ctx);
  if (!p) return void (await ctx.reply('Send /start to get set up first.'));
  const outs = await db()<any[]>`select * from player_payments(${p.id}::uuid) limit 25`;
  if (!outs.length) {
    return void (await ctx.reply("You haven't cashed out any money yet. Use /withdraw to start."));
  }
  const ongoing = outs.filter((w) => ONGOING_WD.has(w.status));
  const done = outs.filter((w) => w.status === 'completed').slice(0, 5);

  const lines: string[] = [];
  if (ongoing.length) { lines.push('*💸 Cash-outs in progress*\n'); for (const w of ongoing) lines.push(renderCashout(w)); }
  if (done.length) { lines.push('*✅ Recently paid*\n'); for (const w of done) lines.push(renderCashout(w, true)); }
  if (!lines.length) lines.push('No completed cash-outs yet.');

  await sendChunks(ctx, lines);
  await postReceipts(ctx, [...ongoing, ...done]);
}

/** /deposithistory — the deposits the player has made, with the receipts sent. */
export async function depositHistory(ctx: Ctx): Promise<void> {
  const p = await currentPlayer(ctx);
  if (!p) return void (await ctx.reply('Send /start to get set up first.'));
  const deps = await db()<any[]>`select * from player_deposits(${p.id}::uuid) limit 25`;
  if (!deps.length) {
    return void (await ctx.reply("You haven't added any money yet. Use /deposit to start."));
  }
  const ongoing = deps.filter((d) => ONGOING_DEP.has(d.status));
  const done = deps.filter((d) => d.status === 'completed').slice(0, 5);

  const lines: string[] = [];
  if (ongoing.length) { lines.push('*💵 Money you\'re adding*\n'); for (const d of ongoing) lines.push(renderDeposit(d)); }
  if (done.length) { lines.push('*✅ Recently added*\n'); for (const d of done) lines.push(renderDeposit(d, true)); }
  if (!lines.length) lines.push('No completed deposits yet.');

  await sendChunks(ctx, lines);
  await postReceipts(ctx, [...ongoing, ...done]);
}

async function sendChunks(ctx: Ctx, lines: string[]): Promise<void> {
  const full = lines.join('\n').trim();
  for (const chunk of chunkMarkdown(full, 3800)) {
    await ctx.reply(chunk, { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } });
  }
}

/** Post the actual receipt IMAGES so every screenshot is viewable — a Telegram
 *  file_id and an http url both work with sendPhoto, which is why a file_id
 *  receipt (e.g. from /adjust) shows here even though it isn't a clickable link. */
async function postReceipts(ctx: Ctx, items: any[]): Promise<void> {
  const seen = new Set<string>();
  for (const it of items) {
    for (const pay of (it.payments ?? []) as any[]) {
      for (const rc of receiptsOf(pay)) {
        if (seen.has(rc.url)) continue;
        seen.add(rc.url);
        try {
          await ctx.replyWithPhoto(rc.url, {
            caption: `Receipt ${rc.ref ?? ''} — ${money(pay.amount)}${pay.ref ? ` · ref ${pay.ref}` : ''}`,
          });
        } catch { /* a broken/expired image link shouldn't break the list */ }
      }
    }
  }
}

/** Every receipt on a payment as {url, ref}. Prefers the `receipts` array (all
 *  screenshots); falls back to the singular `receipt`/`receipt_ref`. */
function receiptsOf(pay: any): { url: string; ref?: string }[] {
  const list = Array.isArray(pay.receipts) && pay.receipts.length
    ? pay.receipts.map((r: any) => (typeof r === 'string' ? { url: r } : r))
    : (pay.receipt ? [{ url: pay.receipt, ref: pay.receipt_ref }] : []);
  return list.filter((r: any) => r?.url);
}

/** Receipt lines. Only an http(s) url becomes a clickable link — a Telegram
 *  file_id isn't a URL, so it's shown as plain text and posted as an image below. */
function receiptLinks(pay: any): string {
  return receiptsOf(pay).map((r) =>
    /^https?:\/\//i.test(r.url)
      ? `\n     📄 [Receipt ${r.ref ?? ''}](${r.url})`
      : `\n     📄 Receipt ${r.ref ?? ''} _(image below)_`,
  ).join('');
}

function renderCashout(w: any, brief = false): string {
  const total = w.total_amount || w.requested;
  const paid = w.amount_paid ?? 0;
  const out: string[] = [
    `*${money(total)}* via ${w.method} — _${friendlyStatus('withdraw', w.status)}_` +
      (paid > 0 && paid < total ? `  (${money(paid)} / ${money(total)} paid)` : ''),
  ];
  const pays = (w.payments ?? []) as any[];
  if (pays.length && !brief) {
    for (const [i, pay] of pays.entries()) out.push(payLine(i, pay));
  } else if (pays.length && brief) {
    for (const pay of pays) {
      const links = receiptLinks(pay);
      if (links) out.push(`  💵 ${money(pay.amount)}${links}`);
    }
  }
  return out.join('\n') + '\n';
}

function renderDeposit(d: any, brief = false): string {
  const out: string[] = [`*${money(d.amount)}* via ${d.method} — _${friendlyStatus('deposit', d.status)}_`];
  const pays = (d.payments ?? []) as any[];
  for (const [i, pay] of pays.entries()) {
    if (brief && receiptsOf(pay).length === 0) continue;
    out.push(payLine(i, pay, pay.to));
  }
  return out.join('\n') + '\n';
}

function payLine(i: number, pay: any, to?: string): string {
  const tick = pay.status === 'released' ? '✅' : pay.status === 'disputed' ? '⏸' : '⏳';
  return (
    `  ${tick} Payment ${i + 1}: *${money(pay.amount)}*` +
    (to ? ` to \`${to}\`` : '') +
    (pay.ref ? ` — ref \`${pay.ref}\`` : '') +
    receiptLinks(pay)
  );
}

/** Split on blank lines so we never cut a Markdown link in half. */
function chunkMarkdown(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const blocks = text.split('\n\n');
  const out: string[] = [];
  let cur = '';
  for (const b of blocks) {
    if ((cur + '\n\n' + b).length > max && cur) { out.push(cur); cur = b; }
    else cur = cur ? cur + '\n\n' + b : b;
  }
  if (cur) out.push(cur);
  return out;
}
