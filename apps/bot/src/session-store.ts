import { db } from '@union/core';
import type { StorageAdapter } from 'grammy';

/**
 * Postgres-backed session storage for grammY.
 *
 * Replaces the default in-memory Map, which loses all state between serverless
 * invocations. With this, /start on one Vercel function instance and the reply
 * on another share the same conversation step — because it lives in Neon, not in
 * whichever function happens to handle the request.
 */
export function pgSessionStorage<T>(): StorageAdapter<T> {
  return {
    async read(key: string): Promise<T | undefined> {
      const sql = db();
      const [r] = await sql<{ value: T }[]>`select value from bot_sessions where key = ${key}`;
      return r ? r.value : undefined;
    },
    async write(key: string, value: T): Promise<void> {
      const sql = db();
      await sql`
        insert into bot_sessions (key, value) values (${key}, ${sql.json(value as any)})
        on conflict (key) do update set value = excluded.value, updated_at = now()`;
    },
    async delete(key: string): Promise<void> {
      await db()`delete from bot_sessions where key = ${key}`;
    },
  };
}
