-- ═══════════════════════════════════════════════════════════════════════════
-- 0061 — Partial cash-out cancels must be ≥ $5 and in multiples of $5
-- ═══════════════════════════════════════════════════════════════════════════
--
-- On top of the "don't strand a sub-$20 remainder" rule (0059), a PARTIAL cancel
-- amount must be at least $5 and a whole multiple of $5 ($5, $10, $15, …). A FULL
-- cancel (taking the whole remaining amount) is always allowed, whatever the odd
-- cents. The player is told exactly why if they enter something else.
--
-- Only change vs 0059: the partial-cancel guard now checks the $5 step too.
create or replace function withdraw_player_cancel(
  p_withdraw_id uuid,
  p_amount      bigint,   -- how much to take back; >= cancellable means "full"
  p_actor       uuid default null
) returns jsonb
language plpgsql as $$
declare
  w    withdraw_requests;
  cfg  config;
  c    bigint;
  cap  bigint;
  ord  loader_orders;
  step constant bigint := 500;   -- $5 cancel granularity
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
       set gross_amount = gross_amount - c, amount = amount - c, amount_remaining = amount_remaining - c
     where id = w.id returning * into w;

    if w.amount_remaining <= 0
       and not exists (select 1 from fills where withdraw_id = w.id and status <> 'cancelled') then
      update withdraw_requests set status = 'cancelled', cancel_reason = 'cancelled by player',
             cancel_requested_at = now(), completed_at = now() where id = w.id;
    end if;

    ord := loader_order_create(w.player_id, w.platform_id, c, w.currency,
             'withdraw.cancel_reload', 'withdraw_request', w.id, 'cancelled by player — re-load to their table');
    return jsonb_build_object('scenario', 'reload', 'order_id', ord.id, 'full', c >= cap, 'cancelled', c);
  end if;

  raise exception 'that cash-out can no longer be cancelled (it is %)', w.status using errcode = 'invalid_parameter_value';
end $$;

-- Shared guard for a PARTIAL cancel (c < cap): enforce the $5 step/minimum and the
-- "no sub-minimum remainder" rule. Full cancels (c >= cap) pass through untouched.
create or replace function withdraw_cancel_check_partial(
  c bigint, cap bigint, p_min bigint, p_step bigint
) returns void
language plpgsql as $$
begin
  if c >= cap then return; end if;   -- full cancel: no constraints
  if c < p_step or (c % p_step) <> 0 then
    raise exception 'you can only cancel in multiples of % (minimum %) — cancel the whole cash-out to take it all',
      '$' || to_char(p_step / 100.0, 'FM999999990.00'),
      '$' || to_char(p_step / 100.0, 'FM999999990.00')
      using errcode = 'invalid_parameter_value';
  end if;
  if (cap - c) < p_min then
    raise exception 'that would leave % still waiting, below the % minimum — cancel the whole cash-out, or leave at least %',
      '$' || to_char((cap - c) / 100.0, 'FM999999990.00'),
      '$' || to_char(p_min / 100.0, 'FM999999990.00'),
      '$' || to_char(p_min / 100.0, 'FM999999990.00')
      using errcode = 'invalid_parameter_value';
  end if;
end $$;
