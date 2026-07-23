-- ═══════════════════════════════════════════════════════════════════════════
-- 0040 — Email freshness by WATERMARK, not wall-clock age
-- ═══════════════════════════════════════════════════════════════════════════
-- 0039 muted "stale" emails by absolute age (older than N minutes = silent).
-- That backfires when the inbox poll runs late (GitHub-Actions cron lag): a real
-- payment can age past the window before it's ever scanned, and never gets
-- announced. So we track a watermark instead — the date of the newest email we've
-- already announced. Anything newer than the watermark is announced no matter how
-- long it waited; anything at/older is recorded silently. The watermark lives in
-- config (which survives a data reset), so a wipe of payment_events can't cause a
-- re-flood either.
alter table config add column if not exists email_watermark timestamptz;

-- Seed to now so the current backlog stays quiet; everything that arrives from
-- here on is newer than the watermark and gets announced.
update config set email_watermark = now() where email_watermark is null;
