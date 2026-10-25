-- ═══════════════════════════════════════════════════════════════════════════
-- 0126 — payment reference uniqueness: player deposits only
-- ═══════════════════════════════════════════════════════════════════════════
--
-- fills_payment_ref_uniq (0004) stops the same transaction ID being used for two
-- fills on one method — a real fraud guard for PLAYER deposits (one payment can't
-- credit twice). But it also covered fills staff create when clearing a withdrawal
-- themselves ("Clear this withdrawal yourself" → withdraw_club_payout), where the
-- reference is a free-text note like "sent" or "paid". Typing "sent" twice on the
-- same method then failed with a raw duplicate-key error.
--
-- Keep the guard for deposit fills (deposit_id set — includes Stripe claims);
-- drop it for staff-entered payout fills (no deposit behind them).
drop index if exists fills_payment_ref_uniq;
create unique index fills_payment_ref_uniq
  on fills (method_id, payment_ref)
  where payment_ref is not null
    and status not in ('expired', 'cancelled')
    and deposit_id is not null;
