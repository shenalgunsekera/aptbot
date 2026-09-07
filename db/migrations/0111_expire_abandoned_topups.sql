-- ═══════════════════════════════════════════════════════════════════════════
-- 0111 — expire abandoned /addtowithdraw add-ons so a paid cash-out can close
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Both withdraw_settle_if_done and sweep_stuck_withdraws refuse to close a
-- cash-out while ANY withdraw.topup take-off is pending/claimed — right, so a
-- legit add-on being worked isn't cut off. But nothing put a time limit on that
-- pending state. If a loader never works the add-on card (the player asked to
-- add, loaders paid out the original and moved on), that take-off sits pending
-- forever and pins a FULLY-PAID cash-out as "in progress" indefinitely.
--
-- Real case: a $1000 Venmo cash-out, paid in full across 10 fills, stayed
-- "pending" because a $2750 add-on requested a day earlier was never worked.
--
-- Fix: before settling, auto-expire add-on take-offs that have been unfinished
-- for over 12h on a cash-out that is ALREADY fully paid (nothing left to pay,
-- no open fills). Safe because an unworked take-off took no chips off the table
-- and posted no ledger entries — failing it unwinds nothing; it only lifts the
-- block so the finished cash-out can close. A recently-claimed order (a loader
-- actively on it) is protected by keying the age off claimed_at when present.
create or replace function sweep_stuck_withdraws()
returns integer
language plpgsql as $$
declare
  w        withdraw_requests;
  v_count  int := 0;
begin
  -- (A) Expire abandoned add-on take-offs on fully-paid cash-outs. An add-on that
  -- has been unfinished >12h was never going to be worked; it moved no value, so
  -- marking it failed is a no-op on the ledger and unblocks the settle below.
  update loader_orders o
     set status = 'failed',
         failure_reason = 'add-on take-off abandoned — auto-expired by sweeper',
         done_at = now()
    from withdraw_requests wr
   where o.ref_type = 'withdraw_request' and o.ref_id = wr.id
     and o.reason = 'withdraw.topup'
     and o.status in ('pending', 'claimed')
     and coalesce(o.claimed_at, o.created_at) < now() - interval '12 hours'
     and wr.status in ('queued', 'partially_filled', 'filled')
     and coalesce(wr.amount_remaining, 0) <= 0
     and not exists (select 1 from fills f
                      where f.withdraw_id = wr.id
                        and f.status in ('locked', 'awaiting_confirmation', 'disputed'));

  -- (B) Settle fully-paid cash-outs with nothing pending (unchanged from before;
  -- the expiry above means abandoned add-ons no longer keep one out of this set).
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
