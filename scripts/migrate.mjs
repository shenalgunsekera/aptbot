import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { connect, ROOT } from './db.mjs';

const DIR = join(ROOT, 'db', 'migrations');
const sql = connect({ max: 1 });

await sql`
  create table if not exists schema_migrations (
    filename   text primary key,
    checksum   text not null,
    applied_at timestamptz not null default now()
  )
`;

const applied = new Map(
  (await sql`select filename, checksum from schema_migrations`).map((r) => [
    r.filename,
    r.checksum,
  ]),
);

const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

let ran = 0;
for (const file of files) {
  const body = readFileSync(join(DIR, file), 'utf8');
  const checksum = createHash('sha256').update(body).digest('hex').slice(0, 16);

  const prev = applied.get(file);
  if (prev) {
    if (prev !== checksum) {
      console.error(
        `\n  ✗ ${file} was modified after being applied.\n` +
          `    Applied checksum ${prev}, file is now ${checksum}.\n` +
          `    Migrations are immutable once applied — add a new one, or run \`pnpm db:reset\` in dev.\n`,
      );
      await sql.end();
      process.exit(1);
    }
    continue;
  }

  // Each migration runs in its own transaction: a failure leaves the DB on the
  // last good migration rather than half-applied.
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into schema_migrations (filename, checksum)
               values (${file}, ${checksum})`;
    });
    console.log(`  ✓ ${file}`);
    ran++;
  } catch (err) {
    console.error(`\n  ✗ ${file}\n    ${err.message}\n`);
    await sql.end();
    process.exit(1);
  }
}

console.log(ran ? `\nmigrate: applied ${ran}` : 'migrate: up to date');
await sql.end();
