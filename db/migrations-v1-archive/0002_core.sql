-- ═══════════════════════════════════════════════════════════════════════════
-- 0002 — Core entities: players, admins, payment methods, owner config
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Players ────────────────────────────────────────────────────────────────
create table players (
  id                uuid primary key default gen_random_uuid(),
  telegram_id       bigint unique not null,
  telegram_username text,
  display_name      text,

  -- ── ClubGG identity ──
  -- Two columns, and the split is load-bearing.
  --
  -- clubgg_id_claimed is what the PLAYER typed at registration. Untrusted.
  -- clubgg_id is what an ADMIN confirmed. Trusted, and the key the automated
  -- chip loader actually acts on.
  --
  -- They are separate because a typo'd ClubGG id in an automated loader does
  -- not bounce — it silently loads someone else's account, and chips are not
  -- recoverable once they hit a stranger's table. A human confirming the exact
  -- string once, at link time, is the only thing standing between a fat finger
  -- and an unrecoverable transfer. Simple mapping, no document verification
  -- (per spec) — but the mapping itself gets checked.
  clubgg_id_claimed text,
  clubgg_id         text unique,
  linked_by         uuid,
  linked_at         timestamptz,

  status            player_status not null default 'pending',

  -- Append-only-ish list of {code, note, at, by} objects raised by the
  -- velocity/collusion checks in 0009. Advisory: admins act on these.
  risk_flags        jsonb not null default '[]'::jsonb,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint players_linked_consistently
    check ((clubgg_id is null) = (linked_at is null)),
  -- A player cannot be active until an admin has linked their ClubGG id.
  constraint players_active_requires_link
    check (status <> 'active' or clubgg_id is not null)
);

create index players_status_idx on players (status);
create index players_clubgg_idx on players (clubgg_id) where clubgg_id is not null;

-- ─── Admins ─────────────────────────────────────────────────────────────────
-- Authenticated by Firebase Auth on the web panel (2FA enforced there).
-- `firebase_uid` is the join key from a verified Firebase ID token to a role.
-- Role lives HERE, not in Firebase custom claims, because the DB is the thing
-- that enforces it — a claim can be stale, this row cannot.
create table admins (
  id           uuid primary key default gen_random_uuid(),
  firebase_uid text unique not null,
  email        text not null,
  display_name text,
  role         text not null check (role in ('admin', 'owner')),

  -- Optional: lets an admin also act via Telegram and receive escalations.
  telegram_id  bigint unique,

  disabled     boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index admins_role_idx on admins (role) where not disabled;

alter table players
  add constraint players_linked_by_fk foreign key (linked_by) references admins (id);

-- ─── Payment methods ────────────────────────────────────────────────────────
create table payment_methods (
  id             uuid primary key default gen_random_uuid(),
  code           text unique not null,          -- 'usdt_trc20', 'paypal', ...
  name           text not null,                 -- shown in the bot
  currency       char(3) not null,
  reversibility  reversibility_tier not null,
  enabled        boolean not null default true,

  -- Optional per-method bounds, in minor units. Null = fall back to config.
  min_amount     bigint check (min_amount is null or min_amount > 0),
  max_amount     bigint check (max_amount is null or max_amount > 0),

  -- The owner's own payout handle for this method. Revealed to a depositor
  -- ONLY when their deposit cannot be matched to a pending withdrawal.
  -- Null = this method cannot be backstopped; unmatched deposits will wait.
  backstop_handle text,

  -- Per-method override of config.reversible_hold_seconds. Null = use config.
  hold_seconds   integer check (hold_seconds is null or hold_seconds >= 0),

  -- The PROCESSOR's own cut (what Wise/PayPal/the chain takes), used to compute
  -- what a depositor must SEND so the withdrawer NETS the amount they asked
  -- for. This never enters the ledger — the processor takes it outside our
  -- perimeter — it only changes the number we quote the depositor.
  -- bps of 10000 would mean the processor takes everything; rejected.
  processor_fee_bps  int not null default 0
    check (processor_fee_bps between 0 and 9999),
  processor_fee_flat bigint not null default 0 check (processor_fee_flat >= 0),

  -- Shown to a withdrawer when asking for their payout handle, e.g.
  -- "your USDT TRC20 address (starts with T)". Pure UX, no logic depends on it.
  handle_hint    text,

  -- Advisory regex the bot uses to sanity-check a payout handle at entry.
  -- Catches typos, not fraud.
  handle_pattern text,

  sort_order     integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint payment_methods_bounds_sane
    check (min_amount is null or max_amount is null or min_amount <= max_amount)
);

create index payment_methods_enabled_idx on payment_methods (enabled, sort_order);

-- ─── Owner config (singleton) ───────────────────────────────────────────────
-- One row, enforced by the `id` primary key being a constant-true boolean.
-- Every knob the spec puts in the owner's hands lives here.
create table config (
  id boolean primary key default true check (id),

  base_currency char(3) not null default 'USD',

  -- ── Matching ──
  -- How long a depositor holds a revealed handle before the lock is swept and
  -- the slice returns to the FRONT of the FIFO queue. Spec default 15–30 min.
  match_timeout_seconds int not null default 1800
    check (match_timeout_seconds between 60 and 86400),

  -- ── Reversibility holds ──
  allow_reversible        boolean not null default true,
  reversible_hold_seconds int not null default 259200   -- 72h
    check (reversible_hold_seconds >= 0),
  -- If true, a reversible fill with no dispute auto-releases at hold_until.
  -- If false, it waits for the withdrawer or an admin — safer, slower.
  auto_release_on_expiry  boolean not null default false,

  -- ── Rake (booked to house_rake) ──
  -- Charged as bps + flat, per direction. Deposit rake is taken when a fill
  -- releases; withdraw rake is taken up front when the withdrawal is escrowed.
  rake_deposit_bps   int not null default 0 check (rake_deposit_bps between 0 and 10000),
  rake_deposit_flat  bigint not null default 0 check (rake_deposit_flat >= 0),
  rake_withdraw_bps  int not null default 0 check (rake_withdraw_bps between 0 and 10000),
  rake_withdraw_flat bigint not null default 0 check (rake_withdraw_flat >= 0),

  -- ── Processor fee bearer ──
  -- 'depositor'  → depositor sends GROSS so the withdrawer nets the ask (default)
  -- 'withdrawer' → depositor sends the ask; withdrawer eats the processor's cut
  -- This never touches the ledger: the processor's fee is taken outside our
  -- perimeter. It only changes the number we TELL the depositor to send.
  fee_bearer text not null default 'depositor'
    check (fee_bearer in ('depositor', 'withdrawer')),

  -- ── Limits ──
  min_amount               bigint not null default 100 check (min_amount > 0),
  max_amount               bigint not null default 500000 check (max_amount > 0),
  daily_cap_per_player     bigint check (daily_cap_per_player is null or daily_cap_per_player > 0),
  max_open_deposits_per_player int not null default 3 check (max_open_deposits_per_player > 0),
  max_open_withdraws_per_player int not null default 3 check (max_open_withdraws_per_player > 0),
  handle_reveals_per_hour  int not null default 10 check (handle_reveals_per_hour > 0),

  -- Withdrawals at or above this need an OWNER (not just admin) sign-off.
  -- Null = no threshold; any admin may act.
  owner_approval_threshold bigint check (owner_approval_threshold is null or owner_approval_threshold > 0),

  -- ── Live ClubGG balance check ──
  -- Whether a withdrawal must be validated against the player's REAL ClubGG
  -- stack before it is accepted, rather than against what the ledger believes.
  --
  -- These differ constantly: players gamble. Approving a withdrawal off the
  -- ledger means approving against chips the player may have lost an hour ago —
  -- you find out only when an admin tries the unload and comes up short, after
  -- the player has already been told yes.
  --
  -- Requires a chip adapter that can read balances (see packages/core/chips).
  -- Off by default because with a purely manual chip desk there is nothing to
  -- read from, and the unload-came-up-short path in 0009 is the safety net.
  require_live_chip_check boolean not null default false,
  -- How stale a snapshot may be and still count as "live". A player can lose a
  -- stack in one hand, so this wants to be seconds, not minutes.
  live_chip_check_max_age_seconds int not null default 120
    check (live_chip_check_max_age_seconds > 0),

  -- ── Ops ──
  reconcile_cron text not null default '0 * * * *',

  -- If the withdrawer doesn't respond to a confirmation request within this
  -- window, the fill escalates to admin review rather than stalling forever.
  confirm_escalation_seconds int not null default 86400
    check (confirm_escalation_seconds > 0),

  updated_at timestamptz not null default now(),
  updated_by uuid references admins (id),

  constraint config_bounds_sane check (min_amount <= max_amount)
);

insert into config (id) values (true);

-- ─── Audit log ──────────────────────────────────────────────────────────────
-- Every admin action, attributable and immutable. Enforcement of immutability
-- lives in 0003 alongside the ledger's, since they share the same trigger.
create table audit_log (
  id         bigserial primary key,
  admin_id   uuid references admins (id),   -- null = system/automated action
  action     text not null,                 -- 'fill.fast_path_confirm', ...
  ref_type   text,
  ref_id     uuid,
  -- Before/after snapshots for config changes; evidence for rulings.
  detail     jsonb not null default '{}'::jsonb,
  ip         inet,
  created_at timestamptz not null default now()
);

create index audit_log_admin_idx on audit_log (admin_id, created_at desc);
create index audit_log_ref_idx   on audit_log (ref_type, ref_id, created_at desc);
create index audit_log_action_idx on audit_log (action, created_at desc);

-- ─── updated_at maintenance ─────────────────────────────────────────────────
create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger players_touch         before update on players
  for each row execute function touch_updated_at();
create trigger admins_touch          before update on admins
  for each row execute function touch_updated_at();
create trigger payment_methods_touch before update on payment_methods
  for each row execute function touch_updated_at();
create trigger config_touch          before update on config
  for each row execute function touch_updated_at();
