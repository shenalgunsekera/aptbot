-- ═══════════════════════════════════════════════════════════════════════════
-- 0052 — Collect a ClubGG username alongside the ClubGG ID
-- ═══════════════════════════════════════════════════════════════════════════
--
-- ClubGG players are identified by a numeric ID (1234-5678) AND a username on
-- ClubGG. We now ask for both at setup so the admin can match the person on the
-- platform. Stored per-platform; carried on the "wants to link" alert.
alter table player_platforms add column if not exists platform_username text;

-- Recreate with an optional username. Adding a parameter makes an OVERLOAD, not a
-- replacement, which would make existing 3-arg calls ambiguous — so drop first.
drop function if exists player_claim_platform(uuid, uuid, text);
create or replace function player_claim_platform(
  p_player_id   uuid,
  p_platform_id uuid,
  p_uid         text,
  p_username    text default null
) returns player_platforms
language plpgsql as $$
declare
  pp player_platforms;
  pf platforms;
begin
  select * into pf from platforms where id = p_platform_id;
  if not found or not pf.enabled then
    raise exception 'that platform is not available' using errcode = 'invalid_parameter_value';
  end if;
  if coalesce(trim(p_uid), '') = '' then
    raise exception 'we need your % ID', pf.name using errcode = 'invalid_parameter_value';
  end if;

  insert into player_platforms (player_id, platform_id, platform_uid_claimed, platform_username)
  values (p_player_id, p_platform_id, trim(p_uid), nullif(trim(p_username), ''))
  on conflict (player_id, platform_id) do update
    set platform_uid_claimed = case
          when player_platforms.platform_uid is null then excluded.platform_uid_claimed
          else player_platforms.platform_uid_claimed end,
        platform_username = coalesce(excluded.platform_username, player_platforms.platform_username)
  returning * into pp;

  if pp.platform_uid is null then
    perform notify_admins('player.claim', 'player', p_player_id,
      jsonb_build_object('platform', pf.name, 'uid_claimed', pp.platform_uid_claimed,
                         'username', pp.platform_username,
                         'name', (select display_name from players where id = p_player_id)));
  end if;
  return pp;
end $$;
