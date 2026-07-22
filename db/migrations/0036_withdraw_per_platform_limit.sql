-- ═══════════════════════════════════════════════════════════════════════════
-- 0036 — One open cash-out PER PLATFORM (matches the deposit rule in 0035)
-- ═══════════════════════════════════════════════════════════════════════════
-- Was a flat cap across all platforms, which let a player stack two identical
-- cash-outs on the same platform. Now it's one in progress per platform: someone
-- on both ClubGG and Sportsbook can cash out of each at once, but not twice from
-- the same one. Only the open-cash-out check changes from 0006.
create or replace function withdraw_create(p_player_id uuid, p_platform_id uuid, p_method_id uuid, p_requested bigint, p_payout_handle text)
returns withdraw_requests
language plpgsql as $$
declare
  cfg   config;
  pl    players;
  m     payment_methods;
  pf    platforms;
  w     withdraw_requests;
  v_open  int;
  v_today bigint;
  v_order loader_orders;
begin
  select * into cfg from config where id;

  -- Lock the player for the whole check-then-act sequence: without it two
  -- concurrent withdrawals could each pass the open-request and daily-cap
  -- checks before either inserted.
  select * into pl from players where id = p_player_id for update;
  if not found then
    raise exception 'player % not found', p_player_id;
  end if;
  if pl.status <> 'active' then
    raise exception 'account is % — withdrawals are not available', pl.status
      using errcode = 'insufficient_privilege';
  end if;

  select * into pf from platforms where id = p_platform_id;
  if not found or not pf.enabled then
    raise exception 'that platform is not available'
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
  if coalesce(trim(p_payout_handle), '') = '' then
    raise exception 'we need to know where to send your money'
      using errcode = 'invalid_parameter_value';
  end if;

  -- ── Limits ──
  if p_requested < coalesce(m.min_amount, cfg.min_amount) then
    raise exception 'the smallest %s cash out is %s', m.name,
      to_char(coalesce(m.min_amount, cfg.min_amount) / 100.0, 'FM999999990.00')
      using errcode = 'invalid_parameter_value';
  end if;
  if p_requested > coalesce(m.max_amount, cfg.max_amount) then
    raise exception 'the largest %s cash out is %s', m.name,
      to_char(coalesce(m.max_amount, cfg.max_amount) / 100.0, 'FM999999990.00')
      using errcode = 'invalid_parameter_value';
  end if;

  -- One open cash-out per platform (see 0035 for the deposit twin).
  select count(*) into v_open
    from withdraw_requests
   where player_id = p_player_id
     and platform_id = p_platform_id
     and status in ('pending_unload', 'queued', 'partially_filled', 'filled');
  if v_open >= 1 then
    raise exception 'you already have a cash out in progress on % — finish or cancel it first', pf.name
      using errcode = 'invalid_parameter_value';
  end if;

  if cfg.daily_cap_per_player is not null then
    select coalesce(sum(coalesce(gross_amount, requested_amount)), 0) into v_today
      from withdraw_requests
     where player_id = p_player_id
       and status <> 'cancelled'
       and created_at > now() - interval '24 hours';
    if v_today + p_requested > cfg.daily_cap_per_player then
      raise exception 'that would go over your daily limit'
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  insert into withdraw_requests (
    player_id, platform_id, method_id, currency,
    requested_amount, payout_handle, status, terms
  ) values (
    p_player_id, p_platform_id, p_method_id, m.currency,
    p_requested, trim(p_payout_handle), 'pending_unload',
    jsonb_build_object(
      'rake_withdraw_bps',  cfg.rake_withdraw_bps,
      'rake_withdraw_flat', cfg.rake_withdraw_flat,
      'method_code',        m.code,
      'settlement',         m.settlement,
      'reversibility',      m.reversibility)
  ) returning * into w;

  -- Using a handle is what saves it for next time.
  perform payout_handle_remember(p_player_id, p_method_id, p_payout_handle);

  -- The loader takes it off the table. Nothing is escrowed, promised, or queued
  -- until they report back what actually moved.
  v_order := loader_order_create(
    p_player_id, p_platform_id, -p_requested, m.currency,
    'withdraw.unload', 'withdraw_request', w.id);

  update withdraw_requests set unload_order_id = v_order.id where id = w.id
  returning * into w;

  return w;
end $$;
