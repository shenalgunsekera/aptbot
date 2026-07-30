-- ═══════════════════════════════════════════════════════════════════════════
-- 0047 — notify_admins: restore per-platform routing (regression from 0044)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- d0001 (Discord) made notify_admins stamp the row with the current platform
-- (app.platform GUC — the Discord bot sets it to 'discord'), so a Discord
-- player's approval/receipt lands in the Discord admin channel. 0044 rewrote the
-- function for the payments-feed fan-out but hardcoded 'telegram', so ALL admin
-- notifications — including Discord ones — went to Telegram. Read the GUC again,
-- and keep payment.detected fanning out to BOTH platforms.
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
  insert into notifications (audience, kind, ref_type, ref_id, payload, platform)
  values ('admins', p_kind, p_ref_type, p_ref_id, coalesce(p_payload, '{}'::jsonb), v_platform)
  returning id into v_id;

  -- The money-in feed shows on BOTH platforms' payments channels, whichever side
  -- detected it — so also emit the row for the other platform.
  if p_kind = 'payment.detected' then
    insert into notifications (audience, kind, ref_type, ref_id, payload, platform)
    values ('admins', p_kind, p_ref_type, p_ref_id, coalesce(p_payload, '{}'::jsonb),
            case when v_platform = 'telegram' then 'discord' else 'telegram' end);
  end if;
  return v_id;
end $$;
