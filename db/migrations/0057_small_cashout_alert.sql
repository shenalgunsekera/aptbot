-- ═══════════════════════════════════════════════════════════════════════════
-- 0057 — Alert admins to pay SMALL P2P cash-outs directly (under the minimum)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Club-method cash-outs (crypto/PayPal/Stripe/Cash App) already get a
-- `withdraw.needs_payout` "pay it + I paid it" card at escrow (0016). The P2P
-- rails (Venmo/Zelle) instead go to the depositor-matching queue — and a
-- remainder below the deposit minimum (config.min_amount, $20) can sit there
-- forever because no single depositor will match something that small. So the
-- admins are never prompted and the player waits.
--
-- Fix: whenever a P2P cash-out is waiting to be paid with LESS than the minimum
-- still owed, fire the same actionable pay card to the admin group — carrying a
-- `small` flag so the message says "pay it directly". It STAYS in the queue
-- (a depositor could still fill it; amount_remaining + row locks make double-pay
-- impossible), we just make sure a human is told. Deduped via small_alert_sent_at
-- so a card is sent once per time it drops below the line, not on every update.
--
-- notify_admins reads the app.platform GUC, so a Telegram player's small cash-out
-- lands in the Telegram admin group and a Discord player's in the Discord one.

alter table withdraw_requests add column if not exists small_alert_sent_at timestamptz;

create or replace function withdraw_small_pay_alert() returns trigger
language plpgsql as $$
declare
  m   payment_methods;
  cfg config;
  pl  players;
begin
  -- Only cash-outs that are waiting to be paid, with something still owed.
  if new.status not in ('queued', 'partially_filled') or coalesce(new.amount_remaining, 0) <= 0 then
    new.small_alert_sent_at := null;   -- nothing to pay now → re-arm for later
    return new;
  end if;

  select * into m from payment_methods where id = new.method_id;
  -- Club methods already got their pay card at escrow; only P2P needs this.
  if m.settlement <> 'p2p' then
    return new;
  end if;

  select * into cfg from config where id;
  if new.amount_remaining >= cfg.min_amount then
    new.small_alert_sent_at := null;   -- not small (any more) → re-arm
    return new;
  end if;

  if new.small_alert_sent_at is not null then
    return new;   -- already alerted at this small level; don't spam
  end if;

  select * into pl from players where id = new.player_id;
  perform notify_admins('withdraw.needs_payout', 'withdraw_request', new.id,
    jsonb_build_object('withdraw_id', new.id, 'name', pl.display_name,
                       'amount', new.amount_remaining, 'currency', new.currency,
                       'method', m.name, 'handle', new.payout_handle,
                       'small', true, 'min', cfg.min_amount));
  new.small_alert_sent_at := now();
  return new;
end $$;

drop trigger if exists withdraw_small_pay_alert_trg on withdraw_requests;
create trigger withdraw_small_pay_alert_trg
  before insert or update on withdraw_requests
  for each row execute function withdraw_small_pay_alert();
