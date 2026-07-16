-- ═══════════════════════════════════════════════════════════════════════════
-- 0012 — Bot conversation sessions
-- ═══════════════════════════════════════════════════════════════════════════
--
-- grammY's default session store is an in-memory Map. That is fine for a
-- long-running process (local dev), but FATAL on serverless: each Vercel webhook
-- invocation is a fresh, possibly cold, function instance with an empty Map. So
-- the step set by /start ("waiting for your name") is gone by the time the next
-- message arrives, and the bot forgets where it was mid-flow.
--
-- The fix is to persist session state where every invocation can see it — the
-- database. This table is that store, driven by a grammY StorageAdapter.
--
-- It holds NO money and NO decisions: only "which question is this user
-- answering", keyed by their telegram id. Safe to truncate; a player just
-- restarts whatever flow they were in.
create table bot_sessions (
  key        text primary key,           -- the session key (telegram user id)
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- Stale sessions are harmless but need not live forever.
create index bot_sessions_stale_idx on bot_sessions (updated_at);
