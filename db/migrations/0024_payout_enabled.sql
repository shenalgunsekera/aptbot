-- ═══════════════════════════════════════════════════════════════════════════
-- 0024 — Deposit-only methods (Stripe can't pay out) + Apple Pay label
-- ═══════════════════════════════════════════════════════════════════════════
-- Stripe (card / Apple Pay) can take a payment but can't SEND one, so it must not
-- appear as a cash-out option. payout_enabled=false marks a method deposit-only.
alter table payment_methods add column if not exists payout_enabled boolean not null default true;

update payment_methods set payout_enabled = false, name = '🍎 Apple Pay / Debit Card' where code = 'stripe';
