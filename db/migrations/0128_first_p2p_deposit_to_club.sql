-- ═══════════════════════════════════════════════════════════════════════════
-- 0128 — a new player's first Venmo/Zelle deposit goes to a club tag
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A P2P deposit normally pays a queued cash-out directly, so the club never sees
-- the money — staff are trusting a stranger's screenshot. With this switch on, a
-- player who has never had a Venmo/Zelle (p2p) deposit complete skips the queue
-- and is handed the club tag instead (club_handle_for: the same tiers the backstop
-- already uses — fixed tag, PEERPAY or STAFF by amount), so the money lands in an
-- account we control and email detection can confirm it. Once one clears, the
-- player matches player-to-player as usual.
--
-- A club fill can't be swapped (deposit_skip_payee refuses withdraw_id null), so a
-- first-timer can't skip their way back onto a payee. Off by default.

alter table config
  add column if not exists first_p2p_deposit_to_club boolean not null default false;

create or replace function player_has_cleared_p2p(p_player_id uuid)
returns boolean language sql stable as $$
  select exists (
    select 1 from deposit_requests dr
      join payment_methods m on m.id = dr.method_id
     where dr.player_id = p_player_id
       and dr.status = 'completed'
       and m.settlement = 'p2p')
$$;

create or replace function deposit_match(p_deposit_id uuid)
returns setof fills
language plpgsql as $fn$
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

  -- A first-timer's Venmo/Zelle skips the queue and falls to the club tag below (0128).
  if m.settlement = 'p2p'
     and not (cfg.first_p2p_deposit_to_club and not player_has_cleared_p2p(d.player_id)) then
    select wr.id, wr.player_id, wr.payout_handle, wr.amount_remaining, wr.is_split
      into w
      from withdraw_requests wr
     where wr.currency  = d.currency
       and wr.status in ('queued', 'partially_filled')
       and wr.amount_remaining >= v_remaining
       and wr.player_id <> d.player_id
       and wr.paused_at is null
       and (v_remaining >= greatest(coalesce(wr.min_override, 0), cfg.min_amount)
            or v_remaining = wr.amount_remaining)
       -- don't re-offer a tag this deposit already skipped (0121)
       and (d.skipped_withdraws is null or wr.id <> all (d.skipped_withdraws))
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
end $fn$;
