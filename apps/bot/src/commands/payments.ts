import { db } from '@union/core';
import type { Ctx } from '../session.js';
import { currentPlayer } from '../player.js';
import { money, friendlyStatus } from '../words.js';

/**
 * /payments — the player's own money tracker.
 *
 * The point (from the spec): a $100 cash out paid as 50 + 25 + 25 by three
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

  const outOngoing = outs.filter((w) => ONGOING_WD.has(w.status));
  const outDone = outs.filter((w) => !ONGOING_WD.has(w.status)).slice(0, 3);
  const depOngoing = deps.filter((d) => ONGOING_DEP.has(d.status));
  const depDone = deps.filter((d) => !ONGOING_DEP.has(d.status)).slice(0, 3);

  if (!outs.length && !deps.length) {
    await ctx.reply("You haven't added or cashed out any money yet. Use /add or /cashout to start.");
    return;
  }

  const lines: string[] = [];

  if (outOngoing.length) {
    lines.push('*💸 Cash outs in progress*\n');
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
    // Everything is old/done beyond the recent window — still let them see it.
    lines.push('*Your recent payments*\n');
    for (const w of outs.slice(0, 5)) lines.push(renderCashout(w, true));
  }

  const full = lines.join('\n').trim();
  for (const chunk of chunkMarkdown(full, 3800)) {
    await ctx.reply(chunk, { parse_mode: 'Markdown', link_preview_options: { is_disabled: true } });
  }
}

function renderCashout(w: any, brief = false): string {
  const total = w.total_amount || w.requested;
  const paid = w.amount_paid ?? 0;
  const out: string[] = [
    `*${money(total)}* via ${w.method} — _${friendlyStatus('withdraw', w.status)}_` +
      (paid > 0 && paid < total ? `  (${money(paid)} of ${money(total)} paid)` : ''),
  ];
  const pays = (w.payments ?? []) as any[];
  if (pays.length && !brief) {
    for (const [i, pay] of pays.entries()) out.push(payLine(i, pay));
  } else if (pays.length && brief) {
    // Brief: just the receipt links, still reachable.
    const withReceipts = pays.filter((x) => x.receipt);
    for (const [i, pay] of withReceipts.entries()) {
      out.push(`  📄 [Receipt ${pay.receipt_ref ?? i + 1}](${pay.receipt}) — ${money(pay.amount)}`);
    }
  }
  return out.join('\n') + '\n';
}

function renderDeposit(d: any, brief = false): string {
  const out: string[] = [`*${money(d.amount)}* via ${d.method} — _${friendlyStatus('deposit', d.status)}_`];
  const pays = (d.payments ?? []) as any[];
  for (const [i, pay] of pays.entries()) {
    if (brief && !pay.receipt) continue;
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
    (pay.receipt ? `\n     📄 [Receipt ${pay.receipt_ref ?? ''}](${pay.receipt})` : '')
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
