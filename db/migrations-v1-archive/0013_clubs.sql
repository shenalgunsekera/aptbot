-- ═══════════════════════════════════════════════════════════════════════════
-- 0013 — Clubs: routing chip work to the device that can actually do it
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE STRUCTURE THIS EXISTS FOR
--
--     Union  ──┬── Club A ──┬── player
--              │            └── player
--              └── Club B ──┬── player
--                           └── player
--
-- Chips are loaded by CLUB OWNERS, not by the union. A club owner can only move
-- chips for players in their own club — that is ClubGG's permission model, and
-- no amount of software on our side changes it.
--
-- Until now `chip_orders` was one global queue and any worker could claim any
-- row. With more than one club that is actively broken: club B's overlay claims
-- an order for one of club A's players, discovers it cannot perform it, and the
-- order either fails or sits `claimed` until a human notices. Worse, the claim
-- is atomic — so the WRONG worker winning the race is the normal case, not the
-- rare one, and the right worker never even sees the row.
--
-- So work is now addressed: every chip order carries the club whose owner must
-- execute it, and each club owner's worker only sees its own club's queue.
--
-- Money is deliberately NOT partitioned by club. The ledger, the FIFO queue and
-- the matching engine stay union-wide: a player in club A settling with a player
-- in club B is the entire point of a union. Only the physical chip work is
-- club-scoped, because only the physical chip work is permission-scoped.

create table clubs (
  id   uuid primary key default gen_random_uuid(),
  code text unique not null,          -- short internal handle, e.g. 'main'
  name text not null,

  -- The club's identifier inside ClubGG. What the overlay switches to before
  -- touching a player.
  clubgg_club_id text unique not null,

  -- The admin whose device runs this club's overlay. Their worker is the only
  -- one that will be handed this club's chip orders.
  owner_admin_id uuid references admins (id),

  -- Off = no new players, no new chip work routed here. Existing money is
  -- untouched; the ledger is union-wide and does not care about clubs.
  enabled boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index clubs_owner_idx on clubs (owner_admin_id) where enabled;

create trigger clubs_touch before update on clubs
  for each row execute function touch_updated_at();

-- ─── Players belong to a club ───────────────────────────────────────────────
-- Nullable, because existing players predate this migration and because a
-- player can register before an admin decides which club they go in. But chips
-- cannot move without it — see chip_order_create below.
alter table players add column club_id uuid references clubs (id);
create index players_club_idx on players (club_id);

-- ─── Chip orders are addressed to a club ────────────────────────────────────
-- Snapshotted at creation, exactly like clubgg_id and for the same reason:
-- moving a player between clubs must never silently re-route work that is
-- already in flight to a different owner's device.
alter table chip_orders add column club_id uuid references clubs (id);
create index chip_orders_club_queue_idx on chip_orders (club_id, status, created_at)
  where status in ('pending', 'claimed');

-- ─── Routing ────────────────────────────────────────────────────────────────
-- Replaces the 0005 version. Now resolves and snapshots the club alongside the
-- ClubGG id, and refuses to queue work that no device could execute.
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
  pl players;
  cl clubs;
  o  chip_orders;
begin
  select * into pl from players where id = p_player_id;
  if not found then
    raise exception 'chip_order_create: player % not found', p_player_id;
  end if;

  if pl.clubgg_id is null then
    raise exception
      'player % has no confirmed ClubGG id — an admin must link the account before chips can move',
      p_player_id
      using errcode = 'invalid_parameter_value';
  end if;

  -- An order with no club is an order no worker will ever pick up, because
  -- every worker filters by its own club. It would sit pending forever while
  -- the ledger insisted the player was owed chips. Fail loudly at the source.
  if pl.club_id is null then
    raise exception
      'player % is not assigned to a club — chip work cannot be routed to anyone',
      p_player_id
      using errcode = 'invalid_parameter_value';
  end if;

  select * into cl from clubs where id = pl.club_id;
  if not cl.enabled then
    raise exception 'club % (%) is disabled — chip work cannot be routed to it', cl.name, cl.code
      using errcode = 'invalid_parameter_value';
  end if;

  insert into chip_orders (player_id, club_id, clubgg_id, delta, currency,
                           reason, ref_type, ref_id, note)
  values (p_player_id, pl.club_id, pl.clubgg_id, p_delta, p_currency,
          p_reason, p_ref_type, p_ref_id, p_note)
  returning * into o;

  -- Tell the club's own owner, not every admin in the union. A club owner does
  -- not need to be woken up for work they cannot perform.
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
    -- No owner assigned: fall back to the whole admin desk so it is not silently
    -- nobody's job.
    perform notify_admins('chip_order.pending', 'chip_order', o.id,
      jsonb_build_object('player_id', p_player_id, 'clubgg_id', pl.clubgg_id,
                         'club', cl.name, 'delta', p_delta,
                         'currency', p_currency, 'reason', p_reason));
  end if;

  return o;
end $$;

-- ─── Assign a player to a club ──────────────────────────────────────────────
create or replace function player_set_club(
  p_player_id uuid,
  p_club_id   uuid,
  p_admin     uuid
) returns players
language plpgsql as $$
declare
  pl     players;
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

  select * into pl from players where id = p_player_id for update;
  if not found then
    raise exception 'player % not found', p_player_id;
  end if;

  -- Moving a player mid-flight would leave outstanding orders addressed to the
  -- old club's device while new ones go elsewhere — two owners, one player, and
  -- no way to tell who was supposed to do what.
  select count(*) into v_open
    from chip_orders
   where player_id = p_player_id and status in ('pending', 'claimed');
  if v_open > 0 then
    raise exception
      'player % has % chip order(s) outstanding — finish or fail those before moving them between clubs',
      p_player_id, v_open
      using errcode = 'invalid_parameter_value';
  end if;

  update players set club_id = p_club_id where id = pl.id returning * into pl;

  perform audit(p_admin, 'player.set_club', 'player', pl.id,
                jsonb_build_object('club_id', p_club_id, 'club', cl.name));
  return pl;
end $$;

-- ─── Per-club work queue ────────────────────────────────────────────────────
-- What a club owner's overlay sees. Union-wide reporting still reads
-- chip_orders directly.
create or replace view v_club_chip_queue as
select
  co.id, co.club_id, cl.name as club_name, cl.clubgg_club_id,
  co.player_id, p.display_name, co.clubgg_id,
  co.delta, co.currency, co.reason, co.status,
  co.claimed_by, co.claimed_at, co.created_at,
  (co.status = 'claimed' and co.claimed_at < now() - interval '15 minutes') as stale
from chip_orders co
join clubs cl on cl.id = co.club_id
join players p on p.id = co.player_id
where co.status in ('pending', 'claimed');
