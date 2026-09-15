-- ═══════════════════════════════════════════════════════════════════════════
-- 0117 — safety net: auto-close a paid cash-out whose add-on was abandoned
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The recurring "cash-out paid but still shows pending" bug: an /addtowithdraw
-- take-off card the loaders never work sits pending forever and blocks the
-- (fully-paid) cash-out from settling. 0111 auto-closed these; it was reverted
-- (0112) in favour of panel Reminders + manual "Couldn't do it". Those now exist
-- and 0116 makes the manual close instant — but if nobody acts, it still lingers.
--
-- So restore the auto-close as a BACKSTOP: the sweeper expires an add-on take-off
-- that has been unworked for over 12h on a cash-out that is already fully paid
-- (nothing owed, no open fills), then settles it. Safe: an unworked take-off moved
-- no chips and posted no ledger, so failing it unwinds nothing; and if a loader
-- ever does work it after the cash-out closed, withdraw_topup_apply re-loads the
-- chips back to the player's table (0077) — nothing is lost. A recently-claimed
-- order (a loader actively on it) is protected by keying the age off claimed_at.
-- The Reminders surface it the whole 12h first, so this only catches the ignored
-- ones — visible, then self-healing.
create or replace function sweep_stuck_withdraws()
returns integer
language plpgsql as $$
declare
  w       withdraw_requests;
  v_count int := 0;
begin
  -- (A) Expire abandoned add-on take-offs on fully-paid cash-outs (>12h unworked).
  update loader_orders o
     set status = 'failed',
         failure_reason = 'add-on take-off abandoned — auto-closed after 12h so the paid cash-out could complete',
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

  -- (B) Settle every fully-paid cash-out with nothing pending (the abandoned
  -- add-ons cleared in (A) no longer hold one open).
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
