-- ═══════════════════════════════════════════════════════════════════════════
-- 0023 — Match a detected payment to a SPECIFIC fill (for Stripe Checkout)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A Stripe Checkout session is created for one fill and carries that fill's id in
-- metadata, so when it completes we know EXACTLY which request it paid — no amount
-- guessing. Same idempotency + "assist only, admin still verifies" as the rest.
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
  m       payment_methods;
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
    return null;   -- already handled / released; nothing to flag
  end if;

  update fills set detected_at = now(), detected_source = p_source, detected_ref = p_external_id where id = f.id;
  update payment_events set matched_fill_id = f.id, method_code = (select code from payment_methods where id = f.method_id) where id = ev_id;

  select name into m.name from payment_methods where id = f.method_id;
  select dp.display_name into pl_name
    from deposit_requests d join players dp on dp.id = d.player_id where d.id = f.deposit_id;

  perform notify_admins('payment.detected', 'fill', f.id, jsonb_build_object(
    'matched', true, 'fill_id', f.id, 'source', p_source,
    'amount', f.gross_to_send, 'currency', f.currency, 'approx', false,
    'method', m.name, 'name', pl_name, 'ref', p_external_id));
  return f.id;
end $$;
