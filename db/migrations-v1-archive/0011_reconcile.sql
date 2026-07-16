-- ═══════════════════════════════════════════════════════════════════════════
-- 0011 — ClubGG reconciliation: syncing real chip stacks into the ledger
-- ═══════════════════════════════════════════════════════════════════════════

-- Every observation of a real ClubGG stack, kept forever. This is the evidence
-- trail behind every gameplay booking, and the thing you read when a player
-- says "my balance is wrong".
create table clubgg_snapshots (
  id           bigserial primary key,
  player_id    uuid not null references players (id),
  clubgg_id    text not null,          -- snapshotted: where we actually looked
  currency     char(3) not null,

  actual_chips bigint not null check (actual_chips >= 0),

  -- What the ledger predicted the table would show, and the difference. Kept
  -- rather than recomputed so a later ledger change cannot rewrite history.
  expected_chips bigint not null,
  delta        bigint not null,

  source       text not null check (source in ('manual', 'adapter', 'reconcile')),
  taken_by     uuid references admins (id),
  tx_id        uuid references ledger_transactions (id),   -- null when delta = 0
  taken_at     timestamptz not null default now()
);

create index clubgg_snapshots_player_idx on clubgg_snapshots (player_id, taken_at desc);
create index clubgg_snapshots_drift_idx  on clubgg_snapshots (taken_at desc) where delta <> 0;

create trigger clubgg_snapshots_immutable
  before update or delete on clubgg_snapshots
  for each row execute function reject_mutation();

-- ─── Sync ───────────────────────────────────────────────────────────────────
-- Observe a player's real ClubGG stack and make the ledger agree with it,
-- booking the difference to house_gameplay.
--
-- THE PENDING-LOAD CORRECTION IS NOT OPTIONAL. If we owe a player 200 chips
-- that an admin has not yet put on the table, the ledger says 1000 and the
-- table says 800 — and that 200 gap is a delivery backlog, not a gambling loss.
-- Booking it as gameplay would debit the player 200 they never lost, and then
-- the pending load would arrive and credit them 200 again: their balance ends
-- up right by accident, while house_gameplay carries a permanent phantom loss
-- and the fraud alarm it feeds is now noise. So we compare against what the
-- table SHOULD show given work outstanding, not against the raw ledger.
--
-- (Pending unloads need no such correction: those chips are still on the table
-- and still in the ledger, which is consistent. The ledger only moves them at
-- chip_order_complete, which is the moment they physically leave.)
create or replace function chips_sync(
  p_player_id uuid,
  p_actual    bigint,
  p_currency  char(3),
  p_source    text,
  p_admin     uuid default null
) returns bigint          -- the delta booked to gameplay; 0 = ledger was right
language plpgsql as $$
declare
  pl              players;
  v_ledger        bigint;
  v_pending_loads bigint;
  v_expected      bigint;
  v_delta         bigint;
  v_tx            uuid;
begin
  select * into pl from players where id = p_player_id for update;
  if not found then
    raise exception 'player % not found', p_player_id;
  end if;
  if pl.clubgg_id is null then
    raise exception 'player % has no confirmed ClubGG id — nothing to sync against', p_player_id
      using errcode = 'invalid_parameter_value';
  end if;
  if p_actual < 0 then
    raise exception 'a ClubGG stack cannot be negative (got %)', p_actual
      using errcode = 'invalid_parameter_value';
  end if;

  v_ledger := balance_of('player_chips', p_player_id, p_currency);

  select coalesce(sum(delta), 0) into v_pending_loads
    from chip_orders
   where player_id = p_player_id
     and currency = p_currency
     and delta > 0
     and status in ('pending', 'claimed');

  v_expected := v_ledger - v_pending_loads;
  v_delta    := p_actual - v_expected;

  if v_delta <> 0 then
    v_tx := ledger_post(
      'chips.sync', 'player', p_player_id, p_admin,
      format('ClubGG sync: expected %s on table, found %s (gameplay %s%s)',
             v_expected, p_actual, case when v_delta > 0 then '+' else '' end, v_delta),
      jsonb_build_array(
        jsonb_build_object('account_id', account_of('player_chips', p_player_id, p_currency),
                           'amount', v_delta),
        jsonb_build_object('account_id', account_of('house_gameplay', null, p_currency),
                           'amount', -v_delta)
      )
    );
  end if;

  insert into clubgg_snapshots (
    player_id, clubgg_id, currency, actual_chips, expected_chips, delta, source, taken_by, tx_id
  ) values (
    p_player_id, pl.clubgg_id, p_currency, p_actual, v_expected, v_delta, p_source, p_admin, v_tx
  );

  return v_delta;
end $$;

-- ─── Withdrawable ───────────────────────────────────────────────────────────
-- What a player can actually take out right now: spendable credit plus chips
-- that are really on the table. Escrowed money is excluded automatically —
-- it lives in a different account.
create or replace function withdrawable_amount(
  p_player_id uuid,
  p_currency  char(3)
) returns bigint
language sql stable as $$
  select balance_of('player_wallet', p_player_id, p_currency)
       + balance_of('player_chips',  p_player_id, p_currency)
       - coalesce((
           -- Chips already promised to someone else's unload, not yet executed.
           select sum(-delta) from chip_orders
            where player_id = p_player_id and currency = p_currency
              and delta < 0 and status in ('pending', 'claimed')
         ), 0);
$$;

-- ─── Reconciliation report ──────────────────────────────────────────────────
-- The scheduled job. Per-player rows are informational — a player's stack
-- differing from what we issued them is just poker.
--
-- The row that matters is the aggregate, returned by reconcile_summary(): poker
-- is zero-sum, so across the whole club the chips must add up. If they don't,
-- chips are entering or leaving through a door this system doesn't know about.
create or replace function reconcile_report()
returns table (
  player_id     uuid,
  clubgg_id     text,
  currency      char(3),
  ledger_chips  bigint,
  pending_load  bigint,
  pending_unload bigint,
  expected_on_table bigint,
  last_actual   bigint,
  last_seen_at  timestamptz,
  drift         bigint
)
language sql stable as $$
  with per_player as (
    select
      p.id as player_id,
      p.clubgg_id,
      a.currency,
      a.balance as ledger_chips,
      coalesce((select sum(delta) from chip_orders co
                 where co.player_id = p.id and co.currency = a.currency
                   and co.delta > 0 and co.status in ('pending','claimed')), 0) as pending_load,
      coalesce((select -sum(delta) from chip_orders co
                 where co.player_id = p.id and co.currency = a.currency
                   and co.delta < 0 and co.status in ('pending','claimed')), 0) as pending_unload
    from players p
    join accounts a on a.player_id = p.id and a.kind = 'player_chips'
    where p.clubgg_id is not null
  ),
  latest as (
    select distinct on (s.player_id, s.currency)
           s.player_id, s.currency, s.actual_chips, s.taken_at
      from clubgg_snapshots s
     order by s.player_id, s.currency, s.taken_at desc
  )
  select
    pp.player_id,
    pp.clubgg_id,
    pp.currency,
    pp.ledger_chips,
    pp.pending_load,
    pp.pending_unload,
    pp.ledger_chips - pp.pending_load as expected_on_table,
    l.actual_chips,
    l.taken_at,
    l.actual_chips - (pp.ledger_chips - pp.pending_load) as drift
  from per_player pp
  left join latest l on l.player_id = pp.player_id and l.currency = pp.currency;
$$;

-- ─── The alarm ──────────────────────────────────────────────────────────────
-- house_gameplay is the union's chip conservation check. Poker is zero-sum:
-- every chip won was lost by someone else, so once every player has been
-- synced, the wins and losses booked against this account cancel out and it
-- sits near zero.
--
-- It drifts legitimately by exactly one thing: rake the CLUB itself takes at
-- the tables (chips leave players, never arrive anywhere we book). So expect a
-- slow negative trend at roughly the club's in-game rake. Anything else —
-- especially a positive trend, or a jump — means chips appeared from nowhere.
create or replace function reconcile_summary()
returns table (
  currency          char(3),
  player_chips_total bigint,
  wallets_total     bigint,
  escrow_total      bigint,
  owner_float       bigint,
  owner_cash_held   bigint,
  house_rake        bigint,
  house_loss        bigint,
  house_gameplay    bigint,
  unsynced_players  bigint,
  stale_snapshots   bigint,
  ledger_balances   boolean
)
language sql stable as $$
  select
    a.currency,
    coalesce(sum(a.balance) filter (where a.kind = 'player_chips'), 0),
    coalesce(sum(a.balance) filter (where a.kind = 'player_wallet'), 0),
    coalesce(sum(a.balance) filter (where a.kind = 'player_escrow'), 0),
    coalesce(sum(a.balance) filter (where a.kind = 'owner_float'), 0),
    -- owner_float is negative when the owner is holding cash; present it the
    -- way a human thinks about it.
    -coalesce(sum(a.balance) filter (where a.kind = 'owner_float'), 0),
    coalesce(sum(a.balance) filter (where a.kind = 'house_rake'), 0),
    coalesce(sum(a.balance) filter (where a.kind = 'house_loss'), 0),
    coalesce(sum(a.balance) filter (where a.kind = 'house_gameplay'), 0),
    (select count(*) from players p
      where p.clubgg_id is not null
        and not exists (select 1 from clubgg_snapshots s where s.player_id = p.id)),
    (select count(*) from (
       select distinct on (s.player_id) s.player_id, s.taken_at
         from clubgg_snapshots s order by s.player_id, s.taken_at desc
     ) t where t.taken_at < now() - interval '24 hours'),
    -- The invariant, live.
    coalesce(sum(a.balance), 0) = 0
  from accounts a
  group by a.currency;
$$;

comment on function reconcile_summary() is
  'Float, net position, and the live sum-to-zero check. ledger_balances=false means stop the world.';
