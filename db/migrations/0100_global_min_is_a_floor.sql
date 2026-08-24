-- ═══════════════════════════════════════════════════════════════════════════
-- 0100 — The global minimum is a hard FLOOR, not just a fallback
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 0095 made the amount rule method-aware via coalesce(method.min, config.min).
-- The side effect: a method's own minimum could sit BELOW the global one, so a
-- $5 Venmo minimum let a $10 deposit through even though the owner had set the
-- global "Min per transaction" to $20 and expected that to be the floor.
--
-- Now the effective minimum is greatest(method.min, config.min): the global is a
-- hard floor every method must clear, and a per-method minimum can only raise it,
-- never lower it — the same "raise-only" rule the per-cash-out override already
-- uses. The global "Min per transaction" is therefore the single source of truth,
-- and changing it re-floors every method at once. Step and max are unchanged.
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

  -- Per-method minimum, but never below the global floor.
  select coalesce(m.min_amount, cfg.min_amount) into v_min
    from payment_methods m where m.id = new.method_id;
  v_min := greatest(coalesce(v_min, cfg.min_amount), cfg.min_amount);

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
