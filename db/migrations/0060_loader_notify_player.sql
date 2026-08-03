-- ═══════════════════════════════════════════════════════════════════════════
-- 0060 — Loader notifications: no double "taken off" line; tell the player on fail
-- ═══════════════════════════════════════════════════════════════════════════
--
-- (1) A cash-out unload already tells the player "<amount> in chips have been
--     claimed" (withdraw.queued, via withdraw_escrow). We were ALSO sending a
--     "<amount> taken off your table" line right after — two messages for one
--     event. Drop the second one for cash-out unloads; standalone admin take-offs
--     (a correction, no withdraw_request) still get their notice.
--
-- (2) When a loader job FAILS, the admin now types a reason (bot side), and for a
--     delivery / cancel re-load (delta > 0) the PLAYER is told what happened with
--     that reason — instead of only a cryptic admin "needs a human" card. The
--     money is safe in their wallet (the cancel already refunded escrow → wallet);
--     the re-load onto the table just hasn't happened yet.

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
    raise exception 'admin % not found or disabled', p_admin using errcode = 'insufficient_privilege';
  end if;

  select * into o from loader_orders where id = p_order_id for update;
  if not found then raise exception 'that job no longer exists'; end if;
  if o.status <> 'claimed' then
    raise exception 'take the job first (it is %)', o.status using errcode = 'invalid_parameter_value';
  end if;
  if o.claimed_by <> p_admin and adm.role <> 'owner' then
    raise exception 'someone else is working on that one' using errcode = 'insufficient_privilege';
  end if;

  v_actual := coalesce(p_actual_delta, o.delta);
  if v_actual <> 0 and (v_actual < 0) <> (o.delta < 0) then
    raise exception 'that amount goes the wrong way for this job' using errcode = 'invalid_parameter_value';
  end if;
  if abs(v_actual) > abs(o.delta) then
    raise exception 'that is more than the job asked for (% vs %)', v_actual, o.delta using errcode = 'invalid_parameter_value';
  end if;

  update loader_orders
     set status = 'done', done_by = p_admin, done_at = now(), actual_delta = v_actual, note = p_note
   where id = o.id returning * into o;

  if o.delta < 0 then
    if o.ref_type = 'withdraw_request' then
      select * into w from withdraw_requests where id = o.ref_id for update;
      if found and w.status = 'pending_unload' then
        if v_actual = 0 then
          perform withdraw_cancel(w.id, p_admin, 'nothing was available to take off');
          perform notify_player(w.player_id, 'withdraw.nothing_available',
            'withdraw_request', w.id, jsonb_build_object('requested', w.requested_amount));
        else
          perform withdraw_escrow(w.id, -v_actual);
        end if;
      end if;
    else
      perform ledger_post(
        'loader.unload', 'loader_order', o.id, p_admin,
        format('took %s off %s', -v_actual, o.platform_uid),
        jsonb_build_array(
          jsonb_build_object('account_id', account_of('house_settlement', null, o.platform_id, o.currency), 'amount', v_actual),
          jsonb_build_object('account_id', account_of('player_wallet', o.player_id, o.platform_id, o.currency), 'amount', -v_actual)
        ));
    end if;
  else
    if v_actual < o.delta then
      perform loader_order_create(
        o.player_id, o.platform_id, o.delta - v_actual, o.currency,
        o.reason, o.ref_type, o.ref_id,
        format('remainder of job %s (%s of %s done)', o.id, v_actual, o.delta));
    end if;
  end if;

  perform audit(p_admin, 'loader.done', 'loader_order', o.id,
    jsonb_build_object('asked', o.delta, 'actual', v_actual, 'player_name', o.player_name));

  -- Player notice. A cash-out unload is already announced as "chips claimed"
  -- (withdraw.queued), so don't send a second "taken off" line for it.
  if o.delta > 0 then
    perform notify_player(o.player_id, 'value.added', 'loader_order', o.id,
      jsonb_build_object('delta', v_actual, 'currency', o.currency));
  elsif o.ref_type is distinct from 'withdraw_request' then
    perform notify_player(o.player_id, 'value.taken', 'loader_order', o.id,
      jsonb_build_object('delta', v_actual, 'currency', o.currency));
  end if;

  return o;
end $$;

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

  perform audit(p_admin, 'loader.fail', 'loader_order', o.id,
                jsonb_build_object('reason', p_reason, 'delta', o.delta));
  return o;
end $$;
