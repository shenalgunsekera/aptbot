-- ═══════════════════════════════════════════════════════════════════════════
-- 0050 — notify_admins: payment.detected reaches BOTH platforms again
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 0048 made every admin notification single-platform. That's right for anything
-- tied to a player (approvals, receipts) — those route to that player's platform
-- via app.platform. But payment.detected comes from the email/crypto watchers,
-- which are NOT tied to a platform: a detected incoming payment can match a
-- deposit from a Telegram OR a Discord player, and whichever admin handles it
-- must be able to see it. With no fan-out it only landed in Telegram and the
-- Discord payments channel went silent. So payment.detected fans out to both;
-- everything else stays on the platform it came from.
create or replace function notify_admins(
  p_kind     text,
  p_ref_type text,
  p_ref_id   uuid,
  p_payload  jsonb default '{}'::jsonb
) returns bigint
language plpgsql as $$
declare
  v_id       bigint;
  v_platform text := coalesce(nullif(current_setting('app.platform', true), ''), 'telegram');
begin
  if p_kind = 'payment.detected' then
    -- The money-in feed goes to both platforms' payments channels.
    insert into notifications (audience, kind, ref_type, ref_id, payload, platform)
    values ('admins', p_kind, p_ref_type, p_ref_id, coalesce(p_payload, '{}'::jsonb), 'telegram')
    returning id into v_id;
    insert into notifications (audience, kind, ref_type, ref_id, payload, platform)
    values ('admins', p_kind, p_ref_type, p_ref_id, coalesce(p_payload, '{}'::jsonb), 'discord');
    return v_id;
  end if;

  insert into notifications (audience, kind, ref_type, ref_id, payload, platform)
  values ('admins', p_kind, p_ref_type, p_ref_id, coalesce(p_payload, '{}'::jsonb), v_platform)
  returning id into v_id;
  return v_id;
end $$;
