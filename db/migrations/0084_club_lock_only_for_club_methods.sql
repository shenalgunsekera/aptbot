-- ═══════════════════════════════════════════════════════════════════════════
-- 0084 — The 24h club lock is only for genuinely-slow methods, not P2P backstops
-- ═══════════════════════════════════════════════════════════════════════════
--
-- extend_club_deposit_lock() bumped EVERY club-payee deposit fill to a 24h window.
-- But a P2P method (Venmo/Cash App/Zelle) that merely fell through to the club
-- backstop is still an INSTANT payment — giving it 24h means the "you have N
-- minutes" prompt never matches reality and the deposit never expires on time.
--
-- Only extend to 24h when the METHOD is company-settled (crypto, bank) — those
-- genuinely take a while. A P2P method keeps the normal match-timeout window, so
-- it expires when the prompt says and the depositor gets the "time's up" notice.
create or replace function extend_club_deposit_lock() returns trigger
language plpgsql as $$
begin
  if new.deposit_id is not null and new.withdraw_id is null and new.status = 'locked'
     and exists (select 1 from payment_methods m
                  where m.id = new.method_id and m.settlement = 'club') then
    new.lock_expires_at := now() + interval '24 hours';
  end if;
  return new;
end $$;
