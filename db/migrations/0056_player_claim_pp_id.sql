-- ═══════════════════════════════════════════════════════════════════════════
-- 0056 — Restore the Approve button on the "wants to link" admin card
-- ═══════════════════════════════════════════════════════════════════════════
--
-- REGRESSION from 0052: recreating player_claim_platform to carry the ClubGG
-- username rebuilt the player.claim payload but dropped 'pp_id' (the
-- player_platform id). Both bots only attach the ✅ Approve button when
-- `pp_id` is present (notifier.ts), so admins lost the ability to approve a
-- link straight from the group — they saw the card with no button.
--
-- Only change vs 0052: add 'pp_id', pp.id back to the notify payload.
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
      jsonb_build_object('pp_id', pp.id, 'platform', pf.name,
                         'uid_claimed', pp.platform_uid_claimed,
                         'username', pp.platform_username,
                         'name', (select display_name from players where id = p_player_id)));
  end if;
  return pp;
end $$;
