-- ═══════════════════════════════════════════════════════════════════════════
-- 0105 — Per-method amount step ($1 everywhere except Venmo / Zelle)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The step (multiples-of) lived only in config.amount_step (global $5). Owners
-- wanted most methods to take $1 increments while Venmo & Zelle stay on $5. So
-- the step becomes a per-method override: coalesce(method.amount_step, global).
--
--   • method.amount_step set   → that method uses it
--   • method.amount_step null  → inherits config.amount_step (the global default)
--
-- Backfill: everything except Venmo & Zelle → $1; Venmo & Zelle stay null so they
-- inherit the global $5. The owner can retune any method in the admin panel.
--
-- enforce_amount_rules() is the single trigger on deposit_requests /
-- withdraw_requests inserts, so this one change covers deposits, cash-outs, and
-- (via deposit_create) admin-credited amounts alike. Stripe stays exempt.

alter table payment_methods add column if not exists amount_step bigint
  check (amount_step is null or amount_step > 0);

update payment_methods set amount_step = 100 where code not in ('venmo', 'zelle');

create or replace function enforce_amount_rules() returns trigger
language plpgsql as $$
declare
  cfg    config;
  v_amt  bigint;
  v_min  bigint;
  v_step bigint;
  v_code text;
begin
  select * into cfg from config where id;

  if tg_table_name = 'deposit_requests' then
    v_amt := new.amount;
  else
    v_amt := new.requested_amount;
  end if;

  -- Card / Apple Pay: the amount is whatever actually arrived on Stripe, not a
  -- bot-entered figure — so the min/step rules don't apply.
  select code into v_code from payment_methods where id = new.method_id;
  if v_code = 'stripe' then
    return new;
  end if;

  -- Per-method minimum, but never below the global floor.
  select coalesce(m.min_amount, cfg.min_amount) into v_min
    from payment_methods m where m.id = new.method_id;
  v_min := greatest(coalesce(v_min, cfg.min_amount), cfg.min_amount);

  if v_amt < v_min then
    raise exception 'the smallest amount is %',
      to_char(v_min / 100.0, 'FM999999990D00')
      using errcode = 'invalid_parameter_value';
  end if;

  -- Per-method step, falling back to the global one.
  select coalesce(m.amount_step, cfg.amount_step) into v_step
    from payment_methods m where m.id = new.method_id;
  if v_step is not null and (v_amt % v_step) <> 0 then
    raise exception 'amounts must be in whole multiples of % — no cents',
      to_char(v_step / 100.0, 'FM999999990')
      using errcode = 'invalid_parameter_value';
  end if;

  return new;
end $$;
