-- ═══════════════════════════════════════════════════════════════════════════
-- 0035 — Soft platform removal + one open deposit PER PLATFORM
-- ═══════════════════════════════════════════════════════════════════════════
-- Removing a platform used to hard-delete the row, which threw away the player's
-- account id. Now it just flips `active` off: the account stays on file, so
-- re-adding the platform switches it straight back on (no re-entering the id).

alter table player_platforms add column if not exists active boolean not null default true;

-- Un-link = deactivate (keep the account). Still refuses while anything's in
-- flight on that platform, so a live deposit/cash-out/job can't be stranded.
create or replace function player_unlink_platform(p_player uuid, p_platform uuid)
returns void
language plpgsql as $$
declare v_open int;
begin
  select count(*) into v_open from deposit_requests
   where player_id = p_player and platform_id = p_platform
     and status in ('matching', 'awaiting_payment', 'awaiting_confirmation');
  if v_open > 0 then
    raise exception 'you have a deposit in progress on that platform — finish or cancel it first'
      using errcode = 'invalid_parameter_value';
  end if;

  select count(*) into v_open from withdraw_requests
   where player_id = p_player and platform_id = p_platform
     and status in ('pending_unload', 'queued', 'partially_filled', 'filled');
  if v_open > 0 then
    raise exception 'you have a cash out in progress on that platform — finish or cancel it first'
      using errcode = 'invalid_parameter_value';
  end if;

  select count(*) into v_open from loader_orders
   where player_id = p_player and platform_id = p_platform and status in ('pending', 'claimed');
  if v_open > 0 then
    raise exception 'there''s a job still running on that platform — try again shortly'
      using errcode = 'invalid_parameter_value';
  end if;

  update player_platforms set active = false where player_id = p_player and platform_id = p_platform;
end $$;

-- ── deposit_create: one open deposit PER PLATFORM (was a flat 3 across all) ──
-- Only two lines change from 0007: the pp lookup now requires `active`, and the
-- open-deposit cap is counted per platform with a limit of one.
create or replace function deposit_create(p_player_id uuid, p_platform_id uuid, p_method_id uuid, p_amount bigint)
returns deposit_requests
language plpgsql as $$
declare
  cfg config;
  pl  players;
  m   payment_methods;
  pf  platforms;
  pp  player_platforms;
  d   deposit_requests;
  v_open    int;
  v_reveals int;
  v_today   bigint;
begin
  select * into cfg from config where id;

  select * into pl from players where id = p_player_id for update;
  if not found then
    raise exception 'player % not found', p_player_id;
  end if;
  if pl.status <> 'active' then
    raise exception 'account is % — deposits are not available', pl.status
      using errcode = 'insufficient_privilege';
  end if;

  select * into pf from platforms where id = p_platform_id;
  if not found or not pf.enabled then
    raise exception 'that platform is not available'
      using errcode = 'invalid_parameter_value';
  end if;

  -- The value has to land somewhere. Checked here rather than at release, so a
  -- player is told before they send money — not after. `active` so a removed
  -- platform can't be deposited to.
  select * into pp from player_platforms
   where player_id = p_player_id and platform_id = p_platform_id and active;
  if not found or pp.platform_uid is null then
    raise exception
      'your % account isn''t confirmed yet — an admin needs to approve it first', pf.name
      using errcode = 'invalid_parameter_value';
  end if;

  select * into m from payment_methods where id = p_method_id;
  if not found or not m.enabled then
    raise exception 'that payment method is not available'
      using errcode = 'invalid_parameter_value';
  end if;
  if m.reversibility = 'reversible' and not cfg.allow_reversible then
    raise exception 'that payment method is temporarily unavailable'
      using errcode = 'invalid_parameter_value';
  end if;

  -- ── Limits ──
  if p_amount < coalesce(m.min_amount, cfg.min_amount) then
    raise exception 'the smallest %s add is %s', m.name,
      to_char(coalesce(m.min_amount, cfg.min_amount) / 100.0, 'FM999999990.00')
      using errcode = 'invalid_parameter_value';
  end if;
  if p_amount > coalesce(m.max_amount, cfg.max_amount) then
    raise exception 'the largest %s add is %s', m.name,
      to_char(coalesce(m.max_amount, cfg.max_amount) / 100.0, 'FM999999990.00')
      using errcode = 'invalid_parameter_value';
  end if;

  -- One open deposit per platform. A player on both ClubGG and Sportsbook can
  -- have one going on each at once — just not two on the same platform.
  select count(*) into v_open
    from deposit_requests
   where player_id = p_player_id
     and platform_id = p_platform_id
     and status in ('matching', 'awaiting_payment', 'awaiting_confirmation');
  if v_open >= 1 then
    raise exception 'you already have a deposit in progress on % — finish or /canceldeposit it first', pf.name
      using errcode = 'invalid_parameter_value';
  end if;

  -- ── Handle-reveal rate limit ──
  -- Every p2p fill reveals a real person's payout details. Without this cap a
  -- griefer could open and abandon deposits in a loop purely to harvest the
  -- payout handles of everyone in the queue.
  select count(*) into v_reveals
    from fills f
    join deposit_requests dr on dr.id = f.deposit_id
   where dr.player_id = p_player_id
     and f.withdraw_id is not null
     and f.created_at > now() - interval '1 hour';
  if v_reveals >= cfg.handle_reveals_per_hour then
    raise exception 'too many payment details shown in the last hour — try again later'
      using errcode = 'invalid_parameter_value';
  end if;

  if cfg.daily_cap_per_player is not null then
    select coalesce(sum(amount), 0) into v_today
      from deposit_requests
     where player_id = p_player_id
       and status <> 'cancelled'
       and created_at > now() - interval '24 hours';
    if v_today + p_amount > cfg.daily_cap_per_player then
      raise exception 'that would go over your daily limit'
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  insert into deposit_requests (player_id, platform_id, method_id, currency, amount, status, terms)
  values (
    p_player_id, p_platform_id, p_method_id, m.currency, p_amount, 'matching',
    jsonb_build_object(
      'rake_deposit_bps',    cfg.rake_deposit_bps,
      'rake_deposit_flat',   cfg.rake_deposit_flat,
      'fee_bearer',          cfg.fee_bearer,
      'processor_fee_bps',   m.processor_fee_bps,
      'processor_fee_flat',  m.processor_fee_flat,
      'match_timeout_seconds', cfg.match_timeout_seconds,
      'method_code',         m.code,
      'settlement',          m.settlement,
      'reversibility',       m.reversibility)
  ) returning * into d;

  perform deposit_match(d.id);

  select * into d from deposit_requests where id = d.id;
  return d;
end $$;
