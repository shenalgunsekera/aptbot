import { connect } from './db.mjs';

const DEADLINE_MS = 60_000;
const started = Date.now();

while (true) {
  const sql = connect({ max: 1, connect_timeout: 3 });
  try {
    await sql`select 1`;
    await sql.end();
    console.log('db: ready');
    process.exit(0);
  } catch (err) {
    await sql.end({ timeout: 1 }).catch(() => {});
    if (Date.now() - started > DEADLINE_MS) {
      console.error(`db: not ready after ${DEADLINE_MS}ms — ${err.message}`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
