-- ═══════════════════════════════════════════════════════════════════════════
-- 0085 — A P2P method's no-match fallback is its backstop tag, not the tier
-- ═══════════════════════════════════════════════════════════════════════════
--
-- When Cash App / PayPal are toggled to P2P, a deposit should match a queued
-- cash-out and, if none, fall to the method's club_handle BACKSTOP tag — exactly
-- like Venmo/Zelle. But deposit_match resolved the fallback via club_handle_for,
-- which returns the amount TIERS — and Cash App still carries a STRIPE tier from
-- when it was club, so an unmatched (and, combined with the bot-side pre-divert,
-- even a matchable) deposit was pushed to the card link instead of the queue.
--
-- Fix: for a P2P method, the club fallback is m.club_handle (the backstop). Club
-- methods keep the tiered club_handle_for (Stripe/Staff/PeerPay/handle). Only the
-- fallback-handle line changes vs the deployed function.
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
  if m.settlement = 'p2p' then
    select id, player_id, payout_handle, amount_remaining
      into w
      from withdraw_requests
     where method_id = d.method_id
       and currency  = d.currency
       and status in ('queued', 'partially_filled')
       and amount_remaining > 0
       and player_id <> d.player_id
     order by created_at, id
       for update skip locked
     limit 1;

    if found and w.amount_remaining >= v_remaining then
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

  -- ── The club takes the rest ──
  -- P2P method with no match → its backstop tag (like Venmo). Club method → the
  -- amount-tiered handle (Stripe / Staff / PeerPay / a tag).
  if v_remaining > 0 then
    if m.settlement = 'p2p' then
      v_club_handle := m.club_handle;
    else
      v_club_handle := club_handle_for(d.method_id, d.amount);
    end if;

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
