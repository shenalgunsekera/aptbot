#!/usr/bin/env node
/**
 * Money-flow smoke test — SAFE to run against production.
 *
 * Every check runs inside a transaction that is ALWAYS rolled back, so it never
 * changes a single row. It exercises the money-mutating DB functions on whatever
 * real rows exist right now and asserts they don't throw — which is exactly how a
 * constraint-violation regression (e.g. a full cancel driving amount to 0) shows
 * up. Run it before a deploy, or after any change to the withdraw/fill/loader SQL.
 *
 *   node scripts/smoke-money.mjs
 *
 * Reads DATABASE_URL from the environment / .env (same as the app).
 */
import { readFileSync } from 'node:fs';
import postgres from 'postgres';

const url = (process.env.DATABASE_URL
  ?? (readFileSync(new URL('../.env', import.meta.url), 'utf8').match(/^DATABASE_URL=(.*)$/m)?.[1] ?? ''))
  .trim().replace(/^["']|["']$/g, '');
if (!url) { console.error('DATABASE_URL not set'); process.exit(2); }

const sql = postgres(url, { ssl: 'require', max: 2, idle_timeout: 15, connect_timeout: 40 });
const ROLLBACK = Symbol('rollback');
let pass = 0, fail = 0, skip = 0;

/** Run `body(tx)` in a transaction that is guaranteed to roll back. A throw from
 *  the DB (constraint violation, bad state) fails the check; a clean run passes. */
async function check(name, findRow, body) {
  const row = await findRow().catch(() => null);
  if (!row) { console.log(`  ⏭  ${name} — no suitable row right now`); skip++; return; }
  try {
    await sql.begin(async (tx) => { await body(tx, row); throw ROLLBACK; });
  } catch (e) {
    if (e === ROLLBACK) { console.log(`  ✅ ${name}`); pass++; return; }
    console.log(`  ❌ ${name} — ${String(e.message).split('\n')[0]}`); fail++;
  }
}

(async () => {
  console.log('Money-flow smoke test (all rolled back, nothing changes)\n');

  // 1) Full cancel of an UNPAID queued cash-out — the 0074 regression.
  await check('cancel: full unpaid cash-out',
    () => sql`select id, amount_remaining from withdraw_requests
              where status in ('queued','partially_filled') and amount_remaining = amount and amount_remaining > 0
              order by created_at desc limit 1`.then(r => r[0]),
    (tx, w) => tx`select withdraw_player_cancel(${w.id}::uuid, ${w.amount_remaining}::bigint, null)`);

  // 2) Partial cancel ($5 step) of a cash-out with room to leave the minimum.
  await check('cancel: partial cash-out',
    () => sql`select w.id, w.amount_remaining, cfg.min_amount from withdraw_requests w, config cfg
              where w.status in ('queued','partially_filled')
                and w.amount_remaining - 500 >= cfg.min_amount and (w.amount_remaining % 500) = 0
              order by w.created_at desc limit 1`.then(r => r[0]),
    (tx, w) => tx`select withdraw_player_cancel(${w.id}::uuid, 500::bigint, null)`);

  // 3) Verify + release a fill that's awaiting confirmation.
  await check('verify: awaiting fill',
    () => sql`select f.id, (select id from admins where not disabled order by role='owner' desc limit 1) admin
              from fills f where f.status = 'awaiting_confirmation' order by f.created_at desc limit 1`.then(r => r[0]),
    (tx, f) => tx`select fill_admin_verify(${f.id}::uuid, ${f.admin}::uuid, 'smoke test')`);

  // 4) Claim + complete a pending loader task.
  await check('loader: claim + complete',
    () => sql`select o.id, o.delta, (select id from admins where not disabled order by role='owner' desc limit 1) admin
              from loader_orders o where o.status = 'pending' order by o.created_at desc limit 1`.then(r => r[0]),
    async (tx, o) => {
      await tx`select loader_order_claim(${o.id}::uuid, ${o.admin}::uuid)`;
      await tx`select loader_order_complete(${o.id}::uuid, ${o.admin}::uuid, ${o.delta}::bigint, 'smoke test')`;
    });

  // 5) Deposit match end-to-end for a real player's confirmed platform.
  await check('deposit: create + match',
    () => sql`select p.id player, pp.platform_id, m.id method from players p
              join player_platforms pp on pp.player_id = p.id and pp.platform_uid is not null and pp.club_id is not null
              join payment_methods m on m.enabled and m.settlement = 'club' and m.reversibility = 'irreversible'
              where p.status = 'active' order by p.created_at desc limit 1`.then(r => r[0]),
    (tx, d) => tx`select deposit_create(${d.player}::uuid, ${d.platform_id}::uuid, ${d.method}::uuid, 2000::bigint)`);

  console.log(`\n${pass} passed · ${fail} failed · ${skip} skipped`);
  await sql.end();
  process.exit(fail > 0 ? 1 : 0);
})().catch(async (e) => { console.error('smoke test crashed:', e.message); await sql.end().catch(() => {}); process.exit(2); });
