import assert from 'node:assert/strict';
import { connect, dbUrl } from '../../scripts/db.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// SAFETY INTERLOCK — do not remove.
//
// resetState() runs `truncate … players, ledger_entries, … cascade`. That is
// correct and necessary for tests. It is also, pointed at the wrong database,
// the single most destructive command in this repository: it would silently
// erase the append-only ledger that every balance in the union is derived from.
//
// There is no undo. The ledger's whole design — append-only triggers, deferred
// constraints — protects against bad WRITES. None of it protects against
// TRUNCATE, because truncate is a DDL-level operation that bypasses row triggers
// entirely.
//
// So the tests refuse to run anywhere that isn't provably the local Docker
// database from docker-compose.yml. The failure mode this prevents is mundane
// and entirely plausible: a .env still pointing at Neon from a deploy, and a
// reflexive `pnpm test:db`.
// ─────────────────────────────────────────────────────────────────────────────
const url = dbUrl();
const LOCAL = /^postgres:\/\/union:union_dev_pw@(localhost|127\.0\.0\.1):54329\/union/;

if (!LOCAL.test(url) && process.env.I_KNOW_THIS_WIPES_THE_DATABASE !== 'yes') {
  const redacted = url.replace(/:\/\/[^@]*@/, '://***@');
  console.error(`
  ✗ REFUSING TO RUN TESTS.

    These tests TRUNCATE the ledger. DATABASE_URL does not point at the local
    Docker database, so this would destroy real data:

      ${redacted}

    Expected: postgres://union:union_dev_pw@localhost:54329/union

    Start the local database with:  pnpm db:up && pnpm db:migrate && pnpm db:seed

    If you genuinely mean to wipe the database this points at, re-run with
    I_KNOW_THIS_WIPES_THE_DATABASE=yes — but read that sentence again first.
`);
  process.exit(1);
}

export const sql = connect({ max: 10 });

/** Wipe all transactional state, keep config/methods/the seeded admins. */
export async function resetState() {
  await sql`
    truncate
      ledger_entries, ledger_transactions, accounts,
      fills, deposit_requests, withdraw_requests,
      chip_orders, disputes, notifications, audit_log,
      clubgg_snapshots, players
    restart identity cascade
  `;

  // `admins` and `clubs` are deliberately NOT truncated above — the seeded owner,
  // the chip-adapter service account and the real club must survive a test run.
  // So anything tests create there would pile up in the dev database forever.
  //
  // That is not cosmetic. A leaked test CLUB makes the union look like it has two
  // clubs, which turns "which club does this player belong to?" back into a real
  // question — and every new player registering through the bot then fails with
  // "not assigned to a club". A leaked test ADMIN with role='owner' is worse.
  //
  // Everything the tests create is `test:`-prefixed so this can never touch a
  // real row. Runs after the truncate, which already cleared what referenced them.
  await sql`delete from admins where firebase_uid like 'test:%'`;
  await sql`delete from clubs where code like 'test:%'`;
}

/** Create a throwaway admin. The `test:` prefix is what makes resetState able
 *  to clean it up without risking a real account. */
export async function mkAdmin(name, role = 'admin') {
  const [a] = await sql`
    insert into admins (firebase_uid, email, role)
    values (${'test:' + name}, ${name + '@test.local'}, ${role})
    on conflict (firebase_uid) do update set role = excluded.role
    returning *`;
  return a;
}

/**
 * The club every test player joins.
 *
 * `test:` prefixed so resetState can remove it. Without that it survives the run
 * and the union permanently looks multi-club — which breaks bot registration for
 * real players, because "which club?" stops having an obvious answer.
 */
export async function testClub() {
  const [c] = await sql`
    insert into clubs (code, name, clubgg_club_id)
    values ('test:club', 'Test Club', 'test:CLUB')
    on conflict (code) do update set name = excluded.name
    returning *`;
  return c;
}

export async function mkPlayer(name, telegramId, clubId) {
  // A player with no club cannot have chip work routed to them — chip_order_create
  // rejects it, because an order nobody's worker will claim is worse than an
  // error. So every test player gets a club.
  const club = clubId ?? (await testClub()).id;
  const [p] = await sql`
    insert into players (telegram_id, display_name, clubgg_id_claimed, clubgg_id,
                         status, linked_at, club_id)
    values (${telegramId}, ${name}, ${'CG-' + name}, ${'CG-' + name}, 'active', now(), ${club})
    returning *
  `;
  return p;
}

export async function method(code) {
  const [m] = await sql`select * from payment_methods where code = ${code}`;
  return m;
}

export async function owner() {
  const [a] = await sql`select * from admins where role = 'owner' limit 1`;
  return a;
}

/** Give a player chips out of thin air — test fixture only. Books against
 *  house_gameplay so the ledger still balances and ledger_verify stays clean. */
export async function grantChips(playerId, amount, currency = 'USD') {
  await sql`
    select ledger_post('test.grant_chips', 'player', ${playerId}::uuid, null, 'test fixture',
      jsonb_build_array(
        jsonb_build_object('account_id', account_of('player_chips', ${playerId}::uuid, ${currency}), 'amount', ${amount}::bigint),
        jsonb_build_object('account_id', account_of('house_gameplay', null, ${currency}), 'amount', ${-amount}::bigint)
      ))
  `;
}

export async function balance(kind, playerId, currency = 'USD') {
  const [r] = await sql`select balance_of(${kind}, ${playerId}::uuid, ${currency}) as b`;
  return r.b;
}

export async function houseBalance(kind, currency = 'USD') {
  const [r] = await sql`select balance_of(${kind}, null, ${currency}) as b`;
  return r.b;
}

/** The whole point. Call after every test. */
export async function assertLedgerHealthy(label = '') {
  const problems = await sql`select * from ledger_verify()`;
  // Compare on length, not deepEqual: postgres.js hands back a Result object
  // rather than a plain Array, so deepEqual(result, []) fails even when empty.
  assert.equal(
    problems.length,
    0,
    `LEDGER INVARIANT VIOLATED ${label}\n${JSON.stringify([...problems], null, 2)}`,
  );
}

/** Run a withdrawal through unload so it lands in the queue. */
export async function queueWithdraw(player, methodRow, gross, handle) {
  const [w] = await sql`
    select * from withdraw_create(${player.id}::uuid, ${methodRow.id}::uuid, ${gross}::bigint, ${handle})
  `;
  if (w.status === 'pending_unload') {
    const [o] = await sql`select * from chip_orders where id = ${w.unload_order_id}`;
    const adm = await owner();
    await sql`select chip_order_claim(${o.id}::uuid, ${adm.id}::uuid)`;
    await sql`select chip_order_complete(${o.id}::uuid, ${adm.id}::uuid)`;
  }
  const [fresh] = await sql`select * from withdraw_requests where id = ${w.id}`;
  return fresh;
}

export async function fillsOf(depositId) {
  return sql`select * from fills where deposit_id = ${depositId} order by seq`;
}
