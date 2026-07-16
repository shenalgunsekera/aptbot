-- ═══════════════════════════════════════════════════════════════════════════
-- 0007 — The matching engine
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Strict FIFO by withdraw_requests.created_at. No queue-jumping, ever.
--
-- HOW THE RACE IS WON
-- -------------------
-- Two depositors hitting the queue at the same millisecond must never be handed
-- the same withdrawer's handle for the same money. Two mechanisms, both needed:
--
--   1. SELECT ... FOR UPDATE SKIP LOCKED  (row lock, held for the transaction)
--      Depositor B's matching transaction physically cannot see the rows
--      depositor A's transaction is mid-flight on. B skips to the next
--      withdrawal in FIFO order instead of blocking or double-matching.
--      This is what makes concurrent matching correct rather than merely rare.
--
--   2. fills.status = 'locked' + lock_expires_at   (application lock, survives commit)
--      A DB row lock dies at COMMIT, but a depositor holds a revealed handle
--      for 15–30 real-world minutes. So the committed 'locked' fill — which has
--      already decremented amount_remaining — is what reserves the slice across
--      that window. The sweeper in 0008 returns it if no proof arrives.
--
-- Mechanism 1 protects the instant of matching. Mechanism 2 protects the half
-- hour after it. Neither alone is sufficient.

-- ─── Match ──────────────────────────────────────────────────────────────────
-- Walks the FIFO queue slicing the deposit across withdrawals until it is
-- exhausted, then backstops any remainder to the owner.
--
-- PARTIAL FILLS ARE FIRST-CLASS: a 10000 deposit meeting a 6000 withdrawal at
-- the front spills 4000 onto the next one, as two independent fills. A 4000
-- deposit against a 10000 withdrawal partially fills it and leaves
-- amount_remaining = 6000. Either way the backend knows exactly what is owed.
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
  v_matched   int := 0;
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

  -- ONE ROW PER ITERATION. This must not become `FOR w IN SELECT ... FOR UPDATE
  -- SKIP LOCKED LOOP`, however much more natural that reads.
  --
  -- A plpgsql FOR loop over a query opens a cursor and fetches in batches (50
  -- rows by default), and FOR UPDATE locks every row it fetches — not just the
  -- ones the loop body reaches. So a single depositor needing the front of the
  -- queue would lock the first fifty withdrawals and hold them until commit.
  -- Every concurrent depositor would then SKIP LOCKED past the entire queue,
  -- find nothing, and fall through to the owner backstop.
  --
  -- The failure is silent and expensive: withdrawals sit unfilled while the
  -- owner's float absorbs deposits that had a perfectly good counterparty, and
  -- the peer-to-peer model quietly degrades into "the owner is always the
  -- counterparty" under exactly the load where that hurts most. Re-querying with
  -- LIMIT 1 locks precisely what we are about to use.
  --
  -- The loop cannot spin: each iteration either fully consumes the withdrawal
  -- (amount_remaining → 0, so the WHERE excludes it next time) or exhausts the
  -- deposit (v_remaining → 0, so we exit). It can never pick the same row twice.
  loop
    exit when v_remaining <= 0;

    select id, player_id, payout_handle, amount_remaining
      into w
      from withdraw_requests
     where method_id = d.method_id
       and currency  = d.currency
       and status in ('queued', 'partially_filled')
       and amount_remaining > 0
       -- Self-dealing block: you cannot fill your own withdrawal. This is the
       -- cheapest collusion control we have and it costs nothing to enforce.
       and player_id <> d.player_id
     order by created_at, id          -- FIFO. `id` breaks exact-timestamp ties.
       for update skip locked
     limit 1;

    exit when not found;

    v_slice := least(v_remaining, w.amount_remaining);
    v_rake  := calc_rake(v_slice, 'deposit');

    insert into fills (
      deposit_id, withdraw_id, method_id, currency,
      amount, rake_amount, chips_amount, gross_to_send,
      payout_handle, status, lock_expires_at
    ) values (
      d.id, w.id, d.method_id, d.currency,
      v_slice, v_rake, v_slice - v_rake, calc_gross_to_send(v_slice, d.method_id),
      w.payout_handle,       -- snapshot: see fills.payout_handle in 0004
      'locked', v_lock_exp
    ) returning * into f;

    update withdraw_requests
       set amount_remaining = amount_remaining - v_slice,
           status = (case
                       when amount_remaining - v_slice = 0 then 'filled'
                       else 'partially_filled'
                     end)::withdraw_status
     where id = w.id;

    v_remaining := v_remaining - v_slice;
    v_matched   := v_matched + 1;
    return next f;
  end loop;

  -- ── Owner backstop ──
  -- Nothing (or not enough) in the queue: the owner becomes the counterparty.
  -- The depositor pays the owner's handle and the owner carries the float.
  if v_remaining > 0 then
    if m.backstop_handle is null then
      -- All-or-nothing: we will not silently deposit less than the player
      -- asked for. Raising rolls the whole transaction back, including any
      -- fills matched above, so no slice is left stranded.
      raise exception
        'cannot fill % of % on %: the queue is short and no backstop handle is configured for this method',
        v_remaining, d.amount, m.name
        using errcode = 'invalid_parameter_value';
    end if;

    v_rake := calc_rake(v_remaining, 'deposit');

    insert into fills (
      deposit_id, withdraw_id, method_id, currency,
      amount, rake_amount, chips_amount, gross_to_send,
      payout_handle, status, lock_expires_at
    ) values (
      d.id, null, d.method_id, d.currency,      -- null withdraw_id ⇒ backstop
      v_remaining, v_rake, v_remaining - v_rake,
      calc_gross_to_send(v_remaining, d.method_id),
      m.backstop_handle, 'locked', v_lock_exp
    ) returning * into f;

    v_remaining := 0;
    return next f;
  end if;

  update deposit_requests
     set status = 'awaiting_payment'
   where id = d.id;

  return;
end $$;

-- ─── Create ─────────────────────────────────────────────────────────────────
-- Entry point for /club-deposit. Creates the request and matches it in ONE
-- transaction, so a player never sees a deposit that exists but has no
-- counterparty.
create or replace function deposit_create(
  p_player_id uuid,
  p_method_id uuid,
  p_amount    bigint
) returns deposit_requests
language plpgsql as $$
declare
  cfg config;
  pl  players;
  m   payment_methods;
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

  select * into m from payment_methods where id = p_method_id;
  if not found or not m.enabled then
    raise exception 'that payment method is not available'
      using errcode = 'invalid_parameter_value';
  end if;
  if m.reversibility = 'reversible' and not cfg.allow_reversible then
    raise exception 'reversible payment methods are currently disabled'
      using errcode = 'invalid_parameter_value';
  end if;

  -- ── Limits ──
  if p_amount < coalesce(m.min_amount, cfg.min_amount) then
    raise exception 'minimum deposit for % is %', m.name, coalesce(m.min_amount, cfg.min_amount)
      using errcode = 'invalid_parameter_value';
  end if;
  if p_amount > coalesce(m.max_amount, cfg.max_amount) then
    raise exception 'maximum deposit for % is %', m.name, coalesce(m.max_amount, cfg.max_amount)
      using errcode = 'invalid_parameter_value';
  end if;

  select count(*) into v_open
    from deposit_requests
   where player_id = p_player_id
     and status in ('matching', 'awaiting_payment', 'awaiting_confirmation');
  if v_open >= cfg.max_open_deposits_per_player then
    raise exception 'you already have % open deposits (limit %) — finish those first',
      v_open, cfg.max_open_deposits_per_player
      using errcode = 'invalid_parameter_value';
  end if;

  -- ── Handle-reveal rate limit ──
  -- Every fill reveals a counterparty's payout handle. Without this cap, a
  -- griefer could open and abandon deposits in a loop purely to harvest the
  -- payout handles of everyone in the queue.
  select count(*) into v_reveals
    from fills f
    join deposit_requests dr on dr.id = f.deposit_id
   where dr.player_id = p_player_id
     and f.created_at > now() - interval '1 hour';
  if v_reveals >= cfg.handle_reveals_per_hour then
    raise exception 'too many payout handles revealed in the last hour (limit %) — try again later',
      cfg.handle_reveals_per_hour
      using errcode = 'invalid_parameter_value';
  end if;

  if cfg.daily_cap_per_player is not null then
    select coalesce(sum(amount), 0) into v_today
      from deposit_requests
     where player_id = p_player_id
       and status <> 'cancelled'
       and created_at > now() - interval '24 hours';
    if v_today + p_amount > cfg.daily_cap_per_player then
      raise exception 'daily deposit cap of % would be exceeded (% used in the last 24h)',
        cfg.daily_cap_per_player, v_today
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  insert into deposit_requests (player_id, method_id, currency, amount, status, terms)
  values (
    p_player_id, p_method_id, m.currency, p_amount, 'matching',
    jsonb_build_object(
      'rake_deposit_bps',    cfg.rake_deposit_bps,
      'rake_deposit_flat',   cfg.rake_deposit_flat,
      'fee_bearer',          cfg.fee_bearer,
      'processor_fee_bps',   m.processor_fee_bps,
      'processor_fee_flat',  m.processor_fee_flat,
      'match_timeout_seconds', cfg.match_timeout_seconds,
      'method_code',         m.code,
      'reversibility',       m.reversibility
    )
  ) returning * into d;

  perform deposit_match(d.id);

  select * into d from deposit_requests where id = d.id;
  return d;
end $$;

-- ─── Cancel ─────────────────────────────────────────────────────────────────
-- Abandoning a deposit before paying. Every locked slice goes back to the
-- queue; anything already paid for is untouchable by the depositor.
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
    raise exception 'deposit % is already %', d.id, d.status
      using errcode = 'invalid_parameter_value';
  end if;

  -- A slice you have already sent money for is not yours to cancel — it is
  -- the withdrawer's problem now, and the dispute path handles it.
  if exists (
    select 1 from fills
     where deposit_id = d.id
       and status in ('awaiting_confirmation', 'disputed', 'released')
  ) then
    raise exception
      'deposit % has slices already paid or under dispute — cancel is not available; open a dispute instead', d.id
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
