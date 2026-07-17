-- ═══════════════════════════════════════════════════════════════════════════
-- 0027 — Don't spam admins with UNMATCHED crypto payments
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A club crypto address has its own history and ongoing activity. Reporting every
-- incoming transfer that doesn't line up with a pending request floods the admin
-- group. So: crypto only notifies when it MATCHES a waiting deposit. Unmatched
-- crypto is recorded (payment_events) but silent. Stripe/PayPal still report
-- unmatched, since money arriving there with no request genuinely needs a look.
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

  -- Unmatched: crypto stays SILENT (address has its own activity). Others alert.
  if p_source <> 'crypto' then
    perform notify_admins('payment.detected', 'payment_event', ev_id, jsonb_build_object(
      'matched', false, 'source', p_source, 'amount', p_amount,
      'currency', upper(p_currency), 'method', coalesce(m.name, p_method_code), 'ref', p_external_id));
  end if;
  return null;
end $$;
