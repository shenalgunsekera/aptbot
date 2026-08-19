-- ═══════════════════════════════════════════════════════════════════════════
-- 0086 — Cancelling the rest of a partially-PAID cash-out settles it (leaves pending)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- withdraw_player_cancel only marked a cash-out terminal when NOTHING had been
-- paid ("not exists a non-cancelled fill"). But if part was already PAID (a
-- released fill) and the player cancels the rest, amount_remaining hits 0 while a
-- released fill still exists — so that guard was false, nothing settled, and the
-- cash-out lingered in /pending and /payments forever.
--
-- Fix: once nothing is left to pay, settle it. Nothing paid → cancelled (as
-- before); part paid → the cash-out is DONE, so complete it via
-- withdraw_settle_if_done (which also notifies "cash-out complete"). Plus a sweep
-- so any path that leaves a resolved cash-out un-settled is cleaned up each tick.

create or replace function withdraw_player_cancel(
  p_withdraw_id uuid,
  p_amount      bigint,
  p_actor       uuid default null
) returns jsonb
language plpgsql as $$
declare
  w    withdraw_requests;
  cfg  config;
  c    bigint;
  cap  bigint;
  ord  loader_orders;
  step constant bigint := 500;
begin
  select * into w from withdraw_requests where id = p_withdraw_id for update;
  if not found then raise exception 'cash-out not found'; end if;
  if p_amount <= 0 then raise exception 'enter an amount above zero' using errcode = 'invalid_parameter_value'; end if;
  select * into cfg from config where id;

  -- ── Nothing taken off the table yet ──
  if w.status = 'pending_unload' then
    cap := w.requested_amount;
    c := least(p_amount, cap);
    perform withdraw_cancel_check_partial(c, cap, cfg.min_amount, step);
    if c >= cap then
      update loader_orders set status = 'cancelled', failure_reason = 'cancelled by player'
       where id = w.unload_order_id and status in ('pending', 'claimed');
      update withdraw_requests set status = 'cancelled', cancel_reason = 'cancelled by player',
             cancel_requested_at = now(), completed_at = now() where id = w.id;
      perform audit(p_actor, 'withdraw.cancel', 'withdraw_request', w.id, jsonb_build_object('stage', 'pending_unload', 'full', true, 'amount', c));
      return jsonb_build_object('scenario', 'pending_full', 'order_id', w.unload_order_id, 'full', true, 'cancelled', c);
    else
      update withdraw_requests set requested_amount = requested_amount - c where id = w.id;
      update loader_orders set delta = delta + c where id = w.unload_order_id;
      perform audit(p_actor, 'withdraw.reduce', 'withdraw_request', w.id, jsonb_build_object('stage', 'pending_unload', 'by', c));
      return jsonb_build_object('scenario', 'pending_partial', 'order_id', w.unload_order_id, 'full', false,
                                'cancelled', c, 'new_amount', w.requested_amount - c);
    end if;
  end if;

  -- ── Chips already off the table → refund escrow, raise a re-load ──
  if w.status in ('queued', 'partially_filled') then
    cap := w.amount_remaining;
    if cap <= 0 then
      raise exception 'that cash-out is already being paid — there is nothing left to cancel' using errcode = 'invalid_parameter_value';
    end if;
    c := least(p_amount, cap);
    perform withdraw_cancel_check_partial(c, cap, cfg.min_amount, step);

    perform withdraw_refund_escrow(w.id, c, 'withdraw.cancel_reload', p_actor, 'cancelled by player — awaiting re-load');
    update withdraw_requests
       set gross_amount = nullif(gross_amount - c, 0),
           amount = nullif(amount - c, 0),
           amount_remaining = amount_remaining - c
     where id = w.id returning * into w;

    if w.amount_remaining <= 0 then
      if not exists (select 1 from fills where withdraw_id = w.id and status <> 'cancelled') then
        -- Nothing was ever paid → the whole cash-out is cancelled.
        update withdraw_requests set status = 'cancelled', cancel_reason = 'cancelled by player',
               cancel_requested_at = now(), completed_at = now() where id = w.id;
      else
        -- Part was already paid (released) → the cash-out is DONE; settle it so it
        -- leaves /pending and /payments instead of lingering with nothing left.
        perform withdraw_settle_if_done(w.id);
      end if;
    end if;

    ord := loader_order_create(w.player_id, w.platform_id, c, w.currency,
             'withdraw.cancel_reload', 'withdraw_request', w.id, 'cancelled by player — re-load to their table');
    return jsonb_build_object('scenario', 'reload', 'order_id', ord.id, 'full', c >= cap, 'cancelled', c);
  end if;

  raise exception 'that cash-out can no longer be cancelled (it is %)', w.status using errcode = 'invalid_parameter_value';
end $$;

-- Belt-and-braces: settle any cash-out that has nothing left to pay and no open
-- work — regardless of which path left it that way. Idempotent; runs each tick.
create or replace function sweep_stuck_withdraws()
returns int
language plpgsql as $$
declare
  w       withdraw_requests;
  v_count int := 0;
begin
  for w in
    select * from withdraw_requests wr
     where wr.status in ('queued', 'partially_filled', 'filled')
       and coalesce(wr.amount_remaining, 0) <= 0
       and not exists (select 1 from fills f
                        where f.withdraw_id = wr.id
                          and f.status in ('locked', 'awaiting_confirmation', 'disputed'))
       and not exists (select 1 from loader_orders o
                        where o.ref_type = 'withdraw_request' and o.ref_id = wr.id
                          and o.reason = 'withdraw.topup' and o.status in ('pending', 'claimed'))
       for update skip locked
  loop
    perform withdraw_settle_if_done(w.id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

create or replace function sweep_all()
returns table(swept_locks integer, swept_holds integer, escalated integer)
language plpgsql as $$
begin
  swept_locks := sweep_expired_locks();
  swept_holds := sweep_holds();
  escalated   := sweep_escalations();
  perform sweep_orphaned_deposits();   -- deposits whose fills all resolved
  perform sweep_stuck_withdraws();      -- cash-outs with nothing left to pay
  return next;
end $$;
