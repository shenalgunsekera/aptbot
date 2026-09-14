-- ═══════════════════════════════════════════════════════════════════════════
-- 0113 — Split cash-out (/withdraw2): ONE cash-out, fillable by TWO methods
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A player cashes out a single total (e.g. $100) that can be paid via EITHER of
-- two p2p methods (Venmo OR Zelle). It is one withdraw_requests row — taken off
-- the table once, one escrow, one queue spot per method — with a SHARED
-- amount_remaining. Whoever deposits first (Venmo or Zelle) fills the next slice,
-- up to the total. Because the pool is shared:
--   • it can never be overpaid past the total (one amount_remaining, decremented
--     on every lock, restored on unlock/expire), and
--   • when one side has a slice locked, the other side automatically has only the
--     leftover to give — and shows "paused, $X being filled" once nothing is left.
--
-- MINIMAL BLAST RADIUS: a split keeps method_id = its FIRST method and
-- payout_handle = that method's handle, so every existing join, view, and flow
-- (/pending, history, notifier, escrow, cancel, settle, reorder, pause) keeps
-- working unchanged. The second method + both per-method handles live in a child
-- table. deposit_match gains ONE extra match branch; everything else is byte-
-- identical to the live 0098 version.

-- ── Schema ──────────────────────────────────────────────────────────────────
alter table withdraw_requests   add column if not exists is_split boolean not null default false;
alter table payment_methods     add column if not exists split_eligible boolean not null default false;
alter table config              add column if not exists split_cashout_enabled boolean not null default false;

-- One row per method on a split, each with its OWN payout handle (Venmo tag vs
-- Zelle handle). A normal cash-out has no rows here and is unaffected.
create table if not exists withdraw_split_methods (
  withdraw_id   uuid not null references withdraw_requests(id) on delete cascade,
  method_id     uuid not null references payment_methods(id),
  payout_handle text not null,
  primary key (withdraw_id, method_id)
);
create index if not exists idx_wsm_method on withdraw_split_methods (method_id);

-- Ship it working for the pair the owner asked for; the admin panel controls the
-- rest from here.
update payment_methods set split_eligible = true where code in ('venmo', 'zelle');
update config set split_cashout_enabled = true;

-- ── Create a split cash-out ─────────────────────────────────────────────────
-- Mirrors withdraw_create (0109) exactly — same validation, escrow, take-off,
-- one-open-per-platform rule, notifications — but takes TWO methods + TWO handles
-- and records them. method_id / payout_handle = the first method (compat).
create or replace function withdraw_create_split(
  p_player_id   uuid,
  p_platform_id uuid,
  p_method_a    uuid,
  p_handle_a    text,
  p_method_b    uuid,
  p_handle_b    text,
  p_requested   bigint
) returns withdraw_requests
language plpgsql as $$
declare
  cfg     config;
  pl      players;
  pf      platforms;
  ma      payment_methods;
  mb      payment_methods;
  w       withdraw_requests;
  v_open  int;
  v_today bigint;
  v_min   bigint;
  v_max   bigint;
  v_step  bigint;
  v_order loader_orders;
begin
  select * into cfg from config where id;
  if not cfg.split_cashout_enabled then
    raise exception 'split cash-outs are not available right now'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into pl from players where id = p_player_id for update;
  if not found then
    raise exception 'player % not found', p_player_id;
  end if;
  if pl.status <> 'active' then
    raise exception 'account is % — withdrawals are not available', pl.status
      using errcode = 'insufficient_privilege';
  end if;

  select * into pf from platforms where id = p_platform_id;
  if not found or not pf.enabled then
    raise exception 'that platform is not available'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_method_a = p_method_b then
    raise exception 'a split cash-out needs two different methods'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into ma from payment_methods where id = p_method_a;
  select * into mb from payment_methods where id = p_method_b;
  if ma.id is null or mb.id is null or not ma.enabled or not mb.enabled then
    raise exception 'that payment method is not available'
      using errcode = 'invalid_parameter_value';
  end if;
  if not ma.split_eligible or not mb.split_eligible then
    raise exception 'those methods can''t be combined in a split cash-out'
      using errcode = 'invalid_parameter_value';
  end if;
  -- A split is a peer-to-peer pool ("whoever deposits fills it"). Club-mediated
  -- methods skip the queue entirely, so they can't share a pool.
  if ma.settlement <> 'p2p' or mb.settlement <> 'p2p' then
    raise exception 'those methods can''t be combined in a split cash-out'
      using errcode = 'invalid_parameter_value';
  end if;
  if ma.currency <> mb.currency then
    raise exception 'those methods can''t be combined in a split cash-out'
      using errcode = 'invalid_parameter_value';
  end if;
  if (ma.reversibility = 'reversible' or mb.reversibility = 'reversible') and not cfg.allow_reversible then
    raise exception 'that payment method is temporarily unavailable'
      using errcode = 'invalid_parameter_value';
  end if;
  if coalesce(trim(p_handle_a), '') = '' or coalesce(trim(p_handle_b), '') = '' then
    raise exception 'we need to know where to send your money'
      using errcode = 'invalid_parameter_value';
  end if;

  -- The total must clear BOTH methods' limits/step (use the stricter of the two).
  v_min  := greatest(coalesce(ma.min_amount, cfg.min_amount), coalesce(mb.min_amount, cfg.min_amount));
  v_max  := least(coalesce(ma.max_amount, cfg.max_amount), coalesce(mb.max_amount, cfg.max_amount));
  v_step := greatest(coalesce(ma.amount_step, cfg.amount_step), coalesce(mb.amount_step, cfg.amount_step));

  if p_requested < v_min then
    raise exception 'the smallest split cash-out is %s',
      to_char(v_min / 100.0, 'FM999999990.00') using errcode = 'invalid_parameter_value';
  end if;
  if p_requested > v_max then
    raise exception 'the largest split cash-out is %s',
      to_char(v_max / 100.0, 'FM999999990.00') using errcode = 'invalid_parameter_value';
  end if;
  if v_step > 0 and p_requested % v_step <> 0 then
    raise exception 'add in whole multiples of %',
      to_char(v_step / 100.0, 'FM999999990.00') using errcode = 'invalid_parameter_value';
  end if;

  -- One open cash-out per platform — a split counts as that one.
  select count(*) into v_open
    from withdraw_requests
   where player_id = p_player_id
     and platform_id = p_platform_id
     and status in ('pending_unload', 'queued', 'partially_filled', 'filled');
  if v_open >= 1 then
    raise exception 'you already have a cash out in progress on % — finish or cancel it first. If you would like to add to your withdraw, do /addtowithdraw', pf.name
      using errcode = 'invalid_parameter_value';
  end if;

  if cfg.daily_cap_per_player is not null then
    select coalesce(sum(coalesce(gross_amount, requested_amount)), 0) into v_today
      from withdraw_requests
     where player_id = p_player_id
       and status <> 'cancelled'
       and created_at > now() - interval '24 hours';
    if v_today + p_requested > cfg.daily_cap_per_player then
      raise exception 'that would go over your daily limit'
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  insert into withdraw_requests (
    player_id, platform_id, method_id, currency,
    requested_amount, payout_handle, status, is_split, terms
  ) values (
    p_player_id, p_platform_id, p_method_a, ma.currency,
    p_requested, trim(p_handle_a), 'pending_unload', true,
    jsonb_build_object(
      'rake_withdraw_bps',  cfg.rake_withdraw_bps,
      'rake_withdraw_flat', cfg.rake_withdraw_flat,
      'split',              true,
      'method_codes',       jsonb_build_array(ma.code, mb.code),
      'settlement',         'p2p')
  ) returning * into w;

  insert into withdraw_split_methods (withdraw_id, method_id, payout_handle) values
    (w.id, p_method_a, trim(p_handle_a)),
    (w.id, p_method_b, trim(p_handle_b));

  perform payout_handle_remember(p_player_id, p_method_a, p_handle_a);
  perform payout_handle_remember(p_player_id, p_method_b, p_handle_b);

  v_order := loader_order_create(
    p_player_id, p_platform_id, -p_requested, ma.currency,
    'withdraw.unload', 'withdraw_request', w.id);

  update withdraw_requests set unload_order_id = v_order.id where id = w.id
  returning * into w;

  return w;
end $$;

-- ── Matching: let a deposit fill a split via EITHER of its methods ───────────
-- Byte-identical to the live 0098 deposit_match except the p2p lookup also
-- matches a split whose method set includes the deposit's method, and the fill
-- snapshots THAT method's handle (so a Venmo depositor is shown the Venmo tag,
-- a Zelle depositor the Zelle handle) — all against the one shared pool.
create or replace function deposit_match(p_deposit_id uuid)
returns setof fills
language plpgsql as $$
declare
  cfg config;
  d   deposit_requests;
  m   payment_methods;
  w   record;
  f   fills;
  v_remaining   bigint;
  v_slice       bigint;
  v_rake        bigint;
  v_lock_exp    timestamptz;
  v_club_handle text;
  v_handle      text;
begin
  select * into cfg from config where id;

  select * into d from deposit_requests where id = p_deposit_id for update;
  if not found then
    raise exception 'deposit % not found', p_deposit_id;
  end if;
  if d.status <> 'matching' then
    raise exception 'deposit % is % — matching has already run', d.id, d.status
      using errcode = 'invalid_parameter_value';
  end if;

  select * into m from payment_methods where id = d.method_id;

  v_lock_exp  := now() + make_interval(secs => cfg.match_timeout_seconds);
  v_remaining := d.amount;

  -- p2p: the oldest cash-out (by queue order) that can take the WHOLE deposit,
  -- matched by its own method OR — for a split — by any of its split methods.
  if m.settlement = 'p2p' then
    select wr.id, wr.player_id, wr.payout_handle, wr.amount_remaining, wr.is_split
      into w
      from withdraw_requests wr
     where wr.currency  = d.currency
       and wr.status in ('queued', 'partially_filled')
       and wr.amount_remaining >= v_remaining
       and wr.player_id <> d.player_id
       and wr.paused_at is null
       -- honour a per-cash-out minimum (0115): a deposit must clear the floor, or
       -- exactly clear the whole remaining, to fill it.
       and (v_remaining >= greatest(coalesce(wr.min_override, 0), cfg.min_amount)
            or v_remaining = wr.amount_remaining)
       and (
             wr.method_id = d.method_id
          or exists (select 1 from withdraw_split_methods sm
                      where sm.withdraw_id = wr.id and sm.method_id = d.method_id)
           )
     order by wq_key(wr.queue_priority, wr.created_at), wr.id
       for update skip locked
     limit 1;

    if found then
      v_slice := v_remaining;
      v_rake  := calc_rake(v_slice, 'deposit');
      -- A split pays to the handle for THIS deposit's method; a normal cash-out
      -- keeps its single handle.
      v_handle := coalesce(
        (select sm.payout_handle from withdraw_split_methods sm
          where sm.withdraw_id = w.id and sm.method_id = d.method_id),
        w.payout_handle);
      insert into fills (
        deposit_id, withdraw_id, method_id, currency,
        amount, rake_amount, credit_amount, gross_to_send,
        payout_handle, status, lock_expires_at
      ) values (
        d.id, w.id, d.method_id, d.currency,
        v_slice, v_rake, v_slice - v_rake, calc_gross_to_send(v_slice, d.method_id),
        v_handle, 'locked', v_lock_exp
      ) returning * into f;
      update withdraw_requests
         set amount_remaining = amount_remaining - v_slice,
             status = (case when amount_remaining - v_slice = 0 then 'filled'
                            else 'partially_filled' end)::withdraw_status
       where id = w.id;
      v_remaining := 0;
      return next f;
    end if;
  end if;

  if v_remaining > 0 then
    v_club_handle := club_handle_for(d.method_id, d.amount);
    if v_club_handle is null then
      raise exception
        'we can''t take that right now — % isn''t set up to receive it. Try another method or a smaller amount.',
        m.name
        using errcode = 'invalid_parameter_value';
    end if;
    v_rake := calc_rake(v_remaining, 'deposit');
    insert into fills (
      deposit_id, withdraw_id, method_id, currency,
      amount, rake_amount, credit_amount, gross_to_send,
      payout_handle, status, lock_expires_at
    ) values (
      d.id, null, d.method_id, d.currency,
      v_remaining, v_rake, v_remaining - v_rake,
      calc_gross_to_send(v_remaining, d.method_id),
      v_club_handle, 'locked', v_lock_exp
    ) returning * into f;
    v_remaining := 0;
    return next f;
  end if;

  update deposit_requests set status = 'awaiting_payment' where id = d.id;
  return;
end $$;

-- ── Queue view: a split appears under BOTH its method tabs ───────────────────
-- Non-split rows are unchanged (their own method, own handle). A split expands
-- to one row per method, each carrying that method's handle and the SHARED
-- amount / amount_remaining, so it shows in each method's queue and its progress
-- is visible on both sides.
create or replace view v_withdraw_queue as
with eff as (
  select wr.id as wid, wr.method_id, wr.payout_handle
    from withdraw_requests wr
   where not wr.is_split
  union all
  select sm.withdraw_id, sm.method_id, sm.payout_handle
    from withdraw_split_methods sm
)
select
  wr.id, wr.player_id, p.display_name, p.telegram_id,
  pf.name as platform, pm.name as method_name, pm.code as method_code,
  wr.currency, wr.amount, wr.amount_remaining,
  wr.amount - wr.amount_remaining as amount_matched,
  wr.status, wr.created_at, wr.queued_at, eff.payout_handle,
  row_number() over (partition by eff.method_id, wr.currency
                     order by wq_key(wr.queue_priority, wr.created_at), wr.id)
    as queue_position,
  extract(epoch from (now() - wr.created_at))::bigint as waiting_seconds,
  wr.is_split
from withdraw_requests wr
join eff on eff.wid = wr.id
join players p on p.id = wr.player_id
join platforms pf on pf.id = wr.platform_id
join payment_methods pm on pm.id = eff.method_id
where wr.status in ('queued', 'partially_filled') and wr.amount_remaining > 0;
