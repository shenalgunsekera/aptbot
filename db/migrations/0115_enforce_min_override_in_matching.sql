-- ═══════════════════════════════════════════════════════════════════════════
-- 0115 — a cash-out's min override now actually GATES matching
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 0096 added a per-cash-out minimum but, by its own design, only used it for the
-- "small cash-out → pay from float" alert and the "$X min" label — matching
-- ignored it. So an admin who set "min $100" on a cash-out still saw it filled by
-- sub-$100 deposits, leaving awkward slivers (e.g. $10) that then can't be matched
-- at all. The owner wants the min to mean what it says: don't let a deposit fill a
-- cash-out for less than its minimum.
--
-- Rule added to deposit_match: a deposit may fill a cash-out only if the deposit
-- is at least the cash-out's effective minimum — greatest(min_override, global
-- min) — OR it exactly clears the whole remaining (so a legitimate final payment
-- is never blocked and nothing gets permanently stuck below the floor; anything
-- smaller than that is paid from the float, which the small-payout alert nudges).
--
-- Backward compatible: with no override, the effective min is the global minimum,
-- which every deposit already clears — so nothing changes for normal cash-outs.
-- Only the gated SELECT changes vs the live version.
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

  -- p2p: the oldest cash-out (by queue order) that can take the WHOLE deposit AND
  -- whose minimum the deposit clears (or that this deposit fully clears).
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
       and (v_remaining >= greatest(coalesce(min_override, 0), cfg.min_amount)
            or v_remaining = amount_remaining)
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
