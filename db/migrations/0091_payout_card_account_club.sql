-- ═══════════════════════════════════════════════════════════════════════════
-- 0091 — The "Cash-out to pay" card shows the player's platform account + club
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The loader (add/take-off) card and the receipt-to-verify card already name the
-- player's ClubGG/Sportsbook account and their club. The "Cash-out to pay" card
-- (withdraw.needs_payout) did not — it showed only the display name and the
-- payout handle, so an admin paying it couldn't see which club the player is on.
--
-- Add a small helper that returns {account, club, platform} for a withdrawal, and
-- merge it into the two payloads that raise withdraw.needs_payout: withdraw_escrow
-- (club-settled cash-outs) and withdraw_small_pay_alert (the small-P2P nudge).
-- `account` is the ClubGG USERNAME (or the Sportsbook username / uid), never a bare
-- numeric id, falling back to the display name — same rule as the loader card.

create or replace function withdraw_payout_extra(p_withdraw_id uuid) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'account', coalesce(
      case when pf.code = 'clubgg' then pp.platform_username else pp.platform_uid end,
      pl.display_name),
    'club', cl.name,
    'platform', pf.name)
    from withdraw_requests w
    join players pl on pl.id = w.player_id
    left join platforms pf on pf.id = w.platform_id
    left join player_platforms pp on pp.player_id = w.player_id and pp.platform_id = w.platform_id
    left join clubs cl on cl.id = pp.club_id
   where w.id = p_withdraw_id;
$$;

-- ── withdraw_escrow: club-settled cash-out → "pay it" card ───────────────────
-- Unchanged from 0016 except the notify payload gains withdraw_payout_extra(w.id).
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
                         'method', m.name, 'handle', w.payout_handle)
      || withdraw_payout_extra(w.id));
  end if;

  return w;
end $$;

-- ── withdraw_small_pay_alert: small-P2P "pay it directly" nudge ──────────────
-- Unchanged from 0090 except the notify payload gains withdraw_payout_extra(new.id).
create or replace function withdraw_small_pay_alert() returns trigger
language plpgsql as $$
declare
  m   payment_methods;
  cfg config;
  pl  players;
begin
  if new.status not in ('queued', 'partially_filled') or coalesce(new.amount_remaining, 0) <= 0 then
    new.small_alert_sent_at := null;
    return new;
  end if;

  if new.paused_at is not null then
    return new;   -- paused → an admin is handling it; don't nudge anyone else
  end if;

  if exists (select 1 from fills
              where withdraw_id = new.id and status in ('locked', 'awaiting_confirmation')) then
    return new;
  end if;

  select * into m from payment_methods where id = new.method_id;
  if m.settlement <> 'p2p' then
    return new;
  end if;

  select * into cfg from config where id;
  if new.amount_remaining >= cfg.min_amount then
    new.small_alert_sent_at := null;
    return new;
  end if;

  if new.small_alert_sent_at is not null then
    return new;
  end if;

  select * into pl from players where id = new.player_id;
  perform notify_admins('withdraw.needs_payout', 'withdraw_request', new.id,
    jsonb_build_object('withdraw_id', new.id, 'name', pl.display_name,
                       'amount', new.amount_remaining, 'currency', new.currency,
                       'method', m.name, 'handle', new.payout_handle,
                       'small', true, 'min', cfg.min_amount)
    || withdraw_payout_extra(new.id));
  new.small_alert_sent_at := now();
  return new;
end $$;
