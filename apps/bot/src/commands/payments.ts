import { db } from '@union/core';
import type { Ctx } from '../session.js';
import { currentPlayer } from '../player.js';
import { money, friendlyStatus } from '../words.js';

/**
 * /payments — the player's own money tracker.
 *
 * The point (from the spec): a $100 cash-out paid as 50 + 25 + 25 by three
 * different people is three payments, and the player must be able to see each
 * one and its receipt any time.
 *
 * ONGOING first, in full detail with receipts — that's what a player watches.
 * A few recently-finished ones follow, receipts still linked, so nothing they
 * were paid ever becomes unreachable.
 *
 * SECURITY: player_payments/player_deposits are scoped to this player's id, and
 * currentPlayer() resolves it from the verified Telegram user. A player can
 * never see another player's payments or receipts.
 */
const ONGOING_WD = new Set(['pending_unload', 'queued', 'partially_filled', 'filled']);
const ONGOING_DEP = new Set(['matching', 'awaiting_payment', 'awaiting_confirmation']);

export async function payments(ctx: Ctx): Promise<void> {
  const sql = db();
  const p = await currentPlayer(ctx);
  if (!p) return void (await ctx.reply('Send /start to get set up first.'));

  const outs = await sql<any[]>`select * from player_payments(${p.id}::uuid) limit 25`;
  const deps = await sql<any[]>`select * from player_deposits(${p.id}::uuid) limit 25`;

  // Only show payments that actually went through — never cancelled/expired ones.
  const outOngoing = outs.filter((w) => ONGOING_WD.has(w.status));
  const outDone = outs.filter((w) => w.status === 'completed').slice(0, 3);
  const depOngoing = deps.filter((d) => ONGOING_DEP.has(d.status));
  const depDone = deps.filter((d) => d.status === 'completed').slice(0, 3);

  if (!outs.length && !deps.length) {
    await ctx.reply("You haven't added or cashed out any money yet. Use /deposit or /withdraw to start.");
    return;
  }

  const lines: string[] = [];

  if (outOngoing.length) {
    lines.push('*💸 Cash-outs in progress*\n');
    for (const w of outOngoing) lines.push(renderCashout(w));
  }
  if (depOngoing.length) {
    lines.push('*💵 Money you\'re adding*\n');
    for (const d of depOngoing) lines.push(renderDeposit(d));
  }

  if (outDone.length || depDone.length) {
    lines.push('*✅ Recently finished*\n');
    for (const w of outDone) lines.push(renderCashout(w, true));
    for (const d of depDone) lines.push(renderDeposit(d, true));
  }

  if (!lines.length) {
    // Everything is old/done beyond the recent window — still let them see the
    // completed ones (never cancelled).
    const done = outs.filter((w) => w.status === 'completed').slice(0, 5);
    if (done.length) {
      lines.push('*Your recent payments*\n');
      for (const w of done) lines.push(renderCashout(w, true));
    } else {
      lines.push('No completed payments yet.');
    }
  }

  const full = lines.join('\n').trim();
  for (const chunk of chunkMarkdown(full, 3800)) {
    await ctx.reply(chunk, { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } });
  }

  // Then send the actual receipt IMAGES — but only for what a player is actively
  // watching: everything in progress, plus the SINGLE most recent finished one.
  // Older finished payments keep their receipt LINK in the text above; we don't
  // re-post every image or the chat floods.
  const seen = new Set<string>();
  const mostRecentDone = outs.find((w) => w.status === 'completed');
  const showable = [
    ...outs.filter((w) => ONGOING_WD.has(w.status)),
    ...(mostRecentDone ? [mostRecentDone] : []),
  ];
  for (const w of showable) {
    for (const pay of (w.payments ?? []) as any[]) {
      // A payment can have up to two screenshots now — show every one.
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

/** Every receipt on a payment as {url, ref}. Prefers the new `receipts` array
 *  (all screenshots); falls back to the singular `receipt`/`receipt_ref`. */
function receiptsOf(pay: any): { url: string; ref?: string }[] {
  const list = Array.isArray(pay.receipts) && pay.receipts.length
    ? pay.receipts.map((r: any) => (typeof r === 'string' ? { url: r } : r))
    : (pay.receipt ? [{ url: pay.receipt, ref: pay.receipt_ref }] : []);
  return list.filter((r: any) => r?.url);
}

/** Markdown links for ALL of a payment's receipts, each on its own line. */
function receiptLinks(pay: any): string {
  return receiptsOf(pay).map((r) => `\n     📄 [Receipt ${r.ref ?? ''}](${r.url})`).join('');
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
    // Brief: just the receipt links (all of them), still reachable.
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
