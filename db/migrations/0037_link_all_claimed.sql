-- ═══════════════════════════════════════════════════════════════════════════
-- 0037 — One "Approve" confirms ALL of a player's claimed platforms
-- ═══════════════════════════════════════════════════════════════════════════
-- Before: each platform had its own approve button, and linking any one flipped
-- the player to active (see player_link). So a player who picked ClubGG AND
-- Sportsbook would get one approved, look "done", and the other silently stayed
-- unconfirmed — dropping out of the deposit menu. Now approving links every
-- platform they've given an id for, in one go.
--
-- Platforms still awaiting account CREATION (no claimed id yet, e.g. a new APT
-- Sports account) are skipped here — they get linked when the account is made.
create or replace function player_link_all(p_player_id uuid, p_admin uuid)
returns int
language plpgsql as $$
declare
  r       record;
  v_count int := 0;
begin
  for r in
    select platform_id from player_platforms
     where player_id = p_player_id
       and platform_uid is null
       and coalesce(trim(platform_uid_claimed), '') <> ''
     order by platform_id
  loop
    -- Link each independently: a platform that can't link (e.g. its id is already
    -- taken by someone else) must not block the others.
    begin
      perform player_link(p_player_id, r.platform_id, p_admin, null, null);
      v_count := v_count + 1;
    exception when others then
      null;
    end;
  end loop;
  return v_count;
end $$;
