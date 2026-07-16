/**
 * Demonstrates a real peer-to-peer match, end to end.
 *
 * Exists because the two most common "the bot is broken" reports are both the
 * system working correctly:
 *
 *   1. "My deposit went to the owner instead of the withdrawer."
 *      → You used ONE account for both sides. deposit_match skips your own
 *        withdrawal (`player_id <> d.player_id`) — self-dealing is blocked.
 *
 *   2. "My withdrawal isn't matching anything."
 *      → It's in `pending_unload`, not `queued`. Chips have to physically come
 *        off the ClubGG table before the money is escrowed, so an unconfirmed
 *        chip order means the withdrawal was never in the queue to be found.
 *
 * Run:  node scripts/demo-p2p.mjs
 * Local database only — it creates and destroys demo players.
 */
import { connect, dbUrl } from './db.mjs';

const LOCAL = /^postgres:\/\/union:union_dev_pw@(localhost|127\.0\.0\.1):54329\/union/;
if (!LOCAL.test(dbUrl())) {
  console.error('demo: refusing to run against a non-local database.');
  process.exit(1);
}

const sql = connect({ max: 5 });
const money = (m) => `$${(m / 100).toFixed(2)}`;
const log = (s = '') => console.log(s);

// ─── Cast ────────────────────────────────────────────────────────────────────
const [owner] = await sql`select * from admins where role = 'owner' limit 1`;
const [paypal] = await sql`select * from payment_methods where code = 'paypal'`;
const [club] = await sql`select * from clubs where enabled order by created_at limit 1`;
if (!club) {
  console.error('demo: no club configured — run `pnpm db:seed`');
  process.exit(1);
}

async function player(name, tg, clubgg) {
  const [existing] = await sql`select * from players where telegram_id = ${tg}`;
  if (existing) return existing;
  const [p] = await sql`
    insert into players (telegram_id, display_name, clubgg_id_claimed, clubgg_id,
                         status, linked_at, linked_by, club_id)
    values (${tg}, ${name}, ${clubgg}, ${clubgg}, 'active', now(), ${owner.id}, ${club.id})
    returning *`;
  return p;
}

const alice = await player('Alice (withdrawer)', 900001, 'DEMO-ALICE');
const bob = await player('Bob (depositor)', 900002, 'DEMO-BOB');

log('━'.repeat(70));
log('  PEER-TO-PEER SETTLEMENT — live demo');
log('━'.repeat(70));

// ─── Alice has chips at the table ────────────────────────────────────────────
await sql`select chips_sync(${alice.id}::uuid, ${100_00}::bigint, 'USD', 'manual', ${owner.id}::uuid)`;
log(`\n1. Alice has ${money(100_00)} in chips on her ClubGG table.`);

// ─── Alice withdraws ─────────────────────────────────────────────────────────
const [w] = await sql`
  select * from withdraw_create(${alice.id}::uuid, ${paypal.id}::uuid, ${50_00}::bigint,
                                'alice@paypal.example')`;
log(`\n2. Alice runs /club-withdraw for ${money(50_00)} via PayPal.`);
log(`   → status: ${w.status}`);
log(`   ⚠️  NOT in the queue yet. Her chips are still on the table.`);
log(`      The system will not escrow money against chips she could still gamble away.`);

// ─── The chip order ──────────────────────────────────────────────────────────
const [order] = await sql`select * from chip_orders where id = ${w.unload_order_id}`;
log(`\n3. A chip order was raised: UNLOAD ${money(-order.delta)} from ${order.clubgg_id}`);
log(`   THIS is the step that blocks everything. Until it is done, Alice is`);
log(`   invisible to every depositor. A human does it in the panel — or your`);
log(`   overlay does it automatically (CHIP_ADAPTER=clubgg-auto).`);

await sql`select chip_order_claim(${order.id}::uuid, ${owner.id}::uuid)`;
await sql`select chip_order_complete(${order.id}::uuid, ${owner.id}::uuid)`;
log(`   → chip order completed.`);

const [wq] = await sql`select * from withdraw_requests where id = ${w.id}`;
const [pos] = await sql`select queue_position from v_withdraw_queue where id = ${w.id}`;
log(`   → withdrawal status is now: ${wq.status}  (queue position #${pos?.queue_position})`);
log(`   → ${money(wq.amount)} escrowed. Alice cannot spend it; a depositor will pay it.`);

// ─── The self-dealing block ──────────────────────────────────────────────────
log(`\n4. First: what happens if ALICE tries to deposit against her OWN withdrawal?`);
const [selfDep] = await sql`
  select * from deposit_create(${alice.id}::uuid, ${paypal.id}::uuid, ${50_00}::bigint)`;
const [selfFill] = await sql`select * from fills where deposit_id = ${selfDep.id} order by seq`;
log(`   → handle revealed: ${selfFill.payout_handle}`);
log(`   → is_backstop: ${selfFill.withdraw_id === null}`);
log(`   ❗ She got the OWNER'S handle, not her own. Self-dealing is blocked.`);
log(`      THIS IS THE BUG YOU HIT: one account on both sides.`);
await sql`select deposit_cancel(${selfDep.id}::uuid, ${owner.id}::uuid, 'demo cleanup')`;

// ─── The real match ──────────────────────────────────────────────────────────
log(`\n5. Now BOB (a different player) runs /club-deposit for ${money(50_00)} via PayPal.`);
const [dep] = await sql`
  select * from deposit_create(${bob.id}::uuid, ${paypal.id}::uuid, ${50_00}::bigint)`;
const fills = await sql`select * from fills where deposit_id = ${dep.id} order by seq`;

for (const f of fills) {
  log(`\n   ┌─ WHAT BOB SEES IN TELEGRAM ─────────────────────────`);
  log(`   │  Send: ${money(f.gross_to_send)}`);
  if (f.gross_to_send !== f.amount) {
    log(`   │  (${money(f.amount)} + ${money(f.gross_to_send - f.amount)} PayPal fee,`);
    log(`   │   so Alice receives the full amount)`);
  }
  log(`   │  To:   ${f.payout_handle}   ← ALICE'S REAL PAYPAL`);
  log(`   │  This is another player's PayPal.`);
  log(`   └─────────────────────────────────────────────────────`);
  log(`   backstop? ${f.withdraw_id === null}   locked until: ${f.lock_expires_at.toISOString()}`);
}

// ─── Settlement ──────────────────────────────────────────────────────────────
const f = fills[0];
log(`\n6. Bob pays Alice out-of-band, then sends the transaction ID.`);
// Unique per run: fills_payment_ref_uniq deliberately refuses to let one payment
// reference settle two fills — which is exactly what stops a depositor reusing a
// single real payment to claim two deposits. A hardcoded ref here would trip that
// on every re-run.
const ref = `DEMO-PP-${Date.now()}`;
await sql`select fill_submit_proof(${f.id}::uuid, ${ref}, null, null)`;
const [submitted] = await sql`select * from fills where id = ${f.id}`;
log(`   → fill: ${submitted.status}`);
log(`   → hold until ${submitted.hold_until?.toISOString()} (PayPal is reversible)`);

log(`\n7. Alice confirms she received it.`);
await sql`select fill_confirm(${f.id}::uuid, ${alice.id}::uuid)`;
const [confirmed] = await sql`select * from fills where id = ${f.id}`;
log(`   → fill: ${confirmed.status}  — confirmation recorded, but NOT released.`);
log(`     PayPal can still be charged back. The hold has to run out first.`);

log(`\n8. Hold expires (fast-forwarded), sweeper runs.`);
await sql`update fills set hold_until = now() - interval '1 second' where id = ${f.id}`;
await sql`select sweep_holds()`;
const [released] = await sql`select * from fills where id = ${f.id}`;
log(`   → fill: ${released.status} (${released.release_reason})`);

// ─── The ledger ──────────────────────────────────────────────────────────────
log(`\n9. THE LEDGER — real cash moved Bob→Alice outside the system.`);
log(`   Internally, Alice's escrow simply became Bob's chips:`);
const entries = await sql`
  select a.kind, p.display_name, e.amount
    from ledger_entries e
    join accounts a on a.id = e.account_id
    left join players p on p.id = a.player_id
    join ledger_transactions t on t.id = e.tx_id
   where t.ref_id = ${f.id} and t.kind = 'fill.release'
   order by e.amount`;
for (const e of entries) {
  const who = e.display_name ? e.display_name.split(' ')[0] : 'house';
  log(`     ${String(e.kind).padEnd(15)} ${who.padEnd(8)} ${(e.amount > 0 ? '+' : '') + money(e.amount)}`);
}
const sum = entries.reduce((t, e) => t + e.amount, 0);
log(`     ${''.padEnd(24)} ${'─'.repeat(9)}`);
log(`     ${'SUM'.padEnd(24)} ${money(sum)}   ← always exactly zero`);

const [order2] = await sql`
  select * from chip_orders where ref_id = ${f.id} and delta > 0`;
log(`\n10. Chip order raised: LOAD ${money(order2.delta)} → ${order2.clubgg_id}`);
log(`    Your overlay picks this up and puts the chips on Bob's table.`);

const problems = await sql`select * from ledger_verify()`;
log(`\n${problems.length === 0 ? '✓' : '✗'} ledger_verify(): ${problems.length} problems`);
log('━'.repeat(70));

await sql.end();
