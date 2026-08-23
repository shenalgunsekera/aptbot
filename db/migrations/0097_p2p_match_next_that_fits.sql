-- ═══════════════════════════════════════════════════════════════════════════
-- 0097 — A p2p deposit matches the oldest cash-out that FITS, not just the first
-- ═══════════════════════════════════════════════════════════════════════════
--
-- BUG: deposit_match grabbed the single oldest queued cash-out (order by
-- created_at, limit 1) and only then checked `amount_remaining >= deposit`. If the
-- oldest cash-out was SMALLER than the deposit, the check failed and the deposit
-- fell straight to the club account — even when a LATER cash-out in the queue could
-- have taken it in full. So a $100 Zelle deposit with a $1000 cash-out waiting
-- still got the company link, because some smaller cash-out sat ahead of it.
--
-- FIX: put the size requirement into the query. It now selects the OLDEST cash-out
-- whose remaining is >= the deposit (FIFO among the ones that can actually take it),
-- skipping any that are too small. Everything else is unchanged: still one cash-out
-- paid in full (no splits), still `for update skip locked`, still the same club
-- fallback when nothing in the queue fits. Only change vs 0092 is the p2p SELECT.
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

  -- ── p2p: pay ONE player in full, or nobody (no splits) ──
  -- The oldest cash-out that can take the WHOLE deposit (FIFO among those that fit).
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
     order by created_at, id
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

  -- ── The club takes the rest — at the tiered handle for this amount ──
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
