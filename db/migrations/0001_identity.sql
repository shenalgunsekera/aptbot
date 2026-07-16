-- ═══════════════════════════════════════════════════════════════════════════
-- 0001 — Identity: platforms, clubs, players, and who is who
-- ═══════════════════════════════════════════════════════════════════════════
--
-- This is the v2 schema. v1 lives in db/migrations-v1-archive/ for reference;
-- it was never deployed anywhere, so this set replaces it outright.
--
-- WHAT CHANGED FROM V1, AND WHY
-- ─────────────────────────────
-- 1. NO PER-PLAYER CHIP BALANCE. v1 tracked "chips we think this player has on
--    the table" and spent three accounts (player_chips, house_gameplay) plus a
--    sync pipeline keeping that fiction honest. The truth is simpler and
--    harsher: players gamble, there is no API, and the system cannot know a
--    live stack. So it stops claiming to. The UNLOAD is the truth — whatever a
--    loader actually pulls off a table is what becomes credit. Nothing here
--    stores, shows, or checks an "available balance", because no such number
--    exists.
--
-- 2. PLATFORMS. A player can be on ClubGG and on the Sportsbook, each with its
--    own id, its own club, and its OWN WALLET. Two independent books under one
--    union. Real-world money (the P2P matching queue) is shared; internal
--    credit is not.
--
-- 3. THE PLAYER'S NAME IS A REAL IDENTIFIER. Unique across the union, shown
--    everywhere a human is about to act. Money still routes on the platform id
--    underneath, because ids cannot be renamed mid-dispute and names can.
--
-- MONEY REPRESENTATION (unchanged from v1)
-- ────────────────────────────────────────
-- All amounts are bigint MINOR UNITS (cents). No float, numeric, or money type
-- anywhere: binary floating point cannot represent 0.10 exactly, and a ledger
-- that must sum to exactly zero cannot tolerate representation error.

create extension if not exists pgcrypto;  -- gen_random_uuid()

-- ─── Vocabulary ─────────────────────────────────────────────────────────────

-- Irreversible (crypto, cash) cannot be clawed back by the sender, so value can
-- release immediately. Reversible (card, PayPal, bank) can be reversed days
-- later, so it sits under a hold first.
create type reversibility_tier as enum ('irreversible', 'reversible');

-- HOW a payment method settles:
--   p2p  — depositors pay queued withdrawers directly, oldest first; the club's
--          own account is only a fallback when nobody is queued.
--   club — every payment goes through the club's account, both directions. A
--          depositor always pays the club; a withdrawer is always paid BY the
--          club. No player ever sees another player's details. PayPal runs this
--          way: chargebacks land on the club, not on a player who can't absorb
--          them — and the club fronts the float in exchange.
create type settlement_mode as enum ('p2p', 'club');

create type player_status as enum ('pending', 'active', 'frozen', 'banned');

create type deposit_status as enum (
  'matching', 'awaiting_payment', 'awaiting_confirmation',
  'completed', 'cancelled', 'expired'
);

create type withdraw_status as enum (
  'pending_unload', 'queued', 'partially_filled',
  'filled', 'completed', 'cancelled'
);

create type fill_status as enum (
  'locked', 'awaiting_confirmation', 'released',
  'disputed', 'refunded', 'expired', 'cancelled'
);

-- Work orders for the human loaders: put value on a player's account at the
-- platform, or take it off.
create type order_status as enum ('pending', 'claimed', 'done', 'failed', 'cancelled');

-- ─── Chart of accounts ──────────────────────────────────────────────────────
-- Every account's balance is SUM(amount) over its ledger entries, and the sum
-- of ALL entries, per currency, is ALWAYS exactly zero.
--
--   player_wallet    (+) union owes the player this much internal credit,
--                        per platform. Credit exists only between an unload
--                        and a withdrawal, or a deposit and a load.
--   player_escrow    (+) credit locked behind a queued withdrawal, per platform
--   house_rake       (+) rake the union has earned
--   house_loss       (−) money the union ate (reversals, split rulings, comps)
--   house_settlement (±) per platform: net value the union has physically
--                        pushed onto that platform's tables. Loads increase it,
--                        unloads decrease it. It legitimately swings negative
--                        when players win more off the tables than was put on.
--                        This is the ONLY chip tracking that survives v1 —
--                        a total per platform, never per player.
--   owner_float      (−) the owner is HOLDING this much real cash
--                    (+) the owner has PAID OUT this much real cash
--
-- There is deliberately NO "world" account. In a p2p fill, real money moves
-- player→player entirely outside this system, so the ledger records only the
-- internal transfer. Cash enters the ledger only when the club is a
-- counterparty — which is exactly what owner_float measures.
create type account_kind as enum (
  'player_wallet', 'player_escrow',
  'house_rake', 'house_loss', 'house_settlement',
  'owner_float'
);

create type flow_direction as enum ('deposit', 'withdraw');

-- ─── updated_at maintenance ─────────────────────────────────────────────────
create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ─── Admins ─────────────────────────────────────────────────────────────────
-- Authenticated by Firebase Auth on the panel and by telegram_id in the admin
-- group. Role lives HERE, not in a Firebase claim: a claim is a snapshot that
-- keeps working after you revoke someone; this row stops working on their next
-- request.
create table admins (
  id           uuid primary key default gen_random_uuid(),
  firebase_uid text unique not null,
  email        text not null,
  display_name text,
  role         text not null check (role in ('admin', 'owner')),

  -- Lets an admin act from the Telegram admin group and receive escalations.
  telegram_id  bigint unique,

  disabled     boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index admins_role_idx on admins (role) where not disabled;
create trigger admins_touch before update on admins
  for each row execute function touch_updated_at();

-- ─── Platforms ──────────────────────────────────────────────────────────────
create table platforms (
  id         uuid primary key default gen_random_uuid(),
  code       text unique not null,      -- 'clubgg', 'sportsbook'
  name       text not null,             -- what players see
  enabled    boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

insert into platforms (code, name, sort_order) values
  ('clubgg', 'ClubGG', 1),
  ('sportsbook', 'Sportsbook', 2);

-- ─── Clubs ──────────────────────────────────────────────────────────────────
-- The routing unit for loader work. A club belongs to one platform, and its
-- owner is the human whose hands can actually move value there. Money is NOT
-- partitioned by club — the ledger and the matching queue are union-wide.
create table clubs (
  id               uuid primary key default gen_random_uuid(),
  platform_id      uuid not null references platforms (id),
  code             text unique not null,
  name             text not null,
  -- The club's identifier inside the platform itself.
  platform_club_id text not null,
  owner_admin_id   uuid references admins (id),
  enabled          boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  unique (platform_id, platform_club_id)
);

create index clubs_platform_idx on clubs (platform_id) where enabled;
create trigger clubs_touch before update on clubs
  for each row execute function touch_updated_at();

-- ─── Players ────────────────────────────────────────────────────────────────
create table players (
  id                uuid primary key default gen_random_uuid(),
  telegram_id       bigint unique not null,
  telegram_username text,
  display_name      text,

  status            player_status not null default 'pending',

  -- Advisory flags raised by risk_scan and admin rulings. Admins act on these;
  -- the system never freezes anyone automatically.
  risk_flags        jsonb not null default '[]'::jsonb,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- The name as identifier: one name, one player, union-wide. Case-insensitive,
-- whitespace-trimmed, and enforced only for accounts that can transact — a
-- banned account's name may be reused.
alter table players add column display_name_key text
  generated always as (nullif(lower(trim(display_name)), '')) stored;

create unique index players_name_uniq
  on players (display_name_key)
  where display_name_key is not null and status <> 'banned';

create index players_status_idx on players (status);
create trigger players_touch before update on players
  for each row execute function touch_updated_at();

-- ─── A player's identity on each platform ───────────────────────────────────
-- Two columns for the id, and the split is load-bearing (unchanged from v1):
-- _claimed is what the PLAYER typed — untrusted. platform_uid is what an ADMIN
-- confirmed against the roster — trusted, and the key loaders act on. A typo'd
-- id doesn't bounce; it delivers value to a stranger, unrecoverably. One human
-- confirmation at link time is the only gate.
create table player_platforms (
  id                   uuid primary key default gen_random_uuid(),
  player_id            uuid not null references players (id),
  platform_id          uuid not null references platforms (id),

  platform_uid_claimed text,
  platform_uid         text,
  linked_by            uuid references admins (id),
  linked_at            timestamptz,

  -- Which club's loader serves this player on this platform. Nullable until an
  -- admin assigns it (automatic when the platform has exactly one club); loader
  -- work refuses to queue without it.
  club_id              uuid references clubs (id),

  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  unique (player_id, platform_id),
  constraint pp_linked_consistently
    check ((platform_uid is null) = (linked_at is null))
);

-- A confirmed id is unique per platform across the whole union. Two players on
-- one id would mean every credit either is owed lands in the same account.
create unique index player_platforms_uid_uniq
  on player_platforms (platform_id, platform_uid)
  where platform_uid is not null;
create index player_platforms_player_idx on player_platforms (player_id);
create index player_platforms_club_idx on player_platforms (club_id);

create trigger player_platforms_touch before update on player_platforms
  for each row execute function touch_updated_at();
