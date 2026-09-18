-- ═══════════════════════════════════════════════════════════════════════════
-- 0119 — a claim never locks another admin out: any admin can claim & complete
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Jobs (loader take-off / add-to-table, and the add-to-table auto-created when a
-- payment is verified) are claimed by one admin, and until now:
--   • loader_order_claim refused to (re)claim anything already 'claimed' —
--     "already taken by someone else"; and
--   • loader_order_complete refused to let a non-owner finish a job claimed by a
--     different admin — "someone else is working on that one".
-- In a shared admin group where cards go stale (verified from the panel or by
-- another admin), this stranded the job: the admin looking at it could neither
-- take it nor finish it. The owner's rule: NO MATTER WHAT, let admins claim then
-- complete — whoever is actually doing the work grabs it.
--
-- Safety is unchanged: completion still requires the job to be 'claimed' and flips
-- it to 'done' in one locked step, so a job can never be completed twice (the
-- second attempt hits "take the job first (it is done)"). We only drop the
-- WHO-may-act restriction, never the once-only guarantee.

-- Any admin can claim a not-yet-finished job, or TAKE OVER one already claimed.
create or replace function loader_order_claim(p_order_id uuid, p_admin uuid)
returns loader_orders
language plpgsql as $$
declare
  o loader_orders;
begin
  update loader_orders
     set status = 'claimed', claimed_by = p_admin, claimed_at = now()
   where id = p_order_id and status in ('pending', 'claimed')
  returning * into o;

  if not found then
    select * into o from loader_orders where id = p_order_id;
    if not found then
      raise exception 'that job no longer exists';
    end if;
    -- done / failed / cancelled — nothing left to take.
    raise exception 'that job is already %', o.status
      using errcode = 'invalid_parameter_value';
  end if;

  perform audit(p_admin, 'loader.claim', 'loader_order', o.id,
                jsonb_build_object('delta', o.delta, 'player_name', o.player_name));
  return o;
end $$;

-- Any admin may complete a claimed job — not only the one who claimed it. The
-- single-completion guarantee is preserved by the status='claimed' → 'done' flip.
create or replace function loader_order_complete(p_order_id uuid, p_admin uuid, p_actual_delta bigint default null, p_note text default null)
returns loader_orders
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
  -- (ownership restriction removed — any admin who is doing the work may finish it)

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
      if found and o.reason = 'withdraw.topup' then
        if v_actual = 0 then
          perform notify_player(w.player_id, 'withdraw.topup_none', 'withdraw_request', w.id,
            jsonb_build_object('currency', w.currency));
        else
          perform withdraw_topup_apply(w.id, -v_actual);
        end if;
      elsif found and w.status = 'pending_unload' then
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

  if o.delta > 0 then
    perform notify_player(o.player_id, 'value.added', 'loader_order', o.id,
      jsonb_build_object('delta', v_actual, 'currency', o.currency));
  elsif o.ref_type is distinct from 'withdraw_request' then
    perform notify_player(o.player_id, 'value.taken', 'loader_order', o.id,
      jsonb_build_object('delta', v_actual, 'currency', o.currency));
  end if;

  return o;
end $$;
