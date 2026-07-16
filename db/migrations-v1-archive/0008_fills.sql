-- ═══════════════════════════════════════════════════════════════════════════
-- 0008 — Fill lifecycle: lock → proof → confirm → hold → release
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Unlock ─────────────────────────────────────────────────────────────────
-- A locked slice stops being claimed. Only reachable from 'locked': once money
-- has actually been sent, the depositor has no unilateral exit and the dispute
-- path takes over.
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
    raise exception 'fill % is % — only a locked fill can be unlocked', f.id, f.status
      using errcode = 'invalid_parameter_value';
  end if;

  -- Backstop fills hold no queue slice, so there is nothing to give back.
  if f.withdraw_id is not null then
    perform withdraw_return_slice(f.withdraw_id, f.amount, p_status::text);
  end if;

  update fills set status = p_status where id = f.id returning * into f;
  return f;
end $$;

-- ─── Submit proof ───────────────────────────────────────────────────────────
-- The depositor has paid out-of-band and is presenting evidence.
--
-- The payment reference is the PRIMARY evidence and is mandatory; the
-- screenshot is secondary and optional. A transaction ID can be checked against
-- the processor by an admin. A screenshot is a picture, and pictures are
-- trivially forged — so the system will not accept one as the only claim that
-- money moved.
create or replace function fill_submit_proof(
  p_fill_id       uuid,
  p_payment_ref   text,
  p_proof_file_id text default null,
  p_note          text default null
) returns fills
language plpgsql as $$
declare
  f     fills;
  d     deposit_requests;
  w     withdraw_requests;
  v_open int;
begin
  select * into f from fills where id = p_fill_id for update;
  if not found then
    raise exception 'fill % not found', p_fill_id;
  end if;

  -- Deliberately accepts a fill whose lock_expires_at has passed but which the
  -- sweeper has not yet collected. While status is still 'locked' the slice is
  -- genuinely still reserved for this depositor, so honouring a payment that
  -- landed a second late is both correct and race-free: whichever of the two
  -- transactions gets the row lock first wins, and there is no window where
  -- both a sweep and a submit succeed.
  if f.status <> 'locked' then
    if f.status = 'expired' then
      raise exception
        'this slice timed out and has returned to the queue — start a new deposit before paying'
        using errcode = 'invalid_parameter_value';
    end if;
    raise exception 'fill % is % — proof can only be submitted against a locked slice', f.id, f.status
      using errcode = 'invalid_parameter_value';
  end if;

  if coalesce(trim(p_payment_ref), '') = '' then
    raise exception 'a payment reference / transaction ID is required'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into d from deposit_requests where id = f.deposit_id for update;

  update fills
     set status       = 'awaiting_confirmation',
         payment_ref  = trim(p_payment_ref),
         proof_file_id = p_proof_file_id,
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
    -- Owner backstop: there is no counterparty player to ask. An admin must
    -- verify the money landed in the owner's account.
    perform notify_admins('fill.backstop_review', 'fill', f.id,
      jsonb_build_object('amount', f.amount, 'currency', f.currency,
                         'payment_ref', f.payment_ref, 'method_id', f.method_id));
  else
    select * into w from withdraw_requests where id = f.withdraw_id;
    perform notify_player(w.player_id, 'fill.confirm_request', 'fill', f.id,
      jsonb_build_object('amount', f.amount, 'currency', f.currency,
                         'payment_ref', f.payment_ref,
                         'proof_file_id', f.proof_file_id,
                         'hold_until', f.hold_until));
  end if;

  return f;
end $$;

-- ─── Release ────────────────────────────────────────────────────────────────
-- THE MONEY MOVE. Chips are issued to the depositor and the counterparty's
-- claim is discharged.
--
-- Two shapes, and the difference is the whole architecture of this system:
--
--   MATCHED (withdraw_id set) — real cash went depositor→withdrawer entirely
--   outside this system. So the ledger records no cash at all: the withdrawer's
--   escrow simply BECOMES the depositor's chips.
--       escrow:W  −amount
--       chips:D   +chips
--       rake      +rake
--
--   BACKSTOP (withdraw_id null) — no withdrawal existed, so the owner took the
--   cash and is now holding it. This is the only path where real money crosses
--   our perimeter, and owner_float is exactly that fact.
--       owner_float  −amount        (owner is holding this much real cash)
--       chips:D      +chips
--       rake         +rake
--
-- Both sum to zero because chips = amount − rake. Money is moved, never made.
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
  -- already covers it (dispute_open flips status to 'disputed'), but this is
  -- the single most expensive mistake in the system, so it gets a second lock.
  if exists (select 1 from disputes where fill_id = f.id and status = 'open') then
    raise exception 'fill % has an open dispute and is frozen', f.id
      using errcode = 'invalid_parameter_value';
  end if;

  select * into d from deposit_requests where id = f.deposit_id for update;

  if f.withdraw_id is null then
    v_entries := jsonb_build_array(
      jsonb_build_object('account_id', account_of('owner_float', null, f.currency),
                         'amount', -f.amount),
      jsonb_build_object('account_id', account_of('player_chips', d.player_id, f.currency),
                         'amount', f.chips_amount),
      jsonb_build_object('account_id', account_of('house_rake', null, f.currency),
                         'amount', f.rake_amount)
    );
  else
    select * into w from withdraw_requests where id = f.withdraw_id for update;
    v_entries := jsonb_build_array(
      jsonb_build_object('account_id', account_of('player_escrow', w.player_id, f.currency),
                         'amount', -f.amount),
      jsonb_build_object('account_id', account_of('player_chips', d.player_id, f.currency),
                         'amount', f.chips_amount),
      jsonb_build_object('account_id', account_of('house_rake', null, f.currency),
                         'amount', f.rake_amount)
    );
  end if;

  perform ledger_post(
    'fill.release', 'fill', f.id, p_admin,
    format('release %s to depositor as %s chips (rake %s, via %s)',
           f.amount, f.chips_amount, f.rake_amount, p_reason),
    v_entries
  );

  update fills
     set status = 'released', released_at = now(),
         released_by = p_admin, release_reason = p_reason
   where id = f.id
  returning * into f;

  -- Physical work order: actually put the chips on the ClubGG table. The ledger
  -- already says we owe them; this is the delivery.
  perform chip_order_create(d.player_id, f.chips_amount, f.currency,
                            'fill.release', 'fill', f.id);

  perform notify_player(d.player_id, 'fill.released', 'fill', f.id,
    jsonb_build_object('chips', f.chips_amount, 'currency', f.currency, 'reason', p_reason));
  if f.withdraw_id is not null then
    perform notify_player(w.player_id, 'fill.settled', 'fill', f.id,
      jsonb_build_object('amount', f.amount, 'currency', f.currency));
  end if;

  perform audit(p_admin, 'fill.release', 'fill', f.id,
    jsonb_build_object('reason', p_reason, 'amount', f.amount,
                       'chips', f.chips_amount, 'rake', f.rake_amount,
                       'payment_ref', f.payment_ref, 'backstop', f.withdraw_id is null));

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
   where deposit_id = d.id
     and status in ('locked', 'awaiting_confirmation', 'disputed');

  if v_open > 0 then
    return d;
  end if;

  -- Every slice resolved. If none actually released, this deposit died rather
  -- than completed — say so honestly instead of marking it 'completed'.
  if exists (select 1 from fills where deposit_id = d.id and status = 'released') then
    update deposit_requests set status = 'completed', completed_at = now()
     where id = d.id returning * into d;
  else
    update deposit_requests set status = 'expired', completed_at = now()
     where id = d.id returning * into d;
  end if;

  return d;
end $$;

-- ─── Withdrawer confirms receipt ────────────────────────────────────────────
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
    raise exception 'this payment is % and cannot be confirmed', f.status
      using errcode = 'invalid_parameter_value';
  end if;
  if f.withdraw_id is null then
    raise exception 'fill % is an owner backstop — only an admin can verify it', f.id
      using errcode = 'insufficient_privilege';
  end if;

  select * into w from withdraw_requests where id = f.withdraw_id;
  if w.player_id <> p_player_id then
    raise exception 'you are not the recipient of this payment'
      using errcode = 'insufficient_privilege';
  end if;

  update fills set withdrawer_confirmed_at = now() where id = f.id returning * into f;

  perform audit(null, 'fill.withdrawer_confirmed', 'fill', f.id,
    jsonb_build_object('player_id', p_player_id, 'payment_ref', f.payment_ref));

  if f.hold_until is null or f.hold_until <= now() then
    return fill_release(f.id, 'withdrawer_confirmed', null);
  end if;

  -- Held. sweep_holds() will release it when the hold runs out.
  perform notify_player(w.player_id, 'fill.confirmed_pending_hold', 'fill', f.id,
    jsonb_build_object('hold_until', f.hold_until));
  return f;
end $$;

-- ─── Admin fast-path ────────────────────────────────────────────────────────
-- Path 2 of 3. An admin who has verified the payment reference against the
-- processor confirms on the withdrawer's behalf — and MAY override the hold,
-- because a human who has looked at the actual transaction knows more than the
-- clock does. Always attributed to the admin who did it.
create or replace function fill_fast_path(
  p_fill_id uuid,
  p_admin   uuid,
  p_note    text default null
) returns fills
language plpgsql as $$
declare
  f   fills;
  cfg config;
  adm admins;
  w   withdraw_requests;
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
    raise exception 'fill % is % — cannot fast-path', f.id, f.status
      using errcode = 'invalid_parameter_value';
  end if;

  -- Owner sign-off threshold: above it, a plain admin may not act alone.
  select * into cfg from config where id;
  if cfg.owner_approval_threshold is not null
     and f.amount >= cfg.owner_approval_threshold
     and adm.role <> 'owner' then
    raise exception
      'fills of % or more need owner sign-off (this is %)', cfg.owner_approval_threshold, f.amount
      using errcode = 'insufficient_privilege';
  end if;

  perform audit(p_admin, 'fill.fast_path_confirm', 'fill', f.id,
    jsonb_build_object('note', p_note, 'payment_ref', f.payment_ref,
                       'amount', f.amount, 'hold_overridden', f.hold_until is not null and f.hold_until > now()));

  return fill_release(
    f.id,
    case when f.withdraw_id is null then 'owner_backstop_verified' else 'admin_fast_path' end,
    p_admin
  );
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Sweepers — the clock as an actor. Run these on a schedule (see 0011).
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Expired locks ──────────────────────────────────────────────────────────
-- A depositor took a handle and never paid. Give the slice back to the queue —
-- at its original FIFO position, so the withdrawer loses nothing but time.
--
-- SKIP LOCKED so two sweeper instances can run concurrently without fighting,
-- and so one wedged row cannot stall the whole sweep.
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

-- ─── Holds ──────────────────────────────────────────────────────────────────
-- Path 3 of 3. A reversible fill has sat out its hold. Three outcomes:
--
--   confirmed by withdrawer  → release. They said it arrived and the chargeback
--                              window has now closed. This is the happy path.
--   not confirmed, auto-release ON  → release. Owner policy: silence means
--                              consent once the money is unclawbackable.
--   not confirmed, auto-release OFF → escalate to an admin. Do NOT release, and
--                              do NOT stall silently.
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
       and hold_until is not null
       and hold_until <= now()
     order by hold_until
       for update skip locked
  loop
    if exists (select 1 from disputes where fill_id = f.id and status = 'open') then
      continue;   -- frozen; an admin owns this now
    end if;

    if f.withdrawer_confirmed_at is not null then
      perform fill_release(f.id, 'withdrawer_confirmed', null);
      v_count := v_count + 1;
    elsif cfg.auto_release_on_expiry then
      perform fill_release(f.id, 'hold_expiry', null);
      v_count := v_count + 1;
    elsif f.escalated_at is null then
      update fills set escalated_at = now() where id = f.id;
      perform notify_admins('fill.hold_expired_needs_review', 'fill', f.id,
        jsonb_build_object('amount', f.amount, 'currency', f.currency,
                           'payment_ref', f.payment_ref));
      perform audit(null, 'fill.escalated', 'fill', f.id,
        jsonb_build_object('cause', 'hold expired with no confirmation and auto-release off'));
    end if;
  end loop;

  return v_count;
end $$;

-- ─── Unresponsive withdrawers ───────────────────────────────────────────────
-- The spec's explicit requirement: if the withdrawer is offline, has blocked
-- the bot, or simply never answers, the fill must escalate to admin review
-- rather than stall forever with the depositor's money in limbo.
--
-- Covers irreversible fills (no hold to expire, so sweep_holds never sees them)
-- and backstop fills nobody picked up.
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
       and withdrawer_confirmed_at is null
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

    perform notify_admins('fill.unanswered_needs_review', 'fill', f.id,
      jsonb_build_object('amount', f.amount, 'currency', f.currency,
                         'payment_ref', f.payment_ref,
                         'notification_failed', v_undelivered,
                         'waiting_since', f.submitted_at));

    perform audit(null, 'fill.escalated', 'fill', f.id,
      jsonb_build_object('cause', case when v_undelivered
                                       then 'withdrawer unreachable (notification failed)'
                                       else 'withdrawer did not respond in window' end,
                         'submitted_at', f.submitted_at));
    v_count := v_count + 1;
  end loop;

  return v_count;
end $$;

-- Convenience: everything the scheduler needs to call, in the right order.
create or replace function sweep_all()
returns table (swept_locks int, swept_holds int, escalated int)
language plpgsql as $$
begin
  swept_locks := sweep_expired_locks();
  swept_holds := sweep_holds();
  escalated   := sweep_escalations();
  return next;
end $$;
