import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  sql, resetState, mkPlayer, method, owner, grantChips, mkAdmin,
  balance, assertLedgerHealthy, queueWithdraw,
} from './helpers.mjs';

// These are the tests the whole locking design exists for. Single-threaded,
// FIFO and slice accounting are trivial to get right. The question is what
// happens when N depositors hit the same queue head in the same millisecond.

let usdt, adm;

before(async () => {
  usdt = await method('usdt_trc20');
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

/** Settle after all promises regardless of outcome. */
const allSettled = (ps) => Promise.allSettled(ps);

test('two depositors racing for one slice: exactly one gets the handle', async () => {
  const wp = await mkPlayer('W', 1001);
  const d1 = await mkPlayer('D1', 1002);
  const d2 = await mkPlayer('D2', 1003);
  await grantChips(wp.id, 100_00);
  const w = await queueWithdraw(wp, usdt, 50_00, 'T-WITHDRAWER');

  // Both fire at once, each wanting the full 5000 the queue has.
  const results = await allSettled([
    sql`select * from deposit_create(${d1.id}::uuid, ${usdt.id}::uuid, ${50_00}::bigint)`,
    sql`select * from deposit_create(${d2.id}::uuid, ${usdt.id}::uuid, ${50_00}::bigint)`,
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2, 'both deposits succeed');

  // The withdrawal was worth 5000. Exactly 5000 of fills may point at it —
  // never 10000. The loser must have been pushed to the owner backstop.
  const [{ total }] = await sql`
    select coalesce(sum(amount), 0)::bigint as total from fills
     where withdraw_id = ${w.id} and status in ('locked','awaiting_confirmation','released','disputed')
  `;
  assert.equal(total, 50_00, 'the slice was handed out exactly once');

  const backstops = await sql`select * from fills where withdraw_id is null`;
  assert.equal(backstops.length, 1, 'the loser went to the backstop');
  assert.equal(backstops[0].payout_handle, usdt.backstop_handle);

  const matched = await sql`select * from fills where withdraw_id = ${w.id}`;
  assert.equal(matched.length, 1);
  assert.equal(matched[0].payout_handle, 'T-WITHDRAWER');

  const [wr] = await sql`select * from withdraw_requests where id = ${w.id}`;
  assert.equal(wr.amount_remaining, 0);
  await assertLedgerHealthy();
});

test('20 concurrent deposits against 10 withdrawals never over-fill the queue', async () => {
  const withdrawers = [];
  for (let i = 0; i < 10; i++) {
    const p = await mkPlayer(`W${i}`, 2000 + i);
    await grantChips(p.id, 100_00);
    withdrawers.push(await queueWithdraw(p, usdt, 10_00, `T-W${i}`));
  }
  const depositors = [];
  for (let i = 0; i < 20; i++) depositors.push(await mkPlayer(`D${i}`, 3000 + i));

  // 20 × 1000 = 20000 chasing a queue holding 10 × 1000 = 10000.
  // Half should match; half should backstop. None should double-match.
  await allSettled(
    depositors.map((d) =>
      sql`select * from deposit_create(${d.id}::uuid, ${usdt.id}::uuid, ${10_00}::bigint)`,
    ),
  );

  // No withdrawal may have more claimed against it than it was worth.
  const over = await sql`
    select w.id, w.amount, coalesce(sum(f.amount), 0)::bigint as claimed
      from withdraw_requests w
      left join fills f on f.withdraw_id = w.id
       and f.status in ('locked','awaiting_confirmation','released','disputed')
     group by w.id, w.amount
    having coalesce(sum(f.amount), 0) > w.amount
  `;
  assert.equal(over.length, 0, `over-filled withdrawals: ${JSON.stringify([...over])}`);

  // amount_remaining must agree with the fills that exist.
  const drift = await sql`
    select w.id, w.amount, w.amount_remaining, coalesce(sum(f.amount), 0)::bigint as claimed
      from withdraw_requests w
      left join fills f on f.withdraw_id = w.id
       and f.status in ('locked','awaiting_confirmation','released','disputed')
     group by w.id, w.amount, w.amount_remaining
    having w.amount_remaining <> w.amount - coalesce(sum(f.amount), 0)
  `;
  assert.equal(drift.length, 0, `amount_remaining drifted: ${JSON.stringify([...drift])}`);

  const [{ matched }] = await sql`
    select coalesce(sum(amount), 0)::bigint as matched from fills where withdraw_id is not null`;
  assert.equal(matched, 100_00, 'exactly the queue depth was matched, no more');

  await assertLedgerHealthy();
});

test('concurrent matching still respects FIFO', async () => {
  // Ten withdrawals created in a known order, each 1000. Ten depositors of 1000
  // fire at once. Every withdrawal should end up filled exactly once — nobody
  // skipped, nobody served twice.
  const ws = [];
  for (let i = 0; i < 10; i++) {
    const p = await mkPlayer(`W${i}`, 4000 + i);
    await grantChips(p.id, 50_00);
    ws.push(await queueWithdraw(p, usdt, 10_00, `T-W${i}`));
    await new Promise((r) => setTimeout(r, 5)); // distinct created_at
  }
  const ds = [];
  for (let i = 0; i < 10; i++) ds.push(await mkPlayer(`D${i}`, 5000 + i));

  await allSettled(
    ds.map((d) => sql`select * from deposit_create(${d.id}::uuid, ${usdt.id}::uuid, ${10_00}::bigint)`),
  );

  const unfilled = await sql`
    select id from withdraw_requests where amount_remaining > 0`;
  assert.equal(unfilled.length, 0, 'every withdrawal got served exactly once');

  const backstops = await sql`select * from fills where withdraw_id is null`;
  assert.equal(backstops.length, 0, 'nothing spilled to the backstop — the queue covered it');

  await assertLedgerHealthy();
});

test('two admins cannot claim the same chip order', async () => {
  const p = await mkPlayer('P', 6001);
  await grantChips(p.id, 100_00);

  const admin2 = await mkAdmin('race-admin-2', 'admin');

  const [w] = await sql`select * from withdraw_create(${p.id}::uuid, ${usdt.id}::uuid, ${50_00}::bigint, 'T-X')`;
  const [o] = await sql`select * from chip_orders where id = ${w.unload_order_id}`;

  const results = await allSettled([
    sql`select * from chip_order_claim(${o.id}::uuid, ${adm.id}::uuid)`,
    sql`select * from chip_order_claim(${o.id}::uuid, ${admin2.id}::uuid)`,
  ]);

  const won = results.filter((r) => r.status === 'fulfilled');
  const lost = results.filter((r) => r.status === 'rejected');
  assert.equal(won.length, 1, 'exactly one admin claimed it');
  assert.equal(lost.length, 1);
  assert.match(lost[0].reason.message, /already claimed|is already/);

  const [fresh] = await sql`select * from chip_orders where id = ${o.id}`;
  assert.equal(fresh.status, 'claimed');
});

test('two admins cannot both fast-path the same fill', async () => {
  const wp = await mkPlayer('W', 7001);
  const dp = await mkPlayer('D', 7002);
  await grantChips(wp.id, 100_00);
  await queueWithdraw(wp, usdt, 50_00, 'T-W');
  const [d] = await sql`select * from deposit_create(${dp.id}::uuid, ${usdt.id}::uuid, ${50_00}::bigint)`;
  const [f] = await sql`select * from fills where deposit_id = ${d.id}`;
  await sql`select fill_submit_proof(${f.id}::uuid, 'TX-RACE', null, null)`;

  const admin2 = await mkAdmin('race-admin-3', 'owner');

  const results = await allSettled([
    sql`select * from fill_fast_path(${f.id}::uuid, ${adm.id}::uuid, 'me first')`,
    sql`select * from fill_fast_path(${f.id}::uuid, ${admin2.id}::uuid, 'no, me')`,
  ]);

  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'released exactly once');
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1);

  // The decisive assertion: chips issued once, not twice.
  assert.equal(await balance('player_chips', dp.id), 50_00, 'chips issued exactly once');

  const releases = await sql`
    select * from ledger_transactions where kind = 'fill.release' and ref_id = ${f.id}`;
  assert.equal(releases.length, 1, 'one release transaction');

  const loads = await sql`select * from chip_orders where ref_id = ${f.id} and delta > 0`;
  assert.equal(loads.length, 1, 'one chip load order — no double load');

  await assertLedgerHealthy();
});

test('sweeper and a late proof submission cannot both win', async () => {
  const wp = await mkPlayer('W', 8001);
  const dp = await mkPlayer('D', 8002);
  await grantChips(wp.id, 100_00);
  const w = await queueWithdraw(wp, usdt, 50_00, 'T-W');
  const [d] = await sql`select * from deposit_create(${dp.id}::uuid, ${usdt.id}::uuid, ${50_00}::bigint)`;
  const [f] = await sql`select * from fills where deposit_id = ${d.id}`;

  // The exact race: the lock has expired and the depositor pays at that instant.
  await sql`update fills set lock_expires_at = now() - interval '1 second' where id = ${f.id}`;

  const results = await allSettled([
    sql`select sweep_expired_locks()`,
    sql`select fill_submit_proof(${f.id}::uuid, 'TX-PHOTO-FINISH', null, null)`,
  ]);

  const [ff] = await sql`select * from fills where id = ${f.id}`;
  const [wr] = await sql`select * from withdraw_requests where id = ${w.id}`;

  // Whoever won, the two must AGREE. The unforgivable outcome is a fill holding
  // evidence of payment while its slice has gone back to the queue for someone
  // else to be paid for the same money.
  if (ff.status === 'awaiting_confirmation') {
    assert.equal(wr.amount_remaining, 0, 'proof won → slice stays reserved');
  } else {
    assert.equal(ff.status, 'expired');
    assert.equal(wr.amount_remaining, 50_00, 'sweep won → slice returned');
    assert.equal(ff.payment_ref, null, 'and no evidence was recorded against it');
  }
  await assertLedgerHealthy();
});

test('concurrent withdrawals cannot double-spend one balance', async () => {
  const p = await mkPlayer('P', 9001);
  await grantChips(p.id, 100_00);

  // Five simultaneous attempts to withdraw the whole balance. At most one may
  // survive: the ledger's non-negativity constraint is the backstop even if
  // every check-then-act passes concurrently.
  const results = await allSettled(
    Array.from({ length: 5 }, (_, i) =>
      sql`select * from withdraw_create(${p.id}::uuid, ${usdt.id}::uuid, ${100_00}::bigint, ${'T-' + i})`,
    ),
  );

  const ok = results.filter((r) => r.status === 'fulfilled');
  assert.ok(ok.length >= 1, 'at least one succeeded');

  // Whatever happened, the player cannot have committed more than they own.
  const chips = await balance('player_chips', p.id);
  const wallet = await balance('player_wallet', p.id);
  const escrow = await balance('player_escrow', p.id);
  assert.ok(chips >= 0 && wallet >= 0 && escrow >= 0, 'no negative balances');
  assert.equal(chips + wallet + escrow, 100_00, 'total is conserved — nothing conjured');

  await assertLedgerHealthy();
});
