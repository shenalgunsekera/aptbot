-- ═══════════════════════════════════════════════════════════════════════════
-- 0079 — the "add-on applied" notice speaks in "still to be paid", not gross
-- ═══════════════════════════════════════════════════════════════════════════
--
-- On a partially-paid cash-out, telling the player "it's now $60" (the gross
-- total) is confusing when $20 of it is already paid. Carry `to_pay` (what's
-- still owed = amount − released) in the withdraw.topup_applied payload so the
-- bots can say "you now have $40 still to be paid". Only the notify_player
-- payload changes vs 0077.
create or replace function withdraw_topup_apply(
  p_withdraw_id uuid,
  p_actual      bigint
) returns withdraw_requests
language plpgsql as $$
declare
  w      withdraw_requests;
  v_rake bigint;
  v_net  bigint;
  v_paid bigint;
begin
  select * into w from withdraw_requests where id = p_withdraw_id for update;
  if not found then raise exception 'withdrawal % not found', p_withdraw_id; end if;
  if p_actual <= 0 then
    raise exception 'withdraw_topup_apply: actual must be positive, got %', p_actual;
  end if;

  -- No longer a live cash-out (player cancelled while this add-on was in flight):
  -- book the take-off (chips physically came off) then re-load them. Balanced.
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
         status = (case when w.amount_remaining >= coalesce(w.amount, 0)
                        then 'queued' else 'partially_filled' end)::withdraw_status,
         completed_at = null
   where id = w.id
  returning * into w;

  -- What's still owed to the player: the new total minus what's already been paid
  -- out (released fills). This is the number the player thinks in.
  select coalesce(sum(f.amount), 0) into v_paid
    from fills f where f.withdraw_id = w.id and f.status = 'released';

  perform notify_player(w.player_id, 'withdraw.topup_applied', 'withdraw_request', w.id,
    jsonb_build_object('added', v_net, 'currency', w.currency,
                       'new_total', w.amount, 'to_pay', w.amount - v_paid));
  return w;
end $$;
