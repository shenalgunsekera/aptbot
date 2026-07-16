-- ═══════════════════════════════════════════════════════════════════════════
-- 0001 — Extensions and domain vocabulary
-- ═══════════════════════════════════════════════════════════════════════════
--
-- MONEY REPRESENTATION
-- --------------------
-- All amounts are bigint in MINOR UNITS (cents, satoshis-as-cents, etc).
-- There is no float, numeric, or money type anywhere in this schema, by
-- design: binary floating point cannot represent 0.10 exactly, and a ledger
-- that must sum to exactly zero cannot tolerate representation error.
--
-- CHIPS are denominated in the same minor units as the union's base currency,
-- so a $1.00 chip stack and a $1.00 wallet balance are both 100.

create extension if not exists pgcrypto;  -- gen_random_uuid()

-- ─── Payment methods ────────────────────────────────────────────────────────
-- The single most important risk axis in the system. An irreversible payment
-- (crypto, cash) cannot be clawed back by the sender, so chips can release
-- immediately. A reversible one (card, PayPal, bank transfer) can be reversed
-- by the sender days later, so it must sit under a hold before release.
create type reversibility_tier as enum ('irreversible', 'reversible');

-- ─── Players ────────────────────────────────────────────────────────────────
--   pending — registered in the bot, ClubGG id not yet linked by an admin
--   active  — linked, may transact
--   frozen  — under investigation; existing balances intact, no new activity
--   banned  — terminal
create type player_status as enum ('pending', 'active', 'frozen', 'banned');

-- ─── Deposit lifecycle ──────────────────────────────────────────────────────
--   matching             — created, matching engine has not run yet
--   awaiting_payment     — handle(s) revealed and locked; player must pay + prove
--   awaiting_confirmation— proof submitted on every fill; waiting on withdrawers
--   completed            — all fills released
--   cancelled            — player or admin abandoned it
--   expired              — locks timed out with no proof submitted
create type deposit_status as enum (
  'matching', 'awaiting_payment', 'awaiting_confirmation',
  'completed', 'cancelled', 'expired'
);

-- ─── Withdrawal lifecycle ───────────────────────────────────────────────────
--   pending_unload   — chips must come off the ClubGG table before we escrow
--   queued           — escrowed and in the FIFO queue, nothing matched yet
--   partially_filled — some slices matched, amount_remaining > 0
--   filled           — amount_remaining = 0, fills not all released yet
--   completed        — every slice released; escrow fully discharged
--   cancelled        — withdrawn by player or admin; escrow returned to wallet
create type withdraw_status as enum (
  'pending_unload', 'queued', 'partially_filled',
  'filled', 'completed', 'cancelled'
);

-- ─── Fill lifecycle ─────────────────────────────────────────────────────────
-- A fill is ONE slice of money from one depositor to one withdrawer (or to the
-- owner, when acting as backstop). It is the atom of settlement.
--
--   locked                — handle revealed to the depositor and reserved.
--                           Expires at lock_expires_at if no proof lands.
--   awaiting_confirmation — depositor submitted payment ref + proof
--   released              — chips issued to the depositor; ledger posted
--   disputed              — frozen; neither side moves until an admin rules
--   refunded              — resolved against the depositor; withdrawer made whole
--   expired               — lock timed out; slice returned to the queue
--   cancelled             — voided before any money moved
create type fill_status as enum (
  'locked', 'awaiting_confirmation', 'released',
  'disputed', 'refunded', 'expired', 'cancelled'
);

-- ─── Chip work-queue ────────────────────────────────────────────────────────
create type chip_order_status as enum ('pending', 'claimed', 'done', 'failed', 'cancelled');

-- ─── Chart of accounts ──────────────────────────────────────────────────────
-- SIGN CONVENTION (this is the whole ledger in four lines — read it carefully):
--
--   Every account's balance is SUM(amount) over its entries.
--   The sum of ALL entries, per currency, is ALWAYS exactly 0.
--
--   player_chips  (+) = the system owes the player this many chips in ClubGG
--   player_wallet (+) = the system owes the player this much internal credit
--   player_escrow (+) = credit locked against a pending withdrawal
--   house_rake    (+) = rake earned by the union on deposits/withdrawals
--   house_loss    (−) = money the union ate (post-release reversal, split ruling)
--   house_gameplay(±) = the contra account for chips won and lost AT THE TABLES
--   owner_float   (−) = the owner is HOLDING this much real cash
--                 (+) = the owner has PAID OUT this much real cash
--
-- owner_float reads inverted because it is the only account tracking real cash
-- rather than internal credit. `select -balance` = "cash in the owner's hands".
-- The panel presents it that way; see view `v_float_position`.
--
-- Note there is deliberately NO "world"/"external" account. In a matched fill
-- real money moves player→player entirely outside this system, so the ledger
-- records only the internal credit transfer: the withdrawer's escrow is
-- extinguished and becomes the depositor's chips. Cash only enters the ledger
-- when the OWNER is a counterparty, which is exactly what owner_float captures.
--
-- WHY house_gameplay EXISTS
-- ------------------------
-- Players gamble. The instant someone plays a hand, their actual ClubGG stack
-- stops matching what we issued them — and it never matches again. Any design
-- that treats player_chips as "chips we loaded" produces a ledger that is wrong
-- about every active player by the end of the first orbit: a winner would be
-- unable to withdraw their winnings, and a loser could withdraw money they no
-- longer have.
--
-- So player_chips is SYNCED from ClubGG (see chips_sync in 0011), and the delta
-- is booked against house_gameplay. That keeps chip balances true to the tables
-- while preserving the sum-to-zero invariant.
--
-- The payoff is that this account is also the union's fraud alarm. Poker is
-- zero-sum: every chip one player wins, another lost. So house_gameplay must
-- hover near zero (drifting only by in-game rake the club collects). If it
-- walks steadily away from zero, chips are entering or leaving the club through
-- a door this system does not know about — which is exactly the thing you want
-- to find out about. Per-player drift is just poker; AGGREGATE drift is theft.
create type account_kind as enum (
  'player_chips', 'player_wallet', 'player_escrow',
  'house_rake', 'house_loss', 'house_gameplay', 'owner_float'
);

-- Which side of a transaction a rake/fee applies to.
create type flow_direction as enum ('deposit', 'withdraw');
