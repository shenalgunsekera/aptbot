-- ═══════════════════════════════════════════════════════════════════════════
-- 0087 — Pause / resume a cash-out (take it out of the queue while an admin pays)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- An admin sorting out a cash-out by hand needs to freeze it so nobody else pays
-- it in the meantime: no depositor should match it, and the "small cash-out — pay
-- it directly" nudge should not fire. But the admin must still be able to adjust
-- it and pay it while it's frozen, and paying it in full must still complete it.
--
-- A `paused_at` FLAG (not a status change) does exactly this: matching and the
-- nudge skip a paused cash-out, but its status stays queued/partially_filled so
-- withdraw_adjust and withdraw_club_payout keep working, and it holds its place in
-- the FIFO queue (created_at untouched) for when it resumes.

alter table withdraw_requests add column if not exists paused_at timestamptz;

create or replace function withdraw_pause(p_withdraw_id uuid, p_admin uuid)
returns withdraw_requests
language plpgsql as $$
declare w withdraw_requests; adm admins;
begin
  select * into adm from admins where id = p_admin and not disabled;
  if not found then raise exception 'admin % not found or disabled', p_admin using errcode = 'insufficient_privilege'; end if;
  select * into w from withdraw_requests where id = p_withdraw_id for update;
  if not found then raise exception 'cash-out not found'; end if;
  if w.status not in ('queued', 'partially_filled') then
    raise exception 'that cash-out is % — only one waiting in the queue can be paused', w.status
      using errcode = 'invalid_parameter_value';
  end if;
  if w.paused_at is not null then
    raise exception 'that cash-out is already paused' using errcode = 'invalid_parameter_value';
  end if;
  update withdraw_requests set paused_at = now() where id = w.id returning * into w;
  perform audit(p_admin, 'withdraw.pause', 'withdraw_request', w.id, '{}'::jsonb);
  return w;
end $$;

create or replace function withdraw_resume(p_withdraw_id uuid, p_admin uuid)
returns withdraw_requests
language plpgsql as $$
declare w withdraw_requests; adm admins;
begin
  select * into adm from admins where id = p_admin and not disabled;
  if not found then raise exception 'admin % not found or disabled', p_admin using errcode = 'insufficient_privilege'; end if;
  select * into w from withdraw_requests where id = p_withdraw_id for update;
  if not found then raise exception 'cash-out not found'; end if;
  if w.paused_at is null then
    raise exception 'that cash-out is not paused' using errcode = 'invalid_parameter_value';
  end if;
  if w.status not in ('queued', 'partially_filled') then
    raise exception 'that cash-out is % — it can no longer be resumed', w.status
      using errcode = 'invalid_parameter_value';
  end if;
  update withdraw_requests set paused_at = null where id = w.id returning * into w;
  perform audit(p_admin, 'withdraw.resume', 'withdraw_request', w.id, '{}'::jsonb);
  return w;
end $$;

-- ── Matching skips a paused cash-out ────────────────────────────────────────
-- Same as 0085; only the p2p match query gains `and paused_at is null`.
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

  if m.settlement = 'p2p' then
    select id, player_id, payout_handle, amount_remaining
      into w
      from withdraw_requests
     where method_id = d.method_id
       and currency  = d.currency
       and status in ('queued', 'partially_filled')
       and amount_remaining > 0
       and paused_at is null                 -- a paused cash-out is off the queue
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

-- ── The small-cash-out nudge skips a paused cash-out ────────────────────────
-- Same as 0057; only adds `new.paused_at is not null` early-out so a paused
-- cash-out doesn't nag admins to pay it while one is already handling it.
create or replace function withdraw_small_pay_alert() returns trigger
language plpgsql as $$
declare
  m   payment_methods;
  cfg config;
  pl  players;
begin
  if new.status not in ('queued', 'partially_filled') or coalesce(new.amount_remaining, 0) <= 0 then
    new.small_alert_sent_at := null;
    return new;
  end if;

  if new.paused_at is not null then
    return new;   -- paused → an admin is handling it; don't nudge anyone else
  end if;

  select * into m from payment_methods where id = new.method_id;
  if m.settlement <> 'p2p' then
    return new;
  end if;

  select * into cfg from config where id;
  if new.amount_remaining >= cfg.min_amount then
    new.small_alert_sent_at := null;
    return new;
  end if;

  if new.small_alert_sent_at is not null then
    return new;
  end if;

  select * into pl from players where id = new.player_id;
  perform notify_admins('withdraw.needs_payout', 'withdraw_request', new.id,
    jsonb_build_object('withdraw_id', new.id, 'name', pl.display_name,
                       'amount', new.amount_remaining, 'currency', new.currency,
                       'method', m.name, 'handle', new.payout_handle,
                       'small', true, 'min', cfg.min_amount));
  new.small_alert_sent_at := now();
  return new;
end $$;
