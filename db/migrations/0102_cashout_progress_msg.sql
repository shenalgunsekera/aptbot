-- 0102 — cash-out progress in the payee message
-- Adds total (the full cash-out) and remaining (still to be sent) to the
-- fill.settled payload, so the bots can show "$50 has been sent. $200/$250 to
-- be sent." Identical to 0076s fill_release except those two payload fields.

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
                         'urls', v_urls, 'file_ids', v_file_ids,
                         'total', w.amount,
                         'remaining', greatest(w.amount - coalesce((select sum(fx.amount) from fills fx where fx.withdraw_id = w.id and fx.status = 'released'), 0), 0)));
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
