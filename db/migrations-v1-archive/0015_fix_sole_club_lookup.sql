-- ═══════════════════════════════════════════════════════════════════════════
-- 0015 — Fix: min(uuid) does not exist
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 0014 used `select count(*), min(id) into v_clubs, v_club from clubs` to find
-- the sole club in one pass. Postgres has no min() for uuid, so every one of
-- those functions raised at RUNTIME:
--
--     ERROR: function min(uuid) does not exist
--
-- The migration itself applied cleanly because plpgsql only parses a function
-- body at CREATE time — it does not resolve the functions called inside it. So
-- this was invisible until a real player registered.
--
-- Replaced with an explicit count-then-fetch. `order by created_at` makes "the
-- sole club" deterministic even in the degenerate case where the count check is
-- somehow raced.
create or replace function sole_club_id()
returns uuid
language plpgsql stable as $$
declare
  v_count int;
  v_id    uuid;
begin
  select count(*) into v_count from clubs where enabled;
  if v_count <> 1 then
    return null;   -- zero clubs, or a real choice to be made
  end if;
  select id into v_id from clubs where enabled order by created_at limit 1;
  return v_id;
end $$;

comment on function sole_club_id() is
  'The only enabled club, or null when there is a genuine choice to make.';

-- ─── Registration ───────────────────────────────────────────────────────────
create or replace function player_register(
  p_telegram_id     bigint,
  p_username        text default null,
  p_display_name    text default null,
  p_clubgg_claimed  text default null
) returns players
language plpgsql as $$
declare
  pl     players;
  v_club uuid := sole_club_id();
begin
  select * into pl from players where telegram_id = p_telegram_id for update;

  if found then
    update players
       set telegram_username = coalesce(p_username, telegram_username),
           display_name      = coalesce(p_display_name, display_name),
           clubgg_id_claimed = case
                                 when clubgg_id is null
                                   then coalesce(nullif(trim(p_clubgg_claimed), ''), clubgg_id_claimed)
                                 else clubgg_id_claimed
                               end,
           club_id = coalesce(club_id, v_club)
     where id = pl.id
    returning * into pl;
    return pl;
  end if;

  insert into players (telegram_id, telegram_username, display_name,
                       clubgg_id_claimed, status, club_id)
  values (p_telegram_id, p_username, p_display_name,
          nullif(trim(p_clubgg_claimed), ''), 'pending', v_club)
  returning * into pl;

  perform notify_admins('player.registered', 'player', pl.id,
    jsonb_build_object('telegram_id', p_telegram_id, 'username', p_username,
                       'clubgg_claimed', pl.clubgg_id_claimed));
  return pl;
end $$;

-- ─── Linking ────────────────────────────────────────────────────────────────
create or replace function player_link(
  p_player_id uuid,
  p_admin     uuid,
  p_clubgg_id text default null,
  p_club_id   uuid default null
) returns players
language plpgsql as $$
declare
  pl     players;
  adm    admins;
  v_id   text;
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

  v_id := coalesce(nullif(trim(p_clubgg_id), ''), pl.clubgg_id_claimed);
  if coalesce(trim(v_id), '') = '' then
    raise exception 'no ClubGG id to link — the player has not supplied one'
      using errcode = 'invalid_parameter_value';
  end if;

  if exists (select 1 from players where clubgg_id = v_id and id <> pl.id) then
    raise exception 'ClubGG id % is already linked to another player', v_id
      using errcode = 'unique_violation';
  end if;

  -- explicit → the player's existing club → the sole club.
  v_club := coalesce(p_club_id, pl.club_id, sole_club_id());
  if v_club is null then
    raise exception
      'this union has more than one club — say which one this player belongs to'
      using errcode = 'invalid_parameter_value';
  end if;

  update players
     set clubgg_id = v_id,
         club_id   = v_club,
         linked_by = p_admin,
         linked_at = now(),
         status    = case when status = 'pending' then 'active' else status end
   where id = pl.id
  returning * into pl;

  perform audit(p_admin, 'player.link', 'player', pl.id,
    jsonb_build_object('clubgg_id', v_id, 'club_id', v_club,
                       'claimed_was', pl.clubgg_id_claimed));
  perform notify_player(pl.id, 'player.linked', 'player', pl.id,
    jsonb_build_object('clubgg_id', v_id));
  return pl;
end $$;

-- ─── Chip order routing ─────────────────────────────────────────────────────
create or replace function chip_order_create(
  p_player_id uuid,
  p_delta     bigint,
  p_currency  char(3),
  p_reason    text,
  p_ref_type  text default null,
  p_ref_id    uuid default null,
  p_note      text default null
) returns chip_orders
language plpgsql as $$
declare
  pl     players;
  cl     clubs;
  o      chip_orders;
  v_club uuid;
begin
  select * into pl from players where id = p_player_id for update;
  if not found then
    raise exception 'chip_order_create: player % not found', p_player_id;
  end if;

  if pl.clubgg_id is null then
    raise exception
      'player % has no confirmed ClubGG id — an admin must link the account before chips can move',
      p_player_id
      using errcode = 'invalid_parameter_value';
  end if;

  v_club := coalesce(pl.club_id, sole_club_id());
  if v_club is null then
    raise exception
      'player % is not assigned to a club, and this union has more than one — assign one in the panel',
      p_player_id
      using errcode = 'invalid_parameter_value';
  end if;

  -- Adopt the sole club so this resolves once, not on every order.
  if pl.club_id is null then
    update players set club_id = v_club where id = pl.id;
  end if;

  select * into cl from clubs where id = v_club;
  if not cl.enabled then
    raise exception 'club % (%) is disabled — chip work cannot be routed to it', cl.name, cl.code
      using errcode = 'invalid_parameter_value';
  end if;

  insert into chip_orders (player_id, club_id, clubgg_id, delta, currency,
                           reason, ref_type, ref_id, note)
  values (p_player_id, v_club, pl.clubgg_id, p_delta, p_currency,
          p_reason, p_ref_type, p_ref_id, p_note)
  returning * into o;

  if cl.owner_admin_id is not null then
    insert into notifications (admin_id, kind, ref_type, ref_id, payload)
    select cl.owner_admin_id, 'chip_order.pending', 'chip_order', o.id,
           jsonb_build_object('player_id', p_player_id, 'clubgg_id', pl.clubgg_id,
                              'club', cl.name, 'delta', p_delta,
                              'currency', p_currency, 'reason', p_reason)
     where exists (select 1 from admins a
                    where a.id = cl.owner_admin_id and not a.disabled
                      and a.telegram_id is not null);
  else
    perform notify_admins('chip_order.pending', 'chip_order', o.id,
      jsonb_build_object('player_id', p_player_id, 'clubgg_id', pl.clubgg_id,
                         'club', cl.name, 'delta', p_delta,
                         'currency', p_currency, 'reason', p_reason));
  end if;

  return o;
end $$;

-- Backfill anyone stranded by the broken 0014.
update players
   set club_id = sole_club_id()
 where club_id is null and sole_club_id() is not null;
