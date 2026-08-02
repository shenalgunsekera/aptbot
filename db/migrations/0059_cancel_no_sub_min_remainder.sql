-- ═══════════════════════════════════════════════════════════════════════════
-- 0059 — A partial cancel may not strand a remainder below the minimum
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A partial cash-out cancel that leaves LESS than the minimum (config.min_amount,
-- $20) still owed creates a tiny leftover that no depositor can match and an admin
-- must hand-pay. Disallow it: the player must either cancel the WHOLE cash-out
-- (remainder 0) or leave at least the minimum. Full cancels are always allowed.
--
-- Only change vs 0055: load config and add the sub-minimum guard in both branches.
create or replace function withdraw_player_cancel(
  p_withdraw_id uuid,
  p_amount      bigint,   -- how much to take back; >= cancellable means "full"
  p_actor       uuid default null
) returns jsonb
language plpgsql as $$
declare
  w   withdraw_requests;
  cfg config;
  c   bigint;
  cap bigint;
  ord loader_orders;
begin
  select * into w from withdraw_requests where id = p_withdraw_id for update;
  if not found then raise exception 'cash-out not found'; end if;
  if p_amount <= 0 then raise exception 'enter an amount above zero' using errcode = 'invalid_parameter_value'; end if;
  select * into cfg from config where id;

  -- ── Nothing taken off the table yet ──
  if w.status = 'pending_unload' then
    cap := w.requested_amount;
    c := least(p_amount, cap);
    -- A partial that would leave a sub-minimum sliver is not allowed.
    if c < cap and (cap - c) < cfg.min_amount then
      raise exception 'that would leave % still waiting, below the % minimum — cancel the whole cash-out, or leave at least %',
        '$' || to_char((cap - c) / 100.0, 'FM999999990.00'),
        '$' || to_char(cfg.min_amount / 100.0, 'FM999999990.00'),
        '$' || to_char(cfg.min_amount / 100.0, 'FM999999990.00')
        using errcode = 'invalid_parameter_value';
    end if;
    if c >= cap then
      update loader_orders set status = 'cancelled', failure_reason = 'cancelled by player'
       where id = w.unload_order_id and status in ('pending', 'claimed');
      update withdraw_requests set status = 'cancelled', cancel_reason = 'cancelled by player',
             cancel_requested_at = now(), completed_at = now() where id = w.id;
      perform audit(p_actor, 'withdraw.cancel', 'withdraw_request', w.id, jsonb_build_object('stage', 'pending_unload', 'full', true, 'amount', c));
      return jsonb_build_object('scenario', 'pending_full', 'order_id', w.unload_order_id, 'full', true, 'cancelled', c);
    else
      update withdraw_requests set requested_amount = requested_amount - c where id = w.id;
      update loader_orders set delta = delta + c where id = w.unload_order_id;   -- delta<0; +c ⇒ take off less
      perform audit(p_actor, 'withdraw.reduce', 'withdraw_request', w.id, jsonb_build_object('stage', 'pending_unload', 'by', c));
      return jsonb_build_object('scenario', 'pending_partial', 'order_id', w.unload_order_id, 'full', false,
                                'cancelled', c, 'new_amount', w.requested_amount - c);
    end if;
  end if;

  -- ── Chips already off the table → refund escrow, raise a re-load ──
  if w.status in ('queued', 'partially_filled') then
    cap := w.amount_remaining;   -- only the un-matched part can be pulled back
    if cap <= 0 then
      raise exception 'that cash-out is already being paid — there is nothing left to cancel' using errcode = 'invalid_parameter_value';
    end if;
    c := least(p_amount, cap);
    -- A partial that would leave a sub-minimum sliver is not allowed.
    if c < cap and (cap - c) < cfg.min_amount then
      raise exception 'that would leave % still waiting, below the % minimum — cancel the whole cash-out, or leave at least %',
        '$' || to_char((cap - c) / 100.0, 'FM999999990.00'),
        '$' || to_char(cfg.min_amount / 100.0, 'FM999999990.00'),
        '$' || to_char(cfg.min_amount / 100.0, 'FM999999990.00')
        using errcode = 'invalid_parameter_value';
    end if;

    perform withdraw_refund_escrow(w.id, c, 'withdraw.cancel_reload', p_actor, 'cancelled by player — awaiting re-load');
    update withdraw_requests
       set gross_amount = gross_amount - c, amount = amount - c, amount_remaining = amount_remaining - c
     where id = w.id returning * into w;

    -- Fully drained and never matched → it's a cancellation, close it now.
    if w.amount_remaining <= 0
       and not exists (select 1 from fills where withdraw_id = w.id and status <> 'cancelled') then
      update withdraw_requests set status = 'cancelled', cancel_reason = 'cancelled by player',
             cancel_requested_at = now(), completed_at = now() where id = w.id;
    end if;

    -- Actionable re-load job; the player is confirmed only when it's done.
    ord := loader_order_create(w.player_id, w.platform_id, c, w.currency,
             'withdraw.cancel_reload', 'withdraw_request', w.id, 'cancelled by player — re-load to their table');
    return jsonb_build_object('scenario', 'reload', 'order_id', ord.id, 'full', c >= cap, 'cancelled', c);
  end if;

  raise exception 'that cash-out can no longer be cancelled (it is %)', w.status using errcode = 'invalid_parameter_value';
end $$;
