-- ═══════════════════════════════════════════════════════════════════════════
-- 0083 — Never leave a deposit "in progress" once all its fills are resolved
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The old silent discard cancelled a fill but never settled its deposit, so it
-- sat in "checking your payment" forever — the player couldn't deposit again
-- ("already in progress") and couldn't cancel it (no un-paid deposit). 0082 fixed
-- the discard path itself; this is the belt-and-braces net: a sweep that settles
-- any deposit still marked in-progress whose fills have ALL resolved (none live,
-- none released). deposit_settle_if_done marks such a deposit 'expired', freeing
-- the player. Runs every cron tick from sweep_all. `for update skip locked` keeps
-- it from racing an in-flight deposit_create.
create or replace function sweep_orphaned_deposits()
returns int
language plpgsql as $$
declare
  d       deposit_requests;
  v_count int := 0;
begin
  for d in
    select * from deposit_requests dr
     where dr.status in ('awaiting_payment', 'awaiting_confirmation')
       and not exists (
         select 1 from fills f
          where f.deposit_id = dr.id
            and f.status in ('locked', 'awaiting_confirmation', 'released', 'disputed'))
       for update skip locked
  loop
    perform deposit_settle_if_done(d.id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

create or replace function sweep_all()
returns table(swept_locks integer, swept_holds integer, escalated integer)
language plpgsql as $$
begin
  swept_locks := sweep_expired_locks();
  swept_holds := sweep_holds();
  escalated   := sweep_escalations();
  perform sweep_orphaned_deposits();   -- clear deposits whose fills all resolved
  return next;
end $$;
