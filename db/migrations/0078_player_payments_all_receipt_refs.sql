-- ═══════════════════════════════════════════════════════════════════════════
-- 0078 — /payments lists EVERY receipt (url + reference), not just the first
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 0076 gave each payment a `receipts` array of urls so the images could show
-- both. But the TEXT breakdown still linked only the first receipt (the singular
-- `receipt` / `receipt_ref`), so a two-screenshot payment read as one in
-- /payments. Enrich `receipts` to carry each receipt's reference alongside its
-- url — [{url, ref}] — so both bots can list every receipt link. The singular
-- `receipt` / `receipt_ref` stay (first) for anything still reading them.

create or replace function player_payments(p_player_id uuid)
returns table (
  withdraw_id      uuid,
  platform         text,
  method           text,
  requested        bigint,
  total_amount     bigint,
  amount_paid      bigint,
  status           withdraw_status,
  created_at       timestamptz,
  payments         jsonb
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
                                order by r.created_at limit 1),
               'receipts', coalesce((
                              select jsonb_agg(jsonb_build_object('url', r.url, 'ref', r.reference)
                                       order by r.created_at)
                                from receipts r
                               where r.ref_type = 'fill' and r.ref_id = f.id
                                 and r.url is not null), '[]'::jsonb))
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
                                order by r.created_at limit 1),
               'receipts', coalesce((
                              select jsonb_agg(jsonb_build_object('url', r.url, 'ref', r.reference)
                                       order by r.created_at)
                                from receipts r
                               where r.ref_type = 'fill' and r.ref_id = f.id
                                 and r.url is not null), '[]'::jsonb))
             order by f.seq)
        from fills f where f.deposit_id = d.id
    ), '[]'::jsonb)
  from deposit_requests d
  join platforms pf on pf.id = d.platform_id
  join payment_methods pm on pm.id = d.method_id
  where d.player_id = p_player_id
  order by d.created_at desc;
$$;
