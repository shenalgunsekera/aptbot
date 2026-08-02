-- ═══════════════════════════════════════════════════════════════════════════
-- 0055 — Player-driven cash-out cancellation (full / partial) across states
-- ═══════════════════════════════════════════════════════════════════════════
--
-- One entry point the bot calls with "how much to cancel". Behaviour depends on
-- where the cash-out is:
--   pending_unload  — no chips off the table yet. Full → void the loader job +
--                     request. Partial → shrink the request + the take-off job.
--                     (The bot edits the Claim card in place.)
--   queued/part'ly  — chips are off the table (escrowed). Only the UN-MATCHED
--                     remaining part can be pulled. We refund that escrow and
--                     raise a RE-LOAD job; the player is confirmed only once an
--                     admin actually re-loads it (see the trigger below). Any
--                     matched slice keeps its place in the queue.
-- Rake is 0 here, so the cancelled amount == the escrow refunded == the re-load.
create or replace function withdraw_player_cancel(
  p_withdraw_id uuid,
  p_amount      bigint,   -- how much to take back; >= cancellable means "full"
  p_actor       uuid default null
) returns jsonb
language plpgsql as $$
declare
  w   withdraw_requests;
  c   bigint;
  cap bigint;
  ord loader_orders;
begin
  select * into w from withdraw_requests where id = p_withdraw_id for update;
  if not found then raise exception 'cash-out not found'; end if;
  if p_amount <= 0 then raise exception 'enter an amount above zero' using errcode = 'invalid_parameter_value'; end if;

  -- ── Nothing taken off the table yet ──
  if w.status = 'pending_unload' then
    cap := w.requested_amount;
    c := least(p_amount, cap);
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

-- When a cancel re-load job is completed, the refunded wallet credit goes back on
-- the table, and the player is told the cancellation is done. A trigger keeps the
-- big loader_order_complete function untouched. Partial re-loads (loader delivered
-- less) auto-raise a follow-up job inside loader_order_complete, which fires this
-- again for the rest — so it composes.
create or replace function loader_reload_on_done() returns trigger
language plpgsql as $$
begin
  if new.status = 'done' and old.status is distinct from 'done'::order_status
     and new.delta > 0 and new.ref_type = 'withdraw_request' and new.reason = 'withdraw.cancel_reload'
     and coalesce(new.actual_delta, 0) > 0 then
    perform ledger_post('withdraw.cancel_reload', 'loader_order', new.id, new.done_by,
      format('re-loaded %s to the table after cancel', new.actual_delta),
      jsonb_build_array(
        jsonb_build_object('account_id', account_of('player_wallet', new.player_id, new.platform_id, new.currency), 'amount', -new.actual_delta),
        jsonb_build_object('account_id', account_of('house_settlement', null, new.platform_id, new.currency), 'amount', new.actual_delta)));
    perform notify_player(new.player_id, 'withdraw.cancel_confirmed', 'withdraw_request', new.ref_id,
      jsonb_build_object('amount', new.actual_delta, 'currency', new.currency));
  end if;
  return new;
end $$;

drop trigger if exists loader_reload_done on loader_orders;
create trigger loader_reload_done after update on loader_orders
  for each row execute function loader_reload_on_done();
