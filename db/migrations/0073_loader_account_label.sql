-- ═══════════════════════════════════════════════════════════════════════════
-- 0073 — loader.work card shows the platform ACCOUNT NAME + a [ClubGG]/[Sportsbook] tag
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The "Player:" line on the loader (add/take-off) card showed the Telegram/Discord
-- display name. Admins want the platform account instead: the ClubGG USERNAME (not
-- the numeric ID) or the Sportsbook username, tagged with the platform. Only change
-- vs the current definition: look up the platform and add `platform` + `account` to
-- the loader.work payload (account falls back to the display name, never an ID).

create or replace function loader_order_create(
  p_player_id uuid, p_platform_id uuid, p_delta bigint, p_currency character,
  p_reason text, p_ref_type text default null, p_ref_id uuid default null, p_note text default null)
returns loader_orders
language plpgsql as $$
declare
  pl     players;
  pp     player_platforms;
  cl     clubs;
  o      loader_orders;
  v_club uuid;
  v_pf   platforms;
begin
  select * into pl from players where id = p_player_id;
  if not found then
    raise exception 'loader_order_create: player % not found', p_player_id;
  end if;

  select * into pp from player_platforms
   where player_id = p_player_id and platform_id = p_platform_id for update;
  if not found or pp.platform_uid is null then
    raise exception
      'this player has no confirmed account on that platform — an admin must link it first'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_pf from platforms where id = p_platform_id;

  -- An order with no club is one no loader will ever pick up: it would sit
  -- pending forever while the ledger insisted value was owed.
  v_club := coalesce(pp.club_id, sole_club_id(p_platform_id));
  if v_club is null then
    raise exception
      'this player is not assigned to a club on that platform — assign one in the panel'
      using errcode = 'invalid_parameter_value';
  end if;
  if pp.club_id is null then
    update player_platforms set club_id = v_club where id = pp.id;
  end if;

  select * into cl from clubs where id = v_club;
  if not cl.enabled then
    raise exception 'club % is disabled — work cannot be routed to it', cl.name
      using errcode = 'invalid_parameter_value';
  end if;

  insert into loader_orders (
    player_id, platform_id, club_id, platform_uid, player_name,
    delta, currency, reason, ref_type, ref_id, note
  ) values (
    p_player_id, p_platform_id, v_club, pp.platform_uid, coalesce(pl.display_name, 'unnamed'),
    p_delta, p_currency, p_reason, p_ref_type, p_ref_id, p_note
  ) returning * into o;

  perform notify_admins('loader.work', 'loader_order', o.id,
    jsonb_build_object('player_name', o.player_name, 'platform_uid', o.platform_uid,
                       'club', cl.name, 'delta', o.delta, 'currency', o.currency,
                       'reason', o.reason,
                       'platform', v_pf.name,
                       'account', coalesce(
                         case when v_pf.code = 'clubgg' then pp.platform_username else pp.platform_uid end,
                         o.player_name)));
  return o;
end $$;
