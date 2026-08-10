-- ═══════════════════════════════════════════════════════════════════════════
-- 0065 — admin_set_platform_uid can also set the account password (secret)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The panel's "Edit details" now edits a player's account fields directly —
-- ClubGG ID + username, Sportsbook username + password, etc. The password lives
-- in player_platforms.secret, so this adds an optional p_secret. Blank = keep.
--
-- Adding a param makes an OVERLOAD, so drop the old 5-arg first (a 5-arg call
-- then resolves to this one with p_secret defaulted null).
drop function if exists admin_set_platform_uid(uuid, uuid, text, text, uuid);
create or replace function admin_set_platform_uid(
  p_player   uuid,
  p_platform uuid,
  p_uid      text,
  p_username text,
  p_admin    uuid,
  p_secret   text default null
) returns void
language plpgsql as $$
declare
  v_uid    text := nullif(trim(p_uid), '');
  v_name   text := nullif(trim(p_username), '');
  v_secret text := nullif(trim(p_secret), '');
  pf       platforms;
begin
  select * into pf from platforms where id = p_platform;
  if not found then raise exception 'that platform is not available' using errcode = 'invalid_parameter_value'; end if;

  if not exists (select 1 from player_platforms where player_id = p_player and platform_id = p_platform) then
    raise exception '% is not one of this player''s accounts', pf.name using errcode = 'invalid_parameter_value';
  end if;

  if v_uid is not null and exists (
       select 1 from player_platforms
        where platform_id = p_platform and platform_uid = v_uid and player_id <> p_player) then
    raise exception '% ID % is already linked to another player', pf.name, v_uid using errcode = 'unique_violation';
  end if;

  update player_platforms
     set platform_uid       = coalesce(v_uid, platform_uid),
         platform_username  = coalesce(v_name, platform_username),
         secret             = coalesce(v_secret, secret),
         updated_at         = now()
   where player_id = p_player and platform_id = p_platform;

  perform audit(p_admin, 'player.edit_account', 'player', p_player,
                jsonb_build_object('platform', pf.name, 'uid', v_uid, 'username', v_name,
                                   'secret_changed', v_secret is not null));
end $$;
