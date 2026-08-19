-- ═══════════════════════════════════════════════════════════════════════════
-- 0076 — Two-screenshot receipts flow end to end
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A player can send up to TWO screenshots for one payment (both in a single
-- album/message). Those images must flow everywhere the one image did:
--   • the admin verify card (already an album — no change needed there),
--   • the RECIPIENT of a P2P payout (new: fill.settled now carries the images),
--   • the player's own /payments history (new: all receipts, not just the first).
--
-- Three changes here:
--   1. fills.receipts_sent_at — an atomic claim so the admin card is sent EXACTLY
--      once even when the two album frames arrive as two concurrent bot updates.
--   2. fill_release — the payee's "that part of your cash-out is done" now carries
--      the receipt image(s) the payer uploaded, so a Venmo/Zelle payee sees the
--      proof of the payment they received (P2P only — a club/crypto deposit has no
--      withdraw_id and so never reaches this branch).
--   3. player_payments / player_deposits — each payment now returns a `receipts`
--      array (every screenshot), keeping the singular `receipt` for back-compat.

-- 1) Atomic finalize claim. Nullable, defaults null; existing fills are untouched.
alter table fills add column if not exists receipts_sent_at timestamptz;

-- 2) Carry receipts to the P2P recipient on settlement. Same body as 0008; only
--    the fill.settled payload changes (adds urls + telegram file_ids).
create or replace function fill_release(
  p_fill_id uuid,
  p_reason  text,
  p_admin   uuid default null
) returns fills
language plpgsql as $$
declare
  f fills;
  d deposit_requests;
  w withdraw_requests;
  v_entries   jsonb;
  v_urls      jsonb;
  v_file_ids  jsonb;
begin
  select * into f from fills where id = p_fill_id for update;
  if not found then
    raise exception 'fill % not found', p_fill_id;
  end if;
  if f.status <> 'awaiting_confirmation' then
    raise exception 'fill % is % — only a fill awaiting confirmation can be released', f.id, f.status
      using errcode = 'invalid_parameter_value';
  end if;

  -- Belt and braces: a disputed fill must never release. The status check above
  -- already covers it (dispute_open flips status), but this is the single most
  -- expensive mistake in the system, so it gets a second lock.
  if exists (select 1 from disputes where fill_id = f.id and status = 'open') then
    raise exception 'fill % has an open dispute and is frozen', f.id
      using errcode = 'invalid_parameter_value';
  end if;

  select * into d from deposit_requests where id = f.deposit_id for update;

  if f.withdraw_id is null then
    v_entries := jsonb_build_array(
      jsonb_build_object('account_id',
        account_of('owner_float', null, null, f.currency), 'amount', -f.amount),
      jsonb_build_object('account_id',
        account_of('house_settlement', null, d.platform_id, f.currency), 'amount', f.credit_amount),
      jsonb_build_object('account_id',
        account_of('house_rake', null, null, f.currency), 'amount', f.rake_amount)
    );
  else
    select * into w from withdraw_requests where id = f.withdraw_id for update;
    v_entries := jsonb_build_array(
      jsonb_build_object('account_id',
        account_of('player_escrow', w.player_id, w.platform_id, f.currency), 'amount', -f.amount),
      jsonb_build_object('account_id',
        account_of('house_settlement', null, d.platform_id, f.currency), 'amount', f.credit_amount),
      jsonb_build_object('account_id',
        account_of('house_rake', null, null, f.currency), 'amount', f.rake_amount)
    );
  end if;

  perform ledger_post(
    'fill.release', 'fill', f.id, p_admin,
    format('release %s as %s credit (fee %s, via %s)',
           f.amount, f.credit_amount, f.rake_amount, p_reason),
    v_entries);

  update fills
     set status = 'released', released_at = now(),
         released_by = p_admin, release_reason = p_reason
   where id = f.id
  returning * into f;

  -- The promise to actually put it on their account. The ledger already says we
  -- owe it; this is the delivery.
  perform loader_order_create(
    d.player_id, d.platform_id, f.credit_amount, f.currency,
    'fill.release', 'fill', f.id);

  perform notify_player(d.player_id, 'fill.released', 'fill', f.id,
    jsonb_build_object('credit', f.credit_amount, 'currency', f.currency));
  if f.withdraw_id is not null then
    -- Gather the payer's receipt image(s) so the payee sees the proof they were
    -- paid. Prefer public urls (render on either platform); include telegram
    -- file_ids too (instant re-send when the payee is on Telegram). A payee on
    -- Discord can only use the url; a "telegram:" placeholder url is excluded.
    select coalesce(jsonb_agg(r.url order by r.created_at)
                      filter (where r.url is not null and r.url not like 'telegram:%'), '[]'::jsonb),
           coalesce(jsonb_agg(r.telegram_file_id order by r.created_at)
                      filter (where r.telegram_file_id is not null), '[]'::jsonb)
      into v_urls, v_file_ids
      from receipts r
     where r.ref_type = 'fill' and r.ref_id = f.id;
    perform notify_player(w.player_id, 'fill.settled', 'fill', f.id,
      jsonb_build_object('amount', f.amount, 'currency', f.currency,
                         'urls', v_urls, 'file_ids', v_file_ids));
  end if;

  perform audit(p_admin, 'fill.release', 'fill', f.id,
    jsonb_build_object('reason', p_reason, 'amount', f.amount,
                       'credit', f.credit_amount, 'rake', f.rake_amount,
                       'payment_ref', f.payment_ref, 'club_payee', f.withdraw_id is null));

  perform deposit_settle_if_done(d.id);
  if f.withdraw_id is not null then
    perform withdraw_settle_if_done(f.withdraw_id);
  end if;

  return f;
end $$;

-- 3) Every screenshot in the player's own history, not just the first. Adds a
--    `receipts` array to each payment object; `receipt`/`receipt_ref` stay for
--    back-compat with anything still reading the singular field.
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
               'receipts', coalesce((select jsonb_agg(r.url order by r.created_at)
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
               'receipts', coalesce((select jsonb_agg(r.url order by r.created_at)
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
