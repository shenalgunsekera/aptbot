import { connect } from './db.mjs';
const sql = connect({ max: 2, connect_timeout: 20 });
const M = (v) => `$${(v / 100).toFixed(2)}`;
let fail = 0, n = 0;
const ok = (c, l) => { n++; if (!c) { fail++; console.log(`  x FAIL: ${l}`); } else console.log(`  + ${l}`); };
const willThrow = async (fn, l) => { n++; try { await fn(); fail++; console.log(`  x FAIL (no error): ${l}`); } catch { console.log(`  + ${l}`); } };

const [owner] = await sql`select * from admins where role='owner' limit 1`;
const [clubgg] = await sql`select * from platforms where code='clubgg'`;
const [sbook] = await sql`select * from platforms where code='sportsbook'`;
const [club] = await sql`select * from clubs where platform_id=${clubgg.id} limit 1`;
const [btc] = await sql`select * from payment_methods where code='btc'`;
const [venmo] = await sql`select * from payment_methods where code='venmo'`;

async function fresh(name, tg) {
  await sql`delete from player_method_prefs where player_id in (select id from players where telegram_id=${tg})`;
  await sql`delete from player_prefs where player_id in (select id from players where telegram_id=${tg})`;
  await sql`delete from player_platforms where player_id in (select id from players where telegram_id=${tg})`;
  await sql`delete from players where telegram_id=${tg}`;
  await sql`select player_register(${tg}::bigint, null, null)`;
  const [p] = await sql`select * from players where telegram_id=${tg}`;
  return p;
}

console.log('\n=== V2.1 ONBOARDING + RECEIPTS + RETRACTION ===\n');

console.log('1. MONEY RULES');
const p1 = await fresh('Rules', 970001);
await sql`select player_set_name(${p1.id}::uuid, 'RulesGuy', null)`;
await sql`select player_claim_platform(${p1.id}::uuid, ${clubgg.id}::uuid, 'R-100')`;
await sql`select player_link(${p1.id}::uuid, ${clubgg.id}::uuid, ${owner.id}::uuid, 'R-100')`;
await willThrow(() => sql`select deposit_create(${p1.id}::uuid,${clubgg.id}::uuid,${btc.id}::uuid,${1500}::bigint)`, 'deposit of 15 rejected (< min 20)');
await willThrow(() => sql`select deposit_create(${p1.id}::uuid,${clubgg.id}::uuid,${btc.id}::uuid,${2200}::bigint)`, 'deposit of 22 rejected (not multiple of 5)');
const [okDep] = await sql`select id from deposit_create(${p1.id}::uuid,${clubgg.id}::uuid,${btc.id}::uuid,${2000}::bigint)`;
ok(!!okDep?.id, 'deposit of 20 accepted');

console.log('\n2. SPORTSBOOK ACCOUNT CREATION (pause → admin makes it → resume)');
const p2 = await fresh('SB', 970002);
await sql`select player_set_name(${p2.id}::uuid, 'SBGuy', null)`;
await sql`select sb_request_creation(${p2.id}::uuid, ${sbook.id}::uuid, 'sbuser1', 'pass123')`;
const [notif] = await sql`select count(*)::int c from notifications where kind='sportsbook.create' and player_id=${p2.id} or (kind='sportsbook.create' and ref_id=${p2.id})`;
ok(notif.c >= 1, 'admin notified to create sportsbook account');
const [ppReq] = await sql`select needs_creation, platform_uid, platform_uid_claimed, secret from player_platforms where player_id=${p2.id} and platform_id=${sbook.id}`;
ok(ppReq.needs_creation && !ppReq.platform_uid && ppReq.platform_uid_claimed==='sbuser1' && ppReq.secret==='pass123', 'sportsbook row: needs_creation, creds stored, not yet live');
await willThrow(() => sql`select sb_request_creation(${p2.id}::uuid, ${sbook.id}::uuid, 'thisusernameistoolong', 'x')`, 'username > 10 chars rejected');
await sql`select sb_mark_created(${p2.id}::uuid, ${sbook.id}::uuid, ${owner.id}::uuid, null)`;
const [ppLive] = await sql`select needs_creation, platform_uid from player_platforms where player_id=${p2.id} and platform_id=${sbook.id}`;
ok(!ppLive.needs_creation && ppLive.platform_uid==='sbuser1', 'admin created → account live with username as uid');
const [resume] = await sql`select count(*)::int c from notifications where kind='onboarding.resume' and player_id=${p2.id}`;
ok(resume.c === 1, 'player told to resume onboarding');
const [act] = await sql`select status from players where id=${p2.id}`;
ok(act.status === 'active', 'player activated');

console.log('\n3. PREFERENCES (deposit multi-select, withdraw method, finish)');
await sql`select prefs_set_deposit_methods(${p2.id}::uuid, ${sql.array([btc.id, venmo.id])}::uuid[])`;
const [dmc] = await sql`select count(*)::int c from player_method_prefs where player_id=${p2.id}`;
ok(dmc.c === 2, 'two preferred deposit methods stored');
await sql`select prefs_set_deposit_methods(${p2.id}::uuid, ${sql.array([btc.id])}::uuid[])`;
const [dmc2] = await sql`select count(*)::int c from player_method_prefs where player_id=${p2.id}`;
ok(dmc2.c === 1, 'updating deposit methods replaces the set');
await sql`select prefs_set_withdraw_method(${p2.id}::uuid, ${venmo.id}::uuid)`;
await sql`select payout_handle_remember(${p2.id}::uuid, ${venmo.id}::uuid, '@sbguy')`;
await sql`select player_finish_onboarding(${p2.id}::uuid)`;
const [pref] = await sql`select default_withdraw_method_id, onboarded_at from player_prefs where player_id=${p2.id}`;
ok(pref.default_withdraw_method_id === venmo.id && !!pref.onboarded_at, 'withdraw method + onboarded_at set');

console.log('\n4. DEPOSIT WITH RECEIPT-ONLY PROOF (no ref) → admin verify → released');
const dep = await sql`select id from deposit_create(${p1.id}::uuid,${clubgg.id}::uuid,${btc.id}::uuid,${5000}::bigint)`;
const [f] = await sql`select * from fills where deposit_id=${dep[0].id} order by seq`;
await sql`select fill_submit_proof(${f.id}::uuid, null, null, false)`;  // no ref, receipt-only
const [f2] = await sql`select status, payment_ref, submitted_at from fills where id=${f.id}`;
ok(f2.status==='awaiting_confirmation' && f2.payment_ref===null && !!f2.submitted_at, 'proof submitted with NO reference id');
await sql`select fill_admin_verify(${f.id}::uuid, ${owner.id}::uuid, 'receipt looks good')`;
const [f3] = await sql`select status from fills where id=${f.id}`;
ok(f3.status==='released', 'admin verify released it (no player confirm needed)');

console.log('\n5. CASHOUT RETRACTION (unclaimed → fully returned)');
const p5 = await fresh('Retract', 970005);
await sql`select player_set_name(${p5.id}::uuid, 'RetractGuy', null)`;
await sql`select player_claim_platform(${p5.id}::uuid, ${clubgg.id}::uuid, 'RT-1')`;
await sql`select player_link(${p5.id}::uuid, ${clubgg.id}::uuid, ${owner.id}::uuid, 'RT-1')`;
const [w] = await sql`select * from withdraw_create(${p5.id}::uuid,${clubgg.id}::uuid,${venmo.id}::uuid,${30_00}::bigint,'@rt')`;
const [lo] = await sql`select * from loader_orders where id=${w.unload_order_id}`;
await sql`select loader_order_claim(${lo.id}::uuid,${owner.id}::uuid)`;
await sql`select loader_order_complete(${lo.id}::uuid,${owner.id}::uuid,${-30_00}::bigint,null)`;
const [wq] = await sql`select status, amount_remaining from withdraw_requests where id=${w.id}`;
ok(wq.status==='queued' && wq.amount_remaining>0, 'cashout queued (unclaimed)');
await sql`select withdraw_cancel(${w.id}::uuid, null, 'retracted by player')`;
const [wc] = await sql`select status from withdraw_requests where id=${w.id}`;
ok(wc.status==='cancelled', 'retract cancelled it fully');

console.log('\n6. LEDGER');
const probs = await sql`select * from ledger_verify()`;
ok(probs.length === 0, `ledger_verify clean (${probs.length})`);

console.log(fail ? `\nx ${fail}/${n} FAILED` : `\n+ ALL ${n} PASSED`);
for (const tg of [970001, 970002, 970005]) {
  await sql`delete from player_method_prefs where player_id in (select id from players where telegram_id=${tg})`.catch(()=>{});
}
await sql.end();
process.exit(fail ? 1 : 0);
