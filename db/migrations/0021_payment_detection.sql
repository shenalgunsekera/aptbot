-- ═══════════════════════════════════════════════════════════════════════════
-- 0021 — Automatic payment detection (assist, NOT auto-release)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Stripe/Apple Pay (webhook), PayPal (webhook/email), and crypto (chain polling)
-- can all tell us "money arrived". This does NOT release anything — an admin
-- still taps Verify. It just lets the admins KNOW a payment landed, fast, so they
-- aren't waiting on the player's word.
--
-- Every inbound signal lands in payment_events, keyed uniquely per source so a
-- provider retrying its webhook can't double-notify. We try to match it to a
-- pending fill by method + amount; matched or not, the admins get ONE concise
-- message per real payment.

create table if not exists payment_events (
  id           uuid primary key default gen_random_uuid(),
  source       text not null,                 -- 'stripe' | 'paypal' | 'crypto'
  external_id  text not null,                 -- provider event/tx id — the dedupe key
  method_code  text,
  amount       bigint,                        -- minor units, as received
  currency     char(3),
  matched_fill_id uuid references fills (id),
  raw          jsonb,
  created_at   timestamptz not null default now(),
  unique (source, external_id)
);
create index if not exists payment_events_fill_idx on payment_events (matched_fill_id);

-- Detection annotations on the fill (never gates release; purely informational).
alter table fills add column if not exists detected_at     timestamptz;
alter table fills add column if not exists detected_source text;
alter table fills add column if not exists detected_ref    text;

-- ─── The matcher ────────────────────────────────────────────────────────────
-- Returns the matched fill id, or null (no match, or a duplicate event).
create or replace function payment_detect(
  p_source      text,
  p_external_id text,
  p_method_code text,
  p_amount      bigint,
  p_currency    text,
  p_raw         jsonb default '{}'::jsonb
) returns uuid
language plpgsql as $$
declare
  ev_id   uuid;
  m       payment_methods;
  f       fills;
  pl_name text;
begin
  -- Idempotent: the same provider event twice inserts once. A duplicate returns
  -- no row here, so we neither re-match nor re-notify.
  insert into payment_events (source, external_id, method_code, amount, currency, raw)
  values (p_source, p_external_id, p_method_code, p_amount, upper(p_currency), coalesce(p_raw, '{}'::jsonb))
  on conflict (source, external_id) do nothing
  returning id into ev_id;
  if ev_id is null then
    return null;   -- already processed
  end if;

  select * into m from payment_methods where code = p_method_code;

  -- Find a pending fill on this method whose charge amount matches. gross_to_send
  -- is what the payer was told to send, so that's what actually arrives.
  if m.id is not null then
    select * into f
      from fills
     where method_id = m.id
       and currency = coalesce(upper(p_currency), currency)
       and status in ('locked', 'awaiting_confirmation')
       and detected_at is null
       and gross_to_send = p_amount
     order by created_at desc
     for update skip locked
     limit 1;
  end if;

  if f.id is not null then
    update fills
       set detected_at = now(), detected_source = p_source, detected_ref = p_external_id
     where id = f.id;
    update payment_events set matched_fill_id = f.id where id = ev_id;

    select dp.display_name into pl_name
      from deposit_requests d join players dp on dp.id = d.player_id
     where d.id = f.deposit_id;

    perform notify_admins('payment.detected', 'fill', f.id, jsonb_build_object(
      'matched', true, 'fill_id', f.id, 'source', p_source,
      'amount', p_amount, 'currency', upper(p_currency),
      'method', coalesce(m.name, p_method_code), 'name', pl_name, 'ref', p_external_id));
    return f.id;
  end if;

  -- No pending request matched — money arrived unexpectedly. Still tell admins
  -- once (money in with no request is exactly what they must not miss).
  perform notify_admins('payment.detected', 'payment_event', ev_id, jsonb_build_object(
    'matched', false, 'source', p_source, 'amount', p_amount,
    'currency', upper(p_currency), 'method', coalesce(m.name, p_method_code), 'ref', p_external_id));
  return null;
end $$;
