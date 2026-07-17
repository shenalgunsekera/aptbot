import { connect } from './db.mjs';
const sql = connect({ max: 2, connect_timeout: 15 });
const M = (v) => `$${(v / 100).toFixed(2)}`;
let fail = 0, n = 0;
const ok = (c, l) => { n++; if (!c) { fail++; console.log(`  x FAIL: ${l}`); } else console.log(`  + ${l}`); };

const [owner] = await sql`select * from admins where role='owner' limit 1`;
const [clubgg] = await sql`select * from platforms where code='clubgg'`;
const [club] = await sql`select * from clubs where platform_id=${clubgg.id} limit 1`;
const [btc] = await sql`select * from payment_methods where code='btc'`;   // now club
const [venmo] = await sql`select * from payment_methods where code='venmo'`; // p2p

async function mk(name, tg, uid) {
  await sql`delete from player_platforms where player_id in (select id from players where telegram_id=${tg})`;
  await sql`delete from players where telegram_id=${tg}`;
  const [p] = await sql`insert into players (telegram_id, display_name, status) values (${tg},${name},'active') returning *`;
  await sql`insert into player_platforms (player_id, platform_id, platform_uid_claimed, platform_uid, linked_at, club_id, linked_by)
    values (${p.id},${clubgg.id},${uid},${uid},now(),${club.id},${owner.id})`;
  return p;
}

console.log('\n=== CLUB-MEDIATED (crypto) + P2P (venmo) FLOWS ===\n');
console.log('settlement: btc=' + btc.settlement + ' venmo=' + venmo.settlement);

console.log('\n1. CRYPTO DEPOSIT -> club address, admin verifies');
const dep = await mk('CF_Dep', 991001, 'CF-DEP');
const [d] = await sql`select * from deposit_create(${dep.id}::uuid,${clubgg.id}::uuid,${btc.id}::uuid,${50_00}::bigint)`;
const [f] = await sql`select * from fills where deposit_id=${d.id} order by seq`;
ok(f.withdraw_id === null && f.payout_handle === btc.club_handle, `BTC deposit -> club address ${f.payout_handle.slice(0,12)}...`);
await sql`select fill_submit_proof(${f.id}::uuid,${'BTC-' + Date.now()},null)`;
await sql`select fill_admin_verify(${f.id}::uuid,${owner.id}::uuid,'seen on chain')`;
const [fr] = await sql`select status from fills where id=${f.id}`;
ok(fr.status === 'released', 'admin verified crypto deposit -> released');

console.log('\n2. CRYPTO WITHDRAWAL -> admin payout alert (no depositor matches)');
const wp = await mk('CF_With', 991002, 'CF-WITH');
const [w] = await sql`select * from withdraw_create(${wp.id}::uuid,${clubgg.id}::uuid,${btc.id}::uuid,${30_00}::bigint,'bc1qWITHDRAWADDR')`;
const [lo] = await sql`select * from loader_orders where id=${w.unload_order_id}`;
await sql`select loader_order_claim(${lo.id}::uuid,${owner.id}::uuid)`;
await sql`select loader_order_complete(${lo.id}::uuid,${owner.id}::uuid,${-30_00}::bigint,null)`;
const [w2] = await sql`select * from withdraw_requests where id=${w.id}`;
ok(w2.status === 'queued' && w2.amount === 30_00, 'crypto cash out escrowed + queued');
const [notif] = await sql`select count(*)::int c from notifications where kind='withdraw.needs_payout' and ref_id=${w.id}`;
ok(notif.c === 1, 'ADMIN PAYOUT ALERT queued (crypto needs club to pay)');
// admin pays from float
const [payFill] = await sql`select * from withdraw_club_payout(${w.id}::uuid,${owner.id}::uuid,null,'PAYOUT-TX-1','paid')`;
const [w3] = await sql`select * from withdraw_requests where id=${w.id}`;
ok(w3.status === 'completed', 'admin paid crypto cash out from float -> completed');

console.log('\n3. VENMO stays P2P (matches a queued withdrawal)');
const vw = await mk('CF_VenW', 991003, 'CF-VENW');
const [vwd] = await sql`select * from withdraw_create(${vw.id}::uuid,${clubgg.id}::uuid,${venmo.id}::uuid,${20_00}::bigint,'@venmo-user')`;
const [vlo] = await sql`select * from loader_orders where id=${vwd.unload_order_id}`;
await sql`select loader_order_claim(${vlo.id}::uuid,${owner.id}::uuid)`;
await sql`select loader_order_complete(${vlo.id}::uuid,${owner.id}::uuid,${-20_00}::bigint,null)`;
const vdep = await mk('CF_VenD', 991004, 'CF-VEND');
const [vd] = await sql`select * from deposit_create(${vdep.id}::uuid,${clubgg.id}::uuid,${venmo.id}::uuid,${20_00}::bigint)`;
const [vf] = await sql`select * from fills where deposit_id=${vd.id} order by seq`;
ok(vf.withdraw_id === vwd.id && vf.payout_handle === '@venmo-user', 'Venmo deposit matched P2P -> got payee @venmo-user');

console.log('\n4. LEDGER');
const probs = await sql`select * from ledger_verify()`;
ok(probs.length === 0, `ledger_verify clean (${probs.length})`);

console.log(fail ? `\nx ${fail}/${n} FAILED` : `\n+ ALL ${n} PASSED`);
// cleanup
for (const tg of [991001, 991002, 991003, 991004]) {
  await sql`delete from player_platforms where player_id in (select id from players where telegram_id=${tg})`.catch(()=>{});
}
await sql.end();
process.exit(fail ? 1 : 0);
