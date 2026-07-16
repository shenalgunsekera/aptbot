import postgres from 'postgres';

export type Sql = postgres.Sql<{}>;

let _sql: Sql | undefined;

/**
 * The single DB handle. Every money-moving call in this system is a `select
 * some_function(...)` against the plpgsql API — the apps are deliberately thin
 * clients that cannot corrupt the ledger even if they try.
 */
export function db(): Sql {
  if (_sql) return _sql;

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  _sql = postgres(url, {
    max: Number(process.env.PG_POOL_MAX ?? 10),
    onnotice: () => {},
    transform: { undefined: null },
    types: {
      // Money is bigint minor units. JS Number is exact to 2^53, which is ~90
      // trillion dollars in cents — comfortably beyond any poker union — so we
      // parse int8 to Number rather than BigInt and keep arithmetic ordinary.
      bigint: {
        to: 20,
        from: [20],
        serialize: (x: number) => String(x),
        parse: (x: string) => Number(x),
      },
    },
  });
  return _sql;
}

export async function closeDb(): Promise<void> {
  if (_sql) {
    await _sql.end({ timeout: 5 });
    _sql = undefined;
  }
}

/**
 * Postgres errors carry the SQLSTATE we set with `using errcode = ...` in the
 * plpgsql. We use a small set deliberately, so the UI layers can tell "the user
 * did something invalid" (show them the message) from "something broke" (log it,
 * show them nothing).
 */
export function isUserError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return (
    code === '22023' || // invalid_parameter_value — bad input, limits, states
    code === '42501' || // insufficient_privilege — not allowed / not yours
    code === '23505' || // unique_violation — duplicate payment ref etc.
    code === '23514'    // check_violation — insufficient funds, unbalanced
  );
}

/** The message we set in RAISE, with plpgsql's noise stripped. */
export function userMessage(err: unknown): string {
  const m = (err as { message?: string })?.message ?? 'Something went wrong.';
  return m.replace(/^ERROR:\s*/i, '').split('\n')[0] ?? 'Something went wrong.';
}
