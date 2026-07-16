-- ═══════════════════════════════════════════════════════════════════════════
-- 0006 — Withdrawals: ask → unload → escrow → queue
-- ═══════════════════════════════════════════════════════════════════════════
--
-- THE V2 FLOW, AND WHY IT IS SHAPED THIS WAY
--
--   v1:  check the player's tracked chip balance → escrow → raise an unload
--        The check was against a number that started lying the moment anyone
--        played a hand, so a withdrawal could be accepted and then fail at the
--        unload — after the player had been told yes.
--
--   v2:  ask → raise an unload → THE LOADER REPORTS WHAT ACTUALLY CAME OFF →
--        escrow exactly that → queue
--
-- Nothing is promised before it is real. There is no pre-check because there is
-- no honest number to check against, and there is no "available balance" to show
-- because no such thing exists. The loader's hands are the source of truth.

-- ─── Create ─────────────────────────────────────────────────────────────────
-- Entry point for a withdrawal. Raises loader work; escrows nothing yet.
create or replace function withdraw_create(
  p_player_id     uuid,
  p_platform_id   uuid,
  p_method_id     uuid,
  p_requested     bigint,
  p_payout_handle text
) returns withdraw_requests
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

  select count(*) into v_open
    from withdraw_requests
   where player_id = p_player_id
     and status in ('pending_unload', 'queued', 'partially_filled', 'filled');
  if v_open >= cfg.max_open_withdraws_per_player then
    raise exception 'you already have % cash outs in progress — finish those first', v_open
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

-- ─── Escrow ─────────────────────────────────────────────────────────────────
-- Called by loader_order_complete once value has ACTUALLY come off the table.
-- p_actual is what really moved — never what was asked for.
--
--   settlement:platform  −actual   (value left that platform's tables)
--   wallet               +actual   (the union now owes the player credit)
--   ── then immediately ──
--   wallet               −actual
--   escrow               +net
--   rake                 +rake
--
-- Net of it: settlement −actual, escrow +net, rake +rake. Sums to zero. The
-- wallet round-trip is written as two posts so the audit trail shows credit
-- existing before it was locked, which is what actually happened.
create or replace function withdraw_escrow(
  p_withdraw_id uuid,
  p_actual      bigint
) returns withdraw_requests
language plpgsql as $$
declare
  w      withdraw_requests;
  v_rake bigint;
  v_net  bigint;
begin
  select * into w from withdraw_requests where id = p_withdraw_id for update;
  if not found then
    raise exception 'withdrawal % not found', p_withdraw_id;
  end if;
  if w.status <> 'pending_unload' then
    raise exception 'withdrawal % is already past unloading (status %)', w.id, w.status
      using errcode = 'invalid_parameter_value';
  end if;
  if p_actual <= 0 then
    raise exception 'withdraw_escrow: actual must be positive, got %', p_actual;
  end if;

  v_rake := calc_rake(p_actual, 'withdraw');
  v_net  := p_actual - v_rake;

  -- Value leaves the tables and becomes credit we owe.
  perform ledger_post(
    'withdraw.unload', 'withdraw_request', w.id, null,
    format('%s came off the tables', p_actual),
    jsonb_build_array(
      jsonb_build_object('account_id',
        account_of('house_settlement', null, w.platform_id, w.currency), 'amount', -p_actual),
      jsonb_build_object('account_id',
        account_of('player_wallet', w.player_id, w.platform_id, w.currency), 'amount', p_actual)
    ));

  -- ...and is immediately locked behind this withdrawal, rake taken.
  perform ledger_post(
    'withdraw.escrow', 'withdraw_request', w.id, null,
    format('lock %s (%s gross, %s fee)', v_net, p_actual, v_rake),
    jsonb_build_array(
      jsonb_build_object('account_id',
        account_of('player_wallet', w.player_id, w.platform_id, w.currency), 'amount', -p_actual),
      jsonb_build_object('account_id',
        account_of('player_escrow', w.player_id, w.platform_id, w.currency), 'amount', v_net),
      jsonb_build_object('account_id',
        account_of('house_rake', null, null, w.currency), 'amount', v_rake)
    ));

  update withdraw_requests
     set gross_amount = p_actual,
         rake_amount  = v_rake,
         amount       = v_net,
         amount_remaining = v_net,
         status       = 'queued',
         queued_at    = now()
   where id = w.id
  returning * into w;

  perform notify_player(w.player_id, 'withdraw.queued', 'withdraw_request', w.id,
    jsonb_build_object('amount', w.amount, 'currency', w.currency,
                       'short', p_actual < w.requested_amount,
                       'requested', w.requested_amount));
  return w;
end $$;

-- ─── Refund escrow to wallet ────────────────────────────────────────────────
-- Rake is returned pro-rata: a withdrawal that never filled is a service not
-- rendered, and charging for it would be the house quietly keeping money for
-- doing nothing.
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
      jsonb_build_object('account_id',
        account_of('player_escrow', w.player_id, w.platform_id, w.currency), 'amount', -p_amount),
      jsonb_build_object('account_id',
        account_of('player_wallet', w.player_id, w.platform_id, w.currency),
        'amount', p_amount + v_rake_back),
      jsonb_build_object('account_id',
        account_of('house_rake', null, null, w.currency), 'amount', -v_rake_back)
    ));
end $$;

-- ─── Settle ─────────────────────────────────────────────────────────────────
-- Idempotent, and called from every path that could be the last to finish —
-- rather than making any single path responsible for knowing it was last.
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
   where withdraw_id = w.id and status in ('locked', 'awaiting_confirmation', 'disputed');

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
-- A slice stopped being claimed. Where it goes depends on whether the player
-- still wants the money:
--   live withdrawal      → back into the FIFO queue at its ORIGINAL position.
--                          created_at is never touched, so a slice that expires
--                          returns to the FRONT — the payee is not punished for
--                          a payer's timeout.
--   cancelled withdrawal → back to the wallet. Re-queueing here would re-issue
--                          money withdraw_cancel already refunded.
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
           status = (case when amount_remaining + p_amount >= amount then 'queued'
                          else 'partially_filled' end)::withdraw_status,
           completed_at = null
     where id = w.id;
  else
    perform withdraw_refund_escrow(
      w.id, p_amount, 'withdraw.slice_refund', null,
      format('%s returned to balance after cancel (%s)', p_amount, p_reason));
    perform withdraw_settle_if_done(w.id);
  end if;
end $$;

-- ─── Cancel ─────────────────────────────────────────────────────────────────
-- Un-matched escrow goes back to the wallet. Slices already locked or awaiting
-- confirmation keep their claim: a payer may be mid-payment against them, and
-- pulling the rug there is how you manufacture a dispute. Those settle on their
-- own and route through withdraw_return_slice, which sees cancel_requested_at.
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
    raise exception 'that cash out is already %', w.status
      using errcode = 'invalid_parameter_value';
  end if;
  if w.cancel_requested_at is not null then
    raise exception 'that cash out is already being cancelled'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Nothing came off the tables yet — drop it and void the loader's work.
  if w.status = 'pending_unload' then
    update loader_orders
       set status = 'cancelled', failure_reason = 'cash out cancelled'
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
    format('return %s unmatched to balance on cancel', v_refund));

  update withdraw_requests
     set amount_remaining = 0,
         cancel_requested_at = now(),
         cancel_reason = p_reason,
         status = (case when w.amount_remaining >= w.amount then 'cancelled'
                        else 'filled' end)::withdraw_status
   where id = w.id
  returning * into w;

  perform audit(p_actor_admin, 'withdraw.cancel', 'withdraw_request', w.id,
                jsonb_build_object('refunded', v_refund, 'reason', p_reason));

  w := withdraw_settle_if_done(w.id);
  return w;
end $$;
