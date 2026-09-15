-- ═══════════════════════════════════════════════════════════════════════════
-- 0116 — failing an abandoned /addtowithdraw add-on closes the cash-out at once
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A fully-paid cash-out stays "pending" while any withdraw.topup take-off is still
-- pending/claimed (settle refuses to close it). When an add-on is abandoned (the
-- player asked to add, loaders never worked it), an admin resolves it by marking
-- that take-off "Couldn't do it". But loader_order_fail only failed the order — it
-- didn't re-check the cash-out, so it kept showing pending until the next sweep.
--
-- Fix: after failing a withdraw.topup take-off, call withdraw_settle_if_done on
-- its cash-out. That helper only completes a cash-out that is genuinely finished
-- (nothing owed, no open fills, no OTHER add-on still pending), so this is safe —
-- it just closes it immediately instead of waiting for the cron. Manual as the
-- owner wanted: nothing is auto-expired; a human still chooses to fail the job.
-- Only the topup-settle line is added vs the live version.
create or replace function loader_order_fail(p_order_id uuid, p_admin uuid, p_reason text)
returns loader_orders
language plpgsql as $$
declare
  o loader_orders;
  w withdraw_requests;
begin
  select * into o from loader_orders where id = p_order_id for update;
  if not found then raise exception 'that job no longer exists'; end if;
  if o.status in ('done', 'cancelled', 'failed') then
    raise exception 'that job is already %', o.status using errcode = 'invalid_parameter_value';
  end if;

  update loader_orders
     set status = 'failed', failure_reason = p_reason, done_by = p_admin, done_at = now()
   where id = o.id returning * into o;

  -- A failed take-off strands its cash out in pending_unload forever. Close it.
  if o.delta < 0 and o.ref_type = 'withdraw_request' then
    select * into w from withdraw_requests where id = o.ref_id;
    if found and w.status = 'pending_unload' then
      perform withdraw_cancel(w.id, p_admin, format('could not take it off: %s', p_reason));
    end if;
  end if;

  -- A failed delivery / cancel re-load: the ledger already says the player is owed
  -- value we did not put on the table. Alert a human AND tell the player, with the
  -- admin's reason.
  if o.delta > 0 then
    perform notify_admins('loader.delivery_failed', 'loader_order', o.id,
      jsonb_build_object('player_name', o.player_name, 'platform_uid', o.platform_uid,
                         'delta', o.delta, 'reason', p_reason));
    perform notify_player(o.player_id, 'loader.failed_player', o.ref_type, o.ref_id,
      jsonb_build_object('delta', o.delta, 'currency', o.currency, 'reason', p_reason));
  end if;

  -- A failed add-on take-off was the only thing holding a paid cash-out open —
  -- settle it now (no-op unless it's genuinely finished).
  if o.reason = 'withdraw.topup' and o.ref_type = 'withdraw_request' then
    perform withdraw_settle_if_done(o.ref_id);
  end if;

  perform audit(p_admin, 'loader.fail', 'loader_order', o.id,
                jsonb_build_object('reason', p_reason, 'delta', o.delta));
  return o;
end $$;
