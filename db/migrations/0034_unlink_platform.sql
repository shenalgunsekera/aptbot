-- ═══════════════════════════════════════════════════════════════════════════
-- 0034 — Let a player remove (un-link) a platform, safely
-- ═══════════════════════════════════════════════════════════════════════════
-- Only when nothing is in flight on it — an open deposit, an open cash out, or a
-- pending loader job would be stranded otherwise.
create or replace function player_unlink_platform(p_player uuid, p_platform uuid)
returns void
language plpgsql as $$
declare v_open int;
begin
  select count(*) into v_open from deposit_requests
   where player_id = p_player and platform_id = p_platform
     and status in ('matching', 'awaiting_payment', 'awaiting_confirmation');
  if v_open > 0 then
    raise exception 'you have a deposit in progress on that platform — finish or cancel it first'
      using errcode = 'invalid_parameter_value';
  end if;

  select count(*) into v_open from withdraw_requests
   where player_id = p_player and platform_id = p_platform
     and status in ('pending_unload', 'queued', 'partially_filled', 'filled');
  if v_open > 0 then
    raise exception 'you have a cash out in progress on that platform — finish or cancel it first'
      using errcode = 'invalid_parameter_value';
  end if;

  select count(*) into v_open from loader_orders
   where player_id = p_player and platform_id = p_platform and status in ('pending', 'claimed');
  if v_open > 0 then
    raise exception 'there''s a job still running on that platform — try again shortly'
      using errcode = 'invalid_parameter_value';
  end if;

  delete from player_platforms where player_id = p_player and platform_id = p_platform;
end $$;
