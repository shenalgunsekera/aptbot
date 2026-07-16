import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Minimal .env loader. We deliberately avoid a dotenv dependency at the script
 * layer so `pnpm db:*` works before any workspace install.
 */
export function loadEnv() {
  const path = join(ROOT, '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i.exec(line);
    if (!m) continue;
    const [, k, raw] = m;
    if (process.env[k] !== undefined) continue;
    process.env[k] = raw.replace(/^["'](.*)["']$/s, '$1');
  }
}

export function dbUrl() {
  loadEnv();
  return (
    process.env.DATABASE_URL ||
    'postgres://union:union_dev_pw@localhost:54329/union'
  );
}

/**
 * @param {object} [opts]
 * @param {number} [opts.max] pool size
 */
export function connect(opts = {}) {
  return postgres(dbUrl(), {
    max: opts.max ?? 5,
    onnotice: () => {},
    // Money is bigint minor units. node-postgres-style drivers hand back
    // bigints as strings by default; we want real BigInt-free numbers here
    // because JS Number is exact to 2^53 and our amounts are cents.
    types: {
      bigint: {
        to: 20,
        from: [20],
        serialize: (x) => String(x),
        parse: (x) => Number(x),
      },
    },
    ...opts,
  });
}
