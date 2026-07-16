-- ═══════════════════════════════════════════════════════════════════════════
-- 0003 — The double-entry ledger
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Ported from v1 essentially intact — this file carried 43 green tests
-- including concurrency races, and nothing about the platform split changes
-- its logic. What changed: accounts now carry a platform dimension, so a
-- player's ClubGG wallet and Sportsbook wallet are different accounts.
--
-- THE INVARIANT
-- ─────────────
--   For every currency:  SUM(ledger_entries.amount) = 0.  Always. No exceptions.
--
--   1. `ledger_entries` is append-only     — trigger refuses UPDATE/DELETE
--   2. every transaction nets to zero      — DEFERRED constraint trigger,
--                                            checked at COMMIT
--   3. player accounts never go negative   — deferred trigger
--
-- (2) is deferred because a transaction is only balanced once ALL its legs are
-- inserted. Deferring to commit is what makes "unbalanced writes cannot be
-- committed" true regardless of insert order.

-- ─── Accounts ───────────────────────────────────────────────────────────────
create table accounts (
  id          uuid primary key default gen_random_uuid(),
  kind        account_kind not null,
  player_id   uuid references players (id),
  platform_id uuid references platforms (id),
  currency    char(3) not null,

  -- Cached SUM(entries.amount), maintained by trigger. A CACHE, not the truth:
  -- ledger_verify() re-derives from the entries and screams on disagreement.
  balance     bigint not null default 0,

  created_at  timestamptz not null default now(),

  -- Shape rules:
  --   player accounts     → player AND platform (separate wallets per platform)
  --   house_settlement    → platform, no player (value on that platform's tables)
  --   other house/float   → neither
  constraint accounts_shape check (
    (kind in ('player_wallet', 'player_escrow')
       and player_id is not null and platform_id is not null)
    or
    (kind = 'house_settlement' and player_id is null and platform_id is not null)
    or
    (kind in ('house_rake', 'house_loss', 'owner_float')
       and player_id is null and platform_id is null)
  )
);

create unique index accounts_player_uniq
  on accounts (kind, player_id, platform_id, currency)
  where player_id is not null;
create unique index accounts_settlement_uniq
  on accounts (kind, platform_id, currency)
  where player_id is null and platform_id is not null;
create unique index accounts_house_uniq
  on accounts (kind, currency)
  where player_id is null and platform_id is null;
create index accounts_player_lookup_idx on accounts (player_id) where player_id is not null;

-- ─── Transactions and entries ───────────────────────────────────────────────
create table ledger_transactions (
  id             uuid primary key default gen_random_uuid(),
  kind           text not null,     -- 'withdraw.escrow', 'fill.release', ...
  ref_type       text,
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
  -- Signed minor units. Zero is meaningless in double-entry and rejected.
  amount     bigint not null check (amount <> 0),
  created_at timestamptz not null default now()
);

create index ledger_entries_account_idx on ledger_entries (account_id, id);
create index ledger_entries_tx_idx      on ledger_entries (tx_id);

-- ─── (1) Append-only ────────────────────────────────────────────────────────
-- A ledger you can edit is not a ledger. Corrections are reversing entries.
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

-- ─── Balance cache ──────────────────────────────────────────────────────────
-- Serialises concurrent writers on shared accounts (house_rake in particular).
-- At union scale that contention is irrelevant, and it buys a balance we can
-- trust under concurrency without re-summing an append-only table forever.
create or replace function ledger_apply_balance() returns trigger
language plpgsql as $$
begin
  update accounts set balance = balance + new.amount where id = new.account_id;
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
-- You cannot withdraw credit you don't have or release escrow never posted.
-- Deliberately NOT applied to house accounts: house_settlement legitimately
-- swings negative when players win off the tables, owner_float when the owner
-- holds cash. If the union can't claw value back from a player, the honest
-- entry is a house_loss — this constraint is what forces that honesty.
create or replace function assert_account_nonnegative() returns trigger
language plpgsql as $$
declare
  a accounts;
begin
  select * into a from accounts where id = new.account_id;
  if a.kind in ('player_wallet', 'player_escrow') and a.balance < 0 then
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

-- Resolve (kind, player, platform, currency) → account id, creating on first
-- use. Concurrency-safe: a loser on the unique index re-reads the winner's row.
create or replace function account_of(
  p_kind     account_kind,
  p_player   uuid,
  p_platform uuid,
  p_currency char(3)
) returns uuid
language plpgsql as $$
declare
  v_id uuid;
begin
  -- Shape validation mirrors accounts_shape so a miswired caller fails with a
  -- readable message instead of a constraint violation.
  if p_kind in ('player_wallet', 'player_escrow') then
    if p_player is null or p_platform is null then
      raise exception 'account_of: % needs a player AND a platform', p_kind;
    end if;
  elsif p_kind = 'house_settlement' then
    if p_player is not null or p_platform is null then
      raise exception 'account_of: house_settlement takes a platform, no player';
    end if;
  else
    if p_player is not null or p_platform is not null then
      raise exception 'account_of: % is a global house account', p_kind;
    end if;
  end if;

  select id into v_id
    from accounts
   where kind = p_kind
     and player_id   is not distinct from p_player
     and platform_id is not distinct from p_platform
     and currency = p_currency;
  if v_id is not null then
    return v_id;
  end if;

  begin
    insert into accounts (kind, player_id, platform_id, currency)
    values (p_kind, p_player, p_platform, p_currency)
    returning id into v_id;
  exception when unique_violation then
    select id into v_id
      from accounts
     where kind = p_kind
       and player_id   is not distinct from p_player
       and platform_id is not distinct from p_platform
       and currency = p_currency;
  end;
  return v_id;
end $$;

create or replace function balance_of(
  p_kind     account_kind,
  p_player   uuid,
  p_platform uuid,
  p_currency char(3)
) returns bigint
language sql stable as $$
  select coalesce(
    (select balance from accounts
      where kind = p_kind
        and player_id   is not distinct from p_player
        and platform_id is not distinct from p_platform
        and currency = p_currency),
    0
  );
$$;

-- Post one balanced transaction. Zero-amount legs are dropped (a zero rake is
-- legitimate config); what remains must still be real double-entry.
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
      'ledger_post(%): needs at least two non-zero legs, got % — refusing a one-sided entry',
      p_kind, v_rows
      using errcode = 'check_violation';
  end if;
  return v_tx;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Verification — tests, the panel, and anything that should page a human
-- ═══════════════════════════════════════════════════════════════════════════

-- Returns zero rows iff the ledger is healthy. Non-empty = stop the world.
create or replace function ledger_verify()
returns table (problem text, detail jsonb)
language plpgsql stable as $$
begin
  return query
    select 'global sum is not zero',
           jsonb_build_object('currency', a.currency, 'sum', sum(e.amount))
      from ledger_entries e join accounts a on a.id = e.account_id
     group by a.currency having sum(e.amount) <> 0;

  return query
    select 'transaction does not balance',
           jsonb_build_object('tx_id', e.tx_id, 'currency', a.currency, 'sum', sum(e.amount))
      from ledger_entries e join accounts a on a.id = e.account_id
     group by e.tx_id, a.currency having sum(e.amount) <> 0;

  return query
    select 'cached balance disagrees with entries',
           jsonb_build_object('account_id', a.id, 'kind', a.kind, 'player_id', a.player_id,
                              'cached', a.balance, 'derived', coalesce(s.total, 0))
      from accounts a
      left join (select account_id, sum(amount) as total
                   from ledger_entries group by account_id) s on s.account_id = a.id
     where a.balance <> coalesce(s.total, 0);

  return query
    select 'player account is negative',
           jsonb_build_object('account_id', a.id, 'kind', a.kind,
                              'player_id', a.player_id, 'balance', a.balance)
      from accounts a
     where a.kind in ('player_wallet', 'player_escrow') and a.balance < 0;
end $$;

comment on function ledger_verify() is
  'Returns zero rows iff the ledger is healthy. Non-empty result = stop the world.';
