import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, ROOT } from './db.mjs';

// One healthy connection, everything on it, before the flaky Windows npipe proxy
// can drop it. Retries connection establishment aggressively.
async function getConn() {
  for (let i = 0; i < 40; i++) {
    const sql = connect({ max: 1, connect_timeout: 4, idle_timeout: 0 });
    try { await sql`select 1`; return sql; }
    catch { await sql.end({ timeout: 1 }).catch(() => {}); await new Promise(r => setTimeout(r, 1000)); }
  }
  throw new Error('could not establish a connection after 40 tries');
}

const sql = await getConn();
console.log('connected');

const fresh = process.argv.includes('--fresh');
if (fresh) {
  await sql.unsafe('drop schema public cascade; create schema public;');
  console.log('schema reset');
}

await sql`create table if not exists schema_migrations (
  filename text primary key, applied_at timestamptz not null default now())`;
const done = new Set((await sql`select filename from schema_migrations`).map(r => r.filename));

const dir = join(ROOT, 'db', 'migrations');
const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
let ran = 0;
for (const f of files) {
  if (done.has(f)) continue;
  const body = readFileSync(join(dir, f), 'utf8');
  try {
    await sql.begin(async tx => {
      await tx.unsafe(body);
      await tx`insert into schema_migrations (filename) values (${f})`;
    });
    console.log('  OK ' + f); ran++;
  } catch (e) {
    console.error('  FAIL ' + f + '\n    ' + e.message);
    await sql.end(); process.exit(1);
  }
}
console.log(ran ? `\napplied ${ran}` : 'up to date');
await sql.end();
