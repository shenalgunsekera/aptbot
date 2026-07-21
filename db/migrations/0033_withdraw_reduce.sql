-- ═══════════════════════════════════════════════════════════════════════════
-- 0033 — Partially cancel a cash out (lower the amount, get the rest back)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A player cashing out $100 who wants $20 back can lower the request to $80. This
-- only makes sense for methods where WE send to them (Venmo/Zelle/crypto) — a
-- PayPal/Cash App money request can't be lowered, so those must cancel fully and
-- re-request (the bot enforces that). Only the UNPAID (unmatched) portion can be
-- reduced; anything already being paid stays. The reduced amount goes back to the
-- player, and admins are told to re-load it to their table.
create or replace function withdraw_reduce(
  p_withdraw_id uuid,
  p_reduce_by   bigint,
  p_actor       uuid default null
) returns withdraw_requests
language plpgsql as $$
declare
  w withdraw_requests;
  pl players;
begin
  select * into w from withdraw_requests where id = p_withdraw_id for update;
  if not found then
    raise exception 'cash out not found';
  end if;
  if w.status not in ('queued', 'partially_filled') then
    raise exception 'this cash out can no longer be changed' using errcode = 'invalid_parameter_value';
  end if;
  if p_reduce_by <= 0 then
    raise exception 'enter an amount above zero' using errcode = 'invalid_parameter_value';
  end if;
  if p_reduce_by >= w.amount_remaining then
    raise exception 'to take back that much, cancel the whole cash out instead' using errcode = 'invalid_parameter_value';
  end if;

  -- Give the reduced part back (escrow → wallet; rake returned pro-rata inside).
  perform withdraw_refund_escrow(w.id, p_reduce_by, 'withdraw.reduce', p_actor,
    format('reduced by %s at player request', p_reduce_by));

  update withdraw_requests
     set gross_amount      = gross_amount - p_reduce_by,
         amount            = amount - p_reduce_by,
         amount_remaining  = amount_remaining - p_reduce_by
   where id = w.id
  returning * into w;

  select * into pl from players where id = w.player_id;
  perform notify_admins('withdraw.reduced', 'withdraw_request', w.id, jsonb_build_object(
    'name', pl.display_name, 'amount', p_reduce_by, 'currency', w.currency, 'new_total', w.amount));
  perform notify_player(w.player_id, 'withdraw.reduced_player', 'withdraw_request', w.id,
    jsonb_build_object('back', p_reduce_by, 'new_total', w.amount, 'currency', w.currency));
  return w;
end $$;
