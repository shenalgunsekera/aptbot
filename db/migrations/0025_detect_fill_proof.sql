-- ═══════════════════════════════════════════════════════════════════════════
-- 0025 — A detected Stripe payment also marks the fill "paid" so it's verifiable
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A Stripe deposit has no receipt step, so its fill sits at 'locked'. But an admin
-- can only Verify a fill that's 'awaiting_confirmation'. So when the Checkout
-- webhook matches the fill, we submit proof for it (moving it to
-- awaiting_confirmation) before flagging it detected — then the admin's Verify
-- button works. Still assist-only: nothing releases until the admin taps Verify.
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

  -- Move a still-locked fill to awaiting_confirmation so an admin can verify it.
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
    'method', m_name, 'name', pl_name, 'ref', p_external_id));
  return f.id;
end $$;
