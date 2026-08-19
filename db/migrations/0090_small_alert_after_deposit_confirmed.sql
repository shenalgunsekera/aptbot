-- ═══════════════════════════════════════════════════════════════════════════
-- 0090 — The "pay the rest directly" nudge waits until pending deposits confirm
-- ═══════════════════════════════════════════════════════════════════════════
--
-- When a depositor matches PART of a cash-out, the unmatched remainder can drop
-- below the minimum and fire the "small cash-out — pay it directly" card — even
-- though the depositor's payment isn't confirmed yet. If that deposit is then
-- discarded, the money comes back and the remainder was never really small.
--
-- Fix: don't fire the nudge while any fill on the cash-out is still LOCKED or
-- AWAITING_CONFIRMATION (an unconfirmed deposit). Once every such fill is
-- released (confirmed) or cancelled (dropped), re-evaluate — a released fill
-- doesn't touch the withdraw row, so a small AFTER-trigger on fills nudges the
-- withdraw so the check re-runs at exactly the right moment.

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

  -- A deposit matched part of this cash-out but hasn't been confirmed by an admin
  -- yet (locked = awaiting payment/proof; awaiting_confirmation = awaiting Verify).
  -- Wait for it to be released or dropped before nudging anyone to pay the rest.
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
                       'small', true, 'min', cfg.min_amount));
  new.small_alert_sent_at := now();
  return new;
end $$;

-- Re-run the small-payout check the moment a deposit on a cash-out is confirmed
-- (released) or dropped (cancelled). A released fill doesn't change the withdraw
-- row, so nudge it with a no-op touch that fires the BEFORE trigger above.
create or replace function withdraw_reeval_small_alert() returns trigger
language plpgsql as $$
begin
  if new.withdraw_id is not null
     and new.status is distinct from old.status
     and new.status in ('released', 'cancelled') then
    update withdraw_requests set amount_remaining = amount_remaining where id = new.withdraw_id;
  end if;
  return new;
end $$;

drop trigger if exists fills_reeval_small_alert on fills;
create trigger fills_reeval_small_alert after update on fills
  for each row execute function withdraw_reeval_small_alert();
