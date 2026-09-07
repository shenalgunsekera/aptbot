-- ═══════════════════════════════════════════════════════════════════════════
-- 0108 — Club payout can carry TWO receipts (for the panel unpause-adjust flow)
-- ═══════════════════════════════════════════════════════════════════════════
-- The admin unpause-with-adjust flow lets an owner record a payment they made
-- directly and attach up to two receipt screenshots. withdraw_club_payout took
-- only one. Now it takes an optional second, saves both to the payee's history,
-- and sends BOTH in the "you've been paid" notification (a `receipts` array; the
-- old single `receipt` key stays for back-compat). Adding a defaulted param keeps
-- every existing 6-arg call working. Body is otherwise identical to 0099.
-- Drop the old 6-arg overload so a 6-arg call resolves to this one (the added
-- param defaults), rather than leaving two ambiguous overloads.
drop function if exists withdraw_club_payout(uuid, uuid, bigint, text, text, text);
create or replace function withdraw_club_payout(
  p_withdraw_id uuid,
  p_admin       uuid,
  p_amount      bigint default null,
  p_payment_ref text default null,
  p_note        text default null,
  p_receipt     text default null,
  p_receipt2    text default null
) returns fills
language plpgsql as $$
declare
  w        withdraw_requests;
  adm      admins;
  cfg      config;
  f        fills;
  v_amount bigint;
  v_receipts jsonb;
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

  -- Save each receipt to the payee's permanent history (so /payments and the
  -- Receipts page show them, not just the one-off notification).
  if p_receipt is not null and length(trim(p_receipt)) > 0 then
    perform receipt_add(
      w.player_id, 'fill', f.id, p_receipt, p_receipt, w.platform_id,
      null, null, case when p_receipt like 'http%' then null else p_receipt end, null, p_admin);
  end if;
  if p_receipt2 is not null and length(trim(p_receipt2)) > 0 then
    perform receipt_add(
      w.player_id, 'fill', f.id, p_receipt2, p_receipt2, w.platform_id,
      null, null, case when p_receipt2 like 'http%' then null else p_receipt2 end, null, p_admin);
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
                       'receipt', p_receipt is not null, 'receipt2', p_receipt2 is not null));

  v_receipts := (select jsonb_agg(x) from unnest(array[p_receipt, p_receipt2]) x
                  where x is not null and length(trim(x)) > 0);
  perform notify_player(w.player_id, 'withdraw.paid', 'withdraw_request', w.id,
    jsonb_build_object('amount', v_amount, 'currency', w.currency,
                       'payment_ref', p_payment_ref, 'receipt', p_receipt,
                       'receipts', coalesce(v_receipts, '[]'::jsonb)));

  perform withdraw_settle_if_done(w.id);
  return f;
end $$;
