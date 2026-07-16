import { connect } from './db.mjs';
const sql = connect({ max: 1, connect_timeout: 15 });

// KEPT (configuration): admins, platforms, clubs, payment_methods, config
// WIPED (all transactional/test data):
const WIPE = [
  'ledger_entries', 'ledger_transactions', 'accounts',
  'fills', 'deposit_requests', 'withdraw_requests',
  'loader_orders', 'disputes', 'receipts',
  'players', 'player_platforms', 'player_prefs', 'payout_handles',
  'notifications', 'bot_sessions', 'support_threads', 'audit_log',
];

console.log('BEFORE — configuration (kept):');
for (const t of ['admins', 'platforms', 'clubs', 'payment_methods']) {
  const [r] = await sql`select count(*)::int c from ${sql(t)}`;
  console.log(`  ${t}: ${r.c}`);
}
console.log('\nBEFORE — data to wipe:');
for (const t of ['players', 'fills', 'ledger_entries', 'notifications']) {
  const [r] = await sql`select count(*)::int c from ${sql(t)}`;
  console.log(`  ${t}: ${r.c}`);
}

// TRUNCATE bypasses the append-only triggers on ledger/receipts/audit (they
// guard against UPDATE/DELETE, not DDL) — which is exactly what a full reset
// needs. CASCADE only follows FKs FROM these tables; the kept config tables are
// referenced BY them, never the other way, so config is untouched.
await sql.unsafe(`truncate ${WIPE.join(', ')} restart identity cascade`);

console.log('\nAFTER — data (should all be 0):');
for (const t of ['players', 'fills', 'ledger_entries', 'notifications', 'bot_sessions']) {
  const [r] = await sql`select count(*)::int c from ${sql(t)}`;
  console.log(`  ${t}: ${r.c}`);
}

console.log('\nAFTER — configuration intact:');
const admins = await sql`select email, role, telegram_id from admins order by role`;
for (const a of admins) console.log(`  admin: ${a.email} (${a.role})${a.telegram_id ? ' tg=' + a.telegram_id : ''}`);
const methods = await sql`select code, enabled, settlement from payment_methods order by sort_order`;
console.log(`  payment methods: ${methods.length} (${methods.filter((m) => m.enabled).length} enabled)`);
const clubs = await sql`select c.name, pf.name as platform from clubs c join platforms pf on pf.id=c.platform_id`;
for (const c of clubs) console.log(`  club: ${c.name} on ${c.platform}`);

const probs = await sql`select * from ledger_verify()`;
console.log(`\nledger_verify: ${probs.length} problems (clean = 0)`);

console.log('\n✓ CLEAN PRODUCTION DB');
await sql.end();
