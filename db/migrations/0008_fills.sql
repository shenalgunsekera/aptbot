-- ═══════════════════════════════════════════════════════════════════════════
-- 0008 — Fill lifecycle: lock → proof → confirm → hold → release
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Unlock ─────────────────────────────────────────────────────────────────
-- A locked slice stops being claimed. Only reachable from 'locked': once money
-- has been sent, the payer has no unilateral exit and disputes take over.
create or replace function fill_unlock(p_fill_id uuid, p_status fill_status)
returns fills
language plpgsql as $$
declare
  f fills;
begin
  if p_status not in ('expired', 'cancelled') then
    raise exception 'fill_unlock: % is not an unlock status', p_status;
  end if;

  select * into f from fills where id = p_fill_id for update;
  if not found then
    raise exception 'fill % not found', p_fill_id;
  end if;
  if f.status <> 'locked' then
    raise exception 'fill % is % — only a locked slice can be unlocked', f.id, f.status
      using errcode = 'invalid_parameter_value';
  end if;

  -- A club-payee fill holds no queue slice, so there is nothing to give back.
  if f.withdraw_id is not null then
    perform withdraw_return_slice(f.withdraw_id, f.amount, p_status::text);
  end if;

  update fills set status = p_status where id = f.id returning * into f;
  return f;
end $$;

-- ─── Submit proof ───────────────────────────────────────────────────────────
-- The payer has sent money out-of-band and is presenting evidence.
--
-- The payment reference is PRIMARY and mandatory; a receipt image is secondary
-- and attached separately (see receipt_add). A transaction id can be checked
-- against the processor. A picture is trivially forged — so the system will not
-- accept one as the only claim that money moved.
create or replace function fill_submit_proof(
  p_fill_id     uuid,
  p_payment_ref text,
  p_note        text default null
) returns fills
language plpgsql as $$
declare
  f      fills;
  d      deposit_requests;
  w      withdraw_requests;
  m      payment_methods;
  v_open int;
begin
  select * into f from fills where id = p_fill_id for update;
  if not found then
    raise exception 'fill % not found', p_fill_id;
  end if;

  -- Deliberately accepts a fill whose lock_expires_at has passed but which the
  -- sweeper has not yet collected. While status is still 'locked' the slice is
  -- genuinely still reserved for this payer, so honouring a payment that landed
  -- a second late is both correct and race-free: whichever transaction takes the
  -- row lock first wins, and there is no window where both a sweep and a submit
  -- succeed.
  if f.status <> 'locked' then
    if f.status = 'expired' then
      raise exception
        'that ran out of time and went back in the queue — please start a new add before sending anything'
        using errcode = 'invalid_parameter_value';
    end if;
    raise exception 'fill % is % — proof only applies to a locked slice', f.id, f.status
      using errcode = 'invalid_parameter_value';
  end if;

  if coalesce(trim(p_payment_ref), '') = '' then
    raise exception 'we need the transaction ID from your payment'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into d from deposit_requests where id = f.deposit_id for update;
  select * into m from payment_methods where id = f.method_id;

  update fills
     set status       = 'awaiting_confirmation',
         payment_ref  = trim(p_payment_ref),
         proof_note   = p_note,
         submitted_at = now(),
         hold_until   = hold_deadline(f.method_id)
   where id = f.id
  returning * into f;

  -- Move the parent deposit on only once every slice has evidence against it.
  select count(*) into v_open from fills where deposit_id = d.id and status = 'locked';
  if v_open = 0 then
    update deposit_requests set status = 'awaiting_confirmation' where id = d.id;
  end if;

  if f.withdraw_id is null then
    -- The club is the payee: there is no counterparty player to ask, so an
    -- admin verifies the money landed in the club's account. This is EVERY
    -- PayPal deposit, by design.
    perform notify_admins('fill.club_review', 'fill', f.id,
      jsonb_build_object('amount', f.amount, 'currency', f.currency,
                         'payment_ref', f.payment_ref, 'method', m.name));
  else
    select * into w from withdraw_requests where id = f.withdraw_id;
    perform notify_player(w.player_id, 'fill.confirm_request', 'fill', f.id,
      jsonb_build_object('amount', f.amount, 'currency', f.currency,
                         'payment_ref', f.payment_ref, 'method', m.name,
                         'hold_until', f.hold_until));
  end if;

  return f;
end $$;

-- ─── Release ────────────────────────────────────────────────────────────────
-- THE MONEY MOVE. Value is credited to the depositor and the payee's claim is
-- discharged.
--
-- Two shapes, and the difference is the whole architecture:
--
--   MATCHED (withdraw_id set) — real cash went payer→payee entirely outside this
--   system. So the ledger records no cash at all: the payee's escrow simply
--   BECOMES the depositor's credit.
--       escrow:payee   −amount
--       settlement     +credit      (value is going onto the tables)
--       rake           +rake
--
--   CLUB PAYEE (withdraw_id null) — the club took the cash and is holding it.
--   The only path where real money crosses our perimeter, which is exactly what
--   owner_float measures. Every PayPal deposit is this shape.
--       owner_float    −amount      (the club is holding this much cash)
--       settlement     +credit
--       rake           +rake
--
-- Both sum to zero because credit = amount − rake. Money is moved, never made.
--
-- Note `settlement` is credited, not a player wallet: v2 does not track what any
-- individual holds on a table. The loader_order raised below is the promise to
-- actually put it there.
create or replace function fill_release(
  p_fill_id uuid,
  p_reason  text,
  p_admin   uuid default null
) returns fills
language plpgsql as $$
declare
  f fills;
  d deposit_requests;
  w withdraw_requests;
  v_entries jsonb;
begin
  select * into f from fills where id = p_fill_id for update;
  if not found then
    raise exception 'fill % not found', p_fill_id;
  end if;
  if f.status <> 'awaiting_confirmation' then
    raise exception 'fill % is % — only a fill awaiting confirmation can be released', f.id, f.status
      using errcode = 'invalid_parameter_value';
  end if;

  -- Belt and braces: a disputed fill must never release. The status check above
  -- already covers it (dispute_open flips status), but this is the single most
  -- expensive mistake in the system, so it gets a second lock.
  if exists (select 1 from disputes where fill_id = f.id and status = 'open') then
    raise exception 'fill % has an open dispute and is frozen', f.id
      using errcode = 'invalid_parameter_value';
  end if;

  select * into d from deposit_requests where id = f.deposit_id for update;

  if f.withdraw_id is null then
    v_entries := jsonb_build_array(
      jsonb_build_object('account_id',
        account_of('owner_float', null, null, f.currency), 'amount', -f.amount),
      jsonb_build_object('account_id',
        account_of('house_settlement', null, d.platform_id, f.currency), 'amount', f.credit_amount),
      jsonb_build_object('account_id',
        account_of('house_rake', null, null, f.currency), 'amount', f.rake_amount)
    );
  else
    select * into w from withdraw_requests where id = f.withdraw_id for update;
    v_entries := jsonb_build_array(
      jsonb_build_object('account_id',
        account_of('player_escrow', w.player_id, w.platform_id, f.currency), 'amount', -f.amount),
      jsonb_build_object('account_id',
        account_of('house_settlement', null, d.platform_id, f.currency), 'amount', f.credit_amount),
      jsonb_build_object('account_id',
        account_of('house_rake', null, null, f.currency), 'amount', f.rake_amount)
    );
  end if;

  perform ledger_post(
    'fill.release', 'fill', f.id, p_admin,
    format('release %s as %s credit (fee %s, via %s)',
           f.amount, f.credit_amount, f.rake_amount, p_reason),
    v_entries);

  update fills
     set status = 'released', released_at = now(),
         released_by = p_admin, release_reason = p_reason
   where id = f.id
  returning * into f;

  -- The promise to actually put it on their account. The ledger already says we
  -- owe it; this is the delivery.
  perform loader_order_create(
    d.player_id, d.platform_id, f.credit_amount, f.currency,
    'fill.release', 'fill', f.id);

  perform notify_player(d.player_id, 'fill.released', 'fill', f.id,
    jsonb_build_object('credit', f.credit_amount, 'currency', f.currency));
  if f.withdraw_id is not null then
    perform notify_player(w.player_id, 'fill.settled', 'fill', f.id,
      jsonb_build_object('amount', f.amount, 'currency', f.currency));
  end if;

  perform audit(p_admin, 'fill.release', 'fill', f.id,
    jsonb_build_object('reason', p_reason, 'amount', f.amount,
                       'credit', f.credit_amount, 'rake', f.rake_amount,
                       'payment_ref', f.payment_ref, 'club_payee', f.withdraw_id is null));

  perform deposit_settle_if_done(d.id);
  if f.withdraw_id is not null then
    perform withdraw_settle_if_done(f.withdraw_id);
  end if;

  return f;
end $$;

-- ─── Settle a deposit ───────────────────────────────────────────────────────
create or replace function deposit_settle_if_done(p_deposit_id uuid)
returns deposit_requests
language plpgsql as $$
declare
  d      deposit_requests;
  v_open int;
begin
  select * into d from deposit_requests where id = p_deposit_id for update;
  if d.status in ('completed', 'cancelled', 'expired') then
    return d;
  end if;

  select count(*) into v_open
    from fills
   where deposit_id = d.id and status in ('locked', 'awaiting_confirmation', 'disputed');
  if v_open > 0 then
    return d;
  end if;

  -- Every slice resolved. If none released, this deposit died rather than
  -- completed — say so honestly instead of marking it 'completed'.
  if exists (select 1 from fills where deposit_id = d.id and status = 'released') then
    update deposit_requests set status = 'completed', completed_at = now()
     where id = d.id returning * into d;
  else
    update deposit_requests set status = 'expired', completed_at = now()
     where id = d.id returning * into d;
  end if;
  return d;
end $$;

-- ─── Payee confirms receipt ─────────────────────────────────────────────────
-- Path 1 of 3 to release.
--
-- On an irreversible method this releases immediately. On a reversible one it
-- only RECORDS the confirmation — the hold still has to run out, because the
-- sender can charge back long after the recipient truthfully says "it arrived".
-- Releasing on confirmation alone would make the hold decorative.
create or replace function fill_confirm(
  p_fill_id   uuid,
  p_player_id uuid
) returns fills
language plpgsql as $$
declare
  f fills;
  w withdraw_requests;
begin
  select * into f from fills where id = p_fill_id for update;
  if not found then
    raise exception 'fill % not found', p_fill_id;
  end if;
  if f.status <> 'awaiting_confirmation' then
    raise exception 'that payment is % and can''t be confirmed', f.status
      using errcode = 'invalid_parameter_value';
  end if;
  if f.withdraw_id is null then
    raise exception 'that payment went to the club — only an admin can verify it'
      using errcode = 'insufficient_privilege';
  end if;

  select * into w from withdraw_requests where id = f.withdraw_id;
  if w.player_id <> p_player_id then
    raise exception 'you are not the recipient of this payment'
      using errcode = 'insufficient_privilege';
  end if;

  update fills set payee_confirmed_at = now() where id = f.id returning * into f;

  perform audit(null, 'fill.payee_confirmed', 'fill', f.id,
    jsonb_build_object('player_id', p_player_id, 'payment_ref', f.payment_ref));

  if f.hold_until is null or f.hold_until <= now() then
    return fill_release(f.id, 'payee_confirmed', null);
  end if;

  perform notify_player(w.player_id, 'fill.confirmed_pending_hold', 'fill', f.id,
    jsonb_build_object('hold_until', f.hold_until));
  return f;
end $$;

-- ─── Admin verifies ─────────────────────────────────────────────────────────
-- Path 2 of 3. An admin who has checked the payment reference against the
-- processor confirms on the payee's behalf — and MAY override the hold, because
-- a human who has looked at the actual transaction knows more than the clock
-- does. Always attributed.
--
-- This is also the ONLY release path for club-payee fills, i.e. every PayPal
-- deposit: nobody else can see the club's account.
create or replace function fill_admin_verify(
  p_fill_id uuid,
  p_admin   uuid,
  p_note    text default null
) returns fills
language plpgsql as $$
declare
  f   fills;
  cfg config;
  adm admins;
begin
  select * into adm from admins where id = p_admin and not disabled;
  if not found then
    raise exception 'admin % not found or disabled', p_admin
      using errcode = 'insufficient_privilege';
  end if;

  select * into f from fills where id = p_fill_id for update;
  if not found then
    raise exception 'fill % not found', p_fill_id;
  end if;
  if f.status <> 'awaiting_confirmation' then
    raise exception 'fill % is % — cannot verify', f.id, f.status
      using errcode = 'invalid_parameter_value';
  end if;

  -- Owner sign-off threshold: above it, a plain admin may not act alone.
  select * into cfg from config where id;
  if cfg.owner_approval_threshold is not null
     and f.amount >= cfg.owner_approval_threshold
     and adm.role <> 'owner' then
    raise exception 'payments of % or more need the owner', cfg.owner_approval_threshold
      using errcode = 'insufficient_privilege';
  end if;

  perform audit(p_admin, 'fill.admin_verify', 'fill', f.id,
    jsonb_build_object('note', p_note, 'payment_ref', f.payment_ref, 'amount', f.amount,
                       'hold_overridden', f.hold_until is not null and f.hold_until > now()));

  return fill_release(
    f.id,
    case when f.withdraw_id is null then 'club_verified' else 'admin_verified' end,
    p_admin);
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Sweepers — the clock as an actor. Run on a schedule (Vercel Cron).
-- ═══════════════════════════════════════════════════════════════════════════

-- A payer took a counterparty and never paid. Give the slice back to the queue
-- at its original FIFO position, so the payee loses nothing but time.
--
-- SKIP LOCKED so several sweeper invocations can run concurrently without
-- fighting, and so one wedged row cannot stall the whole sweep.
create or replace function sweep_expired_locks()
returns int
language plpgsql as $$
declare
  f       fills;
  v_count int := 0;
begin
  for f in
    select * from fills
     where status = 'locked' and lock_expires_at <= now()
     order by lock_expires_at
       for update skip locked
  loop
    perform fill_unlock(f.id, 'expired');
    perform notify_player(
      (select player_id from deposit_requests where id = f.deposit_id),
      'fill.lock_expired', 'fill', f.id,
      jsonb_build_object('amount', f.amount, 'currency', f.currency));
    perform audit(null, 'fill.lock_expired', 'fill', f.id,
      jsonb_build_object('amount', f.amount, 'lock_expires_at', f.lock_expires_at));
    perform deposit_settle_if_done(f.deposit_id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- Path 3 of 3. A reversible fill has sat out its hold. Three outcomes:
--   confirmed by payee        → release. They said it arrived and the chargeback
--                               window has closed. The happy path.
--   unconfirmed, auto-release → release. Owner policy: silence means consent
--                               once the money is unclawbackable.
--   unconfirmed, no auto      → escalate. Do NOT release, do NOT stall silently.
create or replace function sweep_holds()
returns int
language plpgsql as $$
declare
  f       fills;
  cfg     config;
  v_count int := 0;
begin
  select * into cfg from config where id;

  for f in
    select * from fills
     where status = 'awaiting_confirmation'
       and hold_until is not null and hold_until <= now()
     order by hold_until
       for update skip locked
  loop
    if exists (select 1 from disputes where fill_id = f.id and status = 'open') then
      continue;   -- frozen; an admin owns this now
    end if;

    if f.payee_confirmed_at is not null then
      perform fill_release(f.id, 'payee_confirmed', null);
      v_count := v_count + 1;
    elsif cfg.auto_release_on_expiry then
      perform fill_release(f.id, 'hold_expiry', null);
      v_count := v_count + 1;
    elsif f.escalated_at is null then
      update fills set escalated_at = now() where id = f.id;
      perform notify_admins('fill.needs_review', 'fill', f.id,
        jsonb_build_object('amount', f.amount, 'currency', f.currency,
                           'payment_ref', f.payment_ref,
                           'cause', 'hold expired with no confirmation'));
      perform audit(null, 'fill.escalated', 'fill', f.id,
        jsonb_build_object('cause', 'hold expired with no confirmation and auto-release off'));
    end if;
  end loop;
  return v_count;
end $$;

-- If the payee is offline, has blocked the bot, or simply never answers, the
-- fill must escalate rather than stall forever with the payer's money in limbo.
--
-- Covers irreversible fills (no hold to expire, so sweep_holds never sees them)
-- and club-payee fills nobody picked up.
create or replace function sweep_escalations()
returns int
language plpgsql as $$
declare
  f       fills;
  cfg     config;
  v_count int := 0;
  v_undelivered boolean;
begin
  select * into cfg from config where id;

  for f in
    select * from fills
     where status = 'awaiting_confirmation'
       and escalated_at is null
       and payee_confirmed_at is null
       and submitted_at <= now() - make_interval(secs => cfg.confirm_escalation_seconds)
     order by submitted_at
       for update skip locked
  loop
    if exists (select 1 from disputes where fill_id = f.id and status = 'open') then
      continue;
    end if;

    -- Did we even manage to reach them? A failed notification is a materially
    -- different story for an admin than a delivered one that was ignored.
    select exists (
      select 1 from notifications
       where ref_type = 'fill' and ref_id = f.id
         and kind = 'fill.confirm_request' and status = 'failed'
    ) into v_undelivered;

    update fills set escalated_at = now() where id = f.id;

    perform notify_admins('fill.needs_review', 'fill', f.id,
      jsonb_build_object('amount', f.amount, 'currency', f.currency,
                         'payment_ref', f.payment_ref,
                         'notification_failed', v_undelivered,
                         'waiting_since', f.submitted_at,
                         'cause', case when v_undelivered then 'recipient unreachable'
                                       else 'recipient did not respond' end));
    perform audit(null, 'fill.escalated', 'fill', f.id,
      jsonb_build_object('cause', case when v_undelivered
                                       then 'payee unreachable (notification failed)'
                                       else 'payee did not respond in window' end,
                         'submitted_at', f.submitted_at));
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

-- Everything the scheduler needs, in the right order.
create or replace function sweep_all()
returns table (swept_locks int, swept_holds int, escalated int)
language plpgsql as $$
begin
  swept_locks := sweep_expired_locks();
  swept_holds := sweep_holds();
  escalated   := sweep_escalations();
  return next;
end $$;
