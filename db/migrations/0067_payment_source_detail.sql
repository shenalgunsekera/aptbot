-- ═══════════════════════════════════════════════════════════════════════════
-- 0067 — Show the REAL payment source (Stripe: Apple Pay / Cash App Pay / Link …)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The Stripe webhook now derives what the payer actually used and passes it as
-- raw.source_detail. Both detection functions prefer it for the alert's method
-- label, so a Stripe payment says "Apple Pay (Visa, Debit)" / "Cash App Pay" /
-- "Link" instead of a generic "Stripe". Other rails have no source_detail, so
-- they fall back to the method name unchanged.

create or replace function payment_detect(
  p_source text, p_external_id text, p_method_code text, p_amount bigint,
  p_currency text, p_raw jsonb default '{}'::jsonb, p_tolerance_bps integer default 0)
returns uuid
language plpgsql as $$
declare
  ev_id   uuid;
  m       payment_methods;
  f       fills;
  pl_name text;
  v_lo    bigint;
  v_hi    bigint;
  v_kind  text;
  v_label text;
begin
  insert into payment_events (source, external_id, method_code, amount, currency, raw)
  values (p_source, p_external_id, p_method_code, p_amount, upper(p_currency), coalesce(p_raw, '{}'::jsonb))
  on conflict (source, external_id) do nothing
  returning id into ev_id;
  if ev_id is null then
    return null;
  end if;

  select * into m from payment_methods where code = p_method_code;
  v_label := coalesce(nullif(p_raw->>'source_detail', ''), m.name, p_method_code);

  v_kind := coalesce(p_raw->>'kind', 'payment');
  if v_kind in ('request', 'cancel') then
    if not coalesce((p_raw->>'stale')::boolean, false) then
      perform notify_admins('payment.detected', 'payment_event', ev_id, jsonb_build_object(
        'matched', false, 'kind', v_kind, 'source', p_source, 'amount', p_amount,
        'currency', upper(p_currency), 'method', v_label,
        'ref', p_external_id, 'name', p_raw->>'name'));
    end if;
    return null;
  end if;

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
      'method', v_label, 'name', pl_name, 'ref', p_external_id));
    return f.id;
  end if;

  -- Unmatched: alert unless stale. Crypto alerts for >= $5; dust stays quiet.
  if not coalesce((p_raw->>'stale')::boolean, false)
     and (p_source <> 'crypto' or p_amount >= 500) then
    perform notify_admins('payment.detected', 'payment_event', ev_id, jsonb_build_object(
      'matched', false, 'source', p_source, 'amount', p_amount, 'currency', upper(p_currency),
      'method', v_label, 'ref', p_external_id, 'name', p_raw->>'name'));
  end if;
  return null;
end $$;

create or replace function payment_detect_fill(
  p_source      text,
  p_external_id text,
  p_fill_id     uuid,
  p_amount      bigint,
  p_raw         jsonb default '{}'::jsonb
) returns uuid
language plpgsql as $$
declare
  ev_id   uuid;
  f       fills;
  m_name  text;
  pl_name text;
begin
  insert into payment_events (source, external_id, method_code, amount, currency, raw)
  values (p_source, p_external_id, null, p_amount, 'USD', coalesce(p_raw, '{}'::jsonb))
  on conflict (source, external_id) do nothing
  returning id into ev_id;
  if ev_id is null then
    return null;
  end if;

  select * into f from fills
   where id = p_fill_id and status in ('locked', 'awaiting_confirmation') and detected_at is null
   for update skip locked;
  if f.id is null then
    return null;
  end if;

  if f.status = 'locked' then
    perform fill_submit_proof(f.id, p_external_id, 'stripe checkout', false);
  end if;

  update fills set detected_at = now(), detected_source = p_source, detected_ref = p_external_id where id = f.id;
  update payment_events set matched_fill_id = f.id,
         method_code = (select code from payment_methods where id = f.method_id) where id = ev_id;

  select name into m_name from payment_methods where id = f.method_id;
  select dp.display_name into pl_name
    from deposit_requests d join players dp on dp.id = d.player_id where d.id = f.deposit_id;

  perform notify_admins('payment.detected', 'fill', f.id, jsonb_build_object(
    'matched', true, 'fill_id', f.id, 'source', p_source,
    'amount', f.gross_to_send, 'currency', f.currency, 'approx', false,
    'method', coalesce(nullif(p_raw->>'source_detail', ''), m_name), 'name', pl_name, 'ref', p_external_id));
  return f.id;
end $$;
