-- ═══════════════════════════════════════════════════════════════════════════
-- 0013 — A player's own payment history, with receipts
-- ═══════════════════════════════════════════════════════════════════════════
--
-- "if a person was paid in partial — 50 then 25 then 25 for a 100 cash out —
--  all the receipts should be accessible to him every time so he can track his
--  payments."
--
-- A cash out can be filled by several people, each a separate payment with its
-- own transaction reference and its own uploaded receipt. This view gives a
-- player, for each of their cash outs, every individual payment that made it up
-- and the receipt behind each — so they can always see exactly who paid what.

create or replace function player_payments(p_player_id uuid)
returns table (
  withdraw_id      uuid,
  platform         text,
  method           text,
  requested        bigint,
  total_amount     bigint,       -- what the cash out is worth (net)
  amount_paid      bigint,       -- summed across released fills
  status           withdraw_status,
  created_at       timestamptz,
  payments         jsonb         -- [{amount, ref, status, receipt_url, at}]
)
language sql stable as $$
  select
    w.id, pf.name, pm.name,
    w.requested_amount, coalesce(w.amount, 0),
    coalesce((select sum(f.amount) from fills f
               where f.withdraw_id = w.id and f.status = 'released'), 0),
    w.status, w.created_at,
    coalesce((
      select jsonb_agg(jsonb_build_object(
               'amount', f.amount,
               'ref', f.payment_ref,
               'status', f.status,
               'at', coalesce(f.released_at, f.submitted_at, f.created_at),
               'receipt', (select r.url from receipts r
                            where r.ref_type = 'fill' and r.ref_id = f.id
                            order by r.created_at limit 1),
               'receipt_ref', (select r.reference from receipts r
                                where r.ref_type = 'fill' and r.ref_id = f.id
                                order by r.created_at limit 1))
             order by f.seq)
        from fills f
       where f.withdraw_id = w.id
         and f.status in ('awaiting_confirmation', 'released', 'disputed')
    ), '[]'::jsonb)
  from withdraw_requests w
  join platforms pf on pf.id = w.platform_id
  join payment_methods pm on pm.id = w.method_id
  where w.player_id = p_player_id
  order by w.created_at desc;
$$;

-- The same for money a player ADDED — each deposit's payments + receipts, so
-- they can track those too.
create or replace function player_deposits(p_player_id uuid)
returns table (
  deposit_id   uuid,
  platform     text,
  method       text,
  amount       bigint,
  status       deposit_status,
  created_at   timestamptz,
  payments     jsonb
)
language sql stable as $$
  select
    d.id, pf.name, pm.name, d.amount, d.status, d.created_at,
    coalesce((
      select jsonb_agg(jsonb_build_object(
               'amount', f.amount, 'ref', f.payment_ref, 'status', f.status,
               'to', f.payout_handle,
               'at', coalesce(f.released_at, f.submitted_at, f.created_at),
               'receipt', (select r.url from receipts r
                            where r.ref_type = 'fill' and r.ref_id = f.id
                            order by r.created_at limit 1),
               'receipt_ref', (select r.reference from receipts r
                                where r.ref_type = 'fill' and r.ref_id = f.id
                                order by r.created_at limit 1))
             order by f.seq)
        from fills f where f.deposit_id = d.id
    ), '[]'::jsonb)
  from deposit_requests d
  join platforms pf on pf.id = d.platform_id
  join payment_methods pm on pm.id = d.method_id
  where d.player_id = p_player_id
  order by d.created_at desc;
$$;
