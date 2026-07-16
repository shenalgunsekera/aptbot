-- ═══════════════════════════════════════════════════════════════════════════
-- 0003 — The double-entry ledger
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE INVARIANT
-- -------------
--   For every currency:  SUM(ledger_entries.amount) = 0.  Always. No exceptions.
--
-- Money is never created or destroyed here, only moved. This file makes that a
-- property of the DATABASE rather than a property of the application code:
--
--   1. `ledger_entries` is append-only     — enforced by trigger (no UPDATE/DELETE)
--   2. every transaction nets to zero      — enforced by a DEFERRED constraint
--                                            trigger, checked at COMMIT
--   3. player accounts never go negative   — enforced by a DEFERRED constraint
--                                            trigger, checked at COMMIT
--
-- (2) is deferred rather than immediate because a transaction is only balanced
-- once ALL of its legs are inserted; checking mid-insert would fail on the
-- first leg. Deferring to commit is what makes "unbalanced writes cannot be
-- committed" true regardless of insert order.
--
-- Because of (2), (1) follows by induction: if every transaction sums to zero,
-- the sum of all transactions sums to zero. Verified independently anyway by
-- `ledger_verify()` at the bottom of this file.

-- ─── Accounts ───────────────────────────────────────────────────────────────
create table accounts (
  id         uuid primary key default gen_random_uuid(),
  kind       account_kind not null,
  player_id  uuid references players (id),
  currency   char(3) not null,

  -- Cached SUM(entries.amount), maintained by trigger. This is a CACHE, not
  -- the truth: `ledger_verify()` re-derives from the entries and screams if
  -- they ever disagree. Kept because balance checks sit in the hot path of
  -- every withdrawal, and re-summing an append-only table gets slow forever.
  balance    bigint not null default 0,

  created_at timestamptz not null default now(),

  -- House accounts have no player; player accounts must have one.
  constraint accounts_player_shape check (
    (kind in ('house_rake', 'house_loss', 'house_gameplay', 'owner_float') and player_id is null)
    or
    (kind in ('player_chips', 'player_wallet', 'player_escrow') and player_id is not null)
  )
);

-- One account per (kind, player, currency); one per (kind, currency) for house.
create unique index accounts_player_uniq
  on accounts (kind, player_id, currency) where player_id is not null;
create unique index accounts_house_uniq
  on accounts (kind, currency) where player_id is null;
create index accounts_player_lookup_idx on accounts (player_id) where player_id is not null;

-- ─── Transactions and entries ───────────────────────────────────────────────
-- A ledger_transaction is one atomic money event. Its entries are its legs.
create table ledger_transactions (
  id             uuid primary key default gen_random_uuid(),
  -- 'withdraw.escrow', 'fill.release', 'dispute.refund', ... Free text by
  -- design: new money events should not require a schema migration.
  kind           text not null,
  ref_type       text,        -- 'fill' | 'withdraw_request' | 'chip_order' | ...
  ref_id         uuid,
  memo           text,
  actor_admin_id uuid references admins (id),   -- null = system
  created_at     timestamptz not null default now()
);

create index ledger_transactions_ref_idx  on ledger_transactions (ref_type, ref_id);
create index ledger_transactions_kind_idx on ledger_transactions (kind, created_at desc);

create table ledger_entries (
  id         bigserial primary key,
  tx_id      uuid not null references ledger_transactions (id),
  account_id uuid not null references accounts (id),

  -- Signed, in minor units. Positive and negative legs of a transaction must
  -- cancel exactly. Zero is meaningless in double-entry and rejected outright.
  amount     bigint not null check (amount <> 0),

  created_at timestamptz not null default now()
);

create index ledger_entries_account_idx on ledger_entries (account_id, id);
create index ledger_entries_tx_idx      on ledger_entries (tx_id);

-- ─── (1) Append-only ────────────────────────────────────────────────────────
-- A ledger you can edit is not a ledger. Corrections are made by posting a
-- reversing transaction, never by rewriting history.
create or replace function reject_mutation() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only: % is not permitted. Post a reversing entry instead.',
    tg_table_name, tg_op
    using errcode = 'restrict_violation';
end $$;

create trigger ledger_entries_immutable
  before update or delete on ledger_entries
  for each row execute function reject_mutation();

create trigger ledger_transactions_immutable
  before update or delete on ledger_transactions
  for each row execute function reject_mutation();

create trigger audit_log_immutable
  before update or delete on audit_log
  for each row execute function reject_mutation();

-- ─── Balance cache maintenance ──────────────────────────────────────────────
-- Note this serialises concurrent writers on shared accounts (house_rake in
-- particular, which every raked release touches). At union scale — hundreds of
-- transactions a day, not thousands a second — that contention is irrelevant,
-- and it buys us a balance we can trust under concurrency without re-summing.
create or replace function ledger_apply_balance() returns trigger
language plpgsql as $$
begin
  update accounts
     set balance = balance + new.amount
   where id = new.account_id;
  return null;
end $$;

create trigger ledger_entries_apply_balance
  after insert on ledger_entries
  for each row execute function ledger_apply_balance();

-- ─── (2) Every transaction nets to zero, per currency ───────────────────────
create or replace function assert_tx_balanced() returns trigger
language plpgsql as $$
declare
  v_currency char(3);
  v_sum      bigint;
begin
  -- A transaction may legitimately span currencies only if each currency
  -- balances independently (an FX leg would need an explicit fx account).
  for v_currency, v_sum in
    select a.currency, sum(e.amount)
      from ledger_entries e
      join accounts a on a.id = e.account_id
     where e.tx_id = new.tx_id
     group by a.currency
  loop
    if v_sum <> 0 then
      raise exception
        'ledger transaction % does not balance in %: sum = % (money was created or destroyed)',
        new.tx_id, v_currency, v_sum
        using errcode = 'check_violation';
    end if;
  end loop;
  return null;
end $$;

create constraint trigger ledger_entries_balanced
  after insert on ledger_entries
  deferrable initially deferred
  for each row execute function assert_tx_balanced();

-- ─── (3) Player accounts never go negative ──────────────────────────────────
-- You cannot withdraw credit you do not have, release escrow that was never
-- posted, or unload chips you already gambled away.
--
-- Deliberately NOT applied to house_rake / house_loss / owner_float: those
-- legitimately swing negative (the owner holding cash, the union eating a
-- reversal). If the union cannot claw chips back from a player, the honest
-- entry is a house_loss — not a negative player balance. This constraint is
-- what forces that honesty.
create or replace function assert_account_nonnegative() returns trigger
language plpgsql as $$
declare
  a accounts;
begin
  select * into a from accounts where id = new.account_id;

  if a.kind in ('player_chips', 'player_wallet', 'player_escrow') and a.balance < 0 then
    raise exception
      'account %/% would go negative: balance = % (insufficient funds)',
      a.kind, coalesce(a.player_id::text, 'house'), a.balance
      using errcode = 'check_violation';
  end if;
  return null;
end $$;

create constraint trigger ledger_entries_nonnegative
  after insert on ledger_entries
  deferrable initially deferred
  for each row execute function assert_account_nonnegative();

-- ═══════════════════════════════════════════════════════════════════════════
-- Helpers — the only sanctioned way to touch the ledger
-- ═══════════════════════════════════════════════════════════════════════════

-- Resolve (kind, player, currency) → account id, creating it on first use.
-- Concurrency-safe: two transactions racing to create the same account will
-- have one lose on the unique index and re-read the winner's row.
create or replace function account_of(
  p_kind     account_kind,
  p_player   uuid,
  p_currency char(3)
) returns uuid
language plpgsql as $$
declare
  v_id       uuid;
  v_is_house boolean := p_kind in ('house_rake', 'house_loss', 'house_gameplay', 'owner_float');
begin
  if v_is_house and p_player is not null then
    raise exception 'account_of: % is a house account and takes no player', p_kind;
  elsif not v_is_house and p_player is null then
    raise exception 'account_of: % requires a player', p_kind;
  end if;

  select id into v_id
    from accounts
   where kind = p_kind
     and player_id is not distinct from p_player
     and currency = p_currency;

  if v_id is not null then
    return v_id;
  end if;

  begin
    insert into accounts (kind, player_id, currency)
    values (p_kind, p_player, p_currency)
    returning id into v_id;
  exception when unique_violation then
    select id into v_id
      from accounts
     where kind = p_kind
       and player_id is not distinct from p_player
       and currency = p_currency;
  end;

  return v_id;
end $$;

-- Convenience reader used all over the request functions.
create or replace function balance_of(
  p_kind     account_kind,
  p_player   uuid,
  p_currency char(3)
) returns bigint
language sql stable as $$
  select coalesce(
    (select balance from accounts
      where kind = p_kind
        and player_id is not distinct from p_player
        and currency = p_currency),
    0
  );
$$;

-- Post one balanced transaction.
--
-- p_entries: '[{"account_id": "...", "amount": -100}, {"account_id": "...", "amount": 100}]'
--
-- Zero-amount legs are dropped (a zero rake is a legitimate configuration, and
-- callers shouldn't have to branch on it). What remains must still be a real
-- double-entry transaction, hence the >= 2 assertion.
create or replace function ledger_post(
  p_kind     text,
  p_ref_type text,
  p_ref_id   uuid,
  p_actor    uuid,
  p_memo     text,
  p_entries  jsonb
) returns uuid
language plpgsql as $$
declare
  v_tx   uuid;
  v_rows int;
begin
  insert into ledger_transactions (kind, ref_type, ref_id, actor_admin_id, memo)
  values (p_kind, p_ref_type, p_ref_id, p_actor, p_memo)
  returning id into v_tx;

  insert into ledger_entries (tx_id, account_id, amount)
  select v_tx, (e->>'account_id')::uuid, (e->>'amount')::bigint
    from jsonb_array_elements(p_entries) e
   where (e->>'amount')::bigint <> 0;

  get diagnostics v_rows = row_count;
  if v_rows < 2 then
    raise exception
      'ledger_post(%): needs at least two non-zero legs, got % — refusing to post a one-sided entry',
      p_kind, v_rows
      using errcode = 'check_violation';
  end if;

  return v_tx;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Verification — used by tests, the reconciliation job, and the panel
-- ═══════════════════════════════════════════════════════════════════════════

-- Re-derives everything from the append-only entries and compares against the
-- cache and the invariant. Returns zero rows when the ledger is healthy.
create or replace function ledger_verify()
returns table (problem text, detail jsonb)
language plpgsql stable as $$
begin
  -- (a) The global invariant, per currency, derived from raw entries.
  return query
    select
      'global sum is not zero',
      jsonb_build_object('currency', a.currency, 'sum', sum(e.amount))
    from ledger_entries e
    join accounts a on a.id = e.account_id
    group by a.currency
    having sum(e.amount) <> 0;

  -- (b) Every individual transaction balances.
  return query
    select
      'transaction does not balance',
      jsonb_build_object('tx_id', e.tx_id, 'currency', a.currency, 'sum', sum(e.amount))
    from ledger_entries e
    join accounts a on a.id = e.account_id
    group by e.tx_id, a.currency
    having sum(e.amount) <> 0;

  -- (c) The balance cache agrees with the entries it summarises.
  return query
    select
      'cached balance disagrees with entries',
      jsonb_build_object(
        'account_id', a.id, 'kind', a.kind, 'player_id', a.player_id,
        'cached', a.balance, 'derived', coalesce(s.total, 0)
      )
    from accounts a
    left join (
      select account_id, sum(amount) as total from ledger_entries group by account_id
    ) s on s.account_id = a.id
    where a.balance <> coalesce(s.total, 0);

  -- (d) No player account is underwater.
  return query
    select
      'player account is negative',
      jsonb_build_object('account_id', a.id, 'kind', a.kind,
                         'player_id', a.player_id, 'balance', a.balance)
    from accounts a
    where a.kind in ('player_chips', 'player_wallet', 'player_escrow')
      and a.balance < 0;
end $$;

comment on function ledger_verify() is
  'Returns zero rows iff the ledger is healthy. Non-empty result = stop the world.';
