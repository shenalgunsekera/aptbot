-- ═══════════════════════════════════════════════════════════════════════════
-- 0058 — Carry a receipt IMAGE on an admin-paid cash-out, and send it to the player
-- ═══════════════════════════════════════════════════════════════════════════
--
-- When an admin pays a cash-out ("I paid it"), they should attach a screenshot of
-- the payment — not type a transaction id — and the player should receive that
-- receipt as proof, the same way a player-to-player payment shows a receipt.
--
-- Adds an optional p_receipt (a Telegram file_id or a Discord attachment URL —
-- whichever platform the admin uploaded on; it always matches the player's own
-- platform, since the pay card is in that platform's admin group). It's carried
-- straight into the withdraw.paid payload so the notifier can deliver it as a
-- photo. The panel's text-reference "Pay from float" path is unaffected (p_receipt
-- stays null → player just gets the reference).
--
-- Adding a parameter makes an OVERLOAD, not a replacement — a 5-arg call would
-- then be ambiguous-ish and the two definitions could drift. Drop the old 5-arg
-- signature so there is exactly one function; the panel's 5-arg call resolves to
-- this one with p_receipt defaulted to null.
drop function if exists withdraw_club_payout(uuid, uuid, bigint, text, text);
create or replace function withdraw_club_payout(
  p_withdraw_id uuid,
  p_admin       uuid,
  p_amount      bigint default null,   -- null = clear the whole remainder
  p_payment_ref text default null,
  p_note        text default null,
  p_receipt     text default null      -- file_id / attachment URL of the receipt image
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
    raise exception 'admin % not found or disabled', p_admin
      using errcode = 'insufficient_privilege';
  end if;

  select * into w from withdraw_requests where id = p_withdraw_id for update;
  if not found then
    raise exception 'that cash out no longer exists';
  end if;
  if w.status not in ('queued', 'partially_filled') then
    raise exception 'that cash out is % — it is not waiting to be paid', w.status
      using errcode = 'invalid_parameter_value';
  end if;

  v_amount := coalesce(p_amount, w.amount_remaining);
  if v_amount <= 0 then
    raise exception 'amount must be positive'
      using errcode = 'invalid_parameter_value';
  end if;
  if v_amount > w.amount_remaining then
    raise exception 'only % is still owed on that cash out', w.amount_remaining
      using errcode = 'invalid_parameter_value';
  end if;

  select * into cfg from config where id;
  if cfg.owner_approval_threshold is not null
     and v_amount >= cfg.owner_approval_threshold
     and adm.role <> 'owner' then
    raise exception 'payouts of % or more need the owner', cfg.owner_approval_threshold
      using errcode = 'insufficient_privilege';
  end if;

  -- A club-sourced fill: payee side only, no depositor, no credit, no rake. The
  -- receipt image (if any) is kept on the fill as proof for the payee's history.
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
