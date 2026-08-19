-- ═══════════════════════════════════════════════════════════════════════════
-- 0089 — Don't alert on a STALE crypto tx (so adding a watcher doesn't spam)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- When a new chain/token watcher is added, its first poll re-scans recent history
-- under a fresh dedup id — which would re-alert months-old payments. The event is
-- still recorded (so it's deduped forever), but if the on-chain tx is older than
-- 24h we stay SILENT on the UNMATCHED alert. A matched payment always alerts
-- (the deposit is current even if the tx confirmed hours ago), and detection
-- itself is unchanged — only the noisy "unmatched, and ancient" heads-up is
-- suppressed. Same body as the deployed function, plus the v_old guard.
create or replace function payment_detect(p_source text, p_external_id text, p_method_code text, p_amount bigint, p_currency text, p_raw jsonb default '{}'::jsonb, p_tolerance_bps integer default 0)
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
  v_old   boolean;
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

  -- A crypto tx older than 24h is history (a re-scan) — record it, but don't nag.
  v_old := p_source = 'crypto'
       and (p_raw ? 'ts') and (p_raw->>'ts') ~ '^[0-9]+$'
       and (p_raw->>'ts')::bigint < extract(epoch from now())::bigint - 86400;

  v_kind := coalesce(p_raw->>'kind', 'payment');
  if v_kind in ('request', 'cancel', 'sent') then
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

  -- Unmatched: alert unless stale/old. Crypto alerts for >= $5; dust stays quiet.
  if not coalesce((p_raw->>'stale')::boolean, false) and not v_old
     and (p_source <> 'crypto' or p_amount >= 500) then
    perform notify_admins('payment.detected', 'payment_event', ev_id, jsonb_build_object(
      'matched', false, 'source', p_source, 'amount', p_amount, 'currency', upper(p_currency),
      'method', v_label, 'ref', p_external_id, 'name', p_raw->>'name'));
  end if;
  return null;
end $$;
