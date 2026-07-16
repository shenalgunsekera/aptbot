-- ═══════════════════════════════════════════════════════════════════════════
-- 0014 — Stop making single-club unions do club admin
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 0013 made chip work club-routed and refused to queue an order for a player
-- with no club. That is right in a multi-club union — an unrouted order is one
-- that NO worker will ever claim, so it would sit pending forever while the
-- ledger insisted chips were owed.
--
-- But it made a player registering through the bot dead on arrival:
--
--     player 895fc072-… is not assigned to a club — chip work cannot be routed
--
-- …because player_register never set one, and nothing else did either. The
-- constraint was correct and the ergonomics were broken.
--
-- The resolution: when the union has exactly ONE enabled club, "which club?" is
-- not a real question. Answer it automatically. When there are several it IS a
-- real question, and the constraint stands — because guessing which club owner's
-- device should load a stranger's chips is not a thing software should do.

-- ─── Registration puts players in the club, when there is only one ──────────
create or replace function player_register(
  p_telegram_id     bigint,
  p_username        text default null,
  p_display_name    text default null,
  p_clubgg_claimed  text default null
) returns players
language plpgsql as $$
declare
  pl         players;
  v_club     uuid;
  v_clubs    int;
begin
  -- Exactly one enabled club ⇒ no ambiguity ⇒ assign it. More than one and we
  -- leave it null for an admin to decide at link time.
  select count(*), min(id) into v_clubs, v_club from clubs where enabled;

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
           -- Backfill anyone who registered before this migration.
           club_id = coalesce(club_id, case when v_clubs = 1 then v_club end)
     where id = pl.id
    returning * into pl;
    return pl;
  end if;

  insert into players (telegram_id, telegram_username, display_name,
                       clubgg_id_claimed, status, club_id)
  values (p_telegram_id, p_username, p_display_name,
          nullif(trim(p_clubgg_claimed), ''), 'pending',
          case when v_clubs = 1 then v_club end)
  returning * into pl;

  perform notify_admins('player.registered', 'player', pl.id,
    jsonb_build_object('telegram_id', p_telegram_id, 'username', p_username,
                       'clubgg_claimed', pl.clubgg_id_claimed));
  return pl;
end $$;

-- ─── Linking assigns a club too ─────────────────────────────────────────────
-- The admin is already confirming this player's ClubGG id; the club is the same
-- decision. p_club_id defaults to the only enabled club, so the common path stays
-- one tap.
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
  v_clubs int;
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

  -- explicit → keep it; else the player's existing club; else the sole club.
  select count(*), min(id) into v_clubs, v_club from clubs where enabled;
  v_club := coalesce(p_club_id, pl.club_id, case when v_clubs = 1 then v_club end);

  if v_club is null then
    raise exception
      'this union has % clubs — say which one this player belongs to before linking them', v_clubs
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

-- ─── Last-resort fallback at the point of use ───────────────────────────────
-- Belt and braces for players created by any path that predates or bypasses the
-- above. Same rule: one club is not a question, several clubs is.
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
  pl      players;
  cl      clubs;
  o       chip_orders;
  v_club  uuid;
  v_clubs int;
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

  v_club := pl.club_id;
  if v_club is null then
    select count(*), min(id) into v_clubs, v_club from clubs where enabled;
    if v_clubs <> 1 then
      raise exception
        'player % is not assigned to a club, and this union has % of them — assign one in the panel',
        p_player_id, v_clubs
        using errcode = 'invalid_parameter_value';
    end if;
    -- Sole club: adopt it and remember, so this resolves once rather than on
    -- every order.
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

-- ─── Backfill ───────────────────────────────────────────────────────────────
-- Anyone already stuck, including the player in the error report.
update players p
   set club_id = (select id from clubs where enabled limit 1)
 where p.club_id is null
   and (select count(*) from clubs where enabled) = 1;
