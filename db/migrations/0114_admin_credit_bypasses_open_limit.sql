-- ═══════════════════════════════════════════════════════════════════════════
-- 0114 — admin "Verify & Credit" must not hit the player's open-deposit guard
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Tapping "Verify & Credit" on a Stripe payment calls stripe_claim_credit, which
-- calls deposit_create to book the deposit + fill for the player. deposit_create
-- enforces PLAYER-facing anti-spam limits — one open deposit per platform, the
-- handle-reveal cap, the daily cap. So if the player happened to have another
-- deposit open on that platform (e.g. a Cash App one still in progress), the
-- admin's credit was refused with "you already have a deposit in progress on
-- Sportsbook — finish or /canceldeposit it first" — an error aimed at players,
-- wrongly blocking an admin from crediting a real, already-made payment.
--
-- Fix: deposit_create gains p_bypass_limits (default false → every existing call
-- is byte-identical). When true, the three player anti-spam limits are skipped;
-- the real validity checks (player active, platform/method available, amount in
-- range, account confirmed) still run. stripe_claim_credit passes true.

drop function if exists deposit_create(uuid, uuid, uuid, bigint);

create or replace function deposit_create(
  p_player_id     uuid,
  p_platform_id   uuid,
  p_method_id     uuid,
  p_amount        bigint,
  p_bypass_limits boolean default false
) returns deposit_requests
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

  -- ── Player anti-spam limits — skipped for an admin credit (p_bypass_limits) ──
  if not p_bypass_limits then
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

    -- Handle-reveal rate limit: every p2p fill reveals a real person's payout
    -- details, so cap how many a single player can trigger per hour.
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

-- Admin credit of a detected Stripe payment: bypass the player anti-spam limits.
create or replace function stripe_claim_credit(p_claim uuid, p_admin uuid, p_amount bigint default null)
returns fills
language plpgsql as $$
declare
  c  stripe_claims;
  m  payment_methods;
  d  deposit_requests;
  f  fills;
  v_amt bigint;
begin
  select * into c from stripe_claims where id = p_claim for update;
  if not found then
    raise exception 'claim % not found', p_claim;
  end if;
  if c.status <> 'pending' then
    raise exception 'that Stripe payment is already %', c.status using errcode = 'invalid_parameter_value';
  end if;

  v_amt := coalesce(p_amount, c.amount);
  if v_amt is null or v_amt <= 0 then
    raise exception 'no amount on file yet — enter the amount that was paid' using errcode = 'invalid_parameter_value';
  end if;

  select * into m from payment_methods where code = 'stripe';
  d := deposit_create(c.player_id, c.platform_id, m.id, v_amt, true);   -- admin credit: skip player limits
  select * into f from fills where deposit_id = d.id order by seq limit 1;
  -- Unique per claim: 'stripe' as a literal ref collides on the 2nd Stripe deposit.
  perform fill_submit_proof(f.id, 'stripe:' || c.id::text, 'card via payment link', false);
  f := fill_admin_verify(f.id, p_admin, 'stripe receipt confirmed');

  update stripe_claims set status = 'credited', amount = v_amt, credited_fill = f.id where id = c.id;
  return f;
end $$;
