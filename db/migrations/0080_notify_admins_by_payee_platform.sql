-- ═══════════════════════════════════════════════════════════════════════════
-- 0080 — Withdrawal admin cards land on the PAYEE's platform, not the actor's
-- ═══════════════════════════════════════════════════════════════════════════
--
-- notify_admins stamps the acting bot's platform (app.platform). That misroutes
-- anything tied to a withdrawal when the two platforms cross: a Telegram deposit
-- settling a DISCORD player's cash-out fires the "small cash-out — pay it
-- directly" card in the TELEGRAM admin group, even though the cash-out (and the
-- admins who should pay it) live on Discord. Confusing, and the reverse too.
--
-- Fix: for any admin card tied to a withdraw_request, route by the WITHDRAWAL's
-- player platform (Discord if they have a discord link, else Telegram) — the same
-- rule notify_player uses (0075). payment.detected still fans to both; everything
-- else keeps the acting platform.
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

  -- A card ABOUT a specific cash-out belongs where that cash-out was made, so the
  -- admins on that platform act on it — regardless of who triggered it.
  if p_ref_type = 'withdraw_request' then
    v_platform := (
      select case when exists (
                    select 1 from discord_players dp
                     where dp.player_id = w.player_id)
                  then 'discord' else 'telegram' end
        from withdraw_requests w where w.id = p_ref_id);
    v_platform := coalesce(v_platform, 'telegram');
  end if;

  insert into notifications (audience, kind, ref_type, ref_id, payload, platform)
  values ('admins', p_kind, p_ref_type, p_ref_id, coalesce(p_payload, '{}'::jsonb), v_platform)
  returning id into v_id;
  return v_id;
end $$;
