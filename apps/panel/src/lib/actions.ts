'use server';

import { revalidatePath } from 'next/cache';
import { db, isUserError, userMessage } from '@union/core';
import { requireAdmin, requireOwner } from './auth';

/**
 * Every admin action in the panel. Each is a thin wrapper over a plpgsql
 * function — the panel decides nothing about money, it authenticates the caller
 * and passes their admin id so the database attributes and audits it.
 *
 * These are the SAME functions the Telegram admin group calls, so an action
 * taken in either place is identical and instantly reflected in the other.
 *
 * What is NOT here: no UPDATE, no INSERT, no ledger writes (except allow-listed
 * config/method edits, which are audited). If an action cannot be expressed as a
 * call to a vetted DB function, it does not belong in the panel.
 */

export type Result = { ok: true; message?: string } | { ok: false; error: string };

async function run(fn: () => Promise<string | void>, paths: string[] = ['/']): Promise<Result> {
  try {
    const message = await fn();
    for (const p of paths) revalidatePath(p);

    // Send any notifications this action queued, RIGHT NOW. Panel actions (like
    // approving a player) write to the notification outbox but do not go through
    // the bot webhook, so without this the player's "you're approved!" message
    // would sit undelivered until the next cron. Draining here makes panel
    // actions notify instantly, same as Telegram actions do. Best-effort.
    try {
      const { getBot, drainNotifications } = await import('./bot');
      const bot = await getBot();
      await drainNotifications(bot, 15);
    } catch (e) {
      console.error('[panel] notify drain failed:', e);
    }

    return { ok: true, ...(message ? { message } : {}) };
  } catch (err) {
    const m = (err as Error).message;
    if (m === 'FORBIDDEN') return { ok: false, error: 'Owner access required.' };
    if (m === 'UNAUTHENTICATED') return { ok: false, error: 'Please sign in again.' };
    if (m === 'MFA_REQUIRED') return { ok: false, error: 'Two-factor authentication is required.' };
    if (isUserError(err)) return { ok: false, error: userMessage(err) };
    console.error('[panel] action failed:', err);
    return { ok: false, error: 'Something went wrong. Nothing was changed.' };
  }
}

// ─── Players ─────────────────────────────────────────────────────────────────

export async function confirmPlayer(playerId: string, platformId: string, uid?: string): Promise<Result> {
  return run(async () => {
    const s = await requireAdmin();
    await db()`select player_link(${playerId}::uuid, ${platformId}::uuid, ${s.admin.id}::uuid, ${uid ?? null})`;
    return 'Account confirmed and activated.';
  }, ['/players', '/']);
}

export async function setPlayerName(playerId: string, name: string): Promise<Result> {
  return run(async () => {
    const s = await requireAdmin();
    await db()`select player_set_name(${playerId}::uuid, ${name}, ${s.admin.id}::uuid)`;
    return 'Name updated.';
  }, ['/players']);
}

export async function assignClub(playerId: string, platformId: string, clubId: string): Promise<Result> {
  return run(async () => {
    const s = await requireAdmin();
    await db()`select player_set_club(${playerId}::uuid, ${platformId}::uuid, ${clubId}::uuid, ${s.admin.id}::uuid)`;
    return 'Club assigned.';
  }, ['/players', '/']);
}

export async function setPlayerStatus(
  playerId: string, status: 'active' | 'frozen' | 'banned', reason: string,
): Promise<Result> {
  return run(async () => {
    const s = await requireAdmin();
    await db()`select player_set_status(${playerId}::uuid, ${status}::player_status, ${s.admin.id}::uuid, ${reason})`;
    return `Player is now ${status === 'frozen' ? 'on hold' : status}.`;
  }, ['/players']);
}

export async function adjustPlayer(
  playerId: string, platformId: string, amount: number, currency: string, reason: string,
): Promise<Result> {
  return run(async () => {
    const s = await requireOwner();
    await db()`select admin_adjust(${playerId}::uuid, ${platformId}::uuid, ${amount}::bigint, ${currency}, ${s.admin.id}::uuid, ${reason})`;
    return 'Adjustment saved.';
  }, ['/players', '/']);
}

// ─── Payments (fills) ────────────────────────────────────────────────────────

export async function verifyPayment(fillId: string, note: string): Promise<Result> {
  return run(async () => {
    const s = await requireAdmin();
    await db()`select fill_admin_verify(${fillId}::uuid, ${s.admin.id}::uuid, ${note})`;
    return 'Verified and released.';
  }, ['/transactions', '/']);
}

export async function reversePayment(fillId: string, reason: string, freeze: boolean): Promise<Result> {
  return run(async () => {
    const s = await requireOwner();
    await db()`select fill_reversal(${fillId}::uuid, ${s.admin.id}::uuid, ${reason}, ${freeze})`;
    return 'Reversal recorded as a loss.';
  }, ['/transactions', '/']);
}

// ─── Disputes ────────────────────────────────────────────────────────────────

export async function resolveDispute(
  disputeId: string,
  resolution: 'release_to_depositor' | 'refund_to_payee' | 'split',
  note: string, splitToDepositor: number | null,
  flagDepositor: boolean, flagPayee: boolean,
): Promise<Result> {
  return run(async () => {
    const s = await requireAdmin();
    await db()`
      select dispute_resolve(${disputeId}::uuid, ${s.admin.id}::uuid, ${resolution},
                             ${note}, ${splitToDepositor}::bigint, ${flagDepositor}, ${flagPayee})`;
    return 'Sorted.';
  }, ['/disputes', '/']);
}

// ─── Loader jobs ─────────────────────────────────────────────────────────────

export async function claimJob(orderId: string): Promise<Result> {
  return run(async () => {
    const s = await requireAdmin();
    await db()`select loader_order_claim(${orderId}::uuid, ${s.admin.id}::uuid)`;
    return "Claimed — it's yours.";
  }, ['/jobs', '/']);
}

export async function completeJob(orderId: string, actualDelta: number | null, note: string): Promise<Result> {
  return run(async () => {
    const s = await requireAdmin();
    await db()`select loader_order_complete(${orderId}::uuid, ${s.admin.id}::uuid, ${actualDelta}::bigint, ${note})`;
    return 'Done.';
  }, ['/jobs', '/']);
}

export async function failJob(orderId: string, reason: string): Promise<Result> {
  return run(async () => {
    const s = await requireAdmin();
    await db()`select loader_order_fail(${orderId}::uuid, ${s.admin.id}::uuid, ${reason})`;
    return 'Marked failed.';
  }, ['/jobs', '/']);
}

export async function releaseJob(orderId: string): Promise<Result> {
  return run(async () => {
    const s = await requireAdmin();
    await db()`select loader_order_release(${orderId}::uuid, ${s.admin.id}::uuid)`;
    return 'Put back for someone else.';
  }, ['/jobs']);
}

// ─── Cash outs (withdrawals) ─────────────────────────────────────────────────

export async function payFromClub(
  withdrawId: string, amount: number | null, paymentRef: string, note: string,
): Promise<Result> {
  return run(async () => {
    const s = await requireAdmin();
    await db()`select withdraw_club_payout(${withdrawId}::uuid, ${s.admin.id}::uuid, ${amount}::bigint, ${paymentRef}, ${note})`;
    return 'Paid and closed.';
  }, ['/queue', '/']);
}

export async function cancelCashout(withdrawId: string, reason: string): Promise<Result> {
  return run(async () => {
    const s = await requireAdmin();
    await db()`select withdraw_cancel(${withdrawId}::uuid, ${s.admin.id}::uuid, ${reason})`;
    return 'Cancelled.';
  }, ['/queue']);
}

// ─── Config (owner only) ─────────────────────────────────────────────────────

export async function updateConfig(patch: Record<string, unknown>): Promise<Result> {
  return run(async () => {
    const s = await requireOwner();
    const sql = db();
    const allowed = new Set([
      'base_currency', 'match_timeout_seconds', 'allow_reversible',
      'reversible_hold_seconds', 'auto_release_on_expiry',
      'rake_deposit_bps', 'rake_deposit_flat', 'rake_withdraw_bps', 'rake_withdraw_flat',
      'fee_bearer', 'min_amount', 'max_amount', 'daily_cap_per_player',
      'max_open_deposits_per_player', 'max_open_withdraws_per_player',
      'handle_reveals_per_hour', 'owner_approval_threshold', 'confirm_escalation_seconds',
    ]);
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) if (allowed.has(k)) clean[k] = v;
    if (!Object.keys(clean).length) throw new Error('nothing to update');

    const [before] = await sql`select * from config where id`;
    await sql`update config set ${sql(clean)}, updated_by = ${s.admin.id} where id`;
    const [after] = await sql`select * from config where id`;
    await sql`select audit(${s.admin.id}::uuid, 'config.update', 'config', null,
                           ${sql.json({ before, after, changed: Object.keys(clean) } as any)}::jsonb)`;
    return 'Saved.';
  }, ['/config', '/']);
}

export async function upsertMethod(patch: Record<string, unknown>): Promise<Result> {
  return run(async () => {
    const s = await requireOwner();
    const sql = db();
    const allowed = new Set([
      'code', 'name', 'currency', 'reversibility', 'settlement', 'enabled',
      'min_amount', 'max_amount', 'club_handle', 'hold_seconds',
      'processor_fee_bps', 'processor_fee_flat', 'handle_hint', 'handle_pattern', 'sort_order',
    ]);
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) if (allowed.has(k)) clean[k] = v;

    const id = patch.id as string | undefined;
    if (id) {
      delete clean.code;
      await sql`update payment_methods set ${sql(clean)} where id = ${id}`;
    } else {
      await sql`insert into payment_methods ${sql(clean)}`;
    }
    await sql`select audit(${s.admin.id}::uuid, ${id ? 'method.update' : 'method.create'},
                           'payment_method', ${id ?? null}::uuid, ${sql.json(clean as any)}::jsonb)`;
    return 'Payment method saved.';
  }, ['/config']);
}

export async function setClubDetails(
  clubId: string, platformClubId: string, ownerAdminId: string | null,
): Promise<Result> {
  return run(async () => {
    const s = await requireOwner();
    const sql = db();
    await sql`update clubs set platform_club_id = ${platformClubId}, owner_admin_id = ${ownerAdminId} where id = ${clubId}`;
    await sql`select audit(${s.admin.id}::uuid, 'club.update', 'club', ${clubId}::uuid,
                           ${sql.json({ platform_club_id: platformClubId }) as any}::jsonb)`;
    return 'Club saved.';
  }, ['/config']);
}
