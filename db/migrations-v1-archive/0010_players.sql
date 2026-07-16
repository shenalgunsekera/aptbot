-- ═══════════════════════════════════════════════════════════════════════════
-- 0010 — Player registration and ClubGG linking
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Register ───────────────────────────────────────────────────────────────
-- Called on /start. The player supplies their own ClubGG id — they are the only
-- one who knows it, and it must be EXACT because the chip loader acts on it
-- verbatim. It lands in clubgg_id_claimed (untrusted) and stays there until an
-- admin confirms it.
--
-- Idempotent: /start twice is not an error, it just updates the claim.
create or replace function player_register(
  p_telegram_id     bigint,
  p_username        text default null,
  p_display_name    text default null,
  p_clubgg_claimed  text default null
) returns players
language plpgsql as $$
declare
  pl players;
begin
  select * into pl from players where telegram_id = p_telegram_id for update;

  if found then
    update players
       set telegram_username = coalesce(p_username, telegram_username),
           display_name      = coalesce(p_display_name, display_name),
           -- Only an UNLINKED player may revise their claim. Once an admin has
           -- confirmed an id, changing it is an admin action — otherwise a
           -- player could re-point their own account at someone else's table
           -- after the fact.
           clubgg_id_claimed = case
                                 when clubgg_id is null then coalesce(nullif(trim(p_clubgg_claimed), ''), clubgg_id_claimed)
                                 else clubgg_id_claimed
                               end
     where id = pl.id
    returning * into pl;
    return pl;
  end if;

  insert into players (telegram_id, telegram_username, display_name, clubgg_id_claimed, status)
  values (p_telegram_id, p_username, p_display_name,
          nullif(trim(p_clubgg_claimed), ''), 'pending')
  returning * into pl;

  perform notify_admins('player.registered', 'player', pl.id,
    jsonb_build_object('telegram_id', p_telegram_id, 'username', p_username,
                       'clubgg_claimed', pl.clubgg_id_claimed));
  return pl;
end $$;

-- Lets a pending player correct a typo before an admin gets to them.
create or replace function player_claim_clubgg(
  p_player_id uuid,
  p_clubgg_id text
) returns players
language plpgsql as $$
declare
  pl players;
begin
  select * into pl from players where id = p_player_id for update;
  if not found then
    raise exception 'player % not found', p_player_id;
  end if;
  if pl.clubgg_id is not null then
    raise exception
      'your ClubGG id is already confirmed as % — contact an admin to change it', pl.clubgg_id
      using errcode = 'invalid_parameter_value';
  end if;
  if coalesce(trim(p_clubgg_id), '') = '' then
    raise exception 'ClubGG id cannot be blank'
      using errcode = 'invalid_parameter_value';
  end if;

  update players set clubgg_id_claimed = trim(p_clubgg_id) where id = pl.id
  returning * into pl;

  perform notify_admins('player.clubgg_claimed', 'player', pl.id,
    jsonb_build_object('clubgg_claimed', pl.clubgg_id_claimed));
  return pl;
end $$;

-- ─── Link ───────────────────────────────────────────────────────────────────
-- An admin confirms the mapping and activates the account. This is the gate:
-- before it, the player cannot transact and no chips can move.
--
-- p_clubgg_id defaults to whatever the player claimed, so the common path is
-- one tap — but an admin can override, because the player is the one who
-- typo'd it and the admin is the one looking at the real club roster.
create or replace function player_link(
  p_player_id uuid,
  p_admin     uuid,
  p_clubgg_id text default null
) returns players
language plpgsql as $$
declare
  pl    players;
  adm   admins;
  v_id  text;
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

  update players
     set clubgg_id = v_id,
         linked_by = p_admin,
         linked_at = now(),
         status = case when status = 'pending' then 'active' else status end
   where id = pl.id
  returning * into pl;

  perform audit(p_admin, 'player.link', 'player', pl.id,
    jsonb_build_object('clubgg_id', v_id, 'claimed_was', pl.clubgg_id_claimed,
                       'overridden', p_clubgg_id is not null and trim(p_clubgg_id) <> coalesce(pl.clubgg_id_claimed, '')));
  perform notify_player(pl.id, 'player.linked', 'player', pl.id,
    jsonb_build_object('clubgg_id', v_id));
  return pl;
end $$;

-- ─── Status ─────────────────────────────────────────────────────────────────
-- Freeze/unfreeze/ban. Balances are never touched: a frozen player still owns
-- their money, they simply cannot start anything new. Money already in flight
-- settles on its own — stranding a counterparty's payment because someone
-- ELSE got frozen would be punishing the wrong person.
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

-- ─── Velocity / collusion checks ────────────────────────────────────────────
-- "flag repeated same-pair transactions, self-dealing, abnormal volume"
--
-- Advisory only — these raise flags for a human, they never block money. An
-- automated freeze on a heuristic hands any griefer a denial-of-service against
-- honest players: transact with your target a few times and get them frozen.
--
-- Self-dealing is absent here on purpose: it is not detected after the fact, it
-- is made impossible at the source by the `player_id <> d.player_id` predicate
-- in deposit_match. A control that cannot be violated needs no alarm.
create or replace function risk_scan(
  p_window   interval default interval '7 days',
  p_pair_limit int default 3
) returns table (player_id uuid, code text, detail jsonb)
language plpgsql as $$
begin
  -- Same two people settling with each other over and over. Legitimate at low
  -- counts (friends), a laundering ring at high ones.
  return query
    select dep.player_id, 'repeated_pair'::text,
           jsonb_build_object(
             'counterparty', w.player_id,
             'fills', count(*),
             'total', sum(f.amount),
             'window', p_window::text)
      from fills f
      join deposit_requests dep on dep.id = f.deposit_id
      join withdraw_requests w  on w.id  = f.withdraw_id
     where f.created_at > now() - p_window
       and f.status in ('awaiting_confirmation', 'released')
     group by dep.player_id, w.player_id
    having count(*) > p_pair_limit;

  -- Volume far outside this player's own norm. Compared against their own
  -- history rather than a global threshold, so a whale is not permanently
  -- flagged for being a whale.
  return query
    with recent as (
      select dep.player_id, sum(f.amount) as total
        from fills f
        join deposit_requests dep on dep.id = f.deposit_id
       where f.created_at > now() - p_window
         and f.status in ('awaiting_confirmation', 'released')
       group by dep.player_id
    ),
    baseline as (
      select dep.player_id, sum(f.amount) / greatest(
               extract(epoch from (now() - min(f.created_at))) / extract(epoch from p_window), 1
             ) as per_window
        from fills f
        join deposit_requests dep on dep.id = f.deposit_id
       where f.status in ('awaiting_confirmation', 'released')
         and f.created_at <= now() - p_window
       group by dep.player_id
      having count(*) >= 3          -- need some history before "abnormal" means anything
    )
    select r.player_id, 'abnormal_volume'::text,
           jsonb_build_object('recent', r.total, 'baseline_per_window', round(b.per_window),
                              'ratio', round((r.total / greatest(b.per_window, 1))::numeric, 2))
      from recent r join baseline b on b.player_id = r.player_id
     where r.total > b.per_window * 5;

  -- Deposits opened and abandoned in bulk: harvesting counterparty handles.
  return query
    select d.player_id, 'handle_harvesting'::text,
           jsonb_build_object('expired_deposits', count(*), 'window', p_window::text)
      from deposit_requests d
     where d.created_at > now() - p_window
       and d.status in ('expired', 'cancelled')
     group by d.player_id
    having count(*) >= 5;
end $$;

-- Runs risk_scan and records anything new onto the players it concerns.
create or replace function risk_scan_and_flag()
returns int
language plpgsql as $$
declare
  r       record;
  v_count int := 0;
begin
  for r in select * from risk_scan() loop
    -- Don't re-flag the same thing every hour; one open flag per code is enough
    -- to get a human looking.
    if not exists (
      select 1 from players p, jsonb_array_elements(p.risk_flags) fl
       where p.id = r.player_id
         and fl->>'code' = r.code
         and (fl->>'at')::timestamptz > now() - interval '7 days'
    ) then
      perform flag_player(r.player_id, r.code, r.detail::text, null);
      v_count := v_count + 1;
    end if;
  end loop;
  return v_count;
end $$;
