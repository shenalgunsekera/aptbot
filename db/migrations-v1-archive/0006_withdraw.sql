-- ═══════════════════════════════════════════════════════════════════════════
-- 0006 — Withdrawals: unload chips, escrow, join the FIFO queue
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Escrow ─────────────────────────────────────────────────────────────────
-- Moves the player's credit out of their spendable wallet and into escrow,
-- taking withdraw-direction rake on the way, then puts the request in the queue.
--
--   wallet  −gross
--   escrow  +net          (this is what a depositor will pay them)
--   rake    +rake
--   ───────────────
--   sum        0
--
-- After this the player CANNOT spend that credit: it lives in a different
-- account. That is what stops someone queueing three withdrawals against one
-- balance — no reservation bookkeeping needed, the ledger's non-negativity
-- constraint on player_wallet does it for us.
create or replace function withdraw_escrow(p_withdraw_id uuid)
returns withdraw_requests
language plpgsql as $$
declare
  w withdraw_requests;
begin
  select * into w from withdraw_requests where id = p_withdraw_id for update;
  if not found then
    raise exception 'withdrawal % not found', p_withdraw_id;
  end if;
  if w.status <> 'pending_unload' then
    raise exception 'withdrawal % is already escrowed (status %)', w.id, w.status
      using errcode = 'invalid_parameter_value';
  end if;

  perform ledger_post(
    'withdraw.escrow', 'withdraw_request', w.id, null,
    format('escrow %s net (%s gross, %s rake)', w.amount, w.gross_amount, w.rake_amount),
    jsonb_build_array(
      jsonb_build_object('account_id', account_of('player_wallet', w.player_id, w.currency),
                         'amount', -w.gross_amount),
      jsonb_build_object('account_id', account_of('player_escrow', w.player_id, w.currency),
                         'amount', w.amount),
      jsonb_build_object('account_id', account_of('house_rake', null, w.currency),
                         'amount', w.rake_amount)
    )
  );

  update withdraw_requests
     set status = 'queued', queued_at = now()
   where id = w.id
  returning * into w;

  perform notify_player(w.player_id, 'withdraw.queued', 'withdraw_request', w.id,
                        jsonb_build_object('amount', w.amount, 'currency', w.currency));

  return w;
end $$;

-- ─── Create ─────────────────────────────────────────────────────────────────
-- Entry point for /club-withdraw.
--
-- Wallet-first, chips-second: if the player already holds enough internal
-- credit we escrow immediately and they hit the queue in this transaction. If
-- not, we raise a chip UNLOAD order and the request waits in 'pending_unload'
-- until an admin actually takes the chips off the table. Escrowing before the
-- chips are physically off the table would let a player withdraw credit for
-- chips they are still sitting at a table with — and possibly still losing.
create or replace function withdraw_create(
  p_player_id     uuid,
  p_method_id     uuid,
  p_gross         bigint,
  p_payout_handle text
) returns withdraw_requests
language plpgsql as $$
declare
  cfg config;
  pl  players;
  m   payment_methods;
  w   withdraw_requests;
  v_rake      bigint;
  v_net       bigint;
  v_wallet    bigint;
  v_chips     bigint;
  v_shortfall bigint;
  v_open      int;
  v_today     bigint;
  v_order     chip_orders;
  v_snap_at   timestamptz;
begin
  select * into cfg from config where id;

  -- Lock the player row for the whole check-then-act sequence. Without this,
  -- two concurrent /club-withdraw calls could each pass the open-request and
  -- daily-cap checks before either inserted.
  select * into pl from players where id = p_player_id for update;
  if not found then
    raise exception 'player % not found', p_player_id;
  end if;
  if pl.status <> 'active' then
    raise exception 'account is % — withdrawals are not available', pl.status
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
  if coalesce(trim(p_payout_handle), '') = '' then
    raise exception 'a payout handle is required — that is where you get paid'
      using errcode = 'invalid_parameter_value';
  end if;

  -- ── Limits ──
  if p_gross < coalesce(m.min_amount, cfg.min_amount) then
    raise exception 'minimum withdrawal for % is %', m.name, coalesce(m.min_amount, cfg.min_amount)
      using errcode = 'invalid_parameter_value';
  end if;
  if p_gross > coalesce(m.max_amount, cfg.max_amount) then
    raise exception 'maximum withdrawal for % is %', m.name, coalesce(m.max_amount, cfg.max_amount)
      using errcode = 'invalid_parameter_value';
  end if;

  select count(*) into v_open
    from withdraw_requests
   where player_id = p_player_id
     and status in ('pending_unload', 'queued', 'partially_filled', 'filled');
  if v_open >= cfg.max_open_withdraws_per_player then
    raise exception 'you already have % open withdrawals (limit %)', v_open, cfg.max_open_withdraws_per_player
      using errcode = 'invalid_parameter_value';
  end if;

  if cfg.daily_cap_per_player is not null then
    select coalesce(sum(gross_amount), 0) into v_today
      from withdraw_requests
     where player_id = p_player_id
       and status <> 'cancelled'
       and created_at > now() - interval '24 hours';
    if v_today + p_gross > cfg.daily_cap_per_player then
      raise exception 'daily withdrawal cap of % would be exceeded (% used in the last 24h)',
        cfg.daily_cap_per_player, v_today
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  -- ── Live ClubGG balance check ──
  -- Enforced HERE rather than in the bot because it is a money rule, and money
  -- rules that live in a client are suggestions. The bot is expected to call
  -- chips_sync() (via the chip adapter's balance read) immediately before this;
  -- if it didn't, or the read was too old to trust, we refuse rather than
  -- approve a withdrawal against chips the player may have already lost.
  if cfg.require_live_chip_check then
    select taken_at into v_snap_at
      from clubgg_snapshots
     where player_id = p_player_id and currency = m.currency
     order by taken_at desc
     limit 1;

    if v_snap_at is null
       or v_snap_at < now() - make_interval(secs => cfg.live_chip_check_max_age_seconds) then
      raise exception
        'live ClubGG balance check required: no reading newer than %s. Sync the player''s stack and retry.',
        cfg.live_chip_check_max_age_seconds
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  v_rake := calc_rake(p_gross, 'withdraw');
  v_net  := p_gross - v_rake;

  insert into withdraw_requests (
    player_id, method_id, currency, gross_amount, rake_amount,
    amount, amount_remaining, payout_handle, status, terms
  ) values (
    p_player_id, p_method_id, m.currency, p_gross, v_rake,
    v_net, v_net, trim(p_payout_handle), 'pending_unload',
    jsonb_build_object(
      'rake_withdraw_bps',  cfg.rake_withdraw_bps,
      'rake_withdraw_flat', cfg.rake_withdraw_flat,
      'method_code',        m.code,
      'reversibility',      m.reversibility
    )
  ) returning * into w;

  -- ── Funding ──
  -- Escrowed credit already lives in a different account, so the wallet
  -- balance IS free credit. No "minus owed/locked" arithmetic required.
  v_wallet := balance_of('player_wallet', p_player_id, m.currency);

  if v_wallet >= p_gross then
    w := withdraw_escrow(w.id);
  else
    v_shortfall := p_gross - v_wallet;
    v_chips     := balance_of('player_chips', p_player_id, m.currency);

    if v_chips < v_shortfall then
      raise exception
        'insufficient funds: wallet % + chips % = %, but you asked for %',
        v_wallet, v_chips, v_wallet + v_chips, p_gross
        using errcode = 'insufficient_privilege';
    end if;

    v_order := chip_order_create(
      p_player_id, -v_shortfall, m.currency,
      'withdraw.unload', 'withdraw_request', w.id
    );

    update withdraw_requests set unload_order_id = v_order.id where id = w.id
    returning * into w;
  end if;

  return w;
end $$;

-- ─── Refund escrow to wallet ────────────────────────────────────────────────
-- Undoes an escrow for `p_amount` of a withdrawal, returning the money to the
-- player's spendable wallet and handing back the withdraw rake in proportion.
--
--   escrow  −amount
--   wallet  +amount + rake_back
--   rake    −rake_back
--
-- Rake is returned pro-rata because a withdrawal that never got filled is a
-- service not rendered; charging for it would be the house quietly keeping
-- money for doing nothing.
create or replace function withdraw_refund_escrow(
  p_withdraw_id uuid,
  p_amount      bigint,
  p_kind        text,
  p_actor_admin uuid,
  p_memo        text
) returns void
language plpgsql as $$
declare
  w           withdraw_requests;
  v_rake_back bigint;
begin
  select * into w from withdraw_requests where id = p_withdraw_id;
  if p_amount <= 0 then
    return;
  end if;

  v_rake_back := (w.rake_amount * p_amount) / greatest(w.amount, 1);

  perform ledger_post(
    p_kind, 'withdraw_request', w.id, p_actor_admin, p_memo,
    jsonb_build_array(
      jsonb_build_object('account_id', account_of('player_escrow', w.player_id, w.currency),
                         'amount', -p_amount),
      jsonb_build_object('account_id', account_of('player_wallet', w.player_id, w.currency),
                         'amount', p_amount + v_rake_back),
      jsonb_build_object('account_id', account_of('house_rake', null, w.currency),
                         'amount', -v_rake_back)
    )
  );
end $$;

-- ─── Settle ─────────────────────────────────────────────────────────────────
-- Closes a withdrawal once nothing is outstanding: fully matched and every
-- slice resolved. Idempotent — called from every path that could be the last
-- one to finish, rather than making any single path responsible for knowing
-- it was last.
create or replace function withdraw_settle_if_done(p_withdraw_id uuid)
returns withdraw_requests
language plpgsql as $$
declare
  w      withdraw_requests;
  v_open int;
begin
  select * into w from withdraw_requests where id = p_withdraw_id for update;
  if w.status in ('completed', 'cancelled') then
    return w;
  end if;

  select count(*) into v_open
    from fills
   where withdraw_id = w.id
     and status in ('locked', 'awaiting_confirmation', 'disputed');

  if v_open > 0 or w.amount_remaining > 0 then
    return w;
  end if;

  update withdraw_requests
     set status = (case when w.cancel_requested_at is not null then 'cancelled' else 'completed' end)::withdraw_status,
         completed_at = now()
   where id = w.id
  returning * into w;

  perform notify_player(w.player_id,
    case when w.status = 'cancelled' then 'withdraw.cancelled' else 'withdraw.completed' end,
    'withdraw_request', w.id,
    jsonb_build_object('amount', w.amount, 'currency', w.currency));

  return w;
end $$;

-- ─── Return a slice ─────────────────────────────────────────────────────────
-- A slice stopped being claimed (lock expired, deposit cancelled, dispute
-- refunded). Where it goes depends on whether the player still wants the money:
--
--   live withdrawal      → back into the FIFO queue, at its ORIGINAL position.
--                          created_at is never touched, so a slice that expires
--                          returns to the FRONT rather than the back — the
--                          withdrawer is not punished for a depositor's timeout.
--   cancelled withdrawal → back to the player's wallet. Re-queueing here would
--                          re-issue money already refunded by withdraw_cancel.
create or replace function withdraw_return_slice(
  p_withdraw_id uuid,
  p_amount      bigint,
  p_reason      text
) returns void
language plpgsql as $$
declare
  w withdraw_requests;
begin
  select * into w from withdraw_requests where id = p_withdraw_id for update;
  if not found then
    raise exception 'withdraw_return_slice: withdrawal % not found', p_withdraw_id;
  end if;

  if w.cancel_requested_at is null then
    update withdraw_requests
       set amount_remaining = amount_remaining + p_amount,
           status = (case
                       when amount_remaining + p_amount >= amount then 'queued'
                       else 'partially_filled'
                     end)::withdraw_status,
           completed_at = null
     where id = w.id;
  else
    perform withdraw_refund_escrow(
      w.id, p_amount, 'withdraw.slice_refund', null,
      format('slice of %s returned to wallet after cancel (%s)', p_amount, p_reason)
    );
    perform withdraw_settle_if_done(w.id);
  end if;
end $$;

-- ─── Cancel ─────────────────────────────────────────────────────────────────
-- Returns un-matched escrow to the wallet. Any slice already locked or
-- awaiting confirmation keeps its claim: a depositor may be mid-payment
-- against it, and pulling the rug there is how you manufacture a dispute.
-- Those slices settle on their own and route through withdraw_return_slice,
-- which sees cancel_requested_at and sends them to the wallet.
create or replace function withdraw_cancel(
  p_withdraw_id uuid,
  p_actor_admin uuid default null,
  p_reason      text default null
) returns withdraw_requests
language plpgsql as $$
declare
  w        withdraw_requests;
  v_refund bigint;
begin
  select * into w from withdraw_requests where id = p_withdraw_id for update;
  if not found then
    raise exception 'withdrawal % not found', p_withdraw_id;
  end if;
  if w.status in ('completed', 'cancelled') then
    raise exception 'withdrawal % is already %', w.id, w.status
      using errcode = 'invalid_parameter_value';
  end if;
  if w.cancel_requested_at is not null then
    raise exception 'withdrawal % is already pending cancellation', w.id
      using errcode = 'invalid_parameter_value';
  end if;

  -- Nothing escrowed yet — drop it and void the unload order.
  if w.status = 'pending_unload' then
    update chip_orders
       set status = 'cancelled', failure_reason = 'withdrawal cancelled'
     where id = w.unload_order_id and status in ('pending', 'claimed');

    update withdraw_requests
       set status = 'cancelled', cancel_reason = p_reason,
           cancel_requested_at = now(), completed_at = now()
     where id = w.id
    returning * into w;

    perform audit(p_actor_admin, 'withdraw.cancel', 'withdraw_request', w.id,
                  jsonb_build_object('reason', p_reason, 'stage', 'pending_unload'));
    return w;
  end if;

  v_refund := w.amount_remaining;

  perform withdraw_refund_escrow(
    w.id, v_refund, 'withdraw.cancel_refund', p_actor_admin,
    format('return %s unmatched escrow to wallet on cancel', v_refund)
  );

  update withdraw_requests
     set amount_remaining = 0,
         cancel_requested_at = now(),
         cancel_reason = p_reason,
         status = (case when w.amount_remaining >= w.amount then 'cancelled' else 'filled' end)::withdraw_status
   where id = w.id
  returning * into w;

  perform audit(p_actor_admin, 'withdraw.cancel', 'withdraw_request', w.id,
                jsonb_build_object('refunded', v_refund, 'reason', p_reason));

  -- Closes it out now if no slices were outstanding; otherwise the last slice to
  -- resolve will.
  w := withdraw_settle_if_done(w.id);
  return w;
end $$;
