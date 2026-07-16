-- ═══════════════════════════════════════════════════════════════════════════
-- 0012 — Read models for the bot and the admin panel
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Player balances ────────────────────────────────────────────────────────
-- Everything /club-info needs about one player's money, in one row.
create or replace view v_player_balances as
select
  p.id as player_id,
  p.telegram_id,
  p.display_name,
  p.clubgg_id,
  p.status,
  c.currency,
  coalesce(w.balance, 0) as wallet,
  coalesce(ch.balance, 0) as chips,
  coalesce(es.balance, 0) as escrow,
  coalesce(w.balance, 0) + coalesce(ch.balance, 0) as spendable,
  -- What other people still owe this player: their queued withdrawals that
  -- depositors have not settled yet.
  coalesce((
    select sum(wr.amount_remaining) from withdraw_requests wr
     where wr.player_id = p.id and wr.currency = c.currency
       and wr.status in ('queued', 'partially_filled')
  ), 0) as awaiting_match,
  -- Money that has been paid to them but not yet confirmed/released.
  coalesce((
    select sum(f.amount) from fills f
     join withdraw_requests wr on wr.id = f.withdraw_id
     where wr.player_id = p.id and f.currency = c.currency
       and f.status in ('awaiting_confirmation', 'disputed')
  ), 0) as awaiting_confirmation
from players p
cross join (select distinct currency from payment_methods) c
left join accounts w  on w.player_id  = p.id and w.kind  = 'player_wallet' and w.currency  = c.currency
left join accounts ch on ch.player_id = p.id and ch.kind = 'player_chips'  and ch.currency = c.currency
left join accounts es on es.player_id = p.id and es.kind = 'player_escrow' and es.currency = c.currency;

-- ─── The queue ──────────────────────────────────────────────────────────────
-- The FIFO queue as an admin sees it, with each row's actual position.
create or replace view v_withdraw_queue as
select
  wr.id,
  wr.player_id,
  p.display_name,
  p.telegram_id,
  wr.method_id,
  pm.name as method_name,
  pm.code as method_code,
  wr.currency,
  wr.amount,
  wr.amount_remaining,
  wr.amount - wr.amount_remaining as amount_matched,
  wr.status,
  wr.created_at,
  wr.queued_at,
  row_number() over (
    partition by wr.method_id, wr.currency
    order by wr.created_at, wr.id
  ) as queue_position,
  extract(epoch from (now() - wr.created_at))::bigint as waiting_seconds
from withdraw_requests wr
join players p on p.id = wr.player_id
join payment_methods pm on pm.id = wr.method_id
where wr.status in ('queued', 'partially_filled')
  and wr.amount_remaining > 0;

-- ─── Transactions ───────────────────────────────────────────────────────────
-- "See every transaction in full: parties, method, amounts, payment ref, proof,
--  confirm state, holds, timestamps, linked ledger entries."
create or replace view v_fills_detail as
select
  f.id,
  f.seq,
  f.status,
  f.currency,
  f.amount,
  f.rake_amount,
  f.chips_amount,
  f.gross_to_send,
  f.payout_handle,
  f.payment_ref,
  f.proof_file_id,
  f.proof_note,

  case
    when f.deposit_id is null then 'owner_payout'
    when f.withdraw_id is null then 'owner_backstop'
    else 'matched'
  end as kind,

  pm.name as method_name,
  pm.code as method_code,
  pm.reversibility,

  -- Depositor
  f.deposit_id,
  dp.id   as depositor_id,
  dp.display_name as depositor_name,
  dp.telegram_id  as depositor_telegram_id,
  dp.clubgg_id    as depositor_clubgg_id,

  -- Withdrawer
  f.withdraw_id,
  wp.id   as withdrawer_id,
  wp.display_name as withdrawer_name,
  wp.telegram_id  as withdrawer_telegram_id,
  wp.clubgg_id    as withdrawer_clubgg_id,

  f.lock_expires_at,
  f.submitted_at,
  f.hold_until,
  f.withdrawer_confirmed_at,
  f.released_at,
  f.release_reason,
  f.released_by,
  ra.email as released_by_email,
  f.escalated_at,
  f.created_at,

  (select count(*) from disputes di where di.fill_id = f.id and di.status = 'open') > 0 as has_open_dispute,

  -- Linked ledger entries, so the panel can show the money trail inline.
  coalesce((
    select jsonb_agg(jsonb_build_object(
             'tx_id', lt.id, 'kind', lt.kind, 'at', lt.created_at,
             'memo', lt.memo,
             'entries', (
               select jsonb_agg(jsonb_build_object(
                        'account_kind', ac.kind,
                        'player_id', ac.player_id,
                        'amount', le.amount))
                 from ledger_entries le join accounts ac on ac.id = le.account_id
                where le.tx_id = lt.id)
           ) order by lt.created_at)
      from ledger_transactions lt
     where lt.ref_type = 'fill' and lt.ref_id = f.id
  ), '[]'::jsonb) as ledger

from fills f
join payment_methods pm on pm.id = f.method_id
left join deposit_requests d  on d.id  = f.deposit_id
left join players dp on dp.id = d.player_id
left join withdraw_requests w on w.id  = f.withdraw_id
left join players wp on wp.id = w.player_id
left join admins ra on ra.id = f.released_by;

-- ─── Float / net position ───────────────────────────────────────────────────
-- What the owner needs: how much cash am I holding, how much am I owed, what
-- is the union's net position.
create or replace view v_float_position as
select
  currency,
  owner_cash_held,
  player_chips_total,
  wallets_total,
  escrow_total,
  house_rake,
  house_loss,
  house_gameplay,
  -- What the union owes players, all in.
  player_chips_total + wallets_total + escrow_total as total_player_liability,
  -- The owner's net: cash held minus what that cash is backing.
  owner_cash_held - (player_chips_total + wallets_total + escrow_total) as net_position,
  ledger_balances
from reconcile_summary();

-- ─── Admin work queue ───────────────────────────────────────────────────────
-- Everything waiting on a human, in one place, most urgent first.
create or replace view v_admin_inbox as
select 'dispute' as kind, di.id as ref_id, di.created_at,
       jsonb_build_object(
         'fill_id', di.fill_id, 'reason', di.reason,
         'amount', f.amount, 'currency', f.currency,
         'payment_ref', f.payment_ref) as detail,
       0 as priority
  from disputes di join fills f on f.id = di.fill_id
 where di.status = 'open'

union all
select 'escalated_fill', f.id, f.escalated_at,
       jsonb_build_object(
         'amount', f.amount, 'currency', f.currency,
         'payment_ref', f.payment_ref,
         'waiting_since', f.submitted_at,
         'backstop', f.withdraw_id is null),
       1
  from fills f
 where f.status = 'awaiting_confirmation' and f.escalated_at is not null

union all
select 'pending_link', p.id, p.created_at,
       jsonb_build_object('telegram_id', p.telegram_id,
                          'username', p.telegram_username,
                          'clubgg_claimed', p.clubgg_id_claimed),
       2
  from players p
 where p.status = 'pending' and p.clubgg_id_claimed is not null

union all
select 'chip_order', co.id, co.created_at,
       jsonb_build_object('player_id', co.player_id, 'clubgg_id', co.clubgg_id,
                          'delta', co.delta, 'currency', co.currency,
                          'reason', co.reason, 'claimed_by', co.claimed_by),
       3
  from chip_orders co
 where co.status in ('pending', 'claimed');
