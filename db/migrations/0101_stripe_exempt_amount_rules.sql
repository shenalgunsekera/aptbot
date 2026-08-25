-- ═══════════════════════════════════════════════════════════════════════════
-- 0101 — Card / Apple Pay (Stripe) is exempt from the min & step rules
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The min/step rules govern amounts a player TYPES INTO THE BOT. A card / Apple
-- Pay deposit is different: the player pays whatever they want on Stripe's own
-- page, so the amount that lands (e.g. $38 on a $30 deposit) isn't a number the
-- bot chose and may not be a whole multiple of $5. When the admin verifies that
-- receipt, stripe_claim_credit → deposit_create re-runs this trigger and the
-- step check refused to book it — stranding real money that had already arrived.
--
-- Fix: real money that landed must ALWAYS be bookable, so the card/Stripe method
-- skips min & step. The admin is the gate (Verify / Discard). Every other method
-- (peer-to-peer bot-entered amounts) keeps min & step exactly as before.
create or replace function enforce_amount_rules() returns trigger
language plpgsql as $$
declare
  cfg    config;
  v_amt  bigint;
  v_min  bigint;
  v_code text;
begin
  select * into cfg from config where id;

  if tg_table_name = 'deposit_requests' then
    v_amt := new.amount;
  else
    v_amt := new.requested_amount;
  end if;

  -- Card / Apple Pay: the amount is whatever actually arrived on Stripe, not a
  -- bot-entered figure — so the min/step rules don't apply. Real money that
  -- landed must always be creditable.
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

  if cfg.amount_step is not null and (v_amt % cfg.amount_step) <> 0 then
    raise exception 'amounts must be in whole multiples of % — no cents',
      to_char(cfg.amount_step / 100.0, 'FM999999990')
      using errcode = 'invalid_parameter_value';
  end if;

  return new;
end $$;
