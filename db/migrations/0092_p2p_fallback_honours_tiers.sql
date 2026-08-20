-- ═══════════════════════════════════════════════════════════════════════════
-- 0092 — A P2P method's no-match fallback honours its amount tiers
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 0085 made a P2P method's no-match fallback always use m.club_handle (its single
-- backstop tag), to stop Cash App's stale STRIPE tier diverting deposits. But that
-- also ignored INTENTIONAL p2p tiers: an admin who sets Venmo to
--   ≤ $249 → @dvbdvb77 ,  above → PEERPAY (staff backup)
-- still saw @dvbdvb77 for a $300 deposit, because the fallback skipped the tiers.
--
-- Fix: the fallback uses club_handle_for for EVERY method. With no tiers,
-- club_handle_for returns the single club_handle — the old backstop — so a
-- tier-less p2p method (plain Venmo/Zelle) is unchanged. With tiers, the amount
-- routes to the right target (a tag / PEERPAY / STAFF / STRIPE). Matchable
-- deposits are untouched: the match runs first (v_remaining → 0), and the bot
-- still never pre-diverts a p2p deposit, so a queued cash-out is always paid
-- before any fallback. Only the fallback-handle line changes vs 0085.
create or replace function deposit_match(p_deposit_id uuid)
returns setof fills
language plpgsql as $$
declare
  cfg config;
  d   deposit_requests;
  m   payment_methods;
  w   record;
  f   fills;
  v_remaining   bigint;
  v_slice       bigint;
  v_rake        bigint;
  v_lock_exp    timestamptz;
  v_club_handle text;
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

  -- ── p2p: pay ONE player in full, or nobody (no splits) ──
  if m.settlement = 'p2p' then
    select id, player_id, payout_handle, amount_remaining
      into w
      from withdraw_requests
     where method_id = d.method_id
       and currency  = d.currency
       and status in ('queued', 'partially_filled')
       and amount_remaining > 0
       and player_id <> d.player_id
       and paused_at is null
     order by created_at, id
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

  -- ── The club takes the rest — at the tiered handle for this amount ──
  -- Every method routes by its amount tiers here. No tiers → club_handle_for
  -- returns the single club_handle (the p2p backstop), so plain Venmo/Zelle is
  -- unchanged; with tiers, the amount picks the right target.
  if v_remaining > 0 then
    v_club_handle := club_handle_for(d.method_id, d.amount);

    if v_club_handle is null then
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
      d.id, null, d.method_id, d.currency,
      v_remaining, v_rake, v_remaining - v_rake,
      calc_gross_to_send(v_remaining, d.method_id),
      v_club_handle, 'locked', v_lock_exp
    ) returning * into f;

    v_remaining := 0;
    return next f;
  end if;

  update deposit_requests set status = 'awaiting_payment' where id = d.id;
  return;
end $$;
