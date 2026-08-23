-- ═══════════════════════════════════════════════════════════════════════════
-- 0095 — The amount-rules trigger respects the PER-METHOD minimum
-- ═══════════════════════════════════════════════════════════════════════════
--
-- enforce_amount_rules (0017) rejected anything below the GLOBAL config.min_amount
-- on every deposit/withdraw — so a method's own lower minimum (e.g. Venmo $5 while
-- the global is $20) was dead: the trigger refused a $10 Venmo deposit before the
-- per-method check in deposit_create/withdraw_create ever ran.
--
-- Fix: the trigger now uses coalesce(method.min_amount, config.min_amount) — the
-- method's minimum, falling back to the global. deposit_create / withdraw_create
-- already use the same coalesce for min AND max, so the whole path is now
-- consistently per-method. The global min is the fallback only. Step is unchanged
-- (global). No method currently has a minimum ABOVE the global, so this only
-- ENABLES the lower per-method minimums that were already configured.
create or replace function enforce_amount_rules() returns trigger
language plpgsql as $$
declare
  cfg   config;
  v_amt bigint;
  v_min bigint;
begin
  select * into cfg from config where id;

  if tg_table_name = 'deposit_requests' then
    v_amt := new.amount;
  else
    v_amt := new.requested_amount;
  end if;

  -- Per-method minimum, falling back to the global one.
  select coalesce(m.min_amount, cfg.min_amount) into v_min
    from payment_methods m where m.id = new.method_id;
  v_min := coalesce(v_min, cfg.min_amount);

  if v_amt < v_min then
    raise exception 'the smallest amount is %',
      to_char(v_min / 100.0, 'FM999999990D00')
      using errcode = 'invalid_parameter_value';
  end if;

  if cfg.amount_step is not null and (v_amt % cfg.amount_step) <> 0 then
    raise exception 'amounts must be in whole multiples of % — no cents',
      to_char(cfg.amount_step / 100.0, 'FM999999990')
      using errcode = 'invalid_parameter_value';
  end if;

  return new;
end $$;
