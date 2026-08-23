-- ═══════════════════════════════════════════════════════════════════════════
-- 0098 — Manual queue reordering (move a cash-out up / down), audited
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The withdrawal queue is strict FIFO by created_at. An admin sometimes needs to
-- bump someone up or down. We add an explicit ordering KEY that both the queue view
-- and deposit_match respect:
--
--   wq_key = coalesce(queue_priority, created_at as epoch-millis)
--
-- A fresh cash-out has queue_priority = NULL, so it orders by created_at exactly as
-- before — nothing changes until someone is moved. Moving X up/down SWAPS its key
-- with its immediate neighbour in the same method+currency queue, so the two trade
-- places and everything else stays put. Every move is written to the audit log with
-- the admin's id, so History shows who did it.

alter table withdraw_requests add column if not exists queue_priority bigint;

-- The single source of truth for a cash-out's place in line.
create or replace function wq_key(p_priority bigint, p_created timestamptz) returns bigint
language sql immutable as $$
  select coalesce(p_priority, (extract(epoch from p_created) * 1000)::bigint);
$$;

-- ── deposit_match: order by wq_key (same as 0097 otherwise) ──────────────────
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

  -- p2p: the oldest cash-out (by queue order) that can take the WHOLE deposit.
  if m.settlement = 'p2p' then
    select id, player_id, payout_handle, amount_remaining
      into w
      from withdraw_requests
     where method_id = d.method_id
       and currency  = d.currency
       and status in ('queued', 'partially_filled')
       and amount_remaining >= v_remaining
       and player_id <> d.player_id
       and paused_at is null
     order by wq_key(queue_priority, created_at), id
       for update skip locked
     limit 1;

    if found then
      v_slice := v_remaining;
      v_rake  := calc_rake(v_slice, 'deposit');
      insert into fills (
        deposit_id, withdraw_id, method_id, currency,
        amount, rake_amount, credit_amount, gross_to_send,
        payout_handle, status, lock_expires_at
      ) values (
        d.id, w.id, d.method_id, d.currency,
        v_slice, v_rake, v_slice - v_rake, calc_gross_to_send(v_slice, d.method_id),
        w.payout_handle, 'locked', v_lock_exp
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

-- ── The queue view orders by wq_key (same columns as before) ─────────────────
create or replace view v_withdraw_queue as
select
  wr.id, wr.player_id, p.display_name, p.telegram_id,
  pf.name as platform, pm.name as method_name, pm.code as method_code,
  wr.currency, wr.amount, wr.amount_remaining,
  wr.amount - wr.amount_remaining as amount_matched,
  wr.status, wr.created_at, wr.queued_at, wr.payout_handle,
  row_number() over (partition by wr.method_id, wr.currency
                     order by wq_key(wr.queue_priority, wr.created_at), wr.id)
    as queue_position,
  extract(epoch from (now() - wr.created_at))::bigint as waiting_seconds
from withdraw_requests wr
join players p on p.id = wr.player_id
join platforms pf on pf.id = wr.platform_id
join payment_methods pm on pm.id = wr.method_id
where wr.status in ('queued', 'partially_filled') and wr.amount_remaining > 0;

-- ── Move a cash-out up / down one place, swapping with its neighbour ──────────
create or replace function withdraw_move(p_withdraw uuid, p_dir text, p_admin uuid)
returns void
language plpgsql as $$
declare
  adm   admins;
  x     withdraw_requests;
  x_key bigint;
  n_id  uuid;
  n_key bigint;
begin
  if p_dir not in ('up', 'down') then
    raise exception 'direction must be up or down' using errcode = 'invalid_parameter_value';
  end if;
  select * into adm from admins where id = p_admin and not disabled;
  if not found then
    raise exception 'admin % not found or disabled', p_admin using errcode = 'insufficient_privilege';
  end if;

  select * into x from withdraw_requests where id = p_withdraw for update;
  if not found then raise exception 'cash-out not found'; end if;
  if x.status not in ('queued', 'partially_filled') then
    raise exception 'that cash-out is not in the queue (it is %)', x.status
      using errcode = 'invalid_parameter_value';
  end if;
  x_key := wq_key(x.queue_priority, x.created_at);

  -- The immediate neighbour in the same method+currency queue: the one directly
  -- ahead (up) or behind (down) by queue order.
  if p_dir = 'up' then
    select id, wq_key(queue_priority, created_at) into n_id, n_key
      from withdraw_requests
     where method_id = x.method_id and currency = x.currency
       and status in ('queued', 'partially_filled') and id <> x.id
       and wq_key(queue_priority, created_at) < x_key
     order by wq_key(queue_priority, created_at) desc, id desc
     limit 1 for update;
  else
    select id, wq_key(queue_priority, created_at) into n_id, n_key
      from withdraw_requests
     where method_id = x.method_id and currency = x.currency
       and status in ('queued', 'partially_filled') and id <> x.id
       and wq_key(queue_priority, created_at) > x_key
     order by wq_key(queue_priority, created_at) asc, id asc
     limit 1 for update;
  end if;

  if n_id is null then
    raise exception 'already at the %', case when p_dir = 'up' then 'top of the queue' else 'bottom of the queue' end
      using errcode = 'invalid_parameter_value';
  end if;

  -- Swap their keys so the two trade places (nudge equal keys apart by 1ms so the
  -- swap always moves them).
  if n_key = x_key then
    n_key := case when p_dir = 'up' then x_key - 1 else x_key + 1 end;
  end if;
  update withdraw_requests set queue_priority = n_key where id = x.id;
  update withdraw_requests set queue_priority = x_key where id = n_id;

  perform audit(p_admin, 'withdraw.reorder', 'withdraw_request', x.id,
    jsonb_build_object('direction', p_dir, 'swapped_with', n_id));
end $$;
