-- ═══════════════════════════════════════════════════════════════════════════
-- 0032 — Let a player cancel their latest un-paid deposit
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A deposit auto-expires when its lock runs out, but players want a way to bail
-- out sooner. This cancels the player's most recent deposit that hasn't been
-- proven yet (still 'matching'/'awaiting_payment'): its locked slices are
-- released (p2p slices return to the queue) and the deposit is marked cancelled.
-- A deposit already in 'awaiting_confirmation' (receipt sent, under review) is
-- left alone — that's for an admin to resolve.
create or replace function deposit_cancel_latest(p_player_id uuid)
returns deposit_requests
language plpgsql as $$
declare
  d deposit_requests;
  f fills;
begin
  select * into d from deposit_requests
   where player_id = p_player_id and status in ('matching', 'awaiting_payment')
   order by created_at desc
   for update skip locked
   limit 1;
  if not found then
    return null;
  end if;

  for f in select * from fills where deposit_id = d.id and status = 'locked' loop
    perform fill_unlock(f.id, 'cancelled');
  end loop;

  update deposit_requests
     set status = 'cancelled', cancel_reason = 'cancelled by player', completed_at = now()
   where id = d.id
  returning * into d;
  return d;
end $$;
