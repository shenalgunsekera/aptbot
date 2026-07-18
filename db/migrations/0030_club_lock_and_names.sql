-- ═══════════════════════════════════════════════════════════════════════════
-- 0030 — Club deposits stay open long enough for crypto; Stripe shows the name
-- ═══════════════════════════════════════════════════════════════════════════
--
-- BUG: a deposit fill locks for match_timeout_seconds (5 min) — the p2p
-- handle-reveal window. But a CLUB deposit (crypto / PayPal / Cash App) waits for
-- the player to actually pay and for on-chain / processor confirmation, which is
-- far longer. So crypto payments were detected AFTER the fill had already expired
-- and could never match. Club deposit fills (withdraw_id null) now get 24 hours.
create or replace function extend_club_deposit_lock() returns trigger
language plpgsql as $$
begin
  if new.deposit_id is not null and new.withdraw_id is null and new.status = 'locked' then
    new.lock_expires_at := now() + interval '24 hours';
  end if;
  return new;
end $$;

drop trigger if exists fills_club_deposit_lock on fills;
create trigger fills_club_deposit_lock
  before insert on fills
  for each row execute function extend_club_deposit_lock();

-- Stripe's checkout session carries the payer's billing name, so the "payment
-- received" alert CAN show a name even on a shared link. Re-enable the Stripe
-- unmatched alert (crypto stays silent) and include the name from the payload.
create or replace function payment_detect(
  p_source        text,
  p_external_id   text,
  p_method_code   text,
  p_amount        bigint,
  p_currency      text,
  p_raw           jsonb default '{}'::jsonb,
  p_tolerance_bps int  default 0
) returns uuid
language plpgsql as $$
declare
  ev_id   uuid;
  m       payment_methods;
  f       fills;
  pl_name text;
  v_lo    bigint;
  v_hi    bigint;
begin
  insert into payment_events (source, external_id, method_code, amount, currency, raw)
  values (p_source, p_external_id, p_method_code, p_amount, upper(p_currency), coalesce(p_raw, '{}'::jsonb))
  on conflict (source, external_id) do nothing
  returning id into ev_id;
  if ev_id is null then
    return null;
  end if;

  select * into m from payment_methods where code = p_method_code;

  if m.id is not null then
    if p_tolerance_bps <= 0 then
      select * into f from fills
       where method_id = m.id and currency = coalesce(upper(p_currency), currency)
         and status in ('locked', 'awaiting_confirmation') and detected_at is null
         and gross_to_send = p_amount
       order by created_at desc for update skip locked limit 1;
    else
      v_lo := (p_amount * (10000 - p_tolerance_bps)) / 10000;
      v_hi := (p_amount * (10000 + p_tolerance_bps)) / 10000;
      select * into f from fills
       where method_id = m.id and currency = coalesce(upper(p_currency), currency)
         and status in ('locked', 'awaiting_confirmation') and detected_at is null
         and gross_to_send between v_lo and v_hi
       order by abs(gross_to_send - p_amount) asc, created_at desc for update skip locked limit 1;
    end if;
  end if;

  if f.id is not null then
    update fills set detected_at = now(), detected_source = p_source, detected_ref = p_external_id where id = f.id;
    update payment_events set matched_fill_id = f.id where id = ev_id;
    select dp.display_name into pl_name
      from deposit_requests d join players dp on dp.id = d.player_id where d.id = f.deposit_id;
    perform notify_admins('payment.detected', 'fill', f.id, jsonb_build_object(
      'matched', true, 'fill_id', f.id, 'source', p_source,
      'amount', f.gross_to_send, 'currency', f.currency, 'approx', p_tolerance_bps > 0,
      'method', coalesce(m.name, p_method_code), 'name', pl_name, 'ref', p_external_id));
    return f.id;
  end if;

  -- Unmatched: crypto stays silent (address has its own history). Stripe & PayPal
  -- alert, now with the payer's name when the provider gave us one.
  if p_source <> 'crypto' then
    perform notify_admins('payment.detected', 'payment_event', ev_id, jsonb_build_object(
      'matched', false, 'source', p_source, 'amount', p_amount, 'currency', upper(p_currency),
      'method', coalesce(m.name, p_method_code), 'ref', p_external_id, 'name', p_raw->>'name'));
  end if;
  return null;
end $$;
