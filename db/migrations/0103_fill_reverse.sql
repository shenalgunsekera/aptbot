-- 0103 — Reverse a released (already-sent) payment on a cash-out
-- ═══════════════════════════════════════════════════════════════════════════
-- For when a payment was VERIFIED and then turns out fake. Unlike /adjust + (which
-- grows the total) this changes the NUMERATOR: the amount already "sent" goes back
-- down, the cash-out total is untouched. 200/1000 → 0/1000, not 200/1200.
--
-- Club absorbs it (the system's stated policy — chargebacks land on the club, not
-- a player who may have already spent the credit): the payee's escrow is restored
-- and the house books the loss; the depositor keeps their credit.
--
-- Handles the FINAL-payment case: if this fill had completed the cash-out,
-- withdraw_return_slice re-opens it and clears completed_at automatically.

create or replace function fill_reverse(
  p_fill_id uuid,
  p_admin   uuid default null,
  p_reason  text default null
) returns fills
language plpgsql as $$
declare
  f fills;
  w withdraw_requests;
  v_remaining bigint;
begin
  select * into f from fills where id = p_fill_id for update;
  if not found then raise exception 'that payment no longer exists'; end if;
  if f.status <> 'released' then
    raise exception 'only a completed payment can be reversed — this one is %', f.status
      using errcode = 'invalid_parameter_value';
  end if;
  if f.withdraw_id is null then
    raise exception 'that payment is not part of a cash-out'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into w from withdraw_requests where id = f.withdraw_id for update;

  -- Restore the payee's escrow (they are owed it again); the house eats the loss.
  -- The depositor's credit is left alone — the club absorbs, by design.
  perform ledger_post(
    'fill.reverse', 'fill', f.id, p_admin,
    coalesce(p_reason, format('reversed payment of %s', f.amount)),
    jsonb_build_array(
      jsonb_build_object('account_id',
        account_of('player_escrow', w.player_id, w.platform_id, f.currency), 'amount', f.amount),
      jsonb_build_object('account_id',
        account_of('house_loss', null, null, f.currency), 'amount', -f.amount)
    ));

  -- Put the slice back on what the payee is owed. Re-opens the cash-out and clears
  -- completed_at even if THIS was the final payment that had completed it.
  perform withdraw_return_slice(f.withdraw_id, f.amount, coalesce(p_reason, 'payment reversed'));

  update fills set status = 'refunded' where id = f.id returning * into f;

  select amount_remaining into v_remaining from withdraw_requests where id = w.id;

  perform audit(p_admin, 'fill.reverse', 'fill', f.id,
    jsonb_build_object('amount', f.amount, 'currency', f.currency,
                       'withdraw_id', f.withdraw_id, 'reason', p_reason));

  perform notify_player(w.player_id, 'fill.reversed', 'fill', f.id,
    jsonb_build_object('amount', f.amount, 'currency', f.currency,
                       'total', w.amount, 'remaining', v_remaining));

  return f;
end $$;
