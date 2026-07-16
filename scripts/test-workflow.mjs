import { connect } from './db.mjs';
const sql = connect({ max: 3, connect_timeout: 15 });
const M = (v) => `$${(v / 100).toFixed(2)}`;
let fail = 0, n = 0;
const ok = (c, l) => { n++; if (!c) { fail++; console.log(`  x FAIL: ${l}`); } else console.log(`  + ${l}`); };

const [owner] = await sql`select * from admins where role='owner' limit 1`;
const [clubgg] = await sql`select * from platforms where code='clubgg'`;
const [club] = await sql`select * from clubs where platform_id=${clubgg.id} limit 1`;
const [usdt] = await sql`select * from payment_methods where code='usdt_trc20'`;
const [paypal] = await sql`select * from payment_methods where code='paypal'`;
await sql`update payment_methods set enabled=true, club_handle='club@paypal.test' where code='paypal'`;

async function mkPlayer(name, tg) {
  await sql`delete from support_threads where player_id in (select id from players where telegram_id=${tg})`;
  await sql`delete from player_platforms where player_id in (select id from players where telegram_id=${tg})`;
  await sql`delete from bot_sessions where key=${String(tg)}`;
  await sql`delete from players where telegram_id=${tg}`;
  const [p] = await sql`insert into players (telegram_id, display_name, status) values (${tg},${name},'active') returning *`;
  return p;
}
async function linkP(p, uid) {
  await sql`insert into player_platforms (player_id, platform_id, platform_uid_claimed, platform_uid, linked_at, club_id, linked_by)
    values (${p.id},${clubgg.id},${uid},${uid},now(),${club.id},${owner.id})`;
}

console.log('\n=== FULL WORKFLOW TEST (Neon) ===\n');

console.log('1. REGISTRATION + NAME UNIQUENESS');
const alice = await mkPlayer('WF_Alice', 990001);
await linkP(alice, 'WF-ALICE');
let dupBlocked = false;
try { await sql`insert into players (telegram_id, display_name, status) values (990099,'WF_Alice','active')`; }
catch { dupBlocked = true; }
ok(dupBlocked, 'duplicate active name is rejected');
await sql`delete from players where telegram_id=990099`.catch(() => {});

console.log('\n2. CASH OUT - unload is the truth (partial)');
const [w] = await sql`select * from withdraw_create(${alice.id}::uuid,${clubgg.id}::uuid,${usdt.id}::uuid,${100_00}::bigint,'T-ALICE')`;
ok(w.status === 'pending_unload', 'cash out waits on a loader (no pre-check)');
const [lo] = await sql`select * from loader_orders where id=${w.unload_order_id}`;
ok(lo.player_name === 'WF_Alice' && lo.platform_uid === 'WF-ALICE', 'loader job shows name + id');
await sql`select loader_order_claim(${lo.id}::uuid,${owner.id}::uuid)`;
await sql`select loader_order_complete(${lo.id}::uuid,${owner.id}::uuid,${-60_00}::bigint,'only 60 there')`;
const [w2] = await sql`select * from withdraw_requests where id=${w.id}`;
ok(w2.status === 'queued' && w2.amount === 60_00, `escrowed ACTUAL ${M(w2.amount)} not requested ${M(100_00)}`);

console.log('\n3. PARTIAL FILLS - 60 paid by 40 + 20, receipts per payment');
const bob = await mkPlayer('WF_Bob', 990002); await linkP(bob, 'WF-BOB');
const carol = await mkPlayer('WF_Carol', 990003); await linkP(carol, 'WF-CAROL');
const [d1] = await sql`select * from deposit_create(${bob.id}::uuid,${clubgg.id}::uuid,${usdt.id}::uuid,${40_00}::bigint)`;
const [f1] = await sql`select * from fills where deposit_id=${d1.id} order by seq`;
ok(f1.withdraw_id === w.id && f1.amount === 40_00, 'Bob 40 matched Alice, gets her handle: ' + f1.payout_handle);
await sql`select fill_submit_proof(${f1.id}::uuid,${'TX40-' + Date.now()},null)`;
await sql`select receipt_add(${bob.id}::uuid,'fill',${f1.id}::uuid,'p/x','https://x/40.png',${clubgg.id}::uuid,'image/png',100,null,${bob.id}::uuid,null)`;
await sql`select fill_confirm(${f1.id}::uuid,${alice.id}::uuid)`;
const [d2] = await sql`select * from deposit_create(${carol.id}::uuid,${clubgg.id}::uuid,${usdt.id}::uuid,${20_00}::bigint)`;
const [f2] = await sql`select * from fills where deposit_id=${d2.id} order by seq`;
ok(f2.withdraw_id === w.id && f2.amount === 20_00, 'Carol 20 matched same withdrawal (spillover)');
await sql`select fill_submit_proof(${f2.id}::uuid,${'TX20-' + Date.now()},null)`;
await sql`select receipt_add(${carol.id}::uuid,'fill',${f2.id}::uuid,'p/y','https://x/20.png',${clubgg.id}::uuid,'image/png',100,null,${carol.id}::uuid,null)`;
await sql`select fill_confirm(${f2.id}::uuid,${alice.id}::uuid)`;
const [wf] = await sql`select * from withdraw_requests where id=${w.id}`;
ok(wf.status === 'completed' && wf.amount_remaining === 0, 'withdrawal fully paid + completed');

console.log('\n4. /payments - Alice sees both receipts');
const pays = await sql`select * from player_payments(${alice.id}::uuid)`;
const paidList = pays[0].payments;
ok(paidList.length === 2, `Alice sees ${paidList.length} payments`);
ok(paidList.every((x) => x.receipt), 'every payment has a receipt link');

console.log('\n5. PAYPAL club-mediated');
const [d3] = await sql`select * from deposit_create(${bob.id}::uuid,${clubgg.id}::uuid,${paypal.id}::uuid,${30_00}::bigint)`;
const [f3] = await sql`select * from fills where deposit_id=${d3.id} order by seq`;
ok(f3.payout_handle === 'club@paypal.test' && f3.withdraw_id === null, 'PayPal deposit -> club account, not a player');
await sql`select fill_submit_proof(${f3.id}::uuid,${'PP-' + Date.now()},null)`;
await sql`select fill_admin_verify(${f3.id}::uuid,${owner.id}::uuid,'ok')`;
const [f3b] = await sql`select status from fills where id=${f3.id}`;
ok(f3b.status === 'released', 'admin verify released it');

console.log('\n6. ADMIN MANAGEMENT (/setadmin + email login bind)');
await sql`delete from admins where email='newadmin@test.com'`.catch(() => {});
const [na] = await sql`select * from admin_upsert(${555111222}::bigint,'New Admin','newadmin@test.com','admin',${owner.id}::uuid)`;
ok(na.telegram_id === 555111222 && na.firebase_uid === null, 'admin added by telegram id, no firebase uid yet');
const [bound] = await sql`select * from admin_bind_firebase('fake-uid-xyz','newadmin@test.com')`;
ok(bound && bound.firebase_uid === 'fake-uid-xyz', 'first Google login binds firebase uid by email');
let nonOwnerBlocked = false;
try { await sql`select admin_upsert(${999}::bigint,'x','x@y.com','admin',${na.id}::uuid)`; } catch { nonOwnerBlocked = true; }
ok(nonOwnerBlocked, 'non-owner cannot add admins');

console.log('\n7. PLAYER APPROVE via button path (player_link_pp)');
const dave = await mkPlayer('WF_Dave', 990004);
await sql`update players set status='pending' where id=${dave.id}`;
const [pp] = await sql`select * from player_claim_platform(${dave.id}::uuid,${clubgg.id}::uuid,'WF-DAVE')`;
ok(pp.platform_uid_claimed === 'WF-DAVE' && pp.platform_uid === null, 'claim recorded, unconfirmed');
await sql`select player_link_pp(${pp.id}::uuid,${owner.id}::uuid)`;
const [dave2] = await sql`select status from players where id=${dave.id}`;
const [pp2] = await sql`select platform_uid from player_platforms where id=${pp.id}`;
ok(dave2.status === 'active' && pp2.platform_uid === 'WF-DAVE', 'approve button path activates player');

console.log('\n8. NOTIFICATIONS queued');
const [notif] = await sql`select count(*)::int c from notifications where kind='player.linked' and status='pending'`;
ok(notif.c >= 1, `player.linked notification queued (${notif.c} pending)`);

console.log('\n9. LEDGER INTEGRITY');
const probs = await sql`select * from ledger_verify()`;
ok(probs.length === 0, `ledger_verify clean (${probs.length} problems)`);
const [fp] = await sql`select ledger_balances from v_float_position where currency='USD'`;
ok(fp.ledger_balances, 'sum-to-zero holds');

console.log('\n=== RESULT ===');
console.log(fail ? `x ${fail}/${n} FAILED` : `+ ALL ${n} CHECKS PASSED`);

await sql`delete from audit_log where ref_id=${na.id}`.catch(() => {});
await sql`delete from admins where email='newadmin@test.com'`.catch(() => {});
await sql.end();
process.exit(fail ? 1 : 0);
