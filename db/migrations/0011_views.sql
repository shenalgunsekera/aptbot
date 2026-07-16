-- ═══════════════════════════════════════════════════════════════════════════
-- 0011 — Read models for the bot, the admin group, and the panel
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Float / net position ───────────────────────────────────────────────────
-- What the owner needs: cash held, what it backs, the net, and the live
-- invariant check. Presented the way a human thinks about it — owner_float is
-- negative when the club holds cash, so this flips the sign.
create or replace view v_float_position as
select
  a.currency,
  -coalesce(sum(a.balance) filter (where a.kind = 'owner_float'), 0)      as owner_cash_held,
  coalesce(sum(a.balance) filter (where a.kind = 'player_wallet'), 0)     as wallets_total,
  coalesce(sum(a.balance) filter (where a.kind = 'player_escrow'), 0)     as escrow_total,
  coalesce(sum(a.balance) filter (where a.kind = 'house_rake'), 0)        as house_rake,
  coalesce(sum(a.balance) filter (where a.kind = 'house_loss'), 0)        as house_loss,
  coalesce(sum(a.balance) filter (where a.kind = 'house_settlement'), 0)  as on_tables,
  coalesce(sum(a.balance) filter (where a.kind in ('player_wallet','player_escrow')), 0)
    as total_owed_to_players,
  -coalesce(sum(a.balance) filter (where a.kind = 'owner_float'), 0)
    - coalesce(sum(a.balance) filter (where a.kind in ('player_wallet','player_escrow')), 0)
    as net_position,
  -- The invariant, live. false = stop the world.
  coalesce(sum(a.balance), 0) = 0 as ledger_balances
from accounts a
group by a.currency;

comment on view v_float_position is
  'Float, net position, and the live sum-to-zero check per currency.';

-- ─── Per-platform settlement (the only chip figure that survives) ───────────
-- house_settlement is net value the union has pushed onto a platform's tables.
-- It is a TOTAL, never per player. It legitimately drifts as players win and
-- lose against each other and the house.
create or replace view v_platform_position as
select
  pf.name as platform, pf.code, a.currency,
  -a.balance as net_on_tables    -- negative balance = value out on tables
from accounts a
join platforms pf on pf.id = a.platform_id
where a.kind = 'house_settlement';

-- ─── The queue ──────────────────────────────────────────────────────────────
create or replace view v_withdraw_queue as
select
  wr.id, wr.player_id, p.display_name, p.telegram_id,
  pf.name as platform, pm.name as method_name, pm.code as method_code,
  wr.currency, wr.amount, wr.amount_remaining,
  wr.amount - wr.amount_remaining as amount_matched,
  wr.status, wr.created_at, wr.queued_at, wr.payout_handle,
  row_number() over (partition by wr.method_id, wr.currency order by wr.created_at, wr.id)
    as queue_position,
  extract(epoch from (now() - wr.created_at))::bigint as waiting_seconds
from withdraw_requests wr
join players p on p.id = wr.player_id
join platforms pf on pf.id = wr.platform_id
join payment_methods pm on pm.id = wr.method_id
where wr.status in ('queued', 'partially_filled') and wr.amount_remaining > 0;

-- ─── Transactions in full ───────────────────────────────────────────────────
-- Parties (by NAME first), amounts, ref, holds, the ledger trail, and every
-- receipt attached to the fill.
create or replace view v_fills_detail as
select
  f.id, f.seq, f.status, f.currency, f.amount, f.rake_amount, f.credit_amount,
  f.gross_to_send, f.payout_handle, f.payment_ref, f.proof_note,

  case when f.deposit_id is null then 'club_payout'
       when f.withdraw_id is null then 'club_received'
       else 'matched' end as kind,

  pm.name as method_name, pm.code as method_code, pm.reversibility, pm.settlement,

  f.deposit_id,
  dp.id as depositor_id, dp.display_name as depositor_name, dp.telegram_id as depositor_telegram_id,
  dpp.platform_uid as depositor_uid, dpf.name as deposit_platform,

  f.withdraw_id,
  wp.id as payee_id, wp.display_name as payee_name, wp.telegram_id as payee_telegram_id,

  f.lock_expires_at, f.submitted_at, f.hold_until, f.payee_confirmed_at,
  f.released_at, f.release_reason, f.released_by, ra.email as released_by_email,
  f.escalated_at, f.created_at,

  (select count(*) from disputes di where di.fill_id = f.id and di.status = 'open') > 0
    as has_open_dispute,

  coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', r.id, 'reference', r.reference, 'url', r.url,
             'player_name', r.player_name, 'at', r.created_at))
      from receipts r where r.ref_type = 'fill' and r.ref_id = f.id
  ), '[]'::jsonb) as receipts,

  coalesce((
    select jsonb_agg(jsonb_build_object(
             'tx_id', lt.id, 'kind', lt.kind, 'at', lt.created_at, 'memo', lt.memo,
             'entries', (select jsonb_agg(jsonb_build_object(
                          'account_kind', ac.kind, 'player_id', ac.player_id, 'amount', le.amount))
                          from ledger_entries le join accounts ac on ac.id = le.account_id
                         where le.tx_id = lt.id))
             order by lt.created_at)
      from ledger_transactions lt where lt.ref_type = 'fill' and lt.ref_id = f.id
  ), '[]'::jsonb) as ledger

from fills f
join payment_methods pm on pm.id = f.method_id
left join deposit_requests d  on d.id  = f.deposit_id
left join players dp on dp.id = d.player_id
left join platforms dpf on dpf.id = d.platform_id
left join player_platforms dpp on dpp.player_id = d.player_id and dpp.platform_id = d.platform_id
left join withdraw_requests w on w.id = f.withdraw_id
left join players wp on wp.id = w.player_id
left join admins ra on ra.id = f.released_by;

-- ─── Player summary for the bot ─────────────────────────────────────────────
-- What /me shows. NO available balance — that number does not exist. Only what
-- is actually in motion: money owed to them, and requests in progress.
create or replace view v_player_summary as
select
  p.id as player_id, p.telegram_id, p.display_name, p.status,
  -- What others still owe them: queued cash outs a payer hasn't settled.
  coalesce((select sum(wr.amount_remaining) from withdraw_requests wr
             where wr.player_id = p.id and wr.status in ('queued','partially_filled')), 0)
    as awaiting_payment,
  -- Paid to them, not yet confirmed/released.
  coalesce((select sum(f.amount) from fills f
             join withdraw_requests wr on wr.id = f.withdraw_id
            where wr.player_id = p.id and f.status in ('awaiting_confirmation','disputed')), 0)
    as being_confirmed
from players p;

-- ─── Admin work queue ───────────────────────────────────────────────────────
-- Everything waiting on a human, most urgent first. Names, not ids, up front.
create or replace view v_admin_inbox as
select 'dispute' as kind, di.id as ref_id, di.created_at,
       jsonb_build_object('fill_id', di.fill_id, 'reason', di.reason,
         'amount', f.amount, 'currency', f.currency, 'payment_ref', f.payment_ref) as detail,
       0 as priority
  from disputes di join fills f on f.id = di.fill_id where di.status = 'open'
union all
select 'needs_review', f.id, f.escalated_at,
       jsonb_build_object('amount', f.amount, 'currency', f.currency,
         'payment_ref', f.payment_ref, 'waiting_since', f.submitted_at,
         'club_payee', f.withdraw_id is null), 1
  from fills f where f.status = 'awaiting_confirmation' and f.escalated_at is not null
union all
select 'club_review', f.id, f.submitted_at,
       jsonb_build_object('amount', f.amount, 'currency', f.currency,
         'payment_ref', f.payment_ref), 1
  from fills f
 where f.status = 'awaiting_confirmation' and f.withdraw_id is null and f.escalated_at is null
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
