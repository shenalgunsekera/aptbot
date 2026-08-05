-- ═══════════════════════════════════════════════════════════════════════════
-- 0063 — Peer-to-peer stays, but a deposit NEVER splits across destinations
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Revert 0062 (Venmo/Zelle back to p2p) and instead fix the matching itself:
--
--   A deposit goes to exactly ONE destination. Take the front-of-queue cash-out
--   (strict FIFO). If that one player can absorb the WHOLE deposit (their
--   amount_remaining >= the deposit), pay them in full — peer-to-peer. If the
--   deposit is bigger than what that player is owed, paying them would leave a
--   remainder that has to go somewhere else (a split), so instead the ENTIRE
--   deposit goes to the company account. A depositor is NEVER asked to pay two
--   people, and never "send $10 to a player and $40 to the company".
--
--   Examples ($ = deposit):  player owed $10, $50 in → all $50 to company.
--                            player owed $50, $50 in → all $50 to that player.
--                            player owed $50, $10 in → $10 to that player (partial).
update payment_methods set settlement = 'p2p' where code in ('venmo', 'zelle');

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

  -- ── p2p: pay ONE player in full, or nobody ──
  -- NO SPLITS. Take the front-of-queue cash-out (FIFO). If it can absorb the
  -- WHOLE deposit, pay it entirely, peer-to-peer. If not, paying it would strand
  -- a remainder that needs a second destination — so we don't; the whole deposit
  -- falls through to the club below. `for update skip locked` keeps concurrent
  -- depositors from grabbing the same payee.
  if m.settlement = 'p2p' then
    select id, player_id, payout_handle, amount_remaining
      into w
      from withdraw_requests
     where method_id = d.method_id
       and currency  = d.currency
       and status in ('queued', 'partially_filled')
       and amount_remaining > 0
       and player_id <> d.player_id          -- self-dealing block
     order by created_at, id                 -- FIFO; id breaks exact-timestamp ties
       for update skip locked
     limit 1;

    if found and w.amount_remaining >= v_remaining then
      v_slice := v_remaining;
      v_rake  := calc_rake(v_slice, 'deposit');

      insert into fills (
        deposit_id, withdraw_id, method_id, currency,
        amount, rake_amount, credit_amount, gross_to_send,
        payout_handle, status, lock_expires_at
      ) values (
        d.id, w.id, d.method_id, d.currency,
        v_slice, v_rake, v_slice - v_rake, calc_gross_to_send(v_slice, d.method_id),
        w.payout_handle, 'locked', v_lock_exp
      ) returning * into f;

      update withdraw_requests
         set amount_remaining = amount_remaining - v_slice,
             status = (case when amount_remaining - v_slice = 0 then 'filled'
                            else 'partially_filled' end)::withdraw_status
       where id = w.id;

      v_remaining := 0;
      return next f;
    end if;
  end if;

  -- ── The club takes the rest ──
  -- club method: always the whole deposit. p2p: the whole deposit whenever no
  -- single player could absorb it (so it was never split).
  if v_remaining > 0 then
    if m.club_handle is null then
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
