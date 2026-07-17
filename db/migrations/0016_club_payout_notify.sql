-- ═══════════════════════════════════════════════════════════════════════════
-- 0016 — Club-mediated withdrawals alert an admin to pay
-- ═══════════════════════════════════════════════════════════════════════════
--
-- With crypto/PayPal/Stripe now club-mediated, their withdrawals are NOT filled
-- by depositors — the club pays them from its own accounts. A queued club-method
-- withdrawal will therefore sit unpaid unless an admin acts. So the moment one is
-- escrowed, alert the admins with everything they need to pay it (and, in
-- Telegram, a button).
--
-- P2P-method withdrawals (Venmo, Zelle) still get filled by depositors, so they
-- do NOT trigger this — they flow through the matching queue as before.
create or replace function withdraw_escrow(
  p_withdraw_id uuid,
  p_actual      bigint
) returns withdraw_requests
language plpgsql as $$
declare
  w      withdraw_requests;
  m      payment_methods;
  pl     players;
  v_rake bigint;
  v_net  bigint;
begin
  select * into w from withdraw_requests where id = p_withdraw_id for update;
  if not found then
    raise exception 'withdrawal % not found', p_withdraw_id;
  end if;
  if w.status <> 'pending_unload' then
    raise exception 'withdrawal % is already past unloading (status %)', w.id, w.status
      using errcode = 'invalid_parameter_value';
  end if;
  if p_actual <= 0 then
    raise exception 'withdraw_escrow: actual must be positive, got %', p_actual;
  end if;

  v_rake := calc_rake(p_actual, 'withdraw');
  v_net  := p_actual - v_rake;

  perform ledger_post(
    'withdraw.unload', 'withdraw_request', w.id, null,
    format('%s came off the tables', p_actual),
    jsonb_build_array(
      jsonb_build_object('account_id',
        account_of('house_settlement', null, w.platform_id, w.currency), 'amount', -p_actual),
      jsonb_build_object('account_id',
        account_of('player_wallet', w.player_id, w.platform_id, w.currency), 'amount', p_actual)
    ));

  perform ledger_post(
    'withdraw.escrow', 'withdraw_request', w.id, null,
    format('lock %s (%s gross, %s fee)', v_net, p_actual, v_rake),
    jsonb_build_array(
      jsonb_build_object('account_id',
        account_of('player_wallet', w.player_id, w.platform_id, w.currency), 'amount', -p_actual),
      jsonb_build_object('account_id',
        account_of('player_escrow', w.player_id, w.platform_id, w.currency), 'amount', v_net),
      jsonb_build_object('account_id',
        account_of('house_rake', null, null, w.currency), 'amount', v_rake)
    ));

  update withdraw_requests
     set gross_amount = p_actual, rake_amount = v_rake, amount = v_net,
         amount_remaining = v_net, status = 'queued', queued_at = now()
   where id = w.id
  returning * into w;

  perform notify_player(w.player_id, 'withdraw.queued', 'withdraw_request', w.id,
    jsonb_build_object('amount', w.amount, 'currency', w.currency,
                       'short', p_actual < w.requested_amount, 'requested', w.requested_amount));

  -- Club-mediated → an admin must pay it. Alert them with the details + a button.
  select * into m from payment_methods where id = w.method_id;
  if m.settlement = 'club' then
    select * into pl from players where id = w.player_id;
    perform notify_admins('withdraw.needs_payout', 'withdraw_request', w.id,
      jsonb_build_object('withdraw_id', w.id, 'name', pl.display_name,
                         'amount', w.amount, 'currency', w.currency,
                         'method', m.name, 'handle', w.payout_handle));
  end if;

  return w;
end $$;
