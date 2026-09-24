-- ═══════════════════════════════════════════════════════════════════════════
-- 0122 — drop "manual cash-out" from the escalation feed
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 0120's escalation sweep posted a "Manual cash-out" for EVERY queued club-settled
-- cash-out the moment it was created. Cash App / PayPal / crypto are all
-- club-settled, so that's routine, high-volume traffic — and it duplicated the
-- admin group, which already shows each one immediately. It also mislabeled
-- admin-added Venmo/Zelle float payouts (club_payout) as "needs an admin to pay"
-- when those are actually filled by depositors. Owner's call: remove them from the
-- escalation channel entirely.
--
-- What the escalation feed keeps: overdue loader jobs (>1 day), cash-outs stuck
-- open by an abandoned add-on, and small cash-outs (below the minimum). Only the
-- manual/club bucket is removed vs 0120.
create or replace function sweep_staff_escalations()
returns integer
language plpgsql as $$
declare
  cfg         config;
  v_platforms text[] := '{}';
  v_count     int := 0;
begin
  select * into cfg from config where id;
  if cfg.escalation_channel_chat_id is not null then v_platforms := array_append(v_platforms, 'telegram'); end if;
  if cfg.discord_escalation_channel_id is not null then v_platforms := array_append(v_platforms, 'discord'); end if;
  if array_length(v_platforms, 1) is null then
    return 0;   -- dormant: no escalation channel set anywhere
  end if;

  with items as (
    -- 1) Overdue loader jobs (unfinished > 1 day)
    select 1 as pri, 'loader_order'::text as ref_type, o.id as ref_id,
           format('⏳ *Overdue task* — %s $%s for %s%s. %s and over a day old. Handle it in the admin group.',
             case when o.delta > 0 then 'ADD' else 'TAKE OFF' end,
             to_char(abs(o.delta) / 100.0, 'FM999999990.00'),
             coalesce(o.player_name, 'player'),
             coalesce(' (' || pf.name || ')', ''),
             case when o.status = 'claimed' then 'Claimed but not finished' else 'Still unclaimed' end
           ) as txt
      from loader_orders o
      left join platforms pf on pf.id = o.platform_id
     where o.status in ('pending', 'claimed')
       and o.created_at < now() - interval '1 day'

    union all
    -- 2) Cash-outs stuck open by an abandoned add-on (fully paid, held by a topup)
    select 2, 'withdraw_request', w.id,
           format('⏳ *Cash-out stuck* — %s''s cash-out is fully paid but held open by an unworked add-on. Mark the add-on job "Couldn''t do it" to close it.',
             coalesce(pl.display_name, 'a player'))
      from withdraw_requests w
      join players pl on pl.id = w.player_id
     where w.status in ('queued', 'partially_filled', 'filled')
       and coalesce(w.amount_remaining, 0) <= 0
       and exists (select 1 from loader_orders o
                    where o.ref_type = 'withdraw_request' and o.ref_id = w.id
                      and o.reason = 'withdraw.topup' and o.status in ('pending', 'claimed'))
       and not exists (select 1 from fills f
                        where f.withdraw_id = w.id
                          and f.status in ('locked', 'awaiting_confirmation', 'disputed'))

    union all
    -- 3) Small cash-outs — remaining below the effective minimum
    select 3, 'withdraw_request', w.id,
           format('💵 *Small cash-out* — $%s to %s via %s. Below the minimum, so the queue can''t clear it — pay it from the float.',
             to_char(w.amount_remaining / 100.0, 'FM999999990.00'),
             coalesce(pl.display_name, 'a player'), coalesce(pm.name, 'a method'))
      from withdraw_requests w
      join players pl on pl.id = w.player_id
      left join payment_methods pm on pm.id = w.method_id,
           config c
     where w.status in ('queued', 'partially_filled') and w.amount_remaining > 0
       and pm.settlement = 'p2p'
       and w.amount_remaining < greatest(coalesce(w.min_override, 0), c.min_amount)
  ),
  fresh as (
    select distinct on (i.ref_type, i.ref_id) i.ref_type, i.ref_id, i.txt
      from items i
     where not exists (
       select 1 from notifications n
        where n.kind = 'escalation.item'
          and n.ref_type = i.ref_type and n.ref_id = i.ref_id
          and n.created_at > now() - interval '20 hours')
     order by i.ref_type, i.ref_id, i.pri
  ),
  ins as (
    insert into notifications (audience, kind, ref_type, ref_id, payload, platform)
    select 'admins', 'escalation.item', f.ref_type, f.ref_id,
           jsonb_build_object('text', f.txt), p
      from fresh f
      cross join unnest(v_platforms) as p
    returning 1
  )
  select count(*) into v_count from ins;
  return v_count;
end $$;

-- Clear any manual-cash-out escalation posts still sitting in the outbox so a few
-- more don't slip out after this change.
update notifications
   set status = 'skipped'
 where kind = 'escalation.item' and status = 'pending'
   and payload->>'text' like '%Manual cash-out%';
