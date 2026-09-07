-- ═══════════════════════════════════════════════════════════════════════════
-- 0106 — Admin-added, club-funded payouts in the cash-out queue
-- ═══════════════════════════════════════════════════════════════════════════
-- Admins can drop a Venmo/Zelle tag straight into the CASH-OUT queue (not just
-- player cash-outs). It's funded by the club's float: it sits in the queue like a
-- normal cash-out and any P2P deposit of the same method fills it (matching is by
-- method + amount, not platform, so it's fillable from any platform). When a
-- depositor pays the tag and the fill is released, the depositor is credited and
-- the club's float has paid that tag. No unload / loader job — no player chips move.
--
-- Escrow at creation (sums to zero):
--     owner_float            −amount      (the club puts up its own money)
--     player_escrow(house)   +amount      (held behind this queue entry)
-- Release (existing fill.release, unchanged): player_escrow(house) → depositor's
-- house_settlement credit. So end to end: owner_float −amount, external tag paid.
--
-- The escrow needs an owner, so a single hidden "house" player holds it. It never
-- deposits and has no chat, so it never matches as a payer and never gets messaged.

alter table players add column if not exists is_house boolean not null default false;

insert into players (telegram_id, display_name, status, is_house)
select -1000, 'Club Payout', 'active', true
where not exists (select 1 from players where is_house);

create or replace function withdraw_create_club(
  p_method_id uuid, p_platform_id uuid, p_amount bigint, p_payout_handle text, p_admin uuid)
returns withdraw_requests
language plpgsql as $$
declare
  m     payment_methods;
  pf    platforms;
  house players;
  w     withdraw_requests;
begin
  select * into house from players where is_house order by created_at limit 1;
  if not found then raise exception 'no house player configured'; end if;

  select * into m from payment_methods where id = p_method_id;
  if not found or not m.enabled then
    raise exception 'that payment method is not available' using errcode = 'invalid_parameter_value'; end if;
  if m.settlement <> 'p2p' then
    raise exception 'only peer-to-peer methods (Venmo, Zelle, …) can be queued' using errcode = 'invalid_parameter_value'; end if;

  select * into pf from platforms where id = p_platform_id;
  if not found or not pf.enabled then
    raise exception 'that platform is not available' using errcode = 'invalid_parameter_value'; end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'enter an amount to pay' using errcode = 'invalid_parameter_value'; end if;
  if coalesce(trim(p_payout_handle), '') = '' then
    raise exception 'enter the Venmo/Zelle tag to pay' using errcode = 'invalid_parameter_value'; end if;

  -- No rake on a club payout (the club is paying its own money out). It goes
  -- straight to 'queued' — there's nothing to unload from a player's table.
  insert into withdraw_requests (
    player_id, platform_id, method_id, currency,
    requested_amount, gross_amount, rake_amount, amount, amount_remaining,
    payout_handle, status, terms
  ) values (
    house.id, p_platform_id, p_method_id, m.currency,
    p_amount, p_amount, 0, p_amount, p_amount,
    trim(p_payout_handle), 'queued',
    jsonb_build_object('method_code', m.code, 'settlement', m.settlement, 'club_payout', true)
  ) returning * into w;

  perform ledger_post(
    'withdraw.club_escrow', 'withdraw_request', w.id, p_admin,
    format('club-funded payout of %s to %s via %s', p_amount, trim(p_payout_handle), m.name),
    jsonb_build_array(
      jsonb_build_object('account_id', account_of('owner_float', null, null, m.currency), 'amount', -p_amount),
      jsonb_build_object('account_id', account_of('player_escrow', house.id, p_platform_id, m.currency), 'amount', p_amount)
    ));

  perform audit(p_admin, 'withdraw.club_create', 'withdraw_request', w.id,
    jsonb_build_object('amount', p_amount, 'method', m.code, 'handle', trim(p_payout_handle)));
  return w;
end $$;

-- Cancel a club payout that hasn't been fully taken: return the still-unfilled
-- escrow to the float. Any slice a depositor is already paying plays out normally.
create or replace function withdraw_club_cancel(p_withdraw_id uuid, p_admin uuid)
returns withdraw_requests
language plpgsql as $$
declare
  w      withdraw_requests;
  house  players;
  v_back bigint;
begin
  select * into w from withdraw_requests where id = p_withdraw_id for update;
  if not found then raise exception 'that cash-out no longer exists'; end if;
  if coalesce((w.terms->>'club_payout')::boolean, false) is not true then
    raise exception 'that is not a club payout' using errcode = 'invalid_parameter_value'; end if;
  if w.status not in ('queued', 'partially_filled') then
    raise exception 'that payout is % — it can''t be cancelled', w.status using errcode = 'invalid_parameter_value'; end if;

  select * into house from players where id = w.player_id;
  v_back := w.amount_remaining;

  if v_back > 0 then
    perform ledger_post(
      'withdraw.club_cancel', 'withdraw_request', w.id, p_admin,
      format('club payout cancelled — %s returned to float', v_back),
      jsonb_build_array(
        jsonb_build_object('account_id', account_of('player_escrow', house.id, w.platform_id, w.currency), 'amount', -v_back),
        jsonb_build_object('account_id', account_of('owner_float', null, null, w.currency), 'amount', v_back)
      ));
  end if;

  update withdraw_requests set status = 'cancelled', amount_remaining = 0 where id = w.id returning * into w;
  perform audit(p_admin, 'withdraw.club_cancel', 'withdraw_request', w.id, jsonb_build_object('returned', v_back));
  return w;
end $$;
