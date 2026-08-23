-- ═══════════════════════════════════════════════════════════════════════════
-- 0096 — A per-cash-out minimum that can only be RAISED above the base
-- ═══════════════════════════════════════════════════════════════════════════
--
-- An admin can set a higher minimum on ONE cash-out: e.g. "$50 minimum here"
-- instead of the usual $20. It only ever RAISES the floor — the effective minimum
-- for a cash-out is greatest(its override, the global minimum). It drives the
-- "small cash-out → pay it directly" threshold and the "$X minimum" text on that
-- cash-out's admin card. Nothing else changes: creation limits, matching, and
-- every other cash-out use the normal minimum.

alter table withdraw_requests
  add column if not exists min_override bigint check (min_override is null or min_override > 0);

-- The small-payout nudge uses the cash-out's effective minimum. Same body as 0090
-- except v_min = greatest(override, global min), and the payload carries v_min so
-- the admin card shows the raised figure.
create or replace function withdraw_small_pay_alert() returns trigger
language plpgsql as $$
declare
  m     payment_methods;
  cfg   config;
  pl    players;
  v_min bigint;
begin
  if new.status not in ('queued', 'partially_filled') or coalesce(new.amount_remaining, 0) <= 0 then
    new.small_alert_sent_at := null;
    return new;
  end if;

  if new.paused_at is not null then
    return new;
  end if;

  if exists (select 1 from fills
              where withdraw_id = new.id and status in ('locked', 'awaiting_confirmation')) then
    return new;
  end if;

  select * into m from payment_methods where id = new.method_id;
  if m.settlement <> 'p2p' then
    return new;
  end if;

  select * into cfg from config where id;
  v_min := greatest(coalesce(new.min_override, 0), cfg.min_amount);   -- override only raises

  if new.amount_remaining >= v_min then
    new.small_alert_sent_at := null;
    return new;
  end if;

  if new.small_alert_sent_at is not null then
    return new;
  end if;

  select * into pl from players where id = new.player_id;
  perform notify_admins('withdraw.needs_payout', 'withdraw_request', new.id,
    jsonb_build_object('withdraw_id', new.id, 'name', pl.display_name,
                       'amount', new.amount_remaining, 'currency', new.currency,
                       'method', m.name, 'handle', new.payout_handle,
                       'small', true, 'min', v_min)
    || withdraw_payout_extra(new.id));
  new.small_alert_sent_at := now();
  return new;
end $$;

-- Set (or clear) a cash-out's minimum override. Owner/admin only; audited. The
-- override must be strictly ABOVE the global minimum (it can only raise the floor);
-- pass null to clear it. The UPDATE itself fires the BEFORE trigger above, so the
-- small-payout nudge re-evaluates immediately against the new floor.
create or replace function withdraw_set_min(p_withdraw uuid, p_min bigint, p_admin uuid)
returns withdraw_requests
language plpgsql as $$
declare
  w   withdraw_requests;
  adm admins;
  cfg config;
begin
  select * into adm from admins where id = p_admin and not disabled;
  if not found then
    raise exception 'admin % not found or disabled', p_admin using errcode = 'insufficient_privilege';
  end if;

  select * into w from withdraw_requests where id = p_withdraw for update;
  if not found then raise exception 'cash-out not found'; end if;
  if w.status not in ('queued', 'partially_filled', 'filled') then
    raise exception 'that cash-out is % — its minimum can no longer be changed', w.status
      using errcode = 'invalid_parameter_value';
  end if;

  select * into cfg from config where id;
  if p_min is not null and p_min <= cfg.min_amount then
    raise exception 'the minimum can only be raised above %',
      '$' || to_char(cfg.min_amount / 100.0, 'FM999999990.00')
      using errcode = 'invalid_parameter_value';
  end if;

  update withdraw_requests set min_override = p_min where id = w.id returning * into w;
  perform audit(p_admin, 'withdraw.set_min', 'withdraw_request', w.id,
    jsonb_build_object('min', p_min));
  return w;
end $$;
