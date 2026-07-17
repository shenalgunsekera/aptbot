-- ═══════════════════════════════════════════════════════════════════════════
-- 0026 — Stripe = fixed payment link, player-entered amount, admin credits
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Stripe now uses ONE shared payment link. The player enters their own amount on
-- Stripe's page, so we don't know it up front and it needn't be a multiple of 5.
-- After paying they send a receipt; the webhook separately tells admins the
-- amount that arrived. An admin credits the exact amount, which runs the normal
-- deposit → verify path so the money lands on the player's table.

-- Any-amount methods skip the "multiples of 5 / min 20" rule (Stripe lets the
-- payer type any figure).
alter table payment_methods add column if not exists free_amount boolean not null default false;
update payment_methods set free_amount = true where code = 'stripe';

create or replace function enforce_amount_rules() returns trigger
language plpgsql as $$
declare
  cfg   config;
  v_amt bigint;
  v_free boolean := false;
begin
  select * into cfg from config where id;

  if tg_table_name = 'deposit_requests' then
    v_amt := new.amount;
    select free_amount into v_free from payment_methods where id = new.method_id;
  else
    v_amt := new.requested_amount;
  end if;

  if coalesce(v_free, false) then
    return new;   -- Stripe & friends: whatever the payer chose stands.
  end if;

  if v_amt < cfg.min_amount then
    raise exception 'the smallest amount is %',
      to_char(cfg.min_amount / 100.0, 'FM999999990') using errcode = 'invalid_parameter_value';
  end if;
  if cfg.amount_step is not null and (v_amt % cfg.amount_step) <> 0 then
    raise exception 'amounts must be in whole multiples of % — no cents',
      to_char(cfg.amount_step / 100.0, 'FM999999990') using errcode = 'invalid_parameter_value';
  end if;
  return new;
end $$;

-- ─── The claim: a receipt awaiting an amount + admin credit ──────────────────
create table if not exists stripe_claims (
  id              uuid primary key default gen_random_uuid(),
  player_id       uuid not null references players (id),
  platform_id     uuid not null references platforms (id),
  receipt_url     text,
  receipt_file_id text,
  status          text not null default 'pending' check (status in ('pending', 'credited', 'rejected')),
  amount          bigint,
  credited_fill   uuid references fills (id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists stripe_claims_status_idx on stripe_claims (status, created_at desc);
create trigger stripe_claims_touch before update on stripe_claims
  for each row execute function touch_updated_at();

-- ─── Credit a claim: normal deposit → proof → verify, at the exact amount ────
create or replace function stripe_claim_credit(
  p_claim  uuid,
  p_admin  uuid,
  p_amount bigint
) returns fills
language plpgsql as $$
declare
  c  stripe_claims;
  m  payment_methods;
  d  deposit_requests;
  f  fills;
begin
  select * into c from stripe_claims where id = p_claim for update;
  if not found then
    raise exception 'claim % not found', p_claim;
  end if;
  if c.status <> 'pending' then
    raise exception 'that Stripe payment is already %', c.status using errcode = 'invalid_parameter_value';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'enter the amount that was paid' using errcode = 'invalid_parameter_value';
  end if;

  select * into m from payment_methods where code = 'stripe';

  d := deposit_create(c.player_id, c.platform_id, m.id, p_amount);
  select * into f from fills where deposit_id = d.id order by seq limit 1;
  perform fill_submit_proof(f.id, 'stripe', 'card via payment link', false);
  f := fill_admin_verify(f.id, p_admin, 'stripe receipt confirmed');

  update stripe_claims set status = 'credited', amount = p_amount, credited_fill = f.id where id = c.id;
  return f;
end $$;
