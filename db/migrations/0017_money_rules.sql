-- ═══════════════════════════════════════════════════════════════════════════
-- 0017 — Money rules: faster timeout, higher floor, whole multiples of 5
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Product rules (v2.1):
--   • Payment window shrinks 30 min → 5 min.
--   • Minimum add/cash-out is 20.
--   • Amounts must be whole multiples of 5 — no decimals, no 22.50.
--
-- The step lives in config (amount_step, minor units) so the owner can retune it
-- without a code change. Enforcement is a BEFORE INSERT trigger on both request
-- tables, so it holds no matter which path creates a request — bot, panel, or a
-- future admin tool — and raises a player-friendly message, not a raw constraint
-- violation.

-- Faster window + higher floor.
update config set match_timeout_seconds = 300, min_amount = 2000 where id;

-- The granularity of money. 500 minor units = multiples of 5.
alter table config
  add column if not exists amount_step bigint not null default 500
    check (amount_step is null or amount_step > 0);

create or replace function enforce_amount_rules() returns trigger
language plpgsql as $$
declare
  cfg   config;
  v_amt bigint;
begin
  select * into cfg from config where id;

  if tg_table_name = 'deposit_requests' then
    v_amt := new.amount;
  else
    v_amt := new.requested_amount;
  end if;

  if v_amt < cfg.min_amount then
    raise exception 'the smallest amount is %',
      to_char(cfg.min_amount / 100.0, 'FM999999990')
      using errcode = 'invalid_parameter_value';
  end if;

  if cfg.amount_step is not null and (v_amt % cfg.amount_step) <> 0 then
    raise exception 'amounts must be in whole multiples of % — no cents',
      to_char(cfg.amount_step / 100.0, 'FM999999990')
      using errcode = 'invalid_parameter_value';
  end if;

  return new;
end $$;

drop trigger if exists deposit_amount_rules on deposit_requests;
create trigger deposit_amount_rules
  before insert on deposit_requests
  for each row execute function enforce_amount_rules();

drop trigger if exists withdraw_amount_rules on withdraw_requests;
create trigger withdraw_amount_rules
  before insert on withdraw_requests
  for each row execute function enforce_amount_rules();
