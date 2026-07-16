-- ═══════════════════════════════════════════════════════════════════════════
-- 0004 — Deposits, withdrawals, fills, loader work, receipts, disputes
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Deposit requests ───────────────────────────────────────────────────────
create table deposit_requests (
  id          uuid primary key default gen_random_uuid(),
  player_id   uuid not null references players (id),
  platform_id uuid not null references platforms (id),   -- where the value lands
  method_id   uuid not null references payment_methods (id),
  currency    char(3) not null,
  amount      bigint not null check (amount > 0),

  status      deposit_status not null default 'matching',

  -- Snapshot of the config that governed this request, so a later config change
  -- can never retroactively rewrite what a player was promised.
  terms       jsonb not null default '{}'::jsonb,

  cancel_reason text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  completed_at timestamptz
);

create index deposit_requests_player_idx on deposit_requests (player_id, created_at desc);
create index deposit_requests_status_idx on deposit_requests (status, created_at);
create index deposit_requests_open_idx on deposit_requests (player_id)
  where status in ('matching', 'awaiting_payment', 'awaiting_confirmation');

-- ─── Withdraw requests ──────────────────────────────────────────────────────
--
-- THE V2 CHANGE: there is no funds pre-check, because there is no number to
-- check against. v1 asked "does this player have 500 chips?" and answered from
-- a tracked balance that started lying the moment anyone played a hand.
--
-- Now: the player asks for an amount, a loader tries to take that much off the
-- table, and WHATEVER ACTUALLY COMES OFF is what gets escrowed. The unload is
-- the truth. `amount` is provisional until the loader reports back; every
-- downstream number derives from what really moved.
--
-- RAKE TIMING: withdraw-direction rake is taken at escrow, so `amount` (net) is
-- what a depositor actually pays and what sits in the queue. The queue trades
-- in NET.
create table withdraw_requests (
  id          uuid primary key default gen_random_uuid(),
  player_id   uuid not null references players (id),
  platform_id uuid not null references platforms (id),   -- where value comes off
  method_id   uuid not null references payment_methods (id),
  currency    char(3) not null,

  -- What the player asked for. Provisional: the unload may come up short.
  requested_amount bigint not null check (requested_amount > 0),

  -- What actually came off the table and got escrowed. Null until the loader
  -- reports. Everything real is computed from this, never from requested.
  gross_amount bigint check (gross_amount is null or gross_amount > 0),
  rake_amount  bigint not null default 0 check (rake_amount >= 0),
  amount       bigint check (amount is null or amount > 0),   -- net payable

  -- Decremented as slices match; restored when a slice expires or is refunded.
  -- Maintained ONLY under `for update` inside the matching functions.
  amount_remaining bigint not null default 0 check (amount_remaining >= 0),

  -- Where the player gets paid. On a `club` settlement method this is still
  -- recorded (the club needs to know where to send / who requested), but no
  -- depositor ever sees it.
  payout_handle text not null,

  status      withdraw_status not null default 'pending_unload',
  unload_order_id uuid,

  terms       jsonb not null default '{}'::jsonb,
  cancel_reason text,

  -- Set the moment a cancel is REQUESTED, which may be long before it can
  -- close: slices already locked have a depositor mid-payment against them.
  -- This flag is what tells a later slice-return where the money goes — queue
  -- if live, wallet if cancelled. Without it, cancelling a withdrawal with an
  -- outstanding slice would re-queue money already refunded, paying it twice.
  cancel_requested_at timestamptz,

  -- FIFO KEY. Strict ordering, no queue-jumping. Set once and never touched —
  -- notably NOT reset when a slice expires back into the queue, which is what
  -- "returns to the front" requires.
  created_at   timestamptz not null default now(),
  queued_at    timestamptz,
  completed_at timestamptz,
  updated_at   timestamptz not null default now(),

  constraint withdraw_net_is_gross_minus_rake
    check (amount is null or gross_amount is null or amount = gross_amount - rake_amount),
  constraint withdraw_remaining_within_amount
    check (amount is null or amount_remaining <= amount)
);

-- THE FIFO INDEX. Every match walks this. Partial, so it carries only rows that
-- are actually matchable.
create index withdraw_fifo_idx
  on withdraw_requests (method_id, currency, created_at, id)
  where status in ('queued', 'partially_filled') and amount_remaining > 0;

create index withdraw_requests_player_idx on withdraw_requests (player_id, created_at desc);
create index withdraw_requests_status_idx on withdraw_requests (status, created_at);
create index withdraw_requests_open_idx on withdraw_requests (player_id)
  where status in ('pending_unload', 'queued', 'partially_filled', 'filled');

-- ─── Fills ──────────────────────────────────────────────────────────────────
--
-- A fill is the ATOM OF SETTLEMENT: one slice of money from one payer to one
-- payee. Partial fills are first-class — a 500 withdrawal filled by 200 + 300
-- is two fill rows, and the backend always knows exactly what is still owed
-- because that is withdraw_requests.amount_remaining.
--
-- The nullable FKs express who the counterparty is:
--   deposit + withdraw  → matched peer-to-peer (p2p methods only)
--   deposit, no withdraw→ the CLUB took the money. Either a p2p method with an
--                         empty queue, or any `club` settlement method, where
--                         this is the only shape that ever happens.
--   withdraw, no deposit→ the CLUB paid the player. Owner clearing the queue,
--                         or any `club` method payout.
create table fills (
  id          uuid primary key default gen_random_uuid(),

  -- Monotonic match order. NOT redundant with created_at: a deposit spilling
  -- across three withdrawals creates three fills in ONE transaction, and now()
  -- is the TRANSACTION timestamp — all three share it to the microsecond.
  -- Ordering by (created_at, id) then tie-breaks on a random uuid and silently
  -- shuffles them. This is the order the engine walked the queue.
  seq         bigserial not null,

  deposit_id  uuid references deposit_requests (id),
  withdraw_id uuid references withdraw_requests (id),
  method_id   uuid not null references payment_methods (id),
  currency    char(3) not null,

  -- What the payer pays, and what the payee's escrow discharges by.
  amount      bigint not null check (amount > 0),
  -- Deposit-direction rake, taken at release, booked to house_rake.
  rake_amount bigint not null default 0 check (rake_amount >= 0),
  -- Value credited to the depositor on release. amount − rake. Zero on a
  -- club-paid withdrawal: nobody deposited, the club is paying cash out.
  credit_amount bigint not null check (credit_amount >= 0),

  -- What we TELL the depositor to send. Differs from `amount` when the depositor
  -- bears the processor fee. The processor's cut never enters the ledger — it is
  -- taken outside our perimeter — so this is instruction, not accounting.
  gross_to_send bigint not null check (gross_to_send > 0),

  -- Snapshot of the counterparty handle AT REVEAL TIME. Snapshotted rather than
  -- joined so a payee editing their handle later cannot retroactively change
  -- where a payer was told to pay — which would be a clean way to steal a
  -- disputed payment.
  payout_handle text not null,

  status      fill_status not null default 'locked',

  -- While 'locked', this slice is reserved: no second depositor can be handed
  -- the same counterparty for the same money. Swept back if no proof lands.
  lock_expires_at timestamptz not null,

  -- Evidence. The payment reference is PRIMARY and mandatory; a receipt image is
  -- secondary. A transaction id can be checked against the processor; a picture
  -- is trivially forged.
  payment_ref  text,
  proof_note   text,
  submitted_at timestamptz,

  -- Chargeback defence on reversible methods. Null on irreversible: crypto and
  -- cash cannot be clawed back, so there is nothing to wait for.
  hold_until   timestamptz,

  -- The payee saying "the money arrived" is NOT the same event as releasing
  -- value, and conflating them is a chargeback hole. On a reversible method the
  -- money genuinely has arrived when they confirm — and can still be reversed
  -- days later. So confirmation is recorded here and release waits for
  -- hold_until. An admin may override the hold; the clock may not.
  payee_confirmed_at timestamptz,

  released_at    timestamptz,
  released_by    uuid references admins (id),
  release_reason text check (release_reason in (
    'payee_confirmed', 'admin_verified', 'hold_expiry',
    'club_verified', 'dispute_resolution'
  )),

  escalated_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint fills_has_a_side
    check (deposit_id is not null or withdraw_id is not null),
  -- Credit is what the depositor receives, so it exists only when there IS a
  -- depositor. A club-paid withdrawal issues none and rakes none.
  constraint fills_credit_math check (
    case when deposit_id is null
         then credit_amount = 0 and rake_amount = 0
         else credit_amount = amount - rake_amount end
  ),
  constraint fills_release_is_attributed
    check ((status <> 'released') or (released_at is not null and release_reason is not null)),
  constraint fills_confirmation_needs_evidence
    check (status <> 'awaiting_confirmation' or (payment_ref is not null and submitted_at is not null))
);

create unique index fills_seq_uniq on fills (seq);
create index fills_deposit_idx  on fills (deposit_id, seq);
create index fills_withdraw_idx on fills (withdraw_id) where withdraw_id is not null;
create index fills_status_idx   on fills (status, created_at);
create index fills_lock_expiry_idx on fills (lock_expires_at) where status = 'locked';
create index fills_hold_idx on fills (hold_until)
  where status = 'awaiting_confirmation' and hold_until is not null;

-- A payment reference is a claim about a real transaction. The same one twice on
-- one method means either a typo or someone reusing one payment for two fills.
create unique index fills_payment_ref_uniq
  on fills (method_id, payment_ref)
  where payment_ref is not null and status not in ('expired', 'cancelled');

-- ─── Receipts ───────────────────────────────────────────────────────────────
--
-- "I don't want them just uploading receipt numbers, I want them to upload the
--  receipt, which can be viewed both from Telegram in the admin group and in
--  the website."
--
-- Telegram file_ids are useless for this: only the bot can fetch them and they
-- expire. So the bot downloads the image and pushes it to Firebase Storage, and
-- what lives here is a permanent URL both surfaces can render.
--
-- Every receipt carries the identifying triple at upload time — the player's
-- NAME, their platform uid, and a human-readable reference — snapshotted, so an
-- admin looking at a receipt six months later sees who it was without a join
-- through data that may since have changed.
create table receipts (
  id          uuid primary key default gen_random_uuid(),

  -- Human-facing identifier, e.g. 'RCP-2K4F9M'. What gets quoted in chat.
  reference   text unique not null,

  player_id   uuid not null references players (id),
  -- Snapshots. Deliberately denormalised: this is evidence, and evidence must
  -- not change when the underlying record does.
  player_name text not null,
  platform_uid text,
  platform_id uuid references platforms (id),

  ref_type    text not null,     -- 'fill' | 'loader_order' | 'dispute'
  ref_id      uuid not null,

  -- Firebase Storage. `storage_path` is the object we own and can delete;
  -- `url` is what the panel and Telegram render.
  storage_path text not null,
  url          text not null,
  content_type text,
  bytes        bigint,

  -- Kept so an admin can re-fetch from Telegram if a Storage upload is ever
  -- lost, but never the primary — see above.
  telegram_file_id text,

  uploaded_by_player uuid references players (id),
  uploaded_by_admin  uuid references admins (id),
  created_at   timestamptz not null default now()
);

create index receipts_ref_idx    on receipts (ref_type, ref_id);
create index receipts_player_idx on receipts (player_id, created_at desc);
create index receipts_name_idx   on receipts (lower(player_name));

-- Receipts are evidence. Same rule as the ledger and the audit log.
create trigger receipts_immutable
  before update or delete on receipts
  for each row execute function reject_mutation();

-- ─── Loader work queue ──────────────────────────────────────────────────────
--
-- Renamed from v1's chip_orders: "chips" is ClubGG's word, and the sportsbook
-- doesn't have any. This is work for a human loader on some platform.
--
-- LEDGER TIMING — the two directions are deliberately asymmetric:
--   LOAD   (delta > 0): the ledger books it at fill RELEASE; this order is the
--                       physical delivery. Until done, the ledger says we owe
--                       value we haven't delivered — which is true.
--   UNLOAD (delta < 0): the ledger books it only when the loader marks it DONE,
--                       because that is the moment value actually leaves the
--                       table. Booking earlier would let a player withdraw
--                       against value still in play.
create table loader_orders (
  id          uuid primary key default gen_random_uuid(),
  player_id   uuid not null references players (id),
  platform_id uuid not null references platforms (id),
  club_id     uuid not null references clubs (id),

  -- Snapshots of who this is, taken when the order was raised. The loader acts
  -- on these verbatim. Snapshotted rather than joined so an id corrected later
  -- cannot silently re-target work already in flight, and so the audit trail
  -- records where value actually went.
  platform_uid text not null,
  player_name  text not null,

  -- Signed, minor units. Positive = put value on their account.
  delta       bigint not null check (delta <> 0),
  currency    char(3) not null,

  reason      text not null,
  ref_type    text,
  ref_id      uuid,

  status      order_status not null default 'pending',

  claimed_by  uuid references admins (id),
  claimed_at  timestamptz,
  done_by     uuid references admins (id),
  done_at     timestamptz,

  -- What the loader could ACTUALLY do. This is the v2 heart: a player can
  -- gamble away value between requesting a withdrawal and a loader reaching it,
  -- so what really moved is often less than what was asked. Reporting the truth
  -- is what lets the rest of the system stay honest.
  actual_delta bigint,

  note           text,
  failure_reason text,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint loader_orders_claimed_is_attributed
    check (status <> 'claimed' or claimed_by is not null),
  constraint loader_orders_done_is_attributed
    check (status <> 'done' or (done_by is not null and done_at is not null and actual_delta is not null))
);

create index loader_orders_queue_idx on loader_orders (club_id, status, created_at)
  where status in ('pending', 'claimed');
create index loader_orders_player_idx on loader_orders (player_id, created_at desc);
create index loader_orders_ref_idx on loader_orders (ref_type, ref_id);

alter table withdraw_requests
  add constraint withdraw_unload_order_fk
  foreign key (unload_order_id) references loader_orders (id);

-- ─── Disputes ───────────────────────────────────────────────────────────────
create table disputes (
  id      uuid primary key default gen_random_uuid(),
  fill_id uuid not null references fills (id),

  opened_by_player uuid references players (id),
  opened_by_admin  uuid references admins (id),
  reason  text not null,

  -- [{kind:'payment_ref'|'receipt'|'note', value, at, by}]
  evidence jsonb not null default '[]'::jsonb,

  status  text not null default 'open' check (status in ('open', 'resolved')),

  -- The MONEY ruling. Three, because the money must end up somewhere and these
  -- are the only somewheres.
  resolution text check (resolution in (
    'release_to_depositor',   -- payment was real; depositor gets their value
    'refund_to_payee',        -- payment never landed; payee's slice restored
    'split'                   -- partial; split_to_depositor says how much
  )),
  split_to_depositor bigint check (split_to_depositor is null or split_to_depositor >= 0),

  -- The RISK ruling, orthogonal to the money one. Either, both, or neither —
  -- because the most common real outcome is "refund the victim AND flag the
  -- scammer", which a single dropdown cannot express.
  flagged_depositor boolean not null default false,
  flagged_payee     boolean not null default false,

  resolution_note text,
  resolved_by     uuid references admins (id),
  resolved_at     timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint disputes_opened_by_someone
    check (opened_by_player is not null or opened_by_admin is not null),
  constraint disputes_resolution_is_attributed
    check (status <> 'resolved' or (resolution is not null and resolved_by is not null and resolved_at is not null)),
  constraint disputes_split_needs_amount
    check (resolution is distinct from 'split' or split_to_depositor is not null),
  constraint disputes_split_amount_only_on_split
    check (resolution = 'split' or split_to_depositor is null)
);

create unique index disputes_one_open_per_fill on disputes (fill_id) where status = 'open';
create index disputes_status_idx on disputes (status, created_at);

-- ─── Saved payout handles ───────────────────────────────────────────────────
-- Re-typing a 34-character crypto address on every withdrawal is not just
-- tedious: each retype is a fresh chance to fat-finger one, and a wrong handle
-- pays a stranger with no reversal. The safest handle is one typed once,
-- checked once, and reused.
--
-- Nothing in flight reads this table — fills and withdrawals snapshot their own
-- copy — so editing a saved handle can never re-target a payment already being
-- made.
create table payout_handles (
  id         uuid primary key default gen_random_uuid(),
  player_id  uuid not null references players (id),
  method_id  uuid not null references payment_methods (id),
  handle     text not null,
  label      text,
  use_count    int not null default 0,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint payout_handles_not_blank check (length(trim(handle)) > 0),
  unique (player_id, method_id, handle)
);

create index payout_handles_lookup_idx
  on payout_handles (player_id, method_id, last_used_at desc nulls last);

-- ─── Player preferences ─────────────────────────────────────────────────────
-- "for the first time they choose only, they will be given the option to either
--  choose whether they want to permanently only withdraw from ClubGG, or from
--  Sportsbook, or whether they want to have the option every time."
--
-- Null = ask every time. Set = go straight there. Asked exactly once, on first
-- use, and changeable later from the bot.
create table player_prefs (
  player_id   uuid primary key references players (id),

  default_platform_id uuid references platforms (id),
  platform_asked      boolean not null default false,

  default_method_id   uuid references payment_methods (id),
  method_asked        boolean not null default false,

  updated_at  timestamptz not null default now()
);

create trigger player_prefs_touch before update on player_prefs
  for each row execute function touch_updated_at();

-- ─── updated_at ─────────────────────────────────────────────────────────────
create trigger deposit_requests_touch  before update on deposit_requests
  for each row execute function touch_updated_at();
create trigger withdraw_requests_touch before update on withdraw_requests
  for each row execute function touch_updated_at();
create trigger fills_touch             before update on fills
  for each row execute function touch_updated_at();
create trigger loader_orders_touch     before update on loader_orders
  for each row execute function touch_updated_at();
create trigger disputes_touch          before update on disputes
  for each row execute function touch_updated_at();
create trigger payout_handles_touch    before update on payout_handles
  for each row execute function touch_updated_at();
