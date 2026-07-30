-- ═══════════════════════════════════════════════════════════════════════════
-- 0048 — notify_admins: one platform per notification, no fan-out
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Every admin notification — payment.detected included — goes ONLY to the
-- platform it came from (the app.platform GUC), not to both. Telegram-detected
-- payments show in the Telegram payments channel; Discord-originated ones in the
-- Discord channel. No duplication across platforms.
create or replace function notify_admins(
  p_kind     text,
  p_ref_type text,
  p_ref_id   uuid,
  p_payload  jsonb default '{}'::jsonb
) returns bigint
language sql as $$
  insert into notifications (audience, kind, ref_type, ref_id, payload, platform)
  values ('admins', p_kind, p_ref_type, p_ref_id, coalesce(p_payload, '{}'::jsonb),
          coalesce(nullif(current_setting('app.platform', true), ''), 'telegram'))
  returning id;
$$;
