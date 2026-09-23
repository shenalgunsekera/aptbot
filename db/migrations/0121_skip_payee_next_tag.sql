-- ═══════════════════════════════════════════════════════════════════════════
-- 0121 — "can't send to this tag → give me the next one" (Zelle for now)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A depositor matched to a payee's Zelle handle sometimes can't actually send to
-- it (recipient blocked, tag won't accept, etc.). This lets them swap to the next
-- payee in line without cancelling and starting over: the current slice is handed
-- back to that payee (returns to the queue for someone else), the deposit is
-- re-matched excluding the ones they've skipped, and they're shown the new tag.
--
-- Rules (owner's choices):
--   • Per-method toggle allow_skip_payee — ON for Zelle only for now.
--   • If no other PLAYER is queued, fall back to the club/backstop handle; if
--     there's no backstop either, the swap rolls back and they keep the current
--     tag (nothing is lost).
--   • Cap 3 skips per deposit — stops someone tapping forever to harvest handles.
--   • The skipped payee keeps its FIFO position (it just goes back in the queue).

alter table payment_methods  add column if not exists allow_skip_payee boolean not null default false;
alter table deposit_requests add column if not exists skipped_withdraws uuid[];

update payment_methods set allow_skip_payee = true where code = 'zelle';

-- ── deposit_match: exclude the cash-outs this deposit has already skipped ─────
-- Byte-identical to the live version except the p2p lookup skips wr.id ∈ the
-- deposit's skipped_withdraws, so a swap never lands back on a tag they rejected.
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

  if m.settlement = 'p2p' then
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
end $$;

-- ── Skip the current tag, get the next one ───────────────────────────────────
create or replace function deposit_skip_payee(p_fill_id uuid)
returns fills
language plpgsql as $$
declare
  f       fills;
  d       deposit_requests;
  m       payment_methods;
  v_skips int;
  v_new   fills;
begin
  select * into f from fills where id = p_fill_id for update;
  if not found then raise exception 'that payment could not be found'; end if;
  if f.status <> 'locked' then
    raise exception 'that payment is already being processed — it can''t be swapped now'
      using errcode = 'invalid_parameter_value';
  end if;
  -- A club/backstop fill has no payee behind it, so there's nothing after it.
  if f.withdraw_id is null then
    raise exception 'this is already the backup tag — there''s nothing after it'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into m from payment_methods where id = f.method_id;
  if not coalesce(m.allow_skip_payee, false) then
    raise exception 'swapping tags isn''t available for this method'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into d from deposit_requests where id = f.deposit_id for update;

  v_skips := coalesce(array_length(d.skipped_withdraws, 1), 0);
  if v_skips >= 3 then
    raise exception 'you''ve already been given a few different tags — please try the last one, or /support if none of them work'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Hand the slice back to the current payee (returns it to the queue) and record
  -- it so we don't offer it again to THIS deposit.
  perform fill_unlock(f.id, 'cancelled');
  update deposit_requests
     set skipped_withdraws = array_append(coalesce(skipped_withdraws, '{}'), f.withdraw_id),
         status = 'matching'
   where id = d.id;

  -- Re-match to the next payee, or the club backstop. If neither exists,
  -- deposit_match raises and this whole swap rolls back — leaving the depositor on
  -- the tag they had (nothing lost), which the bot reports as "no other tag yet".
  perform deposit_match(d.id);

  select * into v_new from fills
   where deposit_id = d.id and status = 'locked'
   order by seq desc limit 1;
  return v_new;
end $$;
