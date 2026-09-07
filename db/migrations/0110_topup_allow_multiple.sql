-- ═══════════════════════════════════════════════════════════════════════════
-- 0110 — /addtowithdraw: allow MORE THAN ONE add-on in flight at a time
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 0077 refused a second /addtowithdraw while the first add-on's take-off was
-- still pending/claimed ("you already have an add-on being processed for this
-- cash-out"). In practice that means a player can only add once and then has to
-- wait for a loader to work the card before adding again — confusing.
--
-- It's safe to lift: each add-on is its own independent loader take-off, and
-- withdraw_topup_apply locks the withdraw row (for update) before it escrows, so
-- concurrent completions serialize and each amount is added correctly on top of
-- the last. withdraw_settle_if_done already holds the cash-out open while ANY
-- withdraw.topup take-off is pending, so multiple in flight are handled too.
--
-- The one thing that guard also did was stop two pending add-ons from jointly
-- exceeding the method/global cap (each checked only APPLIED gross). So we now
-- add the sum of in-flight add-on take-offs into the cap check. Only that block
-- changes vs 0077 — everything else is identical.
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
  v_pending   bigint;
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

  if p_additional <= 0 then
    raise exception 'enter an amount above zero' using errcode = 'invalid_parameter_value';
  end if;
  if cfg.amount_step > 0 and p_additional % cfg.amount_step <> 0 then
    raise exception 'add in whole multiples of %',
      to_char(cfg.amount_step / 100.0, 'FM999999990.00') using errcode = 'invalid_parameter_value';
  end if;

  select * into m from payment_methods where id = w.method_id;

  -- Add-ons already taken off but not yet escrowed on (pending/claimed take-offs)
  -- still count toward the total the player is growing this cash-out to, so the
  -- cap holds even with several add-ons in flight at once.
  select coalesce(sum(abs(delta)), 0) into v_pending
    from loader_orders
   where ref_type = 'withdraw_request' and ref_id = w.id
     and reason = 'withdraw.topup' and status in ('pending', 'claimed');

  -- Guard the NEW gross total (applied + in-flight + this one) against the cap.
  v_new_gross := coalesce(w.gross_amount, w.amount, w.requested_amount, 0) + v_pending + p_additional;
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
    if v_today + v_pending + p_additional > cfg.daily_cap_per_player then
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
