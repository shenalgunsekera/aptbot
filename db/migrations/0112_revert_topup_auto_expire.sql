-- ═══════════════════════════════════════════════════════════════════════════
-- 0112 — revert 0111: do NOT auto-expire abandoned /addtowithdraw add-ons
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 0111 auto-failed add-on take-offs left pending >12h on fully-paid cash-outs so
-- the cash-out could close on its own. The owner would rather these NOT vanish
-- automatically — an unworked take-off is a real loose end a human should see
-- and decide on. They are now surfaced in the admin panel's Jobs "Reminders"
-- section instead. So restore the pre-0111 sweeper: settle only fully-paid
-- cash-outs that have no add-on take-off pending/claimed at all (an abandoned
-- add-on keeps the cash-out open until an admin resolves the job by hand).
create or replace function sweep_stuck_withdraws()
returns integer
language plpgsql as $$
declare
  w       withdraw_requests;
  v_count int := 0;
begin
  for w in
    select * from withdraw_requests wr
     where wr.status in ('queued', 'partially_filled', 'filled')
       and coalesce(wr.amount_remaining, 0) <= 0
       and not exists (select 1 from fills f
                        where f.withdraw_id = wr.id
                          and f.status in ('locked', 'awaiting_confirmation', 'disputed'))
       and not exists (select 1 from loader_orders o
                        where o.ref_type = 'withdraw_request' and o.ref_id = wr.id
                          and o.reason = 'withdraw.topup' and o.status in ('pending', 'claimed'))
       for update skip locked
  loop
    perform withdraw_settle_if_done(w.id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;
