-- ═══════════════════════════════════════════════════════════════════════════
-- 0010 — Registration, linking, preferences, risk
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Register ───────────────────────────────────────────────────────────────
-- Called on /start. Idempotent: /start twice is not an error.
--
-- The NAME is taken here and is the union-wide identifier — unique, and what
-- every human sees before they act. A collision is refused at this door rather
-- than discovered later by a loader looking at two identical rows.
create or replace function player_register(
  p_telegram_id  bigint,
  p_username     text default null,
  p_display_name text default null
) returns players
language plpgsql as $$
declare
  pl players;
begin
  select * into pl from players where telegram_id = p_telegram_id for update;

  if found then
    update players
       set telegram_username = coalesce(p_username, telegram_username),
           display_name      = coalesce(pl.display_name, p_display_name)
     where id = pl.id
    returning * into pl;
    return pl;
  end if;

  insert into players (telegram_id, telegram_username, display_name, status)
  values (p_telegram_id, p_username, nullif(trim(p_display_name), ''), 'pending')
  returning * into pl;

  insert into player_prefs (player_id) values (pl.id) on conflict do nothing;

  perform notify_admins('player.registered', 'player', pl.id,
    jsonb_build_object('telegram_id', p_telegram_id, 'username', p_username,
                       'name', pl.display_name));
  return pl;
end $$;

-- ─── Set the name ───────────────────────────────────────────────────────────
-- The name is an identifier, so this is a real decision, not a profile field.
-- Refused if taken; refused once linked (an admin must do it, because a rename
-- changes what every loader is looking for).
create or replace function player_set_name(
  p_player_id uuid,
  p_name      text,
  p_admin     uuid default null
) returns players
language plpgsql as $$
declare
  pl players;
begin
  select * into pl from players where id = p_player_id for update;
  if not found then
    raise exception 'player % not found', p_player_id;
  end if;
  if coalesce(trim(p_name), '') = '' then
    raise exception 'we need a name'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Once an admin has confirmed who this is, only an admin may change it.
  if p_admin is null
     and exists (select 1 from player_platforms
                  where player_id = pl.id and platform_uid is not null) then
    raise exception 'your name is already confirmed — ask an admin to change it'
      using errcode = 'insufficient_privilege';
  end if;

  if exists (
    select 1 from players
     where display_name_key = lower(trim(p_name))
       and id <> pl.id and status <> 'banned'
  ) then
    raise exception 'someone is already using that name — please pick another'
      using errcode = 'unique_violation';
  end if;

  update players set display_name = trim(p_name) where id = pl.id returning * into pl;

  if p_admin is not null then
    perform audit(p_admin, 'player.rename', 'player', pl.id,
                  jsonb_build_object('name', pl.display_name));
  end if;
  return pl;
end $$;

-- ─── Claim an account on a platform ─────────────────────────────────────────
-- The player says "this is my ClubGG id". Untrusted until an admin confirms.
create or replace function player_claim_platform(
  p_player_id   uuid,
  p_platform_id uuid,
  p_uid         text
) returns player_platforms
language plpgsql as $$
declare
  pp player_platforms;
  pf platforms;
begin
  select * into pf from platforms where id = p_platform_id;
  if not found or not pf.enabled then
    raise exception 'that platform is not available'
      using errcode = 'invalid_parameter_value';
  end if;
  if coalesce(trim(p_uid), '') = '' then
    raise exception 'we need your % ID', pf.name
      using errcode = 'invalid_parameter_value';
  end if;

  insert into player_platforms (player_id, platform_id, platform_uid_claimed)
  values (p_player_id, p_platform_id, trim(p_uid))
  on conflict (player_id, platform_id) do update
    -- Only an UNLINKED account may revise its claim. Once confirmed, changing it
    -- is an admin action — otherwise a player could re-point their account at
    -- someone else's after the fact.
    set platform_uid_claimed = case
          when player_platforms.platform_uid is null then excluded.platform_uid_claimed
          else player_platforms.platform_uid_claimed end
  returning * into pp;

  if pp.platform_uid is null then
    perform notify_admins('player.claim', 'player', p_player_id,
      jsonb_build_object('platform', pf.name, 'uid_claimed', pp.platform_uid_claimed,
                         'name', (select display_name from players where id = p_player_id)));
  end if;
  return pp;
end $$;

-- ─── Link ───────────────────────────────────────────────────────────────────
-- An admin confirms the mapping and activates the account. THE gate: before it,
-- the player cannot transact and no value can move.
--
-- Verification is GLOBAL — it answers "is this really their account?", which has
-- nothing to do with which club loads them. Club assignment is routing, resolved
-- when known (automatically when the platform has one club, otherwise later).
-- Blocking the security boundary on a logistics decision is backwards.
create or replace function player_link(
  p_player_id   uuid,
  p_platform_id uuid,
  p_admin       uuid,
  p_uid         text default null,
  p_club_id     uuid default null
) returns player_platforms
language plpgsql as $$
declare
  pl     players;
  pp     player_platforms;
  adm    admins;
  pf     platforms;
  v_uid  text;
  v_club uuid;
begin
  select * into adm from admins where id = p_admin and not disabled;
  if not found then
    raise exception 'admin % not found or disabled', p_admin
      using errcode = 'insufficient_privilege';
  end if;

  select * into pl from players where id = p_player_id for update;
  if not found then
    raise exception 'player % not found', p_player_id;
  end if;
  if coalesce(trim(pl.display_name), '') = '' then
    raise exception 'this player has no name yet — a name is required before linking'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into pf from platforms where id = p_platform_id;
  select * into pp from player_platforms
   where player_id = p_player_id and platform_id = p_platform_id for update;
  if not found then
    raise exception 'this player has not claimed a % account', pf.name
      using errcode = 'invalid_parameter_value';
  end if;

  v_uid := coalesce(nullif(trim(p_uid), ''), pp.platform_uid_claimed);
  if coalesce(trim(v_uid), '') = '' then
    raise exception 'no % ID to link — the player has not given one', pf.name
      using errcode = 'invalid_parameter_value';
  end if;

  -- The one check that stays absolute. Two players on one id means every credit
  -- either is owed lands in the same account and the ledger cannot tell whose.
  if exists (
    select 1 from player_platforms
     where platform_id = p_platform_id and platform_uid = v_uid and id <> pp.id
  ) then
    raise exception '% ID % is already linked to another player', pf.name, v_uid
      using errcode = 'unique_violation';
  end if;

  -- explicit → existing → the sole club → null (fine: loader work will ask).
  v_club := coalesce(p_club_id, pp.club_id, sole_club_id(p_platform_id));

  update player_platforms
     set platform_uid = v_uid, club_id = v_club,
         linked_by = p_admin, linked_at = now()
   where id = pp.id
  returning * into pp;

  update players set status = 'active' where id = pl.id and status = 'pending';

  perform audit(p_admin, 'player.link', 'player', pl.id,
    jsonb_build_object('platform', pf.name, 'uid', v_uid, 'club_id', v_club,
                       'name', pl.display_name, 'claimed_was', pp.platform_uid_claimed,
                       'club_pending', v_club is null));
  perform notify_player(pl.id, 'player.linked', 'player', pl.id,
    jsonb_build_object('platform', pf.name, 'uid', v_uid));

  -- Approved but unrouted. Not an error — but somebody must notice before their
  -- first deposit, not at exactly the wrong moment.
  if v_club is null then
    perform notify_admins('player.needs_club', 'player', pl.id,
      jsonb_build_object('platform', pf.name, 'uid', v_uid, 'name', pl.display_name));
  end if;
  return pp;
end $$;

-- ─── Assign a club ──────────────────────────────────────────────────────────
create or replace function player_set_club(
  p_player_id   uuid,
  p_platform_id uuid,
  p_club_id     uuid,
  p_admin       uuid
) returns player_platforms
language plpgsql as $$
declare
  pp     player_platforms;
  cl     clubs;
  v_open int;
begin
  if not exists (select 1 from admins where id = p_admin and not disabled) then
    raise exception 'admin % not found or disabled', p_admin
      using errcode = 'insufficient_privilege';
  end if;

  select * into cl from clubs where id = p_club_id;
  if not found then
    raise exception 'club % not found', p_club_id;
  end if;
  if cl.platform_id <> p_platform_id then
    raise exception 'that club is not on that platform'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Moving a player mid-flight would leave outstanding jobs addressed to the old
  -- club's loader while new ones go elsewhere — two loaders, one player, and no
  -- way to tell who was supposed to do what.
  select count(*) into v_open
    from loader_orders
   where player_id = p_player_id and platform_id = p_platform_id
     and status in ('pending', 'claimed');
  if v_open > 0 then
    raise exception 'this player has % jobs outstanding — finish those before moving them', v_open
      using errcode = 'invalid_parameter_value';
  end if;

  update player_platforms
     set club_id = p_club_id
   where player_id = p_player_id and platform_id = p_platform_id
  returning * into pp;
  if not found then
    raise exception 'this player has no account on that platform'
      using errcode = 'invalid_parameter_value';
  end if;

  perform audit(p_admin, 'player.set_club', 'player', p_player_id,
                jsonb_build_object('club', cl.name, 'platform_id', p_platform_id));
  return pp;
end $$;

-- ─── Status ─────────────────────────────────────────────────────────────────
-- Balances are never touched: a frozen player still owns their money, they just
-- cannot start anything new. Money already in flight settles on its own —
-- stranding a counterparty because someone ELSE got frozen punishes the wrong
-- person.
create or replace function player_set_status(
  p_player_id uuid,
  p_status    player_status,
  p_admin     uuid,
  p_reason    text
) returns players
language plpgsql as $$
declare
  pl  players;
  adm admins;
begin
  select * into adm from admins where id = p_admin and not disabled;
  if not found then
    raise exception 'admin % not found or disabled', p_admin
      using errcode = 'insufficient_privilege';
  end if;
  if p_status = 'banned' and adm.role <> 'owner' then
    raise exception 'only the owner can ban a player'
      using errcode = 'insufficient_privilege';
  end if;

  select * into pl from players where id = p_player_id for update;
  if not found then
    raise exception 'player % not found', p_player_id;
  end if;

  update players set status = p_status where id = pl.id returning * into pl;

  perform audit(p_admin, 'player.set_status', 'player', pl.id,
                jsonb_build_object('status', p_status, 'reason', p_reason));
  perform notify_player(pl.id, 'player.status_changed', 'player', pl.id,
                        jsonb_build_object('status', p_status, 'reason', p_reason));
  return pl;
end $$;

-- ─── Preferences ────────────────────────────────────────────────────────────
-- "for the first time they choose only, they will be given the option to either
--  choose whether they want to permanently only use ClubGG, or Sportsbook, or
--  whether they want the option every time."
--
-- Null default = ask every time. The `_asked` flags are what make it a
-- first-run question and not a recurring nag: once asked, never asked again.
create or replace function prefs_set_platform(
  p_player_id   uuid,
  p_platform_id uuid   -- null = ask every time
) returns player_prefs
language plpgsql as $$
declare
  p player_prefs;
begin
  insert into player_prefs (player_id, default_platform_id, platform_asked)
  values (p_player_id, p_platform_id, true)
  on conflict (player_id) do update
    set default_platform_id = excluded.default_platform_id,
        platform_asked = true
  returning * into p;
  return p;
end $$;

create or replace function prefs_set_method(
  p_player_id uuid,
  p_method_id uuid     -- null = ask every time
) returns player_prefs
language plpgsql as $$
declare
  p player_prefs;
begin
  insert into player_prefs (player_id, default_method_id, method_asked)
  values (p_player_id, p_method_id, true)
  on conflict (player_id) do update
    set default_method_id = excluded.default_method_id,
        method_asked = true
  returning * into p;
  return p;
end $$;

-- ─── Velocity / collusion checks ────────────────────────────────────────────
-- Advisory only — these raise flags for a human, they never block money. An
-- automated freeze on a heuristic hands any griefer a denial-of-service against
-- honest players: transact with your target a few times and get them frozen.
--
-- Self-dealing is absent on purpose: it is not detected after the fact, it is
-- made impossible at the source by the `player_id <> d.player_id` predicate in
-- deposit_match. A control that cannot be violated needs no alarm.
create or replace function risk_scan(
  p_window     interval default interval '7 days',
  p_pair_limit int default 3
) returns table (player_id uuid, code text, detail jsonb)
language plpgsql as $$
begin
  -- The same two people settling with each other over and over. Legitimate at
  -- low counts (friends), a laundering ring at high ones.
  return query
    select dep.player_id, 'repeated_pair'::text,
           jsonb_build_object('counterparty', w.player_id, 'fills', count(*),
                              'total', sum(f.amount), 'window', p_window::text)
      from fills f
      join deposit_requests dep on dep.id = f.deposit_id
      join withdraw_requests w  on w.id  = f.withdraw_id
     where f.created_at > now() - p_window
       and f.status in ('awaiting_confirmation', 'released')
     group by dep.player_id, w.player_id
    having count(*) > p_pair_limit;

  -- Deposits opened and abandoned in bulk: harvesting counterparty details.
  return query
    select d.player_id, 'handle_harvesting'::text,
           jsonb_build_object('expired', count(*), 'window', p_window::text)
      from deposit_requests d
     where d.created_at > now() - p_window
       and d.status in ('expired', 'cancelled')
     group by d.player_id
    having count(*) >= 5;
end $$;

create or replace function risk_scan_and_flag()
returns int
language plpgsql as $$
declare
  r       record;
  v_count int := 0;
begin
  for r in select * from risk_scan() loop
    -- Don't re-flag the same thing hourly; one open flag per code is enough to
    -- get a human looking.
    if not exists (
      select 1 from players p, jsonb_array_elements(p.risk_flags) fl
       where p.id = r.player_id and fl->>'code' = r.code
         and (fl->>'at')::timestamptz > now() - interval '7 days'
    ) then
      perform flag_player(r.player_id, r.code, r.detail::text, null);
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end $$;
