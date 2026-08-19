-- ═══════════════════════════════════════════════════════════════════════════
-- 0077 — Add to an existing cash-out (/addtowithdraw) without losing queue spot
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A player with a cash-out already waiting in the queue can INCREASE it. The
-- extra is taken off the tables exactly like a normal cash-out — the same loader
-- "TAKE OFF" card admins already work — and then escrowed onto the SAME
-- withdraw_request row. Because it is the same row (same created_at / queued_at),
-- the player keeps their place in line; only the amount grows.
--
-- Shape (mirrors the ask → unload → escrow flow of a normal cash-out):
--   withdraw_topup(w, extra)        raises a 'withdraw.topup' take-off order.
--   loader completes the take-off   → withdraw_topup_apply(w, actual)
--   withdraw_topup_apply            escrows `actual` ONTO the cash-out (+gross,
--                                   +rake, +amount, +amount_remaining), status
--                                   preserved (queued/partially_filled), queue
--                                   position untouched.
--
-- Safety around the async window (take-off raised now, completed later):
--   • Only ONE add-on may be in flight per cash-out.
--   • withdraw_settle_if_done will NOT complete a cash-out while an add-on
--     take-off is pending — so it can't finish out from under the add-on.
--   • If the cash-out is no longer live when the add-on lands (the player
--     cancelled in the meantime), the chips are re-loaded back to their table
--     instead of being added — nothing is stranded, the ledger stays balanced.

-- ─── Raise the add-on take-off ──────────────────────────────────────────────
create or replace function withdraw_topup(
  p_withdraw_id uuid,
  p_additional  bigint
) returns loader_orders
language plpgsql as $$
declare
  w           withdraw_requests;
  cfg         config;
  m           payment_methods;
  pl          players;
  v_today     bigint;
  v_new_gross bigint;
  v_order     loader_orders;
begin
  select * into cfg from config where id;

  select * into w from withdraw_requests where id = p_withdraw_id for update;
  if not found then raise exception 'cash-out not found'; end if;

  select * into pl from players where id = w.player_id for update;
  if pl.status <> 'active' then
    raise exception 'account is % — cash-outs are not available', pl.status
      using errcode = 'insufficient_privilege';
  end if;

  if w.cancel_requested_at is not null then
    raise exception 'that cash-out is being cancelled — you cannot add to it'
      using errcode = 'invalid_parameter_value';
  end if;
  if w.status not in ('queued', 'partially_filled') then
    raise exception 'you can only add to a cash-out that is waiting in the queue'
      using errcode = 'invalid_parameter_value';
  end if;

  -- One add-on in flight at a time — otherwise two take-offs could race.
  if exists (select 1 from loader_orders
              where ref_type = 'withdraw_request' and ref_id = w.id
                and reason = 'withdraw.topup' and status in ('pending', 'claimed')) then
    raise exception 'you already have an add-on being processed for this cash-out'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_additional <= 0 then
    raise exception 'enter an amount above zero' using errcode = 'invalid_parameter_value';
  end if;
  if cfg.amount_step > 0 and p_additional % cfg.amount_step <> 0 then
    raise exception 'add in whole multiples of %',
      to_char(cfg.amount_step / 100.0, 'FM999999990.00') using errcode = 'invalid_parameter_value';
  end if;

  select * into m from payment_methods where id = w.method_id;
  -- Guard the NEW gross total against the method/global cap.
  v_new_gross := coalesce(w.gross_amount, w.amount, w.requested_amount, 0) + p_additional;
  if v_new_gross > coalesce(m.max_amount, cfg.max_amount) then
    raise exception 'that would take this cash-out over the % limit of %', m.name,
      to_char(coalesce(m.max_amount, cfg.max_amount) / 100.0, 'FM999999990.00')
      using errcode = 'invalid_parameter_value';
  end if;

  if cfg.daily_cap_per_player is not null then
    select coalesce(sum(coalesce(gross_amount, requested_amount)), 0) into v_today
      from withdraw_requests
     where player_id = w.player_id and status <> 'cancelled'
       and created_at > now() - interval '24 hours';
    if v_today + p_additional > cfg.daily_cap_per_player then
      raise exception 'that would go over your daily limit' using errcode = 'invalid_parameter_value';
    end if;
  end if;

  -- The loader takes the extra off the table — the same "TAKE OFF" card. On
  -- completion it is escrowed onto THIS cash-out (withdraw_topup_apply).
  v_order := loader_order_create(
    w.player_id, w.platform_id, -p_additional, w.currency,
    'withdraw.topup', 'withdraw_request', w.id,
    format('add %s to an existing cash-out', p_additional));
  return v_order;
end $$;

-- ─── Apply the add-on once the chips are actually off ────────────────────────
-- p_actual is what really came off (never more than asked). Escrowed onto the
-- same cash-out, so the queue spot is kept. If the cash-out is no longer live
-- (cancelled while this was pending), re-load the chips instead.
create or replace function withdraw_topup_apply(
  p_withdraw_id uuid,
  p_actual      bigint
) returns withdraw_requests
language plpgsql as $$
declare
  w      withdraw_requests;
  v_rake bigint;
  v_net  bigint;
begin
  select * into w from withdraw_requests where id = p_withdraw_id for update;
  if not found then raise exception 'withdrawal % not found', p_withdraw_id; end if;
  if p_actual <= 0 then
    raise exception 'withdraw_topup_apply: actual must be positive, got %', p_actual;
  end if;

  -- No longer a live cash-out (player cancelled while this add-on was in flight):
  -- the chips physically came off, so book that, then put them straight back on
  -- the table via a re-load. Balanced, and nothing is stranded.
  if w.status not in ('queued', 'partially_filled', 'filled') or w.cancel_requested_at is not null then
    perform ledger_post(
      'withdraw.unload', 'withdraw_request', w.id, null,
      format('%s came off the tables (add-on, cash-out no longer live)', p_actual),
      jsonb_build_array(
        jsonb_build_object('account_id',
          account_of('house_settlement', null, w.platform_id, w.currency), 'amount', -p_actual),
        jsonb_build_object('account_id',
          account_of('player_wallet', w.player_id, w.platform_id, w.currency), 'amount', p_actual)
      ));
    perform loader_order_create(
      w.player_id, w.platform_id, p_actual, w.currency,
      'withdraw.cancel_reload', 'withdraw_request', w.id,
      'add-on arrived after the cash-out ended — re-load to their table');
    return w;
  end if;

  v_rake := calc_rake(p_actual, 'withdraw');
  v_net  := p_actual - v_rake;

  -- Same two-step as withdraw_escrow: value leaves the tables → becomes credit →
  -- locked behind THIS cash-out, rake taken. Sums to zero.
  perform ledger_post(
    'withdraw.unload', 'withdraw_request', w.id, null,
    format('%s more came off the tables (add-on)', p_actual),
    jsonb_build_array(
      jsonb_build_object('account_id',
        account_of('house_settlement', null, w.platform_id, w.currency), 'amount', -p_actual),
      jsonb_build_object('account_id',
        account_of('player_wallet', w.player_id, w.platform_id, w.currency), 'amount', p_actual)
    ));
  perform ledger_post(
    'withdraw.escrow', 'withdraw_request', w.id, null,
    format('lock %s more (%s gross, %s fee) — add-on', v_net, p_actual, v_rake),
    jsonb_build_array(
      jsonb_build_object('account_id',
        account_of('player_wallet', w.player_id, w.platform_id, w.currency), 'amount', -p_actual),
      jsonb_build_object('account_id',
        account_of('player_escrow', w.player_id, w.platform_id, w.currency), 'amount', v_net),
      jsonb_build_object('account_id',
        account_of('house_rake', null, null, w.currency), 'amount', v_rake)
    ));

  update withdraw_requests
     set gross_amount = coalesce(gross_amount, 0) + p_actual,
         rake_amount  = coalesce(rake_amount, 0) + v_rake,
         amount       = coalesce(amount, 0) + v_net,
         amount_remaining = coalesce(amount_remaining, 0) + v_net,
         -- Preserve the state: adding to both amount and amount_remaining keeps
         -- their relationship, so a queued cash-out stays queued and a partly
         -- paid one stays partially_filled (a fully-matched 'filled' reopens).
         status = (case when w.amount_remaining >= coalesce(w.amount, 0)
                        then 'queued' else 'partially_filled' end)::withdraw_status,
         completed_at = null
   where id = w.id
  returning * into w;

  perform notify_player(w.player_id, 'withdraw.topup_applied', 'withdraw_request', w.id,
    jsonb_build_object('added', v_net, 'currency', w.currency, 'new_total', w.amount));
  return w;
end $$;

-- ─── Hook the loader completion into the add-on apply ────────────────────────
-- Same as 0060, plus: a completed 'withdraw.topup' take-off on a live cash-out
-- routes to withdraw_topup_apply instead of the first-unload withdraw_escrow.
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
      if found and o.reason = 'withdraw.topup' then
        -- An add-on to an existing cash-out.
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

  -- Player notice. A cash-out unload (first or add-on) is already announced on its
  -- own, so don't send a second "taken off" line for any withdraw_request take-off.
  if o.delta > 0 then
    perform notify_player(o.player_id, 'value.added', 'loader_order', o.id,
      jsonb_build_object('delta', v_actual, 'currency', o.currency));
  elsif o.ref_type is distinct from 'withdraw_request' then
    perform notify_player(o.player_id, 'value.taken', 'loader_order', o.id,
      jsonb_build_object('delta', v_actual, 'currency', o.currency));
  end if;

  return o;
end $$;

-- ─── Don't settle out from under a pending add-on ───────────────────────────
-- Same as 0006, plus: hold the cash-out open while an add-on take-off is pending.
create or replace function withdraw_settle_if_done(p_withdraw_id uuid)
returns withdraw_requests
language plpgsql as $$
declare
  w      withdraw_requests;
  v_open int;
begin
  select * into w from withdraw_requests where id = p_withdraw_id for update;
  if w.status in ('completed', 'cancelled') then
    return w;
  end if;

  select count(*) into v_open
    from fills
   where withdraw_id = w.id and status in ('locked', 'awaiting_confirmation', 'disputed');

  if v_open > 0 or w.amount_remaining > 0 then
    return w;
  end if;

  -- The player asked to add more; hold the cash-out open until the add-on take-off
  -- lands (or is dropped), so it can't finish before the extra is escrowed on.
  if exists (select 1 from loader_orders
              where ref_type = 'withdraw_request' and ref_id = w.id
                and reason = 'withdraw.topup' and status in ('pending', 'claimed')) then
    return w;
  end if;

  update withdraw_requests
     set status = (case when w.cancel_requested_at is not null then 'cancelled' else 'completed' end)::withdraw_status,
         completed_at = now()
   where id = w.id
  returning * into w;

  perform notify_player(w.player_id,
    case when w.status = 'cancelled' then 'withdraw.cancelled' else 'withdraw.completed' end,
    'withdraw_request', w.id,
    jsonb_build_object('amount', w.amount, 'currency', w.currency));
  return w;
end $$;
