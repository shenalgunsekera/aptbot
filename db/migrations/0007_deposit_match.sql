-- ═══════════════════════════════════════════════════════════════════════════
-- 0007 — The matching engine
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Strict FIFO by withdraw_requests.created_at. No queue-jumping, ever.
--
-- TWO SETTLEMENT MODES
-- ────────────────────
--   p2p  (crypto): walk the queue, oldest first. A depositor pays real people.
--                  The club's own account is the fallback when nobody is queued.
--
--   club (PayPal): skip the queue entirely. EVERY deposit pays the club's
--                  account and every withdrawal is paid BY the club. No player
--                  ever sees another player's PayPal.
--
--                  The trade is explicit: the club absorbs every chargeback
--                  (rather than a player who cannot), and in exchange the club
--                  fronts the float. That is why the mode is per-method — crypto
--                  is irreversible so P2P is safe there, PayPal is not.
--
-- HOW THE RACE IS WON (p2p only)
-- ──────────────────────────────
-- Two depositors hitting the queue in the same millisecond must never be handed
-- the same payee for the same money. Two mechanisms, both needed:
--
--   1. SELECT ... FOR UPDATE SKIP LOCKED — a row lock held for the transaction.
--      Depositor B physically cannot see the row A is mid-flight on; B skips to
--      the next in FIFO order rather than blocking or double-matching.
--
--   2. fills.status='locked' + lock_expires_at — a DB row lock dies at COMMIT,
--      but a depositor holds a revealed handle for 15–30 real-world minutes. The
--      committed 'locked' fill — which has already decremented amount_remaining
--      — is what reserves the slice across that window.
--
-- Mechanism 1 protects the instant of matching. Mechanism 2 protects the half
-- hour after it. Neither alone is sufficient.

create or replace function deposit_match(p_deposit_id uuid)
returns setof fills
language plpgsql as $$
declare
  cfg config;
  d   deposit_requests;
  m   payment_methods;
  w   record;
  f   fills;
  v_remaining bigint;
  v_slice     bigint;
  v_rake      bigint;
  v_lock_exp  timestamptz;
begin
  select * into cfg from config where id;

  select * into d from deposit_requests where id = p_deposit_id for update;
  if not found then
    raise exception 'deposit % not found', p_deposit_id;
  end if;
  if d.status <> 'matching' then
    raise exception 'deposit % is % — matching has already run', d.id, d.status
      using errcode = 'invalid_parameter_value';
  end if;

  select * into m from payment_methods where id = d.method_id;

  v_lock_exp  := now() + make_interval(secs => cfg.match_timeout_seconds);
  v_remaining := d.amount;

  -- ── p2p: walk the queue ──
  -- Skipped entirely for `club` methods: on PayPal the club is always the
  -- counterparty, so there is no queue to walk and no player handle to reveal.
  if m.settlement = 'p2p' then
    -- ONE ROW PER ITERATION. This must not become
    -- `FOR w IN SELECT ... FOR UPDATE SKIP LOCKED LOOP`, however much more
    -- natural that reads.
    --
    -- A plpgsql FOR loop opens a cursor and fetches in batches (50 rows by
    -- default), and FOR UPDATE locks every row it FETCHES — not just the ones
    -- the body reaches. So one depositor needing the front of the queue would
    -- lock the first fifty withdrawals and hold them until commit. Every
    -- concurrent depositor would then SKIP LOCKED past the entire queue, find
    -- nothing, and fall through to the club.
    --
    -- The failure is silent and expensive: withdrawals sit unfilled while the
    -- club's float absorbs deposits that had a perfectly good counterparty, and
    -- the peer-to-peer model quietly degrades into "the club is always the
    -- counterparty" under exactly the load where that hurts most. This was a
    -- real bug in v1, found only by a concurrency test.
    --
    -- Re-querying with LIMIT 1 locks precisely what we are about to use. The
    -- loop cannot spin: each iteration either fully consumes the withdrawal
    -- (amount_remaining → 0, so the WHERE excludes it) or exhausts the deposit
    -- (v_remaining → 0, so we exit).
    loop
      exit when v_remaining <= 0;

      select id, player_id, payout_handle, amount_remaining
        into w
        from withdraw_requests
       where method_id = d.method_id
         and currency  = d.currency
         and status in ('queued', 'partially_filled')
         and amount_remaining > 0
         -- Self-dealing block: you cannot fill your own withdrawal. The cheapest
         -- collusion control there is, and it costs nothing to enforce.
         and player_id <> d.player_id
       order by created_at, id          -- FIFO. `id` breaks exact-timestamp ties.
         for update skip locked
       limit 1;

      exit when not found;

      v_slice := least(v_remaining, w.amount_remaining);
      v_rake  := calc_rake(v_slice, 'deposit');

      insert into fills (
        deposit_id, withdraw_id, method_id, currency,
        amount, rake_amount, credit_amount, gross_to_send,
        payout_handle, status, lock_expires_at
      ) values (
        d.id, w.id, d.method_id, d.currency,
        v_slice, v_rake, v_slice - v_rake, calc_gross_to_send(v_slice, d.method_id),
        w.payout_handle,       -- snapshot: see fills.payout_handle in 0004
        'locked', v_lock_exp
      ) returning * into f;

      update withdraw_requests
         set amount_remaining = amount_remaining - v_slice,
             status = (case when amount_remaining - v_slice = 0 then 'filled'
                            else 'partially_filled' end)::withdraw_status
       where id = w.id;

      v_remaining := v_remaining - v_slice;
      return next f;
    end loop;
  end if;

  -- ── The club takes the rest ──
  -- On a `club` method this is the whole deposit and always was. On p2p it is
  -- whatever the queue could not cover.
  if v_remaining > 0 then
    if m.club_handle is null then
      -- All-or-nothing. We will not silently take less than the player asked
      -- for. Raising rolls back every fill matched above, so no slice is left
      -- stranded against a deposit that never happened.
      raise exception
        'we can''t take that right now — % isn''t set up to receive it. Try another method or a smaller amount.',
        m.name
        using errcode = 'invalid_parameter_value';
    end if;

    v_rake := calc_rake(v_remaining, 'deposit');

    insert into fills (
      deposit_id, withdraw_id, method_id, currency,
      amount, rake_amount, credit_amount, gross_to_send,
      payout_handle, status, lock_expires_at
    ) values (
      d.id, null, d.method_id, d.currency,      -- null withdraw_id ⇒ club is payee
      v_remaining, v_rake, v_remaining - v_rake,
      calc_gross_to_send(v_remaining, d.method_id),
      m.club_handle, 'locked', v_lock_exp
    ) returning * into f;

    v_remaining := 0;
    return next f;
  end if;

  update deposit_requests set status = 'awaiting_payment' where id = d.id;
  return;
end $$;

-- ─── Create ─────────────────────────────────────────────────────────────────
-- Creates the request and matches it in ONE transaction, so a player never sees
-- a deposit that exists but has no counterparty.
create or replace function deposit_create(
  p_player_id   uuid,
  p_platform_id uuid,
  p_method_id   uuid,
  p_amount      bigint
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
  -- player is told before they send money — not after.
  select * into pp from player_platforms
   where player_id = p_player_id and platform_id = p_platform_id;
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

  select count(*) into v_open
    from deposit_requests
   where player_id = p_player_id
     and status in ('matching', 'awaiting_payment', 'awaiting_confirmation');
  if v_open >= cfg.max_open_deposits_per_player then
    raise exception 'you already have % adds in progress — finish those first', v_open
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

-- ─── Cancel ─────────────────────────────────────────────────────────────────
create or replace function deposit_cancel(
  p_deposit_id  uuid,
  p_actor_admin uuid default null,
  p_reason      text default null
) returns deposit_requests
language plpgsql as $$
declare
  d deposit_requests;
  f fills;
begin
  select * into d from deposit_requests where id = p_deposit_id for update;
  if not found then
    raise exception 'deposit % not found', p_deposit_id;
  end if;
  if d.status in ('completed', 'cancelled', 'expired') then
    raise exception 'that add is already %', d.status
      using errcode = 'invalid_parameter_value';
  end if;

  -- A slice you have already sent money for is not yours to cancel — it is the
  -- payee's problem now, and the dispute path handles it.
  if exists (
    select 1 from fills
     where deposit_id = d.id
       and status in ('awaiting_confirmation', 'disputed', 'released')
  ) then
    raise exception
      'you''ve already sent money for part of this — we can''t cancel it. Open a dispute instead.'
      using errcode = 'invalid_parameter_value';
  end if;

  for f in select * from fills where deposit_id = d.id and status = 'locked' for update
  loop
    perform fill_unlock(f.id, 'cancelled');
  end loop;

  update deposit_requests
     set status = 'cancelled', cancel_reason = p_reason, completed_at = now()
   where id = d.id
  returning * into d;

  perform audit(p_actor_admin, 'deposit.cancel', 'deposit_request', d.id,
                jsonb_build_object('reason', p_reason));
  return d;
end $$;
