-- ═══════════════════════════════════════════════════════════════════════════
-- 0002 — Payment methods, owner config, audit, notification outbox
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Payment methods ────────────────────────────────────────────────────────
create table payment_methods (
  id             uuid primary key default gen_random_uuid(),
  code           text unique not null,          -- 'usdt_trc20', 'paypal', ...
  name           text not null,
  currency       char(3) not null,
  reversibility  reversibility_tier not null,

  -- The big v2 switch. See 0001 for the definitions.
  --   p2p  → matching queue first, club account only as fallback
  --   club → ALL money flows through the club's account, both directions
  settlement     settlement_mode not null default 'p2p',

  enabled        boolean not null default true,
  min_amount     bigint check (min_amount is null or min_amount > 0),
  max_amount     bigint check (max_amount is null or max_amount > 0),

  -- The club's own account on this method.
  --   p2p methods:  the fallback a depositor pays when nobody is queued.
  --                 Null = unmatched deposits are refused outright.
  --   club methods: REQUIRED — it is where every deposit goes and every
  --                 withdrawal request is sent. The owner sets it in the panel.
  club_handle    text,

  -- Per-method override of config.reversible_hold_seconds. Null = use config.
  hold_seconds   integer check (hold_seconds is null or hold_seconds >= 0),

  -- The processor's own cut (PayPal's fee, the chain's gas) — used only to
  -- compute what a depositor must SEND so the recipient nets the ask. Never
  -- enters the ledger; the processor takes it outside our perimeter.
  processor_fee_bps  int not null default 0 check (processor_fee_bps between 0 and 9999),
  processor_fee_flat bigint not null default 0 check (processor_fee_flat >= 0),

  -- UX only: shown when asking a player for their payout details, plus an
  -- advisory regex that catches typos, not fraud.
  handle_hint    text,
  handle_pattern text,

  sort_order     integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint payment_methods_bounds_sane
    check (min_amount is null or max_amount is null or min_amount <= max_amount)
);

create index payment_methods_enabled_idx on payment_methods (enabled, sort_order);
create trigger payment_methods_touch before update on payment_methods
  for each row execute function touch_updated_at();

-- ─── Owner config (singleton) ───────────────────────────────────────────────
create table config (
  id boolean primary key default true check (id),

  base_currency char(3) not null default 'USD',

  -- ── The admin group ──
  -- The Telegram group where every admin notification lands and where admins
  -- work the queue with inline buttons. The bot NEVER creates a chat: an admin
  -- adds the bot to an existing group and runs the claim command there, and it
  -- is accepted only if their telegram_id matches an enabled row in `admins`.
  -- Null = fall back to DMing each admin individually.
  admin_group_chat_id bigint,
  admin_group_set_by  uuid references admins (id),
  admin_group_set_at  timestamptz,

  -- ── Matching ──
  -- How long a depositor holds a revealed counterparty before the slice goes
  -- back to the front of the queue.
  match_timeout_seconds int not null default 1800
    check (match_timeout_seconds between 60 and 86400),

  -- ── Reversibility holds ──
  allow_reversible        boolean not null default true,
  reversible_hold_seconds int not null default 259200   -- 72h
    check (reversible_hold_seconds >= 0),
  -- If true, a reversible fill with no dispute auto-releases at hold_until.
  auto_release_on_expiry  boolean not null default false,

  -- ── Rake (booked to house_rake) ──
  rake_deposit_bps   int not null default 0 check (rake_deposit_bps between 0 and 10000),
  rake_deposit_flat  bigint not null default 0 check (rake_deposit_flat >= 0),
  rake_withdraw_bps  int not null default 0 check (rake_withdraw_bps between 0 and 10000),
  rake_withdraw_flat bigint not null default 0 check (rake_withdraw_flat >= 0),

  -- ── Processor fee bearer ──
  -- 'depositor' → depositor sends gross so the recipient nets the ask (default)
  -- 'withdrawer'→ depositor sends the ask; the recipient eats the cut
  fee_bearer text not null default 'depositor'
    check (fee_bearer in ('depositor', 'withdrawer')),

  -- ── Limits ──
  min_amount               bigint not null default 100 check (min_amount > 0),
  max_amount               bigint not null default 500000 check (max_amount > 0),
  daily_cap_per_player     bigint check (daily_cap_per_player is null or daily_cap_per_player > 0),
  max_open_deposits_per_player  int not null default 3 check (max_open_deposits_per_player > 0),
  max_open_withdraws_per_player int not null default 3 check (max_open_withdraws_per_player > 0),
  handle_reveals_per_hour  int not null default 10 check (handle_reveals_per_hour > 0),

  -- Withdrawals at or above this need the OWNER, not just any admin.
  owner_approval_threshold bigint check (owner_approval_threshold is null or owner_approval_threshold > 0),

  -- If the counterparty doesn't respond to a confirmation request within this
  -- window, the fill escalates to admin review instead of stalling forever.
  confirm_escalation_seconds int not null default 86400
    check (confirm_escalation_seconds > 0),

  updated_at timestamptz not null default now(),
  updated_by uuid references admins (id),

  constraint config_bounds_sane check (min_amount <= max_amount)
);

insert into config (id) values (true);
create trigger config_touch before update on config
  for each row execute function touch_updated_at();

-- ─── Audit log ──────────────────────────────────────────────────────────────
-- Every admin action, attributable and immutable. The immutability trigger is
-- installed in 0003 alongside the ledger's — they share the same function.
create table audit_log (
  id         bigserial primary key,
  admin_id   uuid references admins (id),   -- null = system/automated action
  action     text not null,
  ref_type   text,
  ref_id     uuid,
  detail     jsonb not null default '{}'::jsonb,
  ip         inet,
  created_at timestamptz not null default now()
);

create index audit_log_admin_idx  on audit_log (admin_id, created_at desc);
create index audit_log_ref_idx    on audit_log (ref_type, ref_id, created_at desc);
create index audit_log_action_idx on audit_log (action, created_at desc);

-- p_admin null = the system did it. Logged anyway: "nobody did it, the clock
-- did" is still an answer the log owes.
create or replace function audit(
  p_admin    uuid,
  p_action   text,
  p_ref_type text,
  p_ref_id   uuid,
  p_detail   jsonb default '{}'::jsonb
) returns void
language sql as $$
  insert into audit_log (admin_id, action, ref_type, ref_id, detail)
  values (p_admin, p_action, p_ref_type, p_ref_id, coalesce(p_detail, '{}'::jsonb));
$$;

-- ─── Notification outbox ────────────────────────────────────────────────────
-- Transactional outbox: a money move and "tell someone about it" commit in the
-- SAME transaction, so they can never disagree. The bot drains this queue.
--
-- chat_id routing:
--   player_id set  → DM the player
--   admin_id  set  → DM that admin
--   audience 'admins' → the admin group if configured, else fan out to admins
create table notifications (
  id        bigserial primary key,
  player_id uuid references players (id),
  admin_id  uuid references admins (id),
  audience  text check (audience in ('admins')),

  kind      text not null,
  payload   jsonb not null default '{}'::jsonb,
  ref_type  text,
  ref_id    uuid,

  status    text not null default 'pending'
    check (status in ('pending', 'sent', 'failed', 'skipped')),
  attempts  int not null default 0,
  last_error text,

  send_after timestamptz not null default now(),
  sent_at    timestamptz,
  created_at timestamptz not null default now(),

  constraint notifications_has_recipient
    check (player_id is not null or admin_id is not null or audience is not null)
);

create index notifications_drain_idx on notifications (send_after, id)
  where status = 'pending';
create index notifications_ref_idx on notifications (ref_type, ref_id);

create or replace function notify_player(
  p_player   uuid,
  p_kind     text,
  p_ref_type text,
  p_ref_id   uuid,
  p_payload  jsonb default '{}'::jsonb
) returns bigint
language sql as $$
  insert into notifications (player_id, kind, ref_type, ref_id, payload)
  values (p_player, p_kind, p_ref_type, p_ref_id, coalesce(p_payload, '{}'::jsonb))
  returning id;
$$;

-- One row, audience 'admins'. The bot resolves it to the admin group at send
-- time (or falls back to individual DMs if no group is set yet). One row rather
-- than a fan-out means one message in the group, not one per admin.
create or replace function notify_admins(
  p_kind     text,
  p_ref_type text,
  p_ref_id   uuid,
  p_payload  jsonb default '{}'::jsonb
) returns bigint
language sql as $$
  insert into notifications (audience, kind, ref_type, ref_id, payload)
  values ('admins', p_kind, p_ref_type, p_ref_id, coalesce(p_payload, '{}'::jsonb))
  returning id;
$$;

-- ─── The admin-group claim ──────────────────────────────────────────────────
-- Run from inside a Telegram group by someone whose telegram_id is an enabled
-- admin. The bot passes the chat id and the sender's telegram id; this function
-- is the whole authorisation check, so the rule cannot be bypassed by a
-- different client.
create or replace function admin_group_claim(
  p_chat_id     bigint,
  p_telegram_id bigint
) returns boolean
language plpgsql as $$
declare
  adm admins;
begin
  select * into adm
    from admins
   where telegram_id = p_telegram_id and not disabled;

  if not found then
    return false;   -- silently no: don't tell a stranger what this command is
  end if;

  update config
     set admin_group_chat_id = p_chat_id,
         admin_group_set_by  = adm.id,
         admin_group_set_at  = now()
   where id;

  perform audit(adm.id, 'config.admin_group_set', 'config', null,
                jsonb_build_object('chat_id', p_chat_id));
  return true;
end $$;

-- ─── Risk flags ─────────────────────────────────────────────────────────────
-- Advisory only. Flags never block money on their own — an admin decides.
create or replace function flag_player(
  p_player uuid,
  p_code   text,
  p_note   text,
  p_admin  uuid default null
) returns void
language plpgsql as $$
begin
  update players
     set risk_flags = risk_flags || jsonb_build_object(
           'code', p_code, 'note', p_note, 'at', now(), 'by', p_admin)
   where id = p_player;

  perform audit(p_admin, 'player.flag', 'player', p_player,
                jsonb_build_object('code', p_code, 'note', p_note));
end $$;
