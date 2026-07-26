-- ═══════════════════════════════════════════════════════════════════════════
-- 0043 — Manual admin adjustment of a cash out (correct the amount up or down)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- When something goes wrong outside the normal flow — a loader under-reported,
-- or a confirmed payment turns out to have been faked — an admin needs to make
-- the player's OPEN cash out right by hand:
--
--   +delta  "you're actually owed 20 more"  → escrow grows, more gets paid out
--   -delta  "that payment was fake, take 20 back" → the unpaid part shrinks
--
-- This is a correction, not a new withdrawal, so NO rake is taken or returned on
-- the delta. The counter-account is house_loss (never platform settlement), so a
-- manual correction can never distort a platform's real settlement figures and
-- every adjustment shows up as a house_loss movement in the ledger.
--
-- Only the UNPAID (amount_remaining) portion can ever be clawed back: money that
-- is already matched, awaiting confirmation, or released has left through a fill
-- and cannot be reached from here — cancel/dispute that fill instead.
create or replace function withdraw_adjust(
  p_withdraw_id uuid,
  p_delta       bigint,      -- signed cents: positive adds, negative removes
  p_actor       uuid,        -- the admin making the change
  p_reason      text default null
) returns withdraw_requests
language plpgsql as $$
declare
  w   withdraw_requests;
  pl  players;
begin
  if p_delta = 0 then
    raise exception 'enter an amount above zero' using errcode = 'invalid_parameter_value';
  end if;

  select * into w from withdraw_requests where id = p_withdraw_id for update;
  if not found then
    raise exception 'cash out not found';
  end if;

  -- Must be past unloading (so gross/escrow exist) but not finished.
  if w.status not in ('queued', 'partially_filled', 'filled') then
    raise exception 'this cash out can no longer be adjusted (status %)', w.status
      using errcode = 'invalid_parameter_value';
  end if;

  if p_delta < 0 and (-p_delta) > w.amount_remaining then
    raise exception 'you can only take back up to the unpaid part (%.2f left); the rest is already being paid',
      w.amount_remaining / 100.0
      using errcode = 'invalid_parameter_value';
  end if;

  if p_delta > 0 then
    -- House credits the player's escrow; more money to be paid out.
    perform ledger_post(
      'withdraw.adjust', 'withdraw_request', w.id, p_actor,
      coalesce(p_reason, format('admin added %s', p_delta)),
      jsonb_build_array(
        jsonb_build_object('account_id',
          account_of('house_loss', null, null, w.currency), 'amount', -p_delta),
        jsonb_build_object('account_id',
          account_of('player_escrow', w.player_id, w.platform_id, w.currency), 'amount', p_delta)
      ));
  else
    -- Pull the unpaid part back out of escrow; house recovers it.
    perform ledger_post(
      'withdraw.adjust', 'withdraw_request', w.id, p_actor,
      coalesce(p_reason, format('admin removed %s', -p_delta)),
      jsonb_build_array(
        jsonb_build_object('account_id',
          account_of('player_escrow', w.player_id, w.platform_id, w.currency), 'amount', p_delta),
        jsonb_build_object('account_id',
          account_of('house_loss', null, null, w.currency), 'amount', -p_delta)
      ));
  end if;

  update withdraw_requests
     set gross_amount     = gross_amount + p_delta,
         amount           = amount + p_delta,
         amount_remaining = amount_remaining + p_delta,
         status           = (case when amount_remaining + p_delta >= amount + p_delta then 'queued'
                                  else 'partially_filled' end)::withdraw_status,
         completed_at     = null
   where id = w.id
  returning * into w;

  perform audit(p_actor, 'withdraw.adjust', 'withdraw_request', w.id,
                jsonb_build_object('delta', p_delta, 'reason', p_reason,
                                   'new_total', w.amount, 'new_remaining', w.amount_remaining));

  select * into pl from players where id = w.player_id;
  perform notify_admins('withdraw.adjusted', 'withdraw_request', w.id, jsonb_build_object(
    'name', pl.display_name, 'delta', p_delta, 'currency', w.currency,
    'new_total', w.amount, 'reason', p_reason));
  perform notify_player(w.player_id, 'withdraw.adjusted_player', 'withdraw_request', w.id,
    jsonb_build_object('delta', p_delta, 'new_total', w.amount, 'currency', w.currency,
                       'reason', p_reason));

  -- A downward adjustment can bring the unpaid part to zero → let it close.
  if w.amount_remaining = 0 then
    w := withdraw_settle_if_done(w.id);
  end if;
  return w;
end $$;
