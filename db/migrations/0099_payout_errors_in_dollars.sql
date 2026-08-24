-- ═══════════════════════════════════════════════════════════════════════════
-- 0099 — Pay-out error messages speak dollars, not raw cents
-- ═══════════════════════════════════════════════════════════════════════════
--
-- withdraw_club_payout raised "only 2500 is still owed on that cash out" and
-- "payouts of 50000 or more need the owner" — the amounts printed as raw cents,
-- which reads like the amount was mis-parsed (e.g. a $30 pay-out looks rejected
-- against "2500"). The pay-out logic was always correct; only the message was
-- wrong. Now both amounts are formatted as dollars, matching every other money
-- message. Same body as 0088, only the two raise strings change.
create or replace function withdraw_club_payout(
  p_withdraw_id uuid,
  p_admin       uuid,
  p_amount      bigint default null,
  p_payment_ref text default null,
  p_note        text default null,
  p_receipt     text default null
) returns fills
language plpgsql as $$
declare
  w        withdraw_requests;
  adm      admins;
  cfg      config;
  f        fills;
  v_amount bigint;
begin
  select * into adm from admins where id = p_admin and not disabled;
  if not found then
    raise exception 'admin % not found or disabled', p_admin using errcode = 'insufficient_privilege';
  end if;

  select * into w from withdraw_requests where id = p_withdraw_id for update;
  if not found then raise exception 'that cash out no longer exists'; end if;
  if w.status not in ('queued', 'partially_filled') then
    raise exception 'that cash out is % — it is not waiting to be paid', w.status
      using errcode = 'invalid_parameter_value';
  end if;

  v_amount := coalesce(p_amount, w.amount_remaining);
  if v_amount <= 0 then
    raise exception 'amount must be positive' using errcode = 'invalid_parameter_value';
  end if;
  if v_amount > w.amount_remaining then
    raise exception 'only $% is still owed on that cash out',
      to_char(w.amount_remaining / 100.0, 'FM999999990.00')
      using errcode = 'invalid_parameter_value';
  end if;

  select * into cfg from config where id;
  if cfg.owner_approval_threshold is not null
     and v_amount >= cfg.owner_approval_threshold
     and adm.role <> 'owner' then
    raise exception 'payouts of $% or more need the owner',
      to_char(cfg.owner_approval_threshold / 100.0, 'FM999999990.00')
      using errcode = 'insufficient_privilege';
  end if;

  insert into fills (
    deposit_id, withdraw_id, method_id, currency,
    amount, rake_amount, credit_amount, gross_to_send,
    payout_handle, status, lock_expires_at,
    payment_ref, proof_note, submitted_at,
    released_at, released_by, release_reason
  ) values (
    null, w.id, w.method_id, w.currency,
    v_amount, 0, 0, v_amount,
    w.payout_handle, 'released', now(),
    p_payment_ref, coalesce(p_note, p_receipt), now(),
    now(), p_admin, 'club_verified'
  ) returning * into f;

  -- Save the receipt image to the player's permanent history (so /payments shows
  -- it, not just the one-off notification). A Telegram file_id is kept as-is (it
  -- doesn't expire); an http url (Firebase, from Discord) is stored as the url.
  if p_receipt is not null and length(trim(p_receipt)) > 0 then
    perform receipt_add(
      w.player_id, 'fill', f.id, p_receipt, p_receipt, w.platform_id,
      null, null,
      case when p_receipt like 'http%' then null else p_receipt end,
      null, p_admin);
  end if;

  perform ledger_post(
    'withdraw.club_payout', 'fill', f.id, p_admin,
    format('club paid %s directly', v_amount),
    jsonb_build_array(
      jsonb_build_object('account_id',
        account_of('player_escrow', w.player_id, w.platform_id, w.currency), 'amount', -v_amount),
      jsonb_build_object('account_id',
        account_of('owner_float', null, null, w.currency), 'amount', v_amount)
    ));

  update withdraw_requests
     set amount_remaining = amount_remaining - v_amount,
         status = (case when amount_remaining - v_amount = 0 then 'filled'
                        else 'partially_filled' end)::withdraw_status
   where id = w.id;

  perform audit(p_admin, 'withdraw.club_payout', 'withdraw_request', w.id,
    jsonb_build_object('amount', v_amount, 'payment_ref', p_payment_ref, 'fill_id', f.id,
                       'receipt', p_receipt is not null));
  perform notify_player(w.player_id, 'withdraw.paid', 'withdraw_request', w.id,
    jsonb_build_object('amount', v_amount, 'currency', w.currency,
                       'payment_ref', p_payment_ref, 'receipt', p_receipt));

  perform withdraw_settle_if_done(w.id);
  return f;
end $$;
