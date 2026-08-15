-- ═══════════════════════════════════════════════════════════════════════════
-- 0068 — Amount-based deposit handles (tiers) per method
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A method can now route the DEPOSIT handle by amount: e.g. Venmo under $300 →
-- @dvbdvb77, over $300 → a business tag. Stored as an ordered list on the method:
--   handle_tiers = [ {"up_to": 30000, "handle": "@dvbdvb77"},
--                    {"up_to": null,  "handle": "@peerpay"} ]
-- (up_to is cents; null = no ceiling / "everything above"). A deposit picks the
-- first tier whose up_to >= the amount. No tiers → the single club_handle, as before.
alter table payment_methods add column if not exists handle_tiers jsonb;

-- The company handle a deposit of `p_amount` (minor units) should be paid to.
create or replace function club_handle_for(p_method uuid, p_amount bigint) returns text
language plpgsql stable as $$
declare
  m payment_methods;
  t jsonb;
begin
  select * into m from payment_methods where id = p_method;
  if m.handle_tiers is null or jsonb_array_length(coalesce(m.handle_tiers, '[]'::jsonb)) = 0 then
    return m.club_handle;
  end if;
  for t in
    select value from jsonb_array_elements(m.handle_tiers) value
    order by (case when nullif(value->>'up_to', '') is null then null else (value->>'up_to')::bigint end) asc nulls last
  loop
    if nullif(t->>'up_to', '') is null or p_amount <= (t->>'up_to')::bigint then
      if coalesce(nullif(trim(t->>'handle'), ''), '') <> '' then
        return t->>'handle';
      end if;
    end if;
  end loop;
  return m.club_handle;   -- amount fell past every tier → fall back
end $$;

-- Recreate deposit_match so the club fill uses the tiered handle (only change vs 0063).
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
