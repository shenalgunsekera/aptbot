import { InlineKeyboard } from 'grammy';
import { db } from '@union/core';
import type { Ctx } from '../session.js';
import { currentPlayer } from '../player.js';
import { money, friendlyStatus } from '../words.js';
import { startOnboarding, advance, isOnboarded } from './onboarding.js';

/**
 * /start — the front door.
 *
 * A finished player gets their account summary. Anyone who hasn't finished the
 * guided setup (brand new, or stalled partway) is dropped straight back into it,
 * exactly where they left off — no re-typing what they already gave us. Frozen
 * or banned accounts are told plainly.
 */
export async function start(ctx: Ctx): Promise<void> {
  const sql = db();
  const p = await currentPlayer(ctx);

  if (p && (p.status === 'frozen' || p.status === 'banned')) {
    await ctx.reply(
      p.status === 'frozen'
        ? "Your account is on hold while we look into something. Your money is safe — someone will be in touch."
        : "This account has been closed. Reach out if you think that's a mistake.",
    );
    return;
  }

  // Already finished setup → show the summary, don't re-onboard.
  if (p && (await isOnboarded(p.id))) {
    const accts = await sql<{ name: string; uid: string | null; claimed: string | null }[]>`
      select pf.name, pp.platform_uid as uid, pp.platform_uid_claimed as claimed
        from player_platforms pp join platforms pf on pf.id = pp.platform_id
       where pp.player_id = ${p.id} and pp.active
       order by pf.sort_order`;
    const acctLines = accts.length
      ? '\n\nYour accounts:\n' + accts.map((a) =>
          `  • ${a.name}: ${a.uid ?? a.claimed}${a.uid ? '' : ' (being confirmed)'}`).join('\n')
      : '';
    await ctx.reply(
      `You're all set${p.display_name ? ', ' + p.display_name : ''} — you already have an account.${acctLines}\n\n` +
        `💵 /deposit — add money\n` +
        `💸 /withdraw — cash out\n` +
        `📄 /payments — your payments & receipts\n` +
        `📋 /pending — your account\n` +
        `➕ /editplatform · 🏆 /editclubs · 💳 /methods · 🏦 /payout — update your setup\n` +
        `💬 /support — message our team`,
    );
    return;
  }

  // New or unfinished → (re)start the guided setup where it left off.
  if (!p) {
    await startOnboarding(ctx);
    return;
  }
  if (!ctx.session.ob) {
    // Session was reset mid-setup; rebuild the plan from what's already stored.
    const rows = await sql<{ platform_id: string }[]>`
      select platform_id from player_platforms where player_id = ${p.id} and active`;
    ctx.session.ob = { platforms: rows.map((r) => r.platform_id) };
  }
  await advance(ctx, p.id);
}

/**
 * /pending — the player's account. NO available balance: that number does not exist.
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
     where pp.player_id = ${p.id} and pp.active order by pf.sort_order`;
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
  const outs = await sql<{ id: string; requested_amount: number; amount: number | null; currency: string; status: string; method_code: string }[]>`
    select w.id, w.requested_amount, w.amount, w.currency, w.status, pm.code as method_code
      from withdraw_requests w join payment_methods pm on pm.id = w.method_id
     where w.player_id = ${p.id} and w.status in ('pending_unload','queued','partially_filled','filled')
     order by w.created_at`;

  if (deps.length || outs.length) {
    lines.push('*In progress*');
    for (const d of deps) lines.push(`  ↓ Adding ${money(d.amount, d.currency)} — ${friendlyStatus('deposit', d.status)}`);
    for (const o of outs) lines.push(`  ↑ Cashing out ${money(o.amount ?? o.requested_amount, o.currency)} — ${friendlyStatus('withdraw', o.status)}`);
    lines.push('');
  }

  // A cash out can be pulled back while it's still waiting (not fully paid). For
  // methods where WE send (Venmo/Zelle/crypto) you can also take PART back;
  // PayPal/Cash App requests can't be lowered, so it's cancel-all only.
  const cancellable = outs.filter((o) => ['pending_unload', 'queued', 'partially_filled'].includes(o.status));
  const reducible = (code: string) => code !== 'paypal' && code !== 'cashapp';
  const kb = new InlineKeyboard();
  for (const o of cancellable) {
    kb.text(`✖️ Cancel ${money(o.amount ?? o.requested_amount, o.currency)}`, `wd:retract:${o.id}`);
    if (reducible(o.method_code) && ['queued', 'partially_filled'].includes(o.status)) {
      kb.text('➖ Take some back', `wd:reduce:${o.id}`);
    }
    kb.row();
  }

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'Markdown',
    reply_markup: cancellable.length ? kb : undefined,
  });
}
