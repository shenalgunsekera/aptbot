-- ═══════════════════════════════════════════════════════════════════════════
-- 0004 — Requests, fills, chip work-queue, disputes, notification outbox
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Deposit requests ───────────────────────────────────────────────────────
create table deposit_requests (
  id         uuid primary key default gen_random_uuid(),
  player_id  uuid not null references players (id),
  method_id  uuid not null references payment_methods (id),
  currency   char(3) not null,
  amount     bigint not null check (amount > 0),

  status     deposit_status not null default 'matching',

  -- Denormalised snapshot of the config that governed this request, so a
  -- later config change can never retroactively rewrite what a player was
  -- promised. Rake/fee/timeout as they stood at creation.
  terms      jsonb not null default '{}'::jsonb,

  cancel_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index deposit_requests_player_idx on deposit_requests (player_id, created_at desc);
create index deposit_requests_status_idx on deposit_requests (status, created_at);

-- Rate limit support: "open deposit requests per player".
create index deposit_requests_open_idx on deposit_requests (player_id)
  where status in ('matching', 'awaiting_payment', 'awaiting_confirmation');

-- ─── Withdraw requests ──────────────────────────────────────────────────────
--
-- RAKE TIMING (deposit vs withdraw differ, deliberately):
--   Withdraw-direction rake is taken UP FRONT, at escrow. A player asking to
--   withdraw 10000 with 2% rake has 10000 debited from their wallet, 200 booked
--   to house_rake, and 9800 escrowed. `amount` (9800) is what a depositor
--   actually pays them and what sits in the FIFO queue. This is why gross and
--   net are separate columns: the queue trades in NET.
create table withdraw_requests (
  id           uuid primary key default gen_random_uuid(),
  player_id    uuid not null references players (id),
  method_id    uuid not null references payment_methods (id),
  currency     char(3) not null,

  gross_amount bigint not null check (gross_amount > 0),  -- debited from wallet
  rake_amount  bigint not null default 0 check (rake_amount >= 0),
  amount       bigint not null check (amount > 0),        -- net payable == escrowed

  -- Decremented as slices match, restored when a slice expires or is refunded.
  -- Maintained ONLY under `for update` inside the matching functions.
  amount_remaining bigint not null check (amount_remaining >= 0),

  -- The withdrawer's own payout handle for this method — where a matched
  -- depositor actually sends the money.
  payout_handle text not null,

  status       withdraw_status not null default 'pending_unload',

  -- Chips that had to come off the ClubGG table before we could escrow.
  unload_order_id uuid,

  terms        jsonb not null default '{}'::jsonb,
  cancel_reason text,

  -- Set the moment a cancel is REQUESTED, which may be long before the request
  -- can actually close: slices already locked or awaiting confirmation have a
  -- depositor mid-payment against them and must play out first.
  --
  -- This flag is what tells a later slice-return where the money should go. A
  -- slice expiring on a live withdrawal goes back to the QUEUE; the same slice
  -- expiring on a cancelled one must go back to the player's WALLET. Without
  -- this, cancelling a withdrawal with an outstanding slice would re-queue
  -- money that had already been refunded — paying it out twice.
  cancel_requested_at timestamptz,

  -- FIFO KEY. Strict ordering, no queue-jumping. Set once at creation and
  -- never touched — notably NOT reset when a slice expires back into the
  -- queue, which is what "returns to the FRONT of the queue" requires.
  created_at   timestamptz not null default now(),
  queued_at    timestamptz,   -- when it actually entered the queue (post-unload)
  completed_at timestamptz,
  updated_at   timestamptz not null default now(),

  constraint withdraw_net_is_gross_minus_rake
    check (amount = gross_amount - rake_amount),
  constraint withdraw_remaining_within_amount
    check (amount_remaining <= amount)
);

-- THE FIFO INDEX. Every match walks this. Partial, so it only carries rows
-- that are actually matchable.
create index withdraw_fifo_idx
  on withdraw_requests (method_id, currency, created_at, id)
  where status in ('queued', 'partially_filled') and amount_remaining > 0;

create index withdraw_requests_player_idx on withdraw_requests (player_id, created_at desc);
create index withdraw_requests_status_idx on withdraw_requests (status, created_at);
create index withdraw_requests_open_idx on withdraw_requests (player_id)
  where status in ('pending_unload', 'queued', 'partially_filled', 'filled');

-- ─── Fills ──────────────────────────────────────────────────────────────────
--
-- A fill is the ATOM OF SETTLEMENT: one slice of money from one depositor to
-- one withdrawer. Partial fills are first-class — a 10000 withdrawal filled by
-- 6000 + 4000 is two fill rows, and the backend always knows exactly how much
-- is still owed because that is `withdraw_requests.amount_remaining`.
--
-- The owner is the counterparty whenever one side is missing, and the nullable
-- FKs are exactly how that is expressed:
--
--   deposit_id + withdraw_id  →  matched peer-to-peer. The normal case.
--   deposit_id, no withdraw   →  OWNER BACKSTOP. No withdrawal existed to match,
--                                so the depositor pays the owner and the owner
--                                carries the float.
--   withdraw_id, no deposit   →  OWNER PAYOUT. An admin cleared a withdrawal
--                                directly from the owner's own pocket, rather
--                                than waiting for a depositor to show up.
--                                ("recorded as an owner-sourced fill")
--   neither                   →  meaningless; rejected by fills_has_a_side.
create table fills (
  id          uuid primary key default gen_random_uuid(),

  -- Monotonic insertion order. NOT redundant with created_at: a deposit that
  -- spills across three withdrawals creates three fills inside ONE transaction,
  -- and `now()` is the TRANSACTION timestamp — so all three share a created_at
  -- to the microsecond. Ordering by (created_at, id) then tie-breaks on a random
  -- uuid, which silently shuffles them.
  --
  -- That matters: this is the order the matching engine walked the FIFO queue,
  -- so it is the answer to "which slice was matched first" — an audit question —
  -- and it is the order the bot must list payments in when it tells a depositor
  -- "pay these three people".
  seq         bigserial not null,

  deposit_id  uuid references deposit_requests (id),
  withdraw_id uuid references withdraw_requests (id),
  method_id   uuid not null references payment_methods (id),
  currency    char(3) not null,

  -- What the depositor pays the withdrawer, and what the withdrawer's escrow
  -- discharges by. The unit the FIFO queue trades in.
  amount      bigint not null check (amount > 0),

  -- Deposit-direction rake, taken at release, booked to house_rake.
  rake_amount bigint not null default 0 check (rake_amount >= 0),

  -- Chips issued to the depositor on release. amount − rake.
  -- Zero on an owner payout: nobody deposited, so no chips are created — the
  -- owner is simply paying cash out to clear the queue.
  chips_amount bigint not null check (chips_amount >= 0),

  -- What we TELL the depositor to send. Differs from `amount` when the
  -- depositor bears the processor fee (config.fee_bearer='depositor'): they
  -- send gross so the withdrawer nets `amount`. The processor's cut never
  -- enters the ledger — it is taken outside our perimeter — so this column is
  -- instruction, not accounting.
  gross_to_send bigint not null check (gross_to_send > 0),

  -- Snapshot of the counterparty handle AT REVEAL TIME. Snapshotted rather
  -- than joined so that a withdrawer editing their handle later can never
  -- retroactively change where a depositor was told to pay — which would
  -- otherwise be a clean way to steal a disputed payment.
  payout_handle text not null,

  status      fill_status not null default 'locked',

  -- ── Lock (anti double-match) ──
  -- While a fill is 'locked', its slice is reserved: no second depositor can
  -- be handed the same handle for the same money. Swept back if no proof lands.
  lock_expires_at timestamptz not null,

  -- ── Evidence (payment ref is PRIMARY, screenshots secondary) ──
  payment_ref    text,
  proof_file_id  text,      -- Telegram file_id of the uploaded screenshot
  proof_note     text,
  submitted_at   timestamptz,

  -- ── Hold (chargeback defence on reversible methods) ──
  -- Null on irreversible methods: crypto and cash cannot be clawed back, so
  -- there is nothing to wait for and confirmation releases immediately.
  hold_until     timestamptz,

  -- The withdrawer saying "yes, the money arrived" is NOT the same event as
  -- releasing chips, and conflating them is a chargeback hole. On a reversible
  -- method the money genuinely has arrived when they confirm — and can still be
  -- reversed by the sender days later. So confirmation is recorded here, and
  -- release waits for hold_until. On an irreversible method the two collapse
  -- into one moment. An admin fast-path may override the hold; the clock may not.
  withdrawer_confirmed_at timestamptz,

  -- ── Release ──
  released_at    timestamptz,
  released_by    uuid references admins (id),   -- null unless admin fast-path
  release_reason text check (release_reason in (
    'withdrawer_confirmed', 'admin_fast_path', 'hold_expiry',
    'owner_backstop_verified', 'dispute_resolution'
  )),

  -- Set when the withdrawer never answered and this went to admin review.
  escalated_at   timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A fill with neither side is not a settlement of anything.
  constraint fills_has_a_side
    check (deposit_id is not null or withdraw_id is not null),

  -- Chips are what the depositor receives, so they only exist when there IS a
  -- depositor. An owner payout issues none and rakes none.
  constraint fills_chips_math check (
    case when deposit_id is null
         then chips_amount = 0 and rake_amount = 0
         else chips_amount = amount - rake_amount
    end
  ),

  constraint fills_release_is_attributed
    check ((status <> 'released') or (released_at is not null and release_reason is not null)),
  -- Proof must exist before a fill can be waiting on anyone's confirmation.
  constraint fills_confirmation_needs_evidence
    check (status <> 'awaiting_confirmation' or (payment_ref is not null and submitted_at is not null))
);

create unique index fills_seq_uniq on fills (seq);
create index fills_deposit_idx  on fills (deposit_id, seq);
create index fills_withdraw_idx on fills (withdraw_id) where withdraw_id is not null;
create index fills_status_idx   on fills (status, created_at);

-- Sweeper index: locked fills past their deadline.
create index fills_lock_expiry_idx on fills (lock_expires_at) where status = 'locked';
-- Auto-release index: held fills past their hold.
create index fills_hold_idx on fills (hold_until)
  where status = 'awaiting_confirmation' and hold_until is not null;

-- A payment reference is a claim about a real-world transaction. The same one
-- appearing twice on the same method means either a typo or someone trying to
-- reuse one payment to settle two fills.
create unique index fills_payment_ref_uniq
  on fills (method_id, payment_ref)
  where payment_ref is not null and status <> 'expired' and status <> 'cancelled';

-- ─── Chip work-queue ────────────────────────────────────────────────────────
--
-- LEDGER TIMING (loads and unloads are deliberately asymmetric):
--   LOAD   (delta > 0): the ledger credits chips at fill RELEASE; this order is
--                       just the physical work of putting them on the table.
--                       Until done, the ledger says we owe chips we haven't
--                       delivered — which is true, and which reconciliation
--                       explains as expected drift.
--   UNLOAD (delta < 0): the ledger moves chips→wallet only when the admin marks
--                       the order DONE. Booking it earlier would let a player
--                       withdraw credit for chips still sitting on the table,
--                       where they can be gambled away.
create table chip_orders (
  id         uuid primary key default gen_random_uuid(),
  player_id  uuid not null references players (id),

  -- Signed, minor units. Positive = load chips onto the table.
  delta      bigint not null check (delta <> 0),
  currency   char(3) not null,

  -- Snapshot of the player's CONFIRMED ClubGG id at the moment the order was
  -- raised. This is the address the loader — human or automated — acts on.
  --
  -- Snapshotted rather than joined so that an id corrected after the fact can
  -- never silently re-target an order that is already in flight, and so the
  -- audit log records where chips were actually sent rather than where the
  -- player's record happens to point today.
  clubgg_id  text not null,

  reason     text not null,             -- 'fill.release', 'withdraw.unload', ...
  ref_type   text,
  ref_id     uuid,

  status     chip_order_status not null default 'pending',

  claimed_by uuid references admins (id),
  claimed_at timestamptz,
  done_by    uuid references admins (id),
  done_at    timestamptz,

  -- What the admin could ACTUALLY do. If a player gambled away chips we meant
  -- to unload, this is smaller than `delta` and the difference is handled
  -- explicitly rather than silently.
  actual_delta bigint,

  proof_file_id  text,     -- balance screenshot, optional
  note           text,
  failure_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint chip_orders_claimed_is_attributed
    check (status <> 'claimed' or claimed_by is not null),
  constraint chip_orders_done_is_attributed
    check (status <> 'done' or (done_by is not null and done_at is not null and actual_delta is not null))
);

create index chip_orders_queue_idx on chip_orders (status, created_at)
  where status in ('pending', 'claimed');
create index chip_orders_player_idx on chip_orders (player_id, created_at desc);
create index chip_orders_ref_idx on chip_orders (ref_type, ref_id);

alter table withdraw_requests
  add constraint withdraw_unload_order_fk
  foreign key (unload_order_id) references chip_orders (id);

-- ─── Disputes ───────────────────────────────────────────────────────────────
create table disputes (
  id        uuid primary key default gen_random_uuid(),
  fill_id   uuid not null references fills (id),

  opened_by_player uuid references players (id),
  opened_by_admin  uuid references admins (id),
  reason    text not null,

  -- [{kind:'payment_ref'|'screenshot'|'note', value, at, by}]
  evidence  jsonb not null default '[]'::jsonb,

  status    text not null default 'open' check (status in ('open', 'resolved')),

  -- The MONEY ruling. Every dispute ends in exactly one of these three, because
  -- the money must end up somewhere and these are the only somewheres there are.
  --
  -- Note the spec listed 'flag_account' alongside these. It is not a money
  -- ruling and books no ledger entries, so it lives on its own axis below —
  -- otherwise an admin could not both refund the victim AND flag the scammer,
  -- which is the single most common real outcome.
  resolution text check (resolution in (
    'release_to_depositor',   -- payment was real; depositor gets their chips
    'refund_to_withdrawer',   -- payment never landed; withdrawer's slice restored
    'split'                   -- partial; split_to_depositor says how much
  )),
  split_to_depositor bigint check (split_to_depositor is null or split_to_depositor >= 0),

  -- The RISK ruling, orthogonal to the money one. Either, both, or neither.
  flagged_depositor  boolean not null default false,
  flagged_withdrawer boolean not null default false,

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

-- At most one open dispute per fill.
create unique index disputes_one_open_per_fill on disputes (fill_id) where status = 'open';
create index disputes_status_idx on disputes (status, created_at);

-- ─── Notification outbox ────────────────────────────────────────────────────
--
-- Transactional outbox. A money move and "tell the withdrawer about it" commit
-- in the SAME transaction, so we can never release chips and then fail to
-- notify (or notify about a release that rolled back). The bot drains this.
--
-- This is also what makes the spec's "withdrawer is offline / has blocked the
-- bot" requirement tractable: delivery failure is a row with attempts > 0 and
-- an error, which the escalation sweeper can see and act on.
create table notifications (
  id        bigserial primary key,
  player_id uuid references players (id),
  admin_id  uuid references admins (id),   -- set for admin-directed escalations

  kind      text not null,   -- 'fill.confirm_request', 'fill.escalated', ...
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
    check (player_id is not null or admin_id is not null)
);

create index notifications_drain_idx on notifications (send_after, id)
  where status = 'pending';
create index notifications_ref_idx on notifications (ref_type, ref_id);

-- ─── updated_at ─────────────────────────────────────────────────────────────
create trigger deposit_requests_touch  before update on deposit_requests
  for each row execute function touch_updated_at();
create trigger withdraw_requests_touch before update on withdraw_requests
  for each row execute function touch_updated_at();
create trigger fills_touch             before update on fills
  for each row execute function touch_updated_at();
create trigger chip_orders_touch       before update on chip_orders
  for each row execute function touch_updated_at();
create trigger disputes_touch          before update on disputes
  for each row execute function touch_updated_at();
