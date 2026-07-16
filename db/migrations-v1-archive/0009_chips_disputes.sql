-- ═══════════════════════════════════════════════════════════════════════════
-- 0009 — Chip work-queue, owner backstop payouts, disputes, reversals
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Claim ──────────────────────────────────────────────────────────────────
-- Two admins tapping "claim" on the same order at the same instant: the
-- `where status = 'pending'` IS the mutex. Exactly one UPDATE matches a row;
-- the loser updates nothing and is told who beat them. No advisory lock, no
-- SELECT-then-UPDATE window.
create or replace function chip_order_claim(p_order_id uuid, p_admin uuid)
returns chip_orders
language plpgsql as $$
declare
  o chip_orders;
begin
  update chip_orders
     set status = 'claimed', claimed_by = p_admin, claimed_at = now()
   where id = p_order_id and status = 'pending'
  returning * into o;

  if not found then
    select * into o from chip_orders where id = p_order_id;
    if not found then
      raise exception 'chip order % not found', p_order_id;
    end if;
    raise exception 'chip order % is already % — claimed by %', o.id, o.status, o.claimed_by
      using errcode = 'invalid_parameter_value';
  end if;

  perform audit(p_admin, 'chip_order.claim', 'chip_order', o.id,
                jsonb_build_object('delta', o.delta, 'player_id', o.player_id));
  return o;
end $$;

create or replace function chip_order_release(p_order_id uuid, p_admin uuid)
returns chip_orders
language plpgsql as $$
declare
  o chip_orders;
begin
  update chip_orders
     set status = 'pending', claimed_by = null, claimed_at = null
   where id = p_order_id and status = 'claimed'
  returning * into o;

  if not found then
    raise exception 'chip order % is not claimed', p_order_id
      using errcode = 'invalid_parameter_value';
  end if;
  perform audit(p_admin, 'chip_order.release', 'chip_order', o.id, '{}'::jsonb);
  return o;
end $$;

-- ─── Complete ───────────────────────────────────────────────────────────────
-- The admin did the work inside ClubGG and is reporting back.
--
-- p_actual_delta lets them report what they could ACTUALLY do, which is not
-- always what was ordered — a player can gamble away chips between requesting a
-- withdrawal and an admin getting to the unload. Silently pretending the full
-- amount moved is how ledgers start lying.
create or replace function chip_order_complete(
  p_order_id      uuid,
  p_admin         uuid,
  p_actual_delta  bigint default null,
  p_proof_file_id text default null,
  p_note          text default null
) returns chip_orders
language plpgsql as $$
declare
  o        chip_orders;
  adm      admins;
  w        withdraw_requests;
  v_actual bigint;
  v_wallet bigint;
begin
  select * into adm from admins where id = p_admin and not disabled;
  if not found then
    raise exception 'admin % not found or disabled', p_admin
      using errcode = 'insufficient_privilege';
  end if;

  select * into o from chip_orders where id = p_order_id for update;
  if not found then
    raise exception 'chip order % not found', p_order_id;
  end if;
  if o.status <> 'claimed' then
    raise exception 'chip order % is % — claim it before completing it', o.id, o.status
      using errcode = 'invalid_parameter_value';
  end if;
  if o.claimed_by <> p_admin and adm.role <> 'owner' then
    raise exception 'chip order % is claimed by another admin', o.id
      using errcode = 'insufficient_privilege';
  end if;

  v_actual := coalesce(p_actual_delta, o.delta);

  if v_actual <> 0 and (v_actual < 0) <> (o.delta < 0) then
    raise exception 'actual delta % has the wrong sign for an order of %', v_actual, o.delta
      using errcode = 'invalid_parameter_value';
  end if;
  if abs(v_actual) > abs(o.delta) then
    raise exception 'actual delta % exceeds the ordered %', v_actual, o.delta
      using errcode = 'invalid_parameter_value';
  end if;

  update chip_orders
     set status = 'done', done_by = p_admin, done_at = now(),
         actual_delta = v_actual, proof_file_id = p_proof_file_id, note = p_note
   where id = o.id
  returning * into o;

  if o.delta < 0 then
    -- ── UNLOAD ── The chips are genuinely off the table now, so this is the
    -- moment the credit becomes real. Booking it any earlier would let a player
    -- withdraw against chips they were still sitting at a table with.
    if v_actual <> 0 then
      perform ledger_post(
        'chips.unload', 'chip_order', o.id, p_admin,
        format('unloaded %s chips to wallet', -v_actual),
        jsonb_build_array(
          jsonb_build_object('account_id', account_of('player_chips', o.player_id, o.currency),
                             'amount', v_actual),      -- negative: chips leave
          jsonb_build_object('account_id', account_of('player_wallet', o.player_id, o.currency),
                             'amount', -v_actual)      -- positive: credit arrives
        )
      );
    end if;

    -- This unload was funding a withdrawal. Now that the credit exists, escrow.
    if o.ref_type = 'withdraw_request' then
      select * into w from withdraw_requests where id = o.ref_id for update;
      if found and w.status = 'pending_unload' then
        v_wallet := balance_of('player_wallet', w.player_id, w.currency);
        if v_wallet >= w.gross_amount then
          perform withdraw_escrow(w.id);
        else
          -- Came up short. Cancel rather than quietly shrink the request: the
          -- player asked for a specific number and should decide what to do
          -- with a smaller one. The chips that DID come off stay in their wallet.
          perform withdraw_cancel(w.id, p_admin,
            format('chip unload came up short: %s available, %s requested', v_wallet, w.gross_amount));
          perform notify_player(w.player_id, 'withdraw.unload_short', 'withdraw_request', w.id,
            jsonb_build_object('available', v_wallet, 'requested', w.gross_amount));
        end if;
      end if;
    end if;
  else
    -- ── LOAD ── The ledger already credited these chips at fill release; this
    -- was the delivery. If only part could be loaded, we still owe the rest, so
    -- raise a follow-up order rather than let the shortfall become silent drift.
    if v_actual < o.delta then
      perform chip_order_create(
        o.player_id, o.delta - v_actual, o.currency,
        o.reason, o.ref_type, o.ref_id,
        format('remainder of order %s (%s of %s loaded)', o.id, v_actual, o.delta));
    end if;
  end if;

  perform audit(p_admin, 'chip_order.done', 'chip_order', o.id,
    jsonb_build_object('ordered', o.delta, 'actual', v_actual, 'player_id', o.player_id));
  perform notify_player(o.player_id,
    case when o.delta > 0 then 'chips.loaded' else 'chips.unloaded' end,
    'chip_order', o.id, jsonb_build_object('delta', v_actual, 'currency', o.currency));

  return o;
end $$;

-- ─── Fail ───────────────────────────────────────────────────────────────────
-- The admin could not do the work at all. No ledger entries: nothing happened.
create or replace function chip_order_fail(
  p_order_id uuid,
  p_admin    uuid,
  p_reason   text
) returns chip_orders
language plpgsql as $$
declare
  o chip_orders;
  w withdraw_requests;
begin
  select * into o from chip_orders where id = p_order_id for update;
  if not found then
    raise exception 'chip order % not found', p_order_id;
  end if;
  if o.status in ('done', 'cancelled', 'failed') then
    raise exception 'chip order % is already %', o.id, o.status
      using errcode = 'invalid_parameter_value';
  end if;

  update chip_orders
     set status = 'failed', failure_reason = p_reason, done_by = p_admin, done_at = now()
   where id = o.id
  returning * into o;

  -- A failed unload strands its withdrawal in pending_unload forever. Close it.
  if o.delta < 0 and o.ref_type = 'withdraw_request' then
    select * into w from withdraw_requests where id = o.ref_id;
    if found and w.status = 'pending_unload' then
      perform withdraw_cancel(w.id, p_admin, format('chip unload failed: %s', p_reason));
    end if;
  end if;

  -- A failed LOAD is worse: the ledger already says the player owns chips we
  -- did not deliver. Nobody's balance is wrong, but a human has to finish the
  -- job, so make sure a human is told.
  if o.delta > 0 then
    perform notify_admins('chip_order.load_failed', 'chip_order', o.id,
      jsonb_build_object('player_id', o.player_id, 'delta', o.delta, 'reason', p_reason));
  end if;

  perform audit(p_admin, 'chip_order.fail', 'chip_order', o.id,
                jsonb_build_object('reason', p_reason, 'delta', o.delta));
  return o;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Owner as counterparty
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Owner clears a withdrawal directly ─────────────────────────────────────
-- "Admins can manually pay out and close a withdrawal at any point (owner
-- clears it directly), recorded as an owner-sourced fill."
--
--   escrow:W     −amount     the withdrawer's claim is discharged
--   owner_float  +amount     the owner is out of pocket by that much cash
--
-- Symmetric to the backstop deposit, where owner_float goes the other way. The
-- two together are the union's float position.
create or replace function withdraw_owner_payout(
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
    raise exception 'withdrawal % not found', p_withdraw_id;
  end if;
  if w.status not in ('queued', 'partially_filled') then
    raise exception 'withdrawal % is % — only a queued withdrawal can be paid out directly', w.id, w.status
      using errcode = 'invalid_parameter_value';
  end if;

  v_amount := coalesce(p_amount, w.amount_remaining);
  if v_amount <= 0 then
    raise exception 'payout amount must be positive'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_amount > w.amount_remaining then
    raise exception 'withdrawal % only has % outstanding, cannot pay %',
      w.id, w.amount_remaining, v_amount
      using errcode = 'invalid_parameter_value';
  end if;

  select * into cfg from config where id;
  if cfg.owner_approval_threshold is not null
     and v_amount >= cfg.owner_approval_threshold
     and adm.role <> 'owner' then
    raise exception 'payouts of % or more need owner sign-off (this is %)',
      cfg.owner_approval_threshold, v_amount
      using errcode = 'insufficient_privilege';
  end if;

  -- An owner-sourced fill: withdraw side only, no depositor, no chips, no rake.
  insert into fills (
    deposit_id, withdraw_id, method_id, currency,
    amount, rake_amount, chips_amount, gross_to_send,
    payout_handle, status, lock_expires_at,
    payment_ref, proof_note, submitted_at,
    released_at, released_by, release_reason
  ) values (
    null, w.id, w.method_id, w.currency,
    v_amount, 0, 0, v_amount,
    w.payout_handle, 'released', now(),
    p_payment_ref, p_note, now(),
    now(), p_admin, 'owner_backstop_verified'
  ) returning * into f;

  perform ledger_post(
    'withdraw.owner_payout', 'fill', f.id, p_admin,
    format('owner paid %s directly to clear withdrawal', v_amount),
    jsonb_build_array(
      jsonb_build_object('account_id', account_of('player_escrow', w.player_id, w.currency),
                         'amount', -v_amount),
      jsonb_build_object('account_id', account_of('owner_float', null, w.currency),
                         'amount', v_amount)
    )
  );

  update withdraw_requests
     set amount_remaining = amount_remaining - v_amount,
         status = (case when amount_remaining - v_amount = 0 then 'filled' else 'partially_filled' end)::withdraw_status
   where id = w.id;

  perform audit(p_admin, 'withdraw.owner_payout', 'withdraw_request', w.id,
    jsonb_build_object('amount', v_amount, 'payment_ref', p_payment_ref, 'fill_id', f.id));
  perform notify_player(w.player_id, 'withdraw.paid_by_owner', 'withdraw_request', w.id,
    jsonb_build_object('amount', v_amount, 'currency', w.currency, 'payment_ref', p_payment_ref));

  perform withdraw_settle_if_done(w.id);
  return f;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Disputes
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Open ───────────────────────────────────────────────────────────────────
-- The withdrawer taps "didn't receive". FREEZES BOTH SIDES: no release, and the
-- escrow stays put. Nothing moves until a human rules.
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
    raise exception 'fill % not found', p_fill_id;
  end if;

  -- Only the withdrawer (the person claiming they weren't paid) or an admin.
  if p_player is not null then
    if f.withdraw_id is null then
      raise exception 'that payment went to the owner, not to you'
        using errcode = 'insufficient_privilege';
    end if;
    select * into w from withdraw_requests where id = f.withdraw_id;
    if w.player_id <> p_player then
      raise exception 'you are not party to this payment'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  if f.status <> 'awaiting_confirmation' then
    raise exception
      'fill % is % — only a payment awaiting confirmation can be disputed here (use fill_reversal for a released one)',
      f.id, f.status
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
    jsonb_build_object('fill_id', f.id, 'reason', p_reason,
                       'opened_by_player', p_player));
  return d;
end $$;

create or replace function dispute_add_evidence(
  p_dispute_id uuid,
  p_kind       text,       -- 'payment_ref' | 'screenshot' | 'note'
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
    raise exception 'dispute % not found or already resolved', p_dispute_id
      using errcode = 'invalid_parameter_value';
  end if;
  return d;
end $$;

-- ─── Resolve ────────────────────────────────────────────────────────────────
-- An admin has arbitrated, using the payment reference and timestamps as
-- primary evidence and screenshots as secondary.
--
-- Money ruling and risk ruling are independent: you can refund the victim AND
-- flag the scammer in one call, which is the most common real outcome.
create or replace function dispute_resolve(
  p_dispute_id uuid,
  p_admin      uuid,
  p_resolution text,
  p_note       text default null,
  p_split_to_depositor  bigint default null,
  p_flag_depositor      boolean default false,
  p_flag_withdrawer     boolean default false
) returns disputes
language plpgsql as $$
declare
  d   disputes;
  f   fills;
  dep deposit_requests;
  w   withdraw_requests;
  adm admins;
  cfg config;
  v_to_depositor bigint;
  v_to_withdrawer bigint;
begin
  select * into adm from admins where id = p_admin and not disabled;
  if not found then
    raise exception 'admin % not found or disabled', p_admin
      using errcode = 'insufficient_privilege';
  end if;

  select * into d from disputes where id = p_dispute_id for update;
  if not found then
    raise exception 'dispute % not found', p_dispute_id;
  end if;
  if d.status <> 'open' then
    raise exception 'dispute % is already resolved', d.id
      using errcode = 'invalid_parameter_value';
  end if;

  select * into f from fills where id = d.fill_id for update;

  select * into cfg from config where id;
  if cfg.owner_approval_threshold is not null
     and f.amount >= cfg.owner_approval_threshold
     and adm.role <> 'owner' then
    raise exception 'disputes of % or more need owner sign-off (this is %)',
      cfg.owner_approval_threshold, f.amount
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
  if p_flag_withdrawer and w.player_id is not null then
    perform flag_player(w.player_id, 'dispute_ruling',
      format('flagged resolving dispute %s: %s', d.id, coalesce(p_note, p_resolution)), p_admin);
  end if;

  -- Close the dispute BEFORE moving any money. fill_release refuses to touch a
  -- fill with an open dispute — deliberately, it is the last line of defence
  -- against releasing frozen money — and this call is exactly the moment that
  -- dispute stops being open. Recording the ruling first is also the honest
  -- ordering: the decision is made, the bookkeeping follows. If the money
  -- ruling below raises, the whole transaction rolls back and the dispute is
  -- open again, so there is no window where it is resolved but unsettled.
  update disputes
     set status = 'resolved', resolution = p_resolution, resolution_note = p_note,
         split_to_depositor = case when p_resolution = 'split' then p_split_to_depositor end,
         flagged_depositor = p_flag_depositor, flagged_withdrawer = p_flag_withdrawer,
         resolved_by = p_admin, resolved_at = now()
   where id = d.id
  returning * into d;

  -- Money ruling.
  if p_resolution = 'release_to_depositor' then
    -- The payment was real. Unfreeze and run the normal release path so the
    -- chips, the chip order and the ledger all happen exactly as they would have.
    update fills set status = 'awaiting_confirmation' where id = f.id;
    perform fill_release(f.id, 'dispute_resolution', p_admin);

  elsif p_resolution = 'refund_to_withdrawer' then
    -- The money never landed. Nothing was ever released, so there is nothing to
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
      raise exception 'split_to_depositor must be between 0 and % (the fill amount)', f.amount
        using errcode = 'invalid_parameter_value';
    end if;
    v_to_withdrawer := f.amount - v_to_depositor;

    -- No rake on a split: the house does not take a cut of a mess it is
    -- arbitrating. The escrow already holds the full amount, so we take the
    -- depositor's share out of it and return the rest to the queue.
    if v_to_depositor > 0 then
      if f.withdraw_id is null then
        perform ledger_post(
          'dispute.split', 'fill', f.id, p_admin,
          format('split ruling: %s to depositor as chips', v_to_depositor),
          jsonb_build_array(
            jsonb_build_object('account_id', account_of('owner_float', null, f.currency),
                               'amount', -v_to_depositor),
            jsonb_build_object('account_id', account_of('player_chips', dep.player_id, f.currency),
                               'amount', v_to_depositor)
          )
        );
      else
        perform ledger_post(
          'dispute.split', 'fill', f.id, p_admin,
          format('split ruling: %s to depositor as chips, %s back to withdrawer',
                 v_to_depositor, v_to_withdrawer),
          jsonb_build_array(
            jsonb_build_object('account_id', account_of('player_escrow', w.player_id, f.currency),
                               'amount', -v_to_depositor),
            jsonb_build_object('account_id', account_of('player_chips', dep.player_id, f.currency),
                               'amount', v_to_depositor)
          )
        );
      end if;

      perform chip_order_create(dep.player_id, v_to_depositor, f.currency,
                                'dispute.split', 'fill', f.id);
    end if;

    update fills
       set status = 'released', released_at = now(), released_by = p_admin,
           release_reason = 'dispute_resolution'
     where id = f.id;

    if f.withdraw_id is not null and v_to_withdrawer > 0 then
      perform withdraw_return_slice(f.withdraw_id, v_to_withdrawer, 'dispute split');
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
                       'flagged_withdrawer', p_flag_withdrawer, 'note', p_note));

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
-- "If a reversible payment is reversed after release, book the loss and
-- flag/freeze the depositor."
--
-- The chips are already on the table and may already be gambled away. The
-- withdrawer is owed again and it is not their fault. So the union eats it:
--
--   house_loss   −amount     the union is out this much
--   escrow:W     +amount     the withdrawer's claim is restored, and their
--                            slice goes back in the queue
--
-- Note this is precisely why the ledger forbids negative player balances. The
-- tempting entry is to claw the chips back by driving chips:D negative — but
-- that would be recording a debt the player never agreed to and may never pay,
-- dressed up as an asset. Booking it as a loss is the truth. If the depositor
-- still has chips and the owner wants them back, that is a separate, explicit
-- admin_adjust — a decision, not an accounting side-effect.
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
    raise exception 'fill % not found', p_fill_id;
  end if;
  if f.status <> 'released' then
    raise exception 'fill % is % — only a released fill can be reversed', f.id, f.status
      using errcode = 'invalid_parameter_value';
  end if;
  if f.deposit_id is null then
    raise exception 'fill % is an owner payout — there is no depositor to reverse', f.id
      using errcode = 'invalid_parameter_value';
  end if;

  select * into dep from deposit_requests where id = f.deposit_id;

  if f.withdraw_id is null then
    -- Backstop: the owner took the cash and it has now been pulled back out of
    -- the owner's account. The owner is short, not a withdrawer.
    perform ledger_post(
      'fill.reversal', 'fill', f.id, p_admin,
      format('reversal of backstop deposit: %s', p_reason),
      jsonb_build_array(
        jsonb_build_object('account_id', account_of('house_loss', null, f.currency),
                           'amount', -f.amount),
        jsonb_build_object('account_id', account_of('owner_float', null, f.currency),
                           'amount', f.amount)
      )
    );
  else
    select * into w from withdraw_requests where id = f.withdraw_id for update;
    perform ledger_post(
      'fill.reversal', 'fill', f.id, p_admin,
      format('reversal after release: %s', p_reason),
      jsonb_build_array(
        jsonb_build_object('account_id', account_of('house_loss', null, f.currency),
                           'amount', -f.amount),
        jsonb_build_object('account_id', account_of('player_escrow', w.player_id, f.currency),
                           'amount', f.amount)
      )
    );
    perform withdraw_return_slice(f.withdraw_id, f.amount, 'payment reversed');
  end if;

  perform flag_player(dep.player_id, 'payment_reversed',
    format('payment reversed after release on fill %s: %s', f.id, p_reason), p_admin);

  if p_freeze_depositor then
    update players set status = 'frozen' where id = dep.player_id and status = 'active';
  end if;

  perform audit(p_admin, 'fill.reversal', 'fill', f.id,
    jsonb_build_object('amount', f.amount, 'reason', p_reason,
                       'payment_ref', f.payment_ref,
                       'froze_depositor', p_freeze_depositor,
                       'depositor', dep.player_id));

  perform notify_admins('fill.reversed', 'fill', f.id,
    jsonb_build_object('amount', f.amount, 'currency', f.currency, 'reason', p_reason));

  return f;
end $$;

-- ─── Manual adjustment ──────────────────────────────────────────────────────
-- The escape hatch, and deliberately a narrow one. Every correction the other
-- functions cannot express goes through here: clawbacks, goodwill credits,
-- fixing a mis-keyed load. Always two-sided, always against a house account,
-- always attributed, always audited.
create or replace function admin_adjust(
  p_player_id uuid,
  p_kind      account_kind,     -- player_chips | player_wallet
  p_amount    bigint,           -- signed
  p_currency  char(3),
  p_admin     uuid,
  p_reason    text
) returns uuid
language plpgsql as $$
declare
  adm   admins;
  v_tx  uuid;
begin
  select * into adm from admins where id = p_admin and not disabled;
  if not found or adm.role <> 'owner' then
    raise exception 'manual adjustments require the owner'
      using errcode = 'insufficient_privilege';
  end if;
  if p_kind not in ('player_chips', 'player_wallet') then
    raise exception 'admin_adjust only targets a player wallet or chip balance';
  end if;
  if p_amount = 0 then
    raise exception 'adjustment must be non-zero';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'adjustments require a reason';
  end if;

  -- The contra side is house_loss: an adjustment that creates value for a
  -- player costs the house, and one that claws value back recovers it. That
  -- keeps every manual correction visible in the P&L instead of vanishing.
  v_tx := ledger_post(
    'admin.adjust', 'player', p_player_id, p_admin, p_reason,
    jsonb_build_array(
      jsonb_build_object('account_id', account_of(p_kind, p_player_id, p_currency),
                         'amount', p_amount),
      jsonb_build_object('account_id', account_of('house_loss', null, p_currency),
                         'amount', -p_amount)
    )
  );

  -- A chip adjustment is a promise about the ClubGG table; queue the real work.
  if p_kind = 'player_chips' then
    perform chip_order_create(p_player_id, p_amount, p_currency,
                              'admin.adjust', 'ledger_transaction', v_tx, p_reason);
  end if;

  perform audit(p_admin, 'admin.adjust', 'player', p_player_id,
    jsonb_build_object('kind', p_kind, 'amount', p_amount,
                       'currency', p_currency, 'reason', p_reason, 'tx_id', v_tx));
  return v_tx;
end $$;
