import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  sql, resetState, mkPlayer, method, owner, grantChips,
  balance, houseBalance, assertLedgerHealthy, queueWithdraw, fillsOf,
} from './helpers.mjs';

let usdt, paypal, bank, adm;

before(async () => {
  usdt = await method('usdt_trc20');
  paypal = await method('paypal');
  bank = await method('bank_transfer');
  adm = await owner();
});
beforeEach(resetState);
after(async () => {
  // beforeEach cleans up for the NEXT test, so the last one's data would
  // otherwise survive the run and appear in the real admin panel as a phantom
  // player awaiting approval. Leave the database as we found it.
  await resetState();
  await sql.end();
});

// ═══════════════════════════════════════════════════════════════════════════
// The invariant
// ═══════════════════════════════════════════════════════════════════════════

test('unbalanced transaction cannot commit', async () => {
  const p = await mkPlayer('A', 1001);
  await assert.rejects(
    sql.begin(async (tx) => {
      await tx`select ledger_post('test.bad','player',${p.id}::uuid,null,null,
        jsonb_build_array(
          jsonb_build_object('account_id', account_of('player_wallet', ${p.id}::uuid, 'USD'), 'amount', 100::bigint),
          jsonb_build_object('account_id', account_of('house_rake', null, 'USD'), 'amount', (-50)::bigint)))`;
    }),
    /does not balance/,
  );
  await assertLedgerHealthy('after rejected unbalanced tx');
});

test('ledger_entries is append-only', async () => {
  const p = await mkPlayer('A', 1001);
  await grantChips(p.id, 500);
  await assert.rejects(sql`update ledger_entries set amount = 1`, /append-only/);
  await assert.rejects(sql`delete from ledger_entries`, /append-only/);
});

test('player balances cannot go negative', async () => {
  const p = await mkPlayer('A', 1001);
  await assert.rejects(
    sql.begin(async (tx) => {
      await tx`select ledger_post('test.neg','player',${p.id}::uuid,null,null,
        jsonb_build_array(
          jsonb_build_object('account_id', account_of('player_wallet', ${p.id}::uuid, 'USD'), 'amount', (-100)::bigint),
          jsonb_build_object('account_id', account_of('house_loss', null, 'USD'), 'amount', 100::bigint)))`;
    }),
    /negative/,
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Withdrawals
// ═══════════════════════════════════════════════════════════════════════════

test('withdraw unloads chips then escrows, and money is conserved', async () => {
  const p = await mkPlayer('W', 2001);
  await grantChips(p.id, 100_00);

  const w = await queueWithdraw(p, usdt, 60_00, 'TW-HANDLE');

  assert.equal(w.status, 'queued');
  assert.equal(w.amount, 60_00);
  assert.equal(w.amount_remaining, 60_00);
  assert.equal(await balance('player_chips', p.id), 40_00, 'chips reduced by unload');
  assert.equal(await balance('player_wallet', p.id), 0, 'wallet fully escrowed');
  assert.equal(await balance('player_escrow', p.id), 60_00, 'escrowed');
  await assertLedgerHealthy();
});

test('cannot withdraw more than wallet + chips', async () => {
  const p = await mkPlayer('W', 2001);
  await grantChips(p.id, 50_00);
  await assert.rejects(
    sql`select withdraw_create(${p.id}::uuid, ${usdt.id}::uuid, ${100_00}::bigint, 'T-X')`,
    /insufficient funds/,
  );
});

test('escrowed money is not spendable twice', async () => {
  const p = await mkPlayer('W', 2001);
  await grantChips(p.id, 100_00);
  await queueWithdraw(p, usdt, 100_00, 'T-A');
  // Everything is escrowed; a second withdrawal has nothing to draw on.
  await assert.rejects(
    sql`select withdraw_create(${p.id}::uuid, ${usdt.id}::uuid, ${50_00}::bigint, 'T-B')`,
    /insufficient funds/,
  );
  await assertLedgerHealthy();
});

test('cancelling an unfilled withdrawal returns escrow and rake', async () => {
  await sql`update config set rake_withdraw_bps = 200 where id`;   // 2%
  try {
    const p = await mkPlayer('W', 2001);
    await grantChips(p.id, 100_00);
    const w = await queueWithdraw(p, usdt, 50_00, 'T-A');

    assert.equal(w.rake_amount, 100, '2% of 5000');
    assert.equal(w.amount, 49_00, 'net payable');
    assert.equal(await houseBalance('house_rake'), 100);

    await sql`select withdraw_cancel(${w.id}::uuid, null, 'changed my mind')`;

    assert.equal(await balance('player_escrow', p.id), 0);
    assert.equal(await balance('player_wallet', p.id), 50_00, 'full gross returned');
    assert.equal(await houseBalance('house_rake'), 0, 'rake returned — service not rendered');
    await assertLedgerHealthy();
  } finally {
    await sql`update config set rake_withdraw_bps = 0 where id`;
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Matching — FIFO, partials, backstop
// ═══════════════════════════════════════════════════════════════════════════

test('matches strict FIFO, oldest first', async () => {
  const w1 = await mkPlayer('W1', 3001);
  const w2 = await mkPlayer('W2', 3002);
  const w3 = await mkPlayer('W3', 3003);
  const dep = await mkPlayer('D', 3009);
  for (const p of [w1, w2, w3]) await grantChips(p.id, 100_00);

  const r1 = await queueWithdraw(w1, usdt, 30_00, 'T-W1');
  await new Promise((r) => setTimeout(r, 15));
  const r2 = await queueWithdraw(w2, usdt, 30_00, 'T-W2');
  await new Promise((r) => setTimeout(r, 15));
  await queueWithdraw(w3, usdt, 30_00, 'T-W3');

  const [d] = await sql`select * from deposit_create(${dep.id}::uuid, ${usdt.id}::uuid, ${30_00}::bigint)`;
  const fills = await fillsOf(d.id);

  assert.equal(fills.length, 1);
  assert.equal(fills[0].withdraw_id, r1.id, 'matched the OLDEST withdrawal');
  assert.equal(fills[0].payout_handle, 'T-W1', 'revealed only that withdrawer handle');
  await assertLedgerHealthy();
});

test('a large deposit spills across withdrawals in FIFO order', async () => {
  const w1 = await mkPlayer('W1', 3001);
  const w2 = await mkPlayer('W2', 3002);
  const dep = await mkPlayer('D', 3009);
  for (const p of [w1, w2]) await grantChips(p.id, 100_00);

  const r1 = await queueWithdraw(w1, usdt, 60_00, 'T-W1');
  await new Promise((r) => setTimeout(r, 15));
  const r2 = await queueWithdraw(w2, usdt, 60_00, 'T-W2');

  // 100 against 60 + 60 → 60 to the first, 40 to the second.
  const [d] = await sql`select * from deposit_create(${dep.id}::uuid, ${usdt.id}::uuid, ${100_00}::bigint)`;
  const fills = await fillsOf(d.id);

  assert.equal(fills.length, 2, 'two slices, two fills');
  assert.equal(fills[0].withdraw_id, r1.id);
  assert.equal(fills[0].amount, 60_00);
  assert.equal(fills[1].withdraw_id, r2.id);
  assert.equal(fills[1].amount, 40_00);

  const [after1] = await sql`select * from withdraw_requests where id = ${r1.id}`;
  const [after2] = await sql`select * from withdraw_requests where id = ${r2.id}`;
  assert.equal(after1.amount_remaining, 0);
  assert.equal(after1.status, 'filled');
  assert.equal(after2.amount_remaining, 20_00, 'still owed 20');
  assert.equal(after2.status, 'partially_filled');
  await assertLedgerHealthy();
});

test('a small deposit partially fills the front withdrawal', async () => {
  const w1 = await mkPlayer('W1', 3001);
  const dep = await mkPlayer('D', 3009);
  await grantChips(w1.id, 100_00);
  const r1 = await queueWithdraw(w1, usdt, 100_00, 'T-W1');

  const [d] = await sql`select * from deposit_create(${dep.id}::uuid, ${usdt.id}::uuid, ${40_00}::bigint)`;
  const fills = await fillsOf(d.id);

  assert.equal(fills.length, 1);
  assert.equal(fills[0].amount, 40_00);
  const [after] = await sql`select * from withdraw_requests where id = ${r1.id}`;
  assert.equal(after.amount_remaining, 60_00);
  assert.equal(after.status, 'partially_filled');
  await assertLedgerHealthy();
});

test('unmatched deposit falls back to the owner backstop handle', async () => {
  const dep = await mkPlayer('D', 3009);
  const [d] = await sql`select * from deposit_create(${dep.id}::uuid, ${usdt.id}::uuid, ${50_00}::bigint)`;
  const fills = await fillsOf(d.id);

  assert.equal(fills.length, 1);
  assert.equal(fills[0].withdraw_id, null, 'backstop fill has no withdrawal');
  assert.equal(fills[0].payout_handle, usdt.backstop_handle, "revealed the owner's handle");
  await assertLedgerHealthy();
});

test('deposit is refused when queue is short and method has no backstop', async () => {
  const dep = await mkPlayer('D', 3009);
  await assert.rejects(
    sql`select deposit_create(${dep.id}::uuid, ${bank.id}::uuid, ${50_00}::bigint)`,
    /no backstop handle is configured/,
  );
  // All-or-nothing: the rolled-back deposit left nothing behind.
  const rows = await sql`select * from deposit_requests`;
  assert.equal(rows.length, 0, 'failed deposit rolled back entirely');
  await assertLedgerHealthy();
});

test('a player cannot fill their own withdrawal (self-dealing)', async () => {
  const p = await mkPlayer('Solo', 4001);
  await grantChips(p.id, 100_00);
  await queueWithdraw(p, usdt, 50_00, 'T-SELF');

  // Their own withdrawal is skipped, so this backstops to the owner instead.
  const [d] = await sql`select * from deposit_create(${p.id}::uuid, ${usdt.id}::uuid, ${50_00}::bigint)`;
  const fills = await fillsOf(d.id);
  assert.equal(fills.length, 1);
  assert.equal(fills[0].withdraw_id, null, 'skipped own withdrawal, went to backstop');
  await assertLedgerHealthy();
});

// ═══════════════════════════════════════════════════════════════════════════
// Release
// ═══════════════════════════════════════════════════════════════════════════

test('matched fill: escrow becomes the depositors chips, money conserved', async () => {
  const wp = await mkPlayer('W', 5001);
  const dp = await mkPlayer('D', 5002);
  await grantChips(wp.id, 100_00);
  const w = await queueWithdraw(wp, usdt, 50_00, 'T-W');

  const [d] = await sql`select * from deposit_create(${dp.id}::uuid, ${usdt.id}::uuid, ${50_00}::bigint)`;
  const [f] = await fillsOf(d.id);

  await sql`select fill_submit_proof(${f.id}::uuid, 'TXHASH-1', null, null)`;
  await sql`select fill_confirm(${f.id}::uuid, ${wp.id}::uuid)`;

  const [rf] = await sql`select * from fills where id = ${f.id}`;
  assert.equal(rf.status, 'released');
  assert.equal(rf.release_reason, 'withdrawer_confirmed');

  assert.equal(await balance('player_escrow', wp.id), 0, 'withdrawer escrow discharged');
  assert.equal(await balance('player_chips', dp.id), 50_00, 'depositor got chips');

  const [w2] = await sql`select * from withdraw_requests where id = ${w.id}`;
  assert.equal(w2.status, 'completed');

  const orders = await sql`select * from chip_orders where ref_id = ${f.id} and delta > 0`;
  assert.equal(orders.length, 1, 'chip load order raised');
  assert.equal(orders[0].delta, 50_00);
  assert.equal(orders[0].clubgg_id, 'CG-D', 'targets the depositor ClubGG id');

  await assertLedgerHealthy();
});

test('irreversible method has no hold; reversible one holds before release', async () => {
  const wp = await mkPlayer('W', 5001);
  const dp = await mkPlayer('D', 5002);
  await grantChips(wp.id, 100_00);
  await queueWithdraw(wp, paypal, 50_00, 'w@example.com');

  const [d] = await sql`select * from deposit_create(${dp.id}::uuid, ${paypal.id}::uuid, ${50_00}::bigint)`;
  const [f] = await fillsOf(d.id);
  await sql`select fill_submit_proof(${f.id}::uuid, 'PP-REF-1', null, null)`;

  const [held] = await sql`select * from fills where id = ${f.id}`;
  assert.ok(held.hold_until, 'reversible method sets a hold');

  // Confirming does NOT release while the hold is live — the sender can still
  // charge back.
  await sql`select fill_confirm(${f.id}::uuid, ${wp.id}::uuid)`;
  const [afterConfirm] = await sql`select * from fills where id = ${f.id}`;
  assert.equal(afterConfirm.status, 'awaiting_confirmation', 'still held');
  assert.ok(afterConfirm.withdrawer_confirmed_at, 'but confirmation recorded');
  assert.equal(await balance('player_chips', dp.id), 0, 'no chips yet');

  // Wind the hold back; the sweeper should now release it.
  await sql`update fills set hold_until = now() - interval '1 second' where id = ${f.id}`;
  await sql`select sweep_holds()`;

  const [released] = await sql`select * from fills where id = ${f.id}`;
  assert.equal(released.status, 'released');
  assert.equal(await balance('player_chips', dp.id), 50_00);
  await assertLedgerHealthy();
});

test('admin fast-path overrides the hold and is attributed', async () => {
  const wp = await mkPlayer('W', 5001);
  const dp = await mkPlayer('D', 5002);
  await grantChips(wp.id, 100_00);
  await queueWithdraw(wp, paypal, 50_00, 'w@example.com');
  const [d] = await sql`select * from deposit_create(${dp.id}::uuid, ${paypal.id}::uuid, ${50_00}::bigint)`;
  const [f] = await fillsOf(d.id);
  await sql`select fill_submit_proof(${f.id}::uuid, 'PP-REF-2', null, null)`;

  await sql`select fill_fast_path(${f.id}::uuid, ${adm.id}::uuid, 'verified in PayPal dashboard')`;

  const [rf] = await sql`select * from fills where id = ${f.id}`;
  assert.equal(rf.status, 'released', 'hold overridden by a human who checked');
  assert.equal(rf.release_reason, 'admin_fast_path');
  assert.equal(rf.released_by, adm.id, 'attributed to the admin');

  const log = await sql`select * from audit_log where action = 'fill.fast_path_confirm'`;
  assert.equal(log.length, 1);
  assert.equal(log[0].admin_id, adm.id);
  await assertLedgerHealthy();
});

test('deposit rake is booked to the house and reduces chips, not the payment', async () => {
  await sql`update config set rake_deposit_bps = 500 where id`;   // 5%
  try {
    const wp = await mkPlayer('W', 5001);
    const dp = await mkPlayer('D', 5002);
    await grantChips(wp.id, 100_00);
    await queueWithdraw(wp, usdt, 50_00, 'T-W');
    const [d] = await sql`select * from deposit_create(${dp.id}::uuid, ${usdt.id}::uuid, ${50_00}::bigint)`;
    const [f] = await fillsOf(d.id);

    assert.equal(f.amount, 50_00, 'withdrawer still receives the full amount');
    assert.equal(f.rake_amount, 250, '5%');
    assert.equal(f.chips_amount, 47_50, 'rake comes out of the depositor chips');

    await sql`select fill_submit_proof(${f.id}::uuid, 'TX-RAKE', null, null)`;
    await sql`select fill_confirm(${f.id}::uuid, ${wp.id}::uuid)`;

    assert.equal(await balance('player_chips', dp.id), 47_50);
    assert.equal(await houseBalance('house_rake'), 250);
    await assertLedgerHealthy();
  } finally {
    await sql`update config set rake_deposit_bps = 0 where id`;
  }
});

test('depositor-pays fee grosses up so the withdrawer nets their ask', async () => {
  const wp = await mkPlayer('W', 5001);
  const dp = await mkPlayer('D', 5002);
  await grantChips(wp.id, 200_00);
  await queueWithdraw(wp, paypal, 100_00, 'w@example.com');
  const [d] = await sql`select * from deposit_create(${dp.id}::uuid, ${paypal.id}::uuid, ${100_00}::bigint)`;
  const [f] = await fillsOf(d.id);

  // PayPal seed: 3.49% + 49. gross = (10000 + 49) / (1 - 0.0349) = 10412.4 → 10413
  assert.equal(f.amount, 100_00, 'withdrawer nets the ask');
  assert.equal(f.gross_to_send, 10413, 'depositor sends more to cover the processor');
  assert.ok(f.gross_to_send > f.amount);
});

// ═══════════════════════════════════════════════════════════════════════════
// Locks and timeouts
// ═══════════════════════════════════════════════════════════════════════════

test('expired lock returns the slice to the FRONT of the queue', async () => {
  const wp = await mkPlayer('W', 6001);
  const dp = await mkPlayer('D', 6002);
  await grantChips(wp.id, 100_00);
  const w = await queueWithdraw(wp, usdt, 50_00, 'T-W');

  const [d] = await sql`select * from deposit_create(${dp.id}::uuid, ${usdt.id}::uuid, ${50_00}::bigint)`;
  const [f] = await fillsOf(d.id);

  let [wr] = await sql`select * from withdraw_requests where id = ${w.id}`;
  assert.equal(wr.amount_remaining, 0, 'slice reserved while locked');

  await sql`update fills set lock_expires_at = now() - interval '1 second' where id = ${f.id}`;
  const [{ sweep_expired_locks: n }] = await sql`select sweep_expired_locks()`;
  assert.equal(n, 1);

  [wr] = await sql`select * from withdraw_requests where id = ${w.id}`;
  assert.equal(wr.amount_remaining, 50_00, 'slice returned to the queue');
  assert.equal(wr.status, 'queued');

  const [ff] = await sql`select * from fills where id = ${f.id}`;
  assert.equal(ff.status, 'expired');

  const [dd] = await sql`select * from deposit_requests where id = ${d.id}`;
  assert.equal(dd.status, 'expired', 'deposit died rather than completed');
  await assertLedgerHealthy();
});

test('proof submitted after the deadline but before the sweep is still honoured', async () => {
  const wp = await mkPlayer('W', 6001);
  const dp = await mkPlayer('D', 6002);
  await grantChips(wp.id, 100_00);
  await queueWithdraw(wp, usdt, 50_00, 'T-W');
  const [d] = await sql`select * from deposit_create(${dp.id}::uuid, ${usdt.id}::uuid, ${50_00}::bigint)`;
  const [f] = await fillsOf(d.id);

  await sql`update fills set lock_expires_at = now() - interval '1 second' where id = ${f.id}`;
  // The slice is still reserved because the sweeper has not run. The player
  // really did pay. Honour it.
  await sql`select fill_submit_proof(${f.id}::uuid, 'TX-LATE', null, null)`;
  const [ff] = await sql`select * from fills where id = ${f.id}`;
  assert.equal(ff.status, 'awaiting_confirmation');
});

test('proof cannot be submitted once the slice has actually been swept', async () => {
  const wp = await mkPlayer('W', 6001);
  const dp = await mkPlayer('D', 6002);
  await grantChips(wp.id, 100_00);
  await queueWithdraw(wp, usdt, 50_00, 'T-W');
  const [d] = await sql`select * from deposit_create(${dp.id}::uuid, ${usdt.id}::uuid, ${50_00}::bigint)`;
  const [f] = await fillsOf(d.id);

  await sql`update fills set lock_expires_at = now() - interval '1 second' where id = ${f.id}`;
  await sql`select sweep_expired_locks()`;

  await assert.rejects(
    sql`select fill_submit_proof(${f.id}::uuid, 'TX-TOOLATE', null, null)`,
    /timed out and has returned to the queue/,
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// Disputes
// ═══════════════════════════════════════════════════════════════════════════

test('dispute freezes the fill; nothing releases', async () => {
  const wp = await mkPlayer('W', 7001);
  const dp = await mkPlayer('D', 7002);
  await grantChips(wp.id, 100_00);
  await queueWithdraw(wp, usdt, 50_00, 'T-W');
  const [d] = await sql`select * from deposit_create(${dp.id}::uuid, ${usdt.id}::uuid, ${50_00}::bigint)`;
  const [f] = await fillsOf(d.id);
  await sql`select fill_submit_proof(${f.id}::uuid, 'TX-DISPUTE', null, null)`;

  await sql`select dispute_open(${f.id}::uuid, 'never received', ${wp.id}::uuid, null, '[]'::jsonb)`;

  const [ff] = await sql`select * from fills where id = ${f.id}`;
  assert.equal(ff.status, 'disputed');
  assert.equal(await balance('player_escrow', wp.id), 50_00, 'escrow frozen, not released');
  assert.equal(await balance('player_chips', dp.id), 0, 'no chips issued');

  await assert.rejects(
    sql`select fill_release(${f.id}::uuid, 'withdrawer_confirmed', null)`,
    /only a fill awaiting confirmation can be released/,
  );
  await assertLedgerHealthy();
});

test('dispute resolved to depositor releases normally', async () => {
  const wp = await mkPlayer('W', 7001);
  const dp = await mkPlayer('D', 7002);
  await grantChips(wp.id, 100_00);
  await queueWithdraw(wp, usdt, 50_00, 'T-W');
  const [d] = await sql`select * from deposit_create(${dp.id}::uuid, ${usdt.id}::uuid, ${50_00}::bigint)`;
  const [f] = await fillsOf(d.id);
  await sql`select fill_submit_proof(${f.id}::uuid, 'TX-D1', null, null)`;
  const [di] = await sql`select * from dispute_open(${f.id}::uuid, 'no', ${wp.id}::uuid, null, '[]'::jsonb)`;

  await sql`select dispute_resolve(${di.id}::uuid, ${adm.id}::uuid, 'release_to_depositor',
                                   'tx confirmed on chain', null, false, true)`;

  assert.equal(await balance('player_chips', dp.id), 50_00);
  assert.equal(await balance('player_escrow', wp.id), 0);

  const [p2] = await sql`select * from players where id = ${wp.id}`;
  assert.equal(p2.risk_flags.length, 1, 'withdrawer flagged for a false claim');
  await assertLedgerHealthy();
});

test('dispute refunded to withdrawer returns the slice to the queue', async () => {
  const wp = await mkPlayer('W', 7001);
  const dp = await mkPlayer('D', 7002);
  await grantChips(wp.id, 100_00);
  const w = await queueWithdraw(wp, usdt, 50_00, 'T-W');
  const [d] = await sql`select * from deposit_create(${dp.id}::uuid, ${usdt.id}::uuid, ${50_00}::bigint)`;
  const [f] = await fillsOf(d.id);
  await sql`select fill_submit_proof(${f.id}::uuid, 'TX-D2', null, null)`;
  const [di] = await sql`select * from dispute_open(${f.id}::uuid, 'no', ${wp.id}::uuid, null, '[]'::jsonb)`;

  await sql`select dispute_resolve(${di.id}::uuid, ${adm.id}::uuid, 'refund_to_withdrawer',
                                   'no such tx id', null, true, false)`;

  const [ff] = await sql`select * from fills where id = ${f.id}`;
  assert.equal(ff.status, 'refunded');
  assert.equal(await balance('player_chips', dp.id), 0, 'depositor gets nothing');
  assert.equal(await balance('player_escrow', wp.id), 50_00, 'withdrawer still escrowed');

  const [wr] = await sql`select * from withdraw_requests where id = ${w.id}`;
  assert.equal(wr.amount_remaining, 50_00, 'back in the queue');
  assert.equal(wr.status, 'queued');

  const [p2] = await sql`select * from players where id = ${dp.id}`;
  assert.equal(p2.risk_flags.length, 1, 'depositor flagged');
  await assertLedgerHealthy();
});

test('split ruling divides the slice and both sides add up', async () => {
  const wp = await mkPlayer('W', 7001);
  const dp = await mkPlayer('D', 7002);
  await grantChips(wp.id, 100_00);
  const w = await queueWithdraw(wp, usdt, 50_00, 'T-W');
  const [d] = await sql`select * from deposit_create(${dp.id}::uuid, ${usdt.id}::uuid, ${50_00}::bigint)`;
  const [f] = await fillsOf(d.id);
  await sql`select fill_submit_proof(${f.id}::uuid, 'TX-D3', null, null)`;
  const [di] = await sql`select * from dispute_open(${f.id}::uuid, 'partial', ${wp.id}::uuid, null, '[]'::jsonb)`;

  await sql`select dispute_resolve(${di.id}::uuid, ${adm.id}::uuid, 'split',
                                   'half landed', ${20_00}::bigint, false, false)`;

  assert.equal(await balance('player_chips', dp.id), 20_00, 'depositor got their share');
  assert.equal(await balance('player_escrow', wp.id), 30_00, 'rest still escrowed');
  const [wr] = await sql`select * from withdraw_requests where id = ${w.id}`;
  assert.equal(wr.amount_remaining, 30_00, 'remainder re-queued');
  await assertLedgerHealthy();
});

test('post-release reversal books a house loss and restores the withdrawer', async () => {
  const wp = await mkPlayer('W', 7001);
  const dp = await mkPlayer('D', 7002);
  await grantChips(wp.id, 100_00);
  const w = await queueWithdraw(wp, paypal, 50_00, 'w@example.com');
  const [d] = await sql`select * from deposit_create(${dp.id}::uuid, ${paypal.id}::uuid, ${50_00}::bigint)`;
  const [f] = await fillsOf(d.id);
  await sql`select fill_submit_proof(${f.id}::uuid, 'PP-CHARGEBACK', null, null)`;
  await sql`select fill_fast_path(${f.id}::uuid, ${adm.id}::uuid, 'looked fine')`;

  assert.equal(await balance('player_chips', dp.id), 50_00, 'chips already out');

  await sql`select fill_reversal(${f.id}::uuid, ${adm.id}::uuid, 'PayPal chargeback', true)`;

  assert.equal(await houseBalance('house_loss'), -50_00, 'the union ate it');
  assert.equal(await balance('player_escrow', wp.id), 50_00, 'withdrawer made whole');
  assert.equal(await balance('player_chips', dp.id), 50_00, 'depositor chips NOT clawed to negative');

  const [wr] = await sql`select * from withdraw_requests where id = ${w.id}`;
  assert.equal(wr.amount_remaining, 50_00, 'back in the queue');

  const [p2] = await sql`select * from players where id = ${dp.id}`;
  assert.equal(p2.status, 'frozen');
  assert.ok(p2.risk_flags.length >= 1);
  await assertLedgerHealthy();
});

// ═══════════════════════════════════════════════════════════════════════════
// Owner backstop / float
// ═══════════════════════════════════════════════════════════════════════════

test('backstop deposit: owner holds the cash, float reflects it', async () => {
  const dp = await mkPlayer('D', 8001);
  const [d] = await sql`select * from deposit_create(${dp.id}::uuid, ${usdt.id}::uuid, ${50_00}::bigint)`;
  const [f] = await fillsOf(d.id);
  await sql`select fill_submit_proof(${f.id}::uuid, 'TX-BACKSTOP', null, null)`;
  await sql`select fill_fast_path(${f.id}::uuid, ${adm.id}::uuid, 'received in owner wallet')`;

  assert.equal(await balance('player_chips', dp.id), 50_00);
  assert.equal(await houseBalance('owner_float'), -50_00, 'negative = owner holding cash');

  const [fp] = await sql`select * from v_float_position where currency = 'USD'`;
  assert.equal(fp.owner_cash_held, 50_00, 'presented the way a human reads it');
  assert.equal(fp.ledger_balances, true);
  await assertLedgerHealthy();
});

test('owner pays a withdrawal directly to clear the queue', async () => {
  const wp = await mkPlayer('W', 8001);
  await grantChips(wp.id, 100_00);
  const w = await queueWithdraw(wp, usdt, 50_00, 'T-W');

  const [f] = await sql`select * from withdraw_owner_payout(${w.id}::uuid, ${adm.id}::uuid, null, 'MANUAL-TX-1', 'cleared')`;

  assert.equal(f.deposit_id, null, 'owner-sourced fill has no depositor');
  assert.equal(f.chips_amount, 0, 'no chips created');
  assert.equal(await balance('player_escrow', wp.id), 0, 'withdrawer paid');
  assert.equal(await houseBalance('owner_float'), 50_00, 'positive = owner out of pocket');

  const [wr] = await sql`select * from withdraw_requests where id = ${w.id}`;
  assert.equal(wr.status, 'completed');
  await assertLedgerHealthy();
});

test('backstop in then owner payout out nets the float to zero', async () => {
  const dp = await mkPlayer('D', 8001);
  const wp = await mkPlayer('W', 8002);

  // Owner takes 50 in.
  const [d] = await sql`select * from deposit_create(${dp.id}::uuid, ${usdt.id}::uuid, ${50_00}::bigint)`;
  const [f] = await fillsOf(d.id);
  await sql`select fill_submit_proof(${f.id}::uuid, 'TX-IN', null, null)`;
  await sql`select fill_fast_path(${f.id}::uuid, ${adm.id}::uuid, 'in')`;

  // Owner pays 50 out.
  await grantChips(wp.id, 50_00);
  const w = await queueWithdraw(wp, usdt, 50_00, 'T-W');
  await sql`select withdraw_owner_payout(${w.id}::uuid, ${adm.id}::uuid, null, 'TX-OUT', 'out')`;

  assert.equal(await houseBalance('owner_float'), 0, 'float square');
  await assertLedgerHealthy();
});

// ═══════════════════════════════════════════════════════════════════════════
// ClubGG sync
// ═══════════════════════════════════════════════════════════════════════════

test('chips_sync books gameplay winnings and keeps the ledger balanced', async () => {
  const p = await mkPlayer('P', 9001);
  await grantChips(p.id, 100_00);

  // They ran it up to 150 at the tables.
  const [{ chips_sync: delta }] = await sql`select chips_sync(${p.id}::uuid, ${150_00}::bigint, 'USD', 'manual', ${adm.id}::uuid)`;
  assert.equal(delta, 50_00, 'booked a 50 win');
  assert.equal(await balance('player_chips', p.id), 150_00, 'ledger now matches the table');
  await assertLedgerHealthy();

  // And then lost it all.
  const [{ chips_sync: delta2 }] = await sql`select chips_sync(${p.id}::uuid, 0::bigint, 'USD', 'manual', ${adm.id}::uuid)`;
  assert.equal(delta2, -150_00);
  assert.equal(await balance('player_chips', p.id), 0);
  await assertLedgerHealthy();
});

test('chips_sync does not mistake an undelivered load for a gambling loss', async () => {
  const wp = await mkPlayer('W', 9001);
  const dp = await mkPlayer('D', 9002);
  await grantChips(wp.id, 100_00);
  await queueWithdraw(wp, usdt, 50_00, 'T-W');
  const [d] = await sql`select * from deposit_create(${dp.id}::uuid, ${usdt.id}::uuid, ${50_00}::bigint)`;
  const [f] = await fillsOf(d.id);
  await sql`select fill_submit_proof(${f.id}::uuid, 'TX-PENDING', null, null)`;
  await sql`select fill_confirm(${f.id}::uuid, ${wp.id}::uuid)`;

  // Ledger says the depositor has 5000 chips, but the load order is still
  // pending — the table legitimately shows 0.
  assert.equal(await balance('player_chips', dp.id), 50_00);

  // Measure the DELTA: the grantChips fixture books against house_gameplay, so
  // the account is not at zero going in. What matters is that this sync moves it
  // by nothing.
  const before = await houseBalance('house_gameplay');
  const [{ chips_sync: delta }] = await sql`select chips_sync(${dp.id}::uuid, 0::bigint, 'USD', 'adapter', null)`;

  assert.equal(delta, 0, 'no phantom gameplay loss');
  assert.equal(await balance('player_chips', dp.id), 50_00, 'balance untouched');
  assert.equal(await houseBalance('house_gameplay'), before, 'alarm stays quiet');
  await assertLedgerHealthy();
});

test('withdrawal is blocked when the live chip check is stale', async () => {
  await sql`update config set require_live_chip_check = true where id`;
  try {
    const p = await mkPlayer('P', 9001);
    await grantChips(p.id, 100_00);
    await assert.rejects(
      sql`select withdraw_create(${p.id}::uuid, ${usdt.id}::uuid, ${50_00}::bigint, 'T-X')`,
      /live ClubGG balance check required/,
    );
    // With a fresh reading it goes through.
    await sql`select chips_sync(${p.id}::uuid, ${100_00}::bigint, 'USD', 'adapter', null)`;
    const [w] = await sql`select * from withdraw_create(${p.id}::uuid, ${usdt.id}::uuid, ${50_00}::bigint, 'T-X')`;
    assert.ok(w.id);
  } finally {
    await sql`update config set require_live_chip_check = false where id`;
  }
});

test('unload that comes up short cancels the withdrawal instead of lying', async () => {
  const p = await mkPlayer('P', 9001);
  await grantChips(p.id, 100_00);
  const [w] = await sql`select * from withdraw_create(${p.id}::uuid, ${usdt.id}::uuid, ${100_00}::bigint, 'T-X')`;
  assert.equal(w.status, 'pending_unload');

  // The player gambled most of it away before the admin got to the unload.
  const [o] = await sql`select * from chip_orders where id = ${w.unload_order_id}`;
  await sql`select chip_order_claim(${o.id}::uuid, ${adm.id}::uuid)`;
  await sql`select chip_order_complete(${o.id}::uuid, ${adm.id}::uuid, ${-30_00}::bigint, null, 'only 30 left')`;

  const [wr] = await sql`select * from withdraw_requests where id = ${w.id}`;
  assert.equal(wr.status, 'cancelled');
  assert.match(wr.cancel_reason, /came up short/);
  assert.equal(await balance('player_wallet', p.id), 30_00, 'what did come off stays theirs');
  assert.equal(await balance('player_chips', p.id), 70_00);
  await assertLedgerHealthy();
});

// ═══════════════════════════════════════════════════════════════════════════
// Rate limits
// ═══════════════════════════════════════════════════════════════════════════

test('open deposit cap is enforced', async () => {
  await sql`update config set max_open_deposits_per_player = 2 where id`;
  try {
    const dp = await mkPlayer('D', 9001);
    await sql`select deposit_create(${dp.id}::uuid, ${usdt.id}::uuid, ${10_00}::bigint)`;
    await sql`select deposit_create(${dp.id}::uuid, ${usdt.id}::uuid, ${10_00}::bigint)`;
    await assert.rejects(
      sql`select deposit_create(${dp.id}::uuid, ${usdt.id}::uuid, ${10_00}::bigint)`,
      /already have 2 open deposits/,
    );
  } finally {
    await sql`update config set max_open_deposits_per_player = 3 where id`;
  }
});

test('handle-reveal rate limit stops handle harvesting', async () => {
  await sql`update config set handle_reveals_per_hour = 2, max_open_deposits_per_player = 99 where id`;
  try {
    const dp = await mkPlayer('D', 9001);
    await sql`select deposit_create(${dp.id}::uuid, ${usdt.id}::uuid, ${10_00}::bigint)`;
    await sql`select deposit_create(${dp.id}::uuid, ${usdt.id}::uuid, ${10_00}::bigint)`;
    await assert.rejects(
      sql`select deposit_create(${dp.id}::uuid, ${usdt.id}::uuid, ${10_00}::bigint)`,
      /too many payout handles revealed/,
    );
  } finally {
    await sql`update config set handle_reveals_per_hour = 10, max_open_deposits_per_player = 3 where id`;
  }
});

test('an unlinked player cannot move chips', async () => {
  const [p] = await sql`
    insert into players (telegram_id, display_name, clubgg_id_claimed, status)
    values (9999, 'Unlinked', 'CG-CLAIM', 'pending') returning *
  `;
  await assert.rejects(
    sql`select deposit_create(${p.id}::uuid, ${usdt.id}::uuid, ${10_00}::bigint)`,
    /account is pending/,
  );
});
