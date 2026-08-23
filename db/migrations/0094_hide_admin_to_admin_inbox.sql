-- ═══════════════════════════════════════════════════════════════════════════
-- 0094 — Keep admin↔admin test transactions out of the overview inbox
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Admins test the system with each other (an admin deposits, another admin's
-- cash-out matches it). Those fills clutter the "Waiting on a person" list on the
-- overview. Hide them there — nothing is deleted, the fills and their history stay
-- exactly as they are; only the overview inbox skips a fill whose BOTH sides are
-- admin-owned player accounts.
--
-- A player is "an admin" if their telegram_id is an admin's, or their linked
-- Discord account is a discord_admin. Only v_admin_inbox reads this (the overview),
-- so redefining it is self-contained.

create or replace function is_admin_player(p_player uuid) returns boolean
language sql stable as $$
  select exists (
    select 1 from players p
     where p.id = p_player and p.telegram_id is not null
       and p.telegram_id in (select telegram_id from admins where telegram_id is not null))
      or exists (
    select 1 from discord_players dp
      join discord_admins da on da.discord_id = dp.discord_id
     where dp.player_id = p_player);
$$;

-- A fill is admin↔admin when BOTH its depositor and its payee are admin accounts
-- (a real player↔club fill has no payee player, so it is never admin↔admin).
create or replace function fill_is_admin_to_admin(p_fill uuid) returns boolean
language sql stable as $$
  select w.id is not null
     and is_admin_player(d.player_id)
     and is_admin_player(w.player_id)
    from fills f
    left join deposit_requests d on d.id = f.deposit_id
    left join withdraw_requests w on w.id = f.withdraw_id
   where f.id = p_fill;
$$;

create or replace view v_admin_inbox as
select 'dispute' as kind, di.id as ref_id, di.created_at,
       jsonb_build_object('fill_id', di.fill_id, 'reason', di.reason,
         'amount', f.amount, 'currency', f.currency, 'payment_ref', f.payment_ref) as detail,
       0 as priority
  from disputes di join fills f on f.id = di.fill_id
 where di.status = 'open' and not fill_is_admin_to_admin(f.id)
union all
select 'needs_review', f.id, f.escalated_at,
       jsonb_build_object('amount', f.amount, 'currency', f.currency,
         'payment_ref', f.payment_ref, 'waiting_since', f.submitted_at,
         'club_payee', f.withdraw_id is null), 1
  from fills f
 where f.status = 'awaiting_confirmation' and f.escalated_at is not null
   and not fill_is_admin_to_admin(f.id)
union all
select 'club_review', f.id, f.submitted_at,
       jsonb_build_object('amount', f.amount, 'currency', f.currency,
         'payment_ref', f.payment_ref), 1
  from fills f
 where f.status = 'awaiting_confirmation' and f.withdraw_id is null and f.escalated_at is null
   and not fill_is_admin_to_admin(f.id)
union all
select 'pending_link', p.id, p.created_at,
       jsonb_build_object('name', p.display_name, 'telegram_id', p.telegram_id,
         'claims', (select jsonb_agg(jsonb_build_object('platform', pf.name, 'uid', pp.platform_uid_claimed))
                     from player_platforms pp join platforms pf on pf.id = pp.platform_id
                    where pp.player_id = p.id and pp.platform_uid is null and pp.platform_uid_claimed is not null)), 2
  from players p
 where p.status = 'pending'
   and exists (select 1 from player_platforms pp
                where pp.player_id = p.id and pp.platform_uid is null
                  and pp.platform_uid_claimed is not null)
union all
select 'needs_club', p.id, pp.linked_at,
       jsonb_build_object('name', p.display_name, 'platform', pf.name, 'uid', pp.platform_uid), 2
  from player_platforms pp
  join players p on p.id = pp.player_id
  join platforms pf on pf.id = pp.platform_id
 where p.status = 'active' and pp.platform_uid is not null and pp.club_id is null
union all
select 'loader_work', lo.id, lo.created_at,
       jsonb_build_object('name', lo.player_name, 'platform_uid', lo.platform_uid,
         'delta', lo.delta, 'currency', lo.currency, 'reason', lo.reason,
         'claimed_by', lo.claimed_by), 3
  from loader_orders lo where lo.status in ('pending', 'claimed');
