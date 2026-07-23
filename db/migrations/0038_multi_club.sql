-- ═══════════════════════════════════════════════════════════════════════════
-- 0038 — A player can belong to several clubs on a platform
-- ═══════════════════════════════════════════════════════════════════════════
-- Until now a player had one club per platform (player_platforms.club_id). Now
-- they can be in several ClubGG clubs: they pick them at signup, and each ClubGG
-- deposit/cash-out asks which one (auto when there's only one). player_platforms
-- .club_id stays as the ACTIVE routing club — the one the current job goes to —
-- and player_clubs is the full membership.

create table if not exists player_clubs (
  id         uuid primary key default gen_random_uuid(),
  player_id  uuid not null references players(id) on delete cascade,
  club_id    uuid not null references clubs(id)   on delete cascade,
  created_at timestamptz not null default now(),
  unique (player_id, club_id)
);
create index if not exists player_clubs_player_idx on player_clubs (player_id);

-- Replace a player's club membership for ONE platform (leaves other platforms'
-- memberships untouched). Also repoints the active club_id at one they're in.
create or replace function player_set_clubs(p_player uuid, p_platform uuid, p_clubs uuid[])
returns void
language plpgsql as $$
declare v_active uuid;
begin
  delete from player_clubs pc using clubs c
   where pc.club_id = c.id and pc.player_id = p_player and c.platform_id = p_platform;

  insert into player_clubs (player_id, club_id)
    select p_player, c.id from clubs c
     where c.id = any(p_clubs) and c.platform_id = p_platform and c.enabled
    on conflict do nothing;

  -- Point the active routing club at a club they're actually in (alphabetical,
  -- stable). Only overwrite if the current one is unset or no longer a member.
  select pc.club_id into v_active
    from player_clubs pc join clubs c on c.id = pc.club_id
   where pc.player_id = p_player and c.platform_id = p_platform
   order by c.name limit 1;

  update player_platforms pp set club_id = v_active
   where pp.player_id = p_player and pp.platform_id = p_platform
     and (pp.club_id is null
          or not exists (select 1 from player_clubs pc where pc.player_id = p_player and pc.club_id = pp.club_id));
end $$;

-- Choose the active routing club for the next job (deposit/cash-out). Must be a
-- club the player belongs to.
create or replace function player_set_active_club(p_player uuid, p_platform uuid, p_club uuid)
returns void
language plpgsql as $$
begin
  if not exists (select 1 from player_clubs where player_id = p_player and club_id = p_club) then
    raise exception 'you are not a member of that club' using errcode = 'invalid_parameter_value';
  end if;
  update player_platforms set club_id = p_club
   where player_id = p_player and platform_id = p_platform;
end $$;

-- ── Admin club management ──
create or replace function club_create(p_platform uuid, p_name text, p_platform_club_id text, p_admin uuid)
returns clubs
language plpgsql as $$
declare c clubs; v_code text; v_pcid text;
begin
  if coalesce(trim(p_name), '') = '' then
    raise exception 'a club needs a name' using errcode = 'invalid_parameter_value';
  end if;
  if not exists (select 1 from platforms where id = p_platform) then
    raise exception 'unknown platform' using errcode = 'invalid_parameter_value';
  end if;
  -- platform_club_id is NOT NULL + unique per platform; fall back to a clearly
  -- unfinished placeholder the admin can fix later rather than blocking creation.
  v_pcid := coalesce(nullif(trim(p_platform_club_id), ''), 'SET-ME-' || substr(gen_random_uuid()::text, 1, 8));
  v_code := lower(regexp_replace(trim(p_name), '[^a-zA-Z0-9]+', '_', 'g')) || '_' || substr(gen_random_uuid()::text, 1, 6);
  insert into clubs (platform_id, code, name, platform_club_id, owner_admin_id, enabled)
    values (p_platform, v_code, trim(p_name), v_pcid, p_admin, true)
  returning * into c;
  return c;
end $$;

create or replace function club_update(p_club uuid, p_name text, p_platform_club_id text, p_enabled boolean)
returns clubs
language plpgsql as $$
declare c clubs;
begin
  update clubs set
      name             = coalesce(nullif(trim(p_name), ''), name),
      platform_club_id = coalesce(nullif(trim(p_platform_club_id), ''), platform_club_id),
      enabled          = coalesce(p_enabled, enabled),
      updated_at       = now()
   where id = p_club
  returning * into c;
  if not found then raise exception 'club not found'; end if;
  return c;
end $$;

-- Backfill: everyone already routed to a club is a member of it.
insert into player_clubs (player_id, club_id)
  select pp.player_id, pp.club_id from player_platforms pp
   where pp.club_id is not null
  on conflict do nothing;
