-- ═══════════════════════════════════════════════════════════════════════════
-- 0009 — Loader work, club payouts, disputes, reversals, adjustments
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Claim ──────────────────────────────────────────────────────────────────
-- Two loaders tapping "claim" on the same order at the same instant: the
-- `where status = 'pending'` IS the mutex. Exactly one UPDATE matches a row; the
-- loser updates nothing and is told who beat them. No advisory lock, no
-- SELECT-then-UPDATE window.
create or replace function loader_order_claim(p_order_id uuid, p_admin uuid)
returns loader_orders
language plpgsql as $$
declare
  o loader_orders;
begin
  update loader_orders
     set status = 'claimed', claimed_by = p_admin, claimed_at = now()
   where id = p_order_id and status = 'pending'
  returning * into o;

  if not found then
    select * into o from loader_orders where id = p_order_id;
    if not found then
      raise exception 'that job no longer exists';
    end if;
    raise exception 'already taken by someone else (%)', o.status
      using errcode = 'invalid_parameter_value';
  end if;

  perform audit(p_admin, 'loader.claim', 'loader_order', o.id,
                jsonb_build_object('delta', o.delta, 'player_name', o.player_name));
  return o;
end $$;

create or replace function loader_order_release(p_order_id uuid, p_admin uuid)
returns loader_orders
language plpgsql as $$
declare
  o loader_orders;
begin
  update loader_orders
     set status = 'pending', claimed_by = null, claimed_at = null
   where id = p_order_id and status = 'claimed'
  returning * into o;
  if not found then
    raise exception 'that job is not currently taken'
      using errcode = 'invalid_parameter_value';
  end if;
  perform audit(p_admin, 'loader.release', 'loader_order', o.id, '{}'::jsonb);
  return o;
end $$;

-- ─── Complete ───────────────────────────────────────────────────────────────
-- The loader did the work and is reporting back.
--
-- p_actual is the whole point of v2. The system asked for an amount; the loader
-- reports what ACTUALLY moved, which is often less — a player can gamble value
-- away between requesting a cash out and a loader reaching it. Everything
-- downstream derives from this number, never from the request.
create or replace function loader_order_complete(
  p_order_id     uuid,
  p_admin        uuid,
  p_actual_delta bigint default null,
  p_note         text default null
) returns loader_orders
language plpgsql as $$
declare
  o        loader_orders;
  adm      admins;
  w        withdraw_requests;
  v_actual bigint;
begin
  select * into adm from admins where id = p_admin and not disabled;
  if not found then
    raise exception 'admin % not found or disabled', p_admin
      using errcode = 'insufficient_privilege';
  end if;

  select * into o from loader_orders where id = p_order_id for update;
  if not found then
    raise exception 'that job no longer exists';
  end if;
  if o.status <> 'claimed' then
    raise exception 'take the job first (it is %)', o.status
      using errcode = 'invalid_parameter_value';
  end if;
  if o.claimed_by <> p_admin and adm.role <> 'owner' then
    raise exception 'someone else is working on that one'
      using errcode = 'insufficient_privilege';
  end if;

  v_actual := coalesce(p_actual_delta, o.delta);

  if v_actual <> 0 and (v_actual < 0) <> (o.delta < 0) then
    raise exception 'that amount goes the wrong way for this job'
      using errcode = 'invalid_parameter_value';
  end if;
  if abs(v_actual) > abs(o.delta) then
    raise exception 'that is more than the job asked for (% vs %)', v_actual, o.delta
      using errcode = 'invalid_parameter_value';
  end if;

  update loader_orders
     set status = 'done', done_by = p_admin, done_at = now(),
         actual_delta = v_actual, note = p_note
   where id = o.id
  returning * into o;

  if o.delta < 0 then
    -- ── TAKING VALUE OFF ── This is the moment it actually left the table, so
    -- this is the moment the ledger may book it. Booking earlier would let a
    -- player cash out against value still in play.
    if o.ref_type = 'withdraw_request' then
      select * into w from withdraw_requests where id = o.ref_id for update;
      if found and w.status = 'pending_unload' then
        if v_actual = 0 then
          perform withdraw_cancel(w.id, p_admin, 'nothing was available to take off');
          perform notify_player(w.player_id, 'withdraw.nothing_available',
            'withdraw_request', w.id, jsonb_build_object('requested', w.requested_amount));
        else
          -- THE V2 HEART: escrow exactly what came off, not what was asked for.
          -- A short unload is not an error — it is the truth, and the player
          -- gets a cash out for what they actually had.
          perform withdraw_escrow(w.id, -v_actual);
        end if;
      end if;
    else
      -- A standalone take-off (admin correction): value leaves the tables and
      -- becomes credit the player can cash out later.
      perform ledger_post(
        'loader.unload', 'loader_order', o.id, p_admin,
        format('took %s off %s', -v_actual, o.platform_uid),
        jsonb_build_array(
          jsonb_build_object('account_id',
            account_of('house_settlement', null, o.platform_id, o.currency), 'amount', v_actual),
          jsonb_build_object('account_id',
            account_of('player_wallet', o.player_id, o.platform_id, o.currency), 'amount', -v_actual)
        ));
    end if;
  else
    -- ── PUTTING VALUE ON ── The ledger already booked this at fill release;
    -- this was the delivery. If only part could be delivered we still owe the
    -- rest, so raise a follow-up rather than let the shortfall become silent.
    if v_actual < o.delta then
      perform loader_order_create(
        o.player_id, o.platform_id, o.delta - v_actual, o.currency,
        o.reason, o.ref_type, o.ref_id,
        format('remainder of job %s (%s of %s done)', o.id, v_actual, o.delta));
    end if;
  end if;

  perform audit(p_admin, 'loader.done', 'loader_order', o.id,
    jsonb_build_object('asked', o.delta, 'actual', v_actual, 'player_name', o.player_name));
  perform notify_player(o.player_id,
    case when o.delta > 0 then 'value.added' else 'value.taken' end,
    'loader_order', o.id,
    jsonb_build_object('delta', v_actual, 'currency', o.currency));

  return o;
end $$;

-- ─── Fail ───────────────────────────────────────────────────────────────────
-- The loader could not do it at all. No ledger entries: nothing happened.
create or replace function loader_order_fail(
  p_order_id uuid,
  p_admin    uuid,
  p_reason   text
) returns loader_orders
language plpgsql as $$
declare
  o loader_orders;
  w withdraw_requests;
begin
  select * into o from loader_orders where id = p_order_id for update;
  if not found then
    raise exception 'that job no longer exists';
  end if;
  if o.status in ('done', 'cancelled', 'failed') then
    raise exception 'that job is already %', o.status
      using errcode = 'invalid_parameter_value';
  end if;

  update loader_orders
     set status = 'failed', failure_reason = p_reason, done_by = p_admin, done_at = now()
   where id = o.id
  returning * into o;

  -- A failed take-off strands its cash out in pending_unload forever. Close it.
  if o.delta < 0 and o.ref_type = 'withdraw_request' then
    select * into w from withdraw_requests where id = o.ref_id;
    if found and w.status = 'pending_unload' then
      perform withdraw_cancel(w.id, p_admin, format('could not take it off: %s', p_reason));
    end if;
  end if;

  -- A failed delivery is worse: the ledger already says the player is owed
  -- value we did not deliver. Nobody's balance is wrong, but a human has to
  -- finish the job — so make sure a human is told.
  if o.delta > 0 then
    perform notify_admins('loader.delivery_failed', 'loader_order', o.id,
      jsonb_build_object('player_name', o.player_name, 'platform_uid', o.platform_uid,
                         'delta', o.delta, 'reason', p_reason));
  end if;

  perform audit(p_admin, 'loader.fail', 'loader_order', o.id,
                jsonb_build_object('reason', p_reason, 'delta', o.delta));
  return o;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- The club as counterparty
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Club pays a withdrawal ─────────────────────────────────────────────────
-- The only payout path for `club` methods (every PayPal cash out), and available
-- on p2p methods when the owner would rather clear the queue than wait.
--
--   escrow:payee  −amount     the payee's claim is discharged
--   owner_float   +amount     the club is out of pocket by that much cash
--
-- Symmetric to a club-payee deposit, where owner_float goes the other way. The
-- two together are the union's float position.
create or replace function withdraw_club_payout(
  p_withdraw_id uuid,
  p_admin       uuid,
  p_amount      bigint default null,   -- null = clear the whole remainder
  p_payment_ref text default null,
  p_note        text default null
) returns fills
language plpgsql as $$
declare
  w        withdraw_requests;
  adm      admins;
  cfg      config;
  f        fills;
  v_amount bigint;
begin
  select * into adm from admins where id = p_admin and not disabled;
  if not found then
    raise exception 'admin % not found or disabled', p_admin
      using errcode = 'insufficient_privilege';
  end if;

  select * into w from withdraw_requests where id = p_withdraw_id for update;
  if not found then
    raise exception 'that cash out no longer exists';
  end if;
  if w.status not in ('queued', 'partially_filled') then
    raise exception 'that cash out is % — it is not waiting to be paid', w.status
      using errcode = 'invalid_parameter_value';
  end if;

  v_amount := coalesce(p_amount, w.amount_remaining);
  if v_amount <= 0 then
    raise exception 'amount must be positive'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_amount > w.amount_remaining then
    raise exception 'only % is still owed on that cash out', w.amount_remaining
      using errcode = 'invalid_parameter_value';
  end if;

  select * into cfg from config where id;
  if cfg.owner_approval_threshold is not null
     and v_amount >= cfg.owner_approval_threshold
     and adm.role <> 'owner' then
    raise exception 'payouts of % or more need the owner', cfg.owner_approval_threshold
      using errcode = 'insufficient_privilege';
  end if;

  -- A club-sourced fill: payee side only, no depositor, no credit, no rake.
  insert into fills (
    deposit_id, withdraw_id, method_id, currency,
    amount, rake_amount, credit_amount, gross_to_send,
    payout_handle, status, lock_expires_at,
    payment_ref, proof_note, submitted_at,
    released_at, released_by, release_reason
  ) values (
    null, w.id, w.method_id, w.currency,
    v_amount, 0, 0, v_amount,
    w.payout_handle, 'released', now(),
    p_payment_ref, p_note, now(),
    now(), p_admin, 'club_verified'
  ) returning * into f;

  perform ledger_post(
    'withdraw.club_payout', 'fill', f.id, p_admin,
    format('club paid %s directly', v_amount),
    jsonb_build_array(
      jsonb_build_object('account_id',
        account_of('player_escrow', w.player_id, w.platform_id, w.currency), 'amount', -v_amount),
      jsonb_build_object('account_id',
        account_of('owner_float', null, null, w.currency), 'amount', v_amount)
    ));

  update withdraw_requests
     set amount_remaining = amount_remaining - v_amount,
         status = (case when amount_remaining - v_amount = 0 then 'filled'
                        else 'partially_filled' end)::withdraw_status
   where id = w.id;

  perform audit(p_admin, 'withdraw.club_payout', 'withdraw_request', w.id,
    jsonb_build_object('amount', v_amount, 'payment_ref', p_payment_ref, 'fill_id', f.id));
  perform notify_player(w.player_id, 'withdraw.paid', 'withdraw_request', w.id,
    jsonb_build_object('amount', v_amount, 'currency', w.currency, 'payment_ref', p_payment_ref));

  perform withdraw_settle_if_done(w.id);
  return f;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Disputes
-- ═══════════════════════════════════════════════════════════════════════════

-- FREEZES BOTH SIDES: no release, and the escrow stays put. Nothing moves until
-- a human rules.
create or replace function dispute_open(
  p_fill_id  uuid,
  p_reason   text,
  p_player   uuid default null,
  p_admin    uuid default null,
  p_evidence jsonb default '[]'::jsonb
) returns disputes
language plpgsql as $$
declare
  f fills;
  w withdraw_requests;
  d disputes;
begin
  if p_player is null and p_admin is null then
    raise exception 'dispute_open: a dispute must be opened by someone';
  end if;

  select * into f from fills where id = p_fill_id for update;
  if not found then
    raise exception 'that payment no longer exists';
  end if;

  -- Only the payee (the person saying they weren't paid) or an admin.
  if p_player is not null then
    if f.withdraw_id is null then
      raise exception 'that payment went to the club, not to you'
        using errcode = 'insufficient_privilege';
    end if;
    select * into w from withdraw_requests where id = f.withdraw_id;
    if w.player_id <> p_player then
      raise exception 'you are not part of this payment'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  if f.status <> 'awaiting_confirmation' then
    raise exception 'that payment is % — it can''t be disputed here', f.status
      using errcode = 'invalid_parameter_value';
  end if;

  insert into disputes (fill_id, opened_by_player, opened_by_admin, reason, evidence)
  values (f.id, p_player, p_admin, p_reason, coalesce(p_evidence, '[]'::jsonb))
  returning * into d;

  update fills set status = 'disputed' where id = f.id;

  perform notify_admins('dispute.opened', 'dispute', d.id,
    jsonb_build_object('fill_id', f.id, 'amount', f.amount, 'currency', f.currency,
                       'payment_ref', f.payment_ref, 'reason', p_reason));
  perform audit(p_admin, 'dispute.open', 'dispute', d.id,
    jsonb_build_object('fill_id', f.id, 'reason', p_reason, 'opened_by_player', p_player));
  return d;
end $$;

create or replace function dispute_add_evidence(
  p_dispute_id uuid,
  p_kind       text,
  p_value      text,
  p_player     uuid default null,
  p_admin      uuid default null
) returns disputes
language plpgsql as $$
declare
  d disputes;
begin
  update disputes
     set evidence = evidence || jsonb_build_object(
           'kind', p_kind, 'value', p_value, 'at', now(),
           'by_player', p_player, 'by_admin', p_admin)
   where id = p_dispute_id and status = 'open'
  returning * into d;
  if not found then
    raise exception 'that dispute is closed or gone'
      using errcode = 'invalid_parameter_value';
  end if;
  return d;
end $$;

-- ─── Resolve ────────────────────────────────────────────────────────────────
-- Money ruling and risk ruling are independent: you can refund the victim AND
-- flag the scammer in one call, which is the most common real outcome.
create or replace function dispute_resolve(
  p_dispute_id uuid,
  p_admin      uuid,
  p_resolution text,
  p_note       text default null,
  p_split_to_depositor bigint default null,
  p_flag_depositor     boolean default false,
  p_flag_payee         boolean default false
) returns disputes
language plpgsql as $$
declare
  d   disputes;
  f   fills;
  dep deposit_requests;
  w   withdraw_requests;
  adm admins;
  cfg config;
  v_to_depositor  bigint;
  v_to_payee      bigint;
begin
  select * into adm from admins where id = p_admin and not disabled;
  if not found then
    raise exception 'admin % not found or disabled', p_admin
      using errcode = 'insufficient_privilege';
  end if;

  select * into d from disputes where id = p_dispute_id for update;
  if not found then
    raise exception 'that dispute no longer exists';
  end if;
  if d.status <> 'open' then
    raise exception 'that dispute is already resolved'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into f from fills where id = d.fill_id for update;

  select * into cfg from config where id;
  if cfg.owner_approval_threshold is not null
     and f.amount >= cfg.owner_approval_threshold
     and adm.role <> 'owner' then
    raise exception 'disputes of % or more need the owner', cfg.owner_approval_threshold
      using errcode = 'insufficient_privilege';
  end if;

  if f.deposit_id is not null then
    select * into dep from deposit_requests where id = f.deposit_id;
  end if;
  if f.withdraw_id is not null then
    select * into w from withdraw_requests where id = f.withdraw_id for update;
  end if;

  -- Risk ruling first: it applies regardless of where the money lands.
  if p_flag_depositor and dep.player_id is not null then
    perform flag_player(dep.player_id, 'dispute_ruling',
      format('flagged resolving dispute %s: %s', d.id, coalesce(p_note, p_resolution)), p_admin);
  end if;
  if p_flag_payee and w.player_id is not null then
    perform flag_player(w.player_id, 'dispute_ruling',
      format('flagged resolving dispute %s: %s', d.id, coalesce(p_note, p_resolution)), p_admin);
  end if;

  -- Close the dispute BEFORE moving money. fill_release refuses to touch a fill
  -- with an open dispute — deliberately, it is the last line of defence against
  -- releasing frozen money — and this call is the moment that dispute stops
  -- being open. If the ruling below raises, the whole transaction rolls back and
  -- the dispute is open again, so there is no window where it is resolved but
  -- unsettled.
  update disputes
     set status = 'resolved', resolution = p_resolution, resolution_note = p_note,
         split_to_depositor = case when p_resolution = 'split' then p_split_to_depositor end,
         flagged_depositor = p_flag_depositor, flagged_payee = p_flag_payee,
         resolved_by = p_admin, resolved_at = now()
   where id = d.id
  returning * into d;

  if p_resolution = 'release_to_depositor' then
    -- The payment was real. Unfreeze and run the normal release path so the
    -- credit, the loader job and the ledger all happen exactly as they would.
    update fills set status = 'awaiting_confirmation' where id = f.id;
    perform fill_release(f.id, 'dispute_resolution', p_admin);

  elsif p_resolution = 'refund_to_payee' then
    -- The money never landed. Nothing was released, so there is nothing to
    -- reverse — the escrow never left. The slice simply goes back.
    update fills set status = 'refunded' where id = f.id;
    if f.withdraw_id is not null then
      perform withdraw_return_slice(f.withdraw_id, f.amount, 'dispute refund');
    end if;
    if f.deposit_id is not null then
      perform deposit_settle_if_done(f.deposit_id);
    end if;

  elsif p_resolution = 'split' then
    v_to_depositor := p_split_to_depositor;
    if v_to_depositor is null or v_to_depositor < 0 or v_to_depositor > f.amount then
      raise exception 'the split must be between 0 and %', f.amount
        using errcode = 'invalid_parameter_value';
    end if;
    v_to_payee := f.amount - v_to_depositor;

    -- No rake on a split: the house does not take a cut of a mess it is
    -- arbitrating. The escrow already holds the full amount, so we take the
    -- depositor's share out of it and return the rest to the queue.
    if v_to_depositor > 0 then
      if f.withdraw_id is null then
        perform ledger_post(
          'dispute.split', 'fill', f.id, p_admin,
          format('split: %s to the depositor', v_to_depositor),
          jsonb_build_array(
            jsonb_build_object('account_id',
              account_of('owner_float', null, null, f.currency), 'amount', -v_to_depositor),
            jsonb_build_object('account_id',
              account_of('house_settlement', null, dep.platform_id, f.currency), 'amount', v_to_depositor)
          ));
      else
        perform ledger_post(
          'dispute.split', 'fill', f.id, p_admin,
          format('split: %s to the depositor, %s back to the payee', v_to_depositor, v_to_payee),
          jsonb_build_array(
            jsonb_build_object('account_id',
              account_of('player_escrow', w.player_id, w.platform_id, f.currency), 'amount', -v_to_depositor),
            jsonb_build_object('account_id',
              account_of('house_settlement', null, dep.platform_id, f.currency), 'amount', v_to_depositor)
          ));
      end if;

      perform loader_order_create(dep.player_id, dep.platform_id, v_to_depositor,
                                  f.currency, 'dispute.split', 'fill', f.id);
    end if;

    update fills
       set status = 'released', released_at = now(), released_by = p_admin,
           release_reason = 'dispute_resolution'
     where id = f.id;

    if f.withdraw_id is not null and v_to_payee > 0 then
      perform withdraw_return_slice(f.withdraw_id, v_to_payee, 'dispute split');
    end if;
    if f.deposit_id is not null then
      perform deposit_settle_if_done(f.deposit_id);
    end if;
    if f.withdraw_id is not null then
      perform withdraw_settle_if_done(f.withdraw_id);
    end if;

  else
    raise exception 'unknown resolution %', p_resolution
      using errcode = 'invalid_parameter_value';
  end if;

  perform audit(p_admin, 'dispute.resolve', 'dispute', d.id,
    jsonb_build_object('fill_id', f.id, 'resolution', p_resolution,
                       'split_to_depositor', p_split_to_depositor,
                       'flagged_depositor', p_flag_depositor,
                       'flagged_payee', p_flag_payee, 'note', p_note));

  if dep.player_id is not null then
    perform notify_player(dep.player_id, 'dispute.resolved', 'dispute', d.id,
      jsonb_build_object('resolution', p_resolution, 'fill_id', f.id));
  end if;
  if w.player_id is not null then
    perform notify_player(w.player_id, 'dispute.resolved', 'dispute', d.id,
      jsonb_build_object('resolution', p_resolution, 'fill_id', f.id));
  end if;

  return d;
end $$;

-- ─── Post-release reversal ──────────────────────────────────────────────────
-- A reversible payment was reversed after release. The value is already on the
-- tables and may already be gambled away; the payee is owed again and it is not
-- their fault. So the union eats it:
--
--   house_loss   −amount     the union is out this much
--   escrow:payee +amount     their claim is restored and re-queued
--
-- This is precisely why the ledger forbids negative player balances. The
-- tempting entry is to claw the credit back by driving an account negative — but
-- that records a debt the player never agreed to and may never pay, dressed up
-- as an asset. Booking it as a loss is the truth.
create or replace function fill_reversal(
  p_fill_id uuid,
  p_admin   uuid,
  p_reason  text,
  p_freeze_depositor boolean default true
) returns fills
language plpgsql as $$
declare
  f   fills;
  dep deposit_requests;
  w   withdraw_requests;
begin
  select * into f from fills where id = p_fill_id for update;
  if not found then
    raise exception 'that payment no longer exists';
  end if;
  if f.status <> 'released' then
    raise exception 'fill % is % — only a released fill can be reversed', f.id, f.status
      using errcode = 'invalid_parameter_value';
  end if;
  if f.deposit_id is null then
    raise exception 'fill % is a club payout — there is no depositor to reverse', f.id
      using errcode = 'invalid_parameter_value';
  end if;

  select * into dep from deposit_requests where id = f.deposit_id;

  if f.withdraw_id is null then
    -- Club-payee: the club took the cash and it has now been pulled back out of
    -- the club's account. The club is short, not a player.
    perform ledger_post(
      'fill.reversal', 'fill', f.id, p_admin,
      format('reversal of a club-received payment: %s', p_reason),
      jsonb_build_array(
        jsonb_build_object('account_id',
          account_of('house_loss', null, null, f.currency), 'amount', -f.amount),
        jsonb_build_object('account_id',
          account_of('owner_float', null, null, f.currency), 'amount', f.amount)
      ));
  else
    select * into w from withdraw_requests where id = f.withdraw_id for update;
    perform ledger_post(
      'fill.reversal', 'fill', f.id, p_admin,
      format('reversal after release: %s', p_reason),
      jsonb_build_array(
        jsonb_build_object('account_id',
          account_of('house_loss', null, null, f.currency), 'amount', -f.amount),
        jsonb_build_object('account_id',
          account_of('player_escrow', w.player_id, w.platform_id, f.currency), 'amount', f.amount)
      ));
    perform withdraw_return_slice(f.withdraw_id, f.amount, 'payment reversed');
  end if;

  perform flag_player(dep.player_id, 'payment_reversed',
    format('payment reversed after release on fill %s: %s', f.id, p_reason), p_admin);

  if p_freeze_depositor then
    update players set status = 'frozen' where id = dep.player_id and status = 'active';
  end if;

  perform audit(p_admin, 'fill.reversal', 'fill', f.id,
    jsonb_build_object('amount', f.amount, 'reason', p_reason,
                       'payment_ref', f.payment_ref, 'froze_depositor', p_freeze_depositor,
                       'depositor', dep.player_id));
  perform notify_admins('fill.reversed', 'fill', f.id,
    jsonb_build_object('amount', f.amount, 'currency', f.currency, 'reason', p_reason));
  return f;
end $$;

-- ─── Manual adjustment ──────────────────────────────────────────────────────
-- The escape hatch, and deliberately a narrow one. Every correction the other
-- functions cannot express goes through here: clawbacks, goodwill, fixing a
-- mis-keyed job. Always two-sided, always against a house account, always
-- attributed, always audited. Owner only.
create or replace function admin_adjust(
  p_player_id   uuid,
  p_platform_id uuid,
  p_amount      bigint,           -- signed
  p_currency    char(3),
  p_admin       uuid,
  p_reason      text
) returns uuid
language plpgsql as $$
declare
  adm  admins;
  v_tx uuid;
begin
  select * into adm from admins where id = p_admin and not disabled;
  if not found or adm.role <> 'owner' then
    raise exception 'manual adjustments require the owner'
      using errcode = 'insufficient_privilege';
  end if;
  if p_amount = 0 then
    raise exception 'adjustment must be non-zero';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'adjustments require a reason';
  end if;

  -- The contra is house_loss: an adjustment that creates value for a player
  -- costs the house, and one that claws value back recovers it. That keeps every
  -- manual correction visible in the P&L instead of vanishing.
  v_tx := ledger_post(
    'admin.adjust', 'player', p_player_id, p_admin, p_reason,
    jsonb_build_array(
      jsonb_build_object('account_id',
        account_of('player_wallet', p_player_id, p_platform_id, p_currency), 'amount', p_amount),
      jsonb_build_object('account_id',
        account_of('house_loss', null, null, p_currency), 'amount', -p_amount)
    ));

  perform audit(p_admin, 'admin.adjust', 'player', p_player_id,
    jsonb_build_object('amount', p_amount, 'platform_id', p_platform_id,
                       'currency', p_currency, 'reason', p_reason, 'tx_id', v_tx));
  return v_tx;
end $$;
