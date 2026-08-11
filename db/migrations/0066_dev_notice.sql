-- ═══════════════════════════════════════════════════════════════════════════
-- 0066 — "Still in development" notice at the end of setup (toggleable)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- While the bot is pre-launch, players who finish onboarding are told not to use
-- deposits/cash-outs yet. Owner can flip it off from the panel once it's live.
alter table config add column if not exists dev_notice_enabled boolean not null default true;
