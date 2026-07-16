-- ═══════════════════════════════════════════════════════════════════════════
-- 0019 — v2 foundation: platforms, per-platform wallets, no chip fiction
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Three changes to the money model, all driven by one honest admission:
-- WE CANNOT KNOW A PLAYER'S LIVE CHIP BALANCE. They gamble; it changes every
-- hand; there is no API. So the system stops pretending it can.
--
--   1. There is no per-player chip balance any more. The old `player_chips`
--      account and the `house_gameplay` reconciliation account are gone. The
--      UNLOAD is the truth: whatever a loader actually pulls off the table is
--      what becomes credit. No pre-check, no "available balance", no drift.
--
--   2. A player transacts on one or more PLATFORMS (ClubGG, Sportsbook), each
--      with its own id and its own wallet. Money on ClubGG and money on the
--      sportsbook are separate books under one union.
--
--   3. The player's NAME is a first-class, unique identifier — shown everywhere
--      a human acts — while the platform id remains the key money is routed on.

-- ─── Platforms ──────────────────────────────────────────────────────────────
create table platforms (
  id         uuid primary key default gen_random_uuid(),
  code       text unique not null,          -- 'clubgg', 'sportsbook'
  name       text not null,                 -- shown to players
  enabled    boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

insert into platforms (code, name, sort_order) values
  ('clubgg', 'ClubGG', 1),
  ('sportsbook', 'Sportsbook', 2);

-- ─── Player name becomes a real identifier ──────────────────────────────────
-- "the name of the user should be prominent and taken as the main identifier."
-- We honour that safely: the NAME is unique and shown everywhere a human is
-- about to act, so loaders can trust it — while money stays keyed on the
-- platform id, which cannot change under a rename. Names people can change;
-- ledgers cannot chase a moving key.
alter table players add column display_name_key text
  generated always as (lower(trim(display_name))) stored;

-- Enforced only for active players — a half-registered pending row with a blank
-- name must not block anyone.
create unique index players_name_uniq
  on players (display_name_key)
  where display_name_key is not null and display_name_key <> '' and status <> 'banned';

-- ─── A player's id on each platform ─────────────────────────────────────────
-- Replaces the single players.clubgg_id. A player may be on ClubGG, the
-- sportsbook, or both — each with a different id and a separate wallet.
create table player_platforms (
  id            uuid primary key default gen_random_uuid(),
  player_id     uuid not null references players (id),
  platform_id   uuid not null references platforms (id),

  -- What the player typed. Untrusted until an admin confirms it.
  platform_uid_claimed text,
  -- What an admin confirmed. The key money is routed on.
  platform_uid  text,
  linked_by     uuid references admins (id),
  linked_at     timestamptz,

  -- Which club (on this platform) loads this player. Nullable until assigned;
  -- chip work refuses without it, exactly as before.
  club_id       uuid references clubs (id),

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  unique (player_id, platform_id),
  constraint pp_linked_consistently
    check ((platform_uid is null) = (linked_at is null))
);

-- One confirmed id per platform is unique across the union.
create unique index player_platforms_uid_uniq
  on player_platforms (platform_id, platform_uid)
  where platform_uid is not null;
create index player_platforms_player_idx on player_platforms (player_id);
create index player_platforms_club_idx on player_platforms (club_id);

create trigger player_platforms_touch before update on player_platforms
  for each row execute function touch_updated_at();

-- ─── Accounts gain a platform dimension ─────────────────────────────────────
-- A wallet and its escrow now belong to (player, platform): separate wallets,
-- as decided. House accounts stay platform-agnostic except settlement.
alter table accounts add column platform_id uuid references platforms (id);

-- New chart of accounts. player_chips and house_gameplay are retired; a new
-- house_settlement (per platform) is the contra for value entering/leaving the
-- tables, which is all we can honestly track now.
alter type account_kind add value if not exists 'house_settlement';

-- Rebuild the uniqueness so it includes platform. A player's wallet is now keyed
-- (kind, player, platform, currency); house_settlement is (kind, platform,
-- currency); other house accounts stay (kind, currency).
drop index if exists accounts_player_uniq;
drop index if exists accounts_house_uniq;

create unique index accounts_player_uniq
  on accounts (kind, player_id, platform_id, currency)
  where player_id is not null;
create unique index accounts_house_platform_uniq
  on accounts (kind, platform_id, currency)
  where player_id is null and platform_id is not null;
create unique index accounts_house_uniq
  on accounts (kind, currency)
  where player_id is null and platform_id is null;

comment on table platforms is 'ClubGG, Sportsbook — each a place a player has an id, a club, and a wallet.';
comment on table player_platforms is 'A player''s confirmed id + club on one platform. The key money routes on.';
