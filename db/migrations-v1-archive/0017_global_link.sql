-- ═══════════════════════════════════════════════════════════════════════════
-- 0017 — Account verification is GLOBAL; club is routing
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 0015 made player_link refuse to link anyone when the union had more than one
-- club, demanding the admin pick one first. That conflated two questions that
-- are not the same question:
--
--   "Is this a real union member, and is this really their ClubGG id?"
--        → a GLOBAL fact about a person. An admin confirms it against the
--          roster. Nothing about it is club-specific.
--
--   "Whose device loads their chips?"
--        → OPERATIONAL routing, and only relevant at the moment chips actually
--          move.
--
-- Tying the first to the second meant an admin could not approve a player they
-- had already verified, purely because a routing decision had not been made yet.
-- The verification is the security boundary; the routing is logistics. Blocking
-- the boundary on the logistics is backwards.
--
-- So: link is global and always available. Club is assigned when known — the
-- sole club automatically, otherwise later in the panel. chip_order_create still
-- insists on a club, because THAT is the moment routing genuinely matters, and
-- an unrouted order is one no worker will ever claim.
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

  -- The one check that stays absolute. Two players on one ClubGG id means every
  -- chip either of them is ever owed lands in the same account, and the ledger
  -- cannot tell whose it was.
  if exists (select 1 from players where clubgg_id = v_id and id <> pl.id) then
    raise exception 'ClubGG id % is already linked to another player', v_id
      using errcode = 'unique_violation';
  end if;

  -- explicit → whatever they already had → the sole club → null.
  -- Null is fine HERE: the player is verified and can transact. Chip work will
  -- ask for a club when there is chip work, and chip_order_create says so
  -- clearly if one is still needed.
  v_club := coalesce(p_club_id, pl.club_id, sole_club_id());

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
                       'claimed_was', pl.clubgg_id_claimed,
                       'club_pending', v_club is null));

  perform notify_player(pl.id, 'player.linked', 'player', pl.id,
    jsonb_build_object('clubgg_id', v_id));

  -- Approved but unrouted. Not an error — but somebody has to notice before
  -- their first deposit, or it fails at exactly the wrong moment.
  if v_club is null then
    perform notify_admins('player.needs_club', 'player', pl.id,
      jsonb_build_object('clubgg_id', v_id, 'display_name', pl.display_name));
  end if;

  return pl;
end $$;

-- Surfaces verified-but-unrouted players in the admin inbox, so "assign a club"
-- is a visible task rather than a surprise the first time they deposit.
create or replace view v_admin_inbox as
select 'dispute' as kind, di.id as ref_id, di.created_at,
       jsonb_build_object(
         'fill_id', di.fill_id, 'reason', di.reason,
         'amount', f.amount, 'currency', f.currency,
         'payment_ref', f.payment_ref) as detail,
       0 as priority
  from disputes di join fills f on f.id = di.fill_id
 where di.status = 'open'

union all
select 'escalated_fill', f.id, f.escalated_at,
       jsonb_build_object(
         'amount', f.amount, 'currency', f.currency,
         'payment_ref', f.payment_ref,
         'waiting_since', f.submitted_at,
         'backstop', f.withdraw_id is null),
       1
  from fills f
 where f.status = 'awaiting_confirmation' and f.escalated_at is not null

union all
select 'pending_link', p.id, p.created_at,
       jsonb_build_object('telegram_id', p.telegram_id,
                          'username', p.telegram_username,
                          'clubgg_claimed', p.clubgg_id_claimed),
       2
  from players p
 where p.status = 'pending' and p.clubgg_id_claimed is not null

union all
select 'needs_club', p.id, p.linked_at,
       jsonb_build_object('clubgg_id', p.clubgg_id,
                          'display_name', p.display_name,
                          'telegram_id', p.telegram_id),
       2
  from players p
 where p.status = 'active' and p.clubgg_id is not null and p.club_id is null

union all
select 'chip_order', co.id, co.created_at,
       jsonb_build_object('player_id', co.player_id, 'clubgg_id', co.clubgg_id,
                          'delta', co.delta, 'currency', co.currency,
                          'reason', co.reason, 'claimed_by', co.claimed_by),
       3
  from chip_orders co
 where co.status in ('pending', 'claimed');
