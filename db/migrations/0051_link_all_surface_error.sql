-- ═══════════════════════════════════════════════════════════════════════════
-- 0051 — Approving a player must not silently fail
-- ═══════════════════════════════════════════════════════════════════════════
--
-- player_link_all links each claimed platform independently so one that can't
-- link (e.g. its ID is already taken by someone else) doesn't block the others.
-- But it swallowed EVERY error — so if the only platform failed, the admin card
-- still said "Approved — the player has been told" while the player stayed
-- pending and got no notification. Now: if we tried to link something and NOTHING
-- succeeded, re-raise the reason so the admin actually sees it (e.g. "ClubGG ID
-- 1234-5678 is already linked to another player"). Partial success still returns.
create or replace function player_link_all(p_player_id uuid, p_admin uuid)
returns int
language plpgsql as $$
declare
  r        record;
  v_count  int := 0;
  v_tried  int := 0;
  v_errmsg text;
  v_errcode text;
begin
  for r in
    select platform_id from player_platforms
     where player_id = p_player_id
       and platform_uid is null
       and coalesce(trim(platform_uid_claimed), '') <> ''
     order by platform_id
  loop
    v_tried := v_tried + 1;
    begin
      perform player_link(p_player_id, r.platform_id, p_admin, null, null);
      v_count := v_count + 1;
    exception when others then
      v_errmsg := sqlerrm;
      v_errcode := sqlstate;
    end;
  end loop;

  if v_count = 0 and v_tried > 0 then
    raise exception '%', coalesce(v_errmsg, 'could not link this player')
      using errcode = coalesce(nullif(v_errcode, ''), '22023');
  end if;
  return v_count;
end $$;
