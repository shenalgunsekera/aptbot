-- ═══════════════════════════════════════════════════════════════════════════
-- 0019 — Receipts instead of reference IDs; admins are the only confirmers
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Two product changes land together because they touch the same lifecycle:
--
--   • No more typing a transaction/reference id. The proof of a payment is now
--     the receipt IMAGE (up to two per payment). So payment_ref becomes optional
--     and a fill may reach 'awaiting_confirmation' on a receipt alone.
--
--   • Players no longer confirm P2P payments. ONE admin reviewing the receipt and
--     tapping Verify is what releases the money — for every method, P2P or club.
--     So submitting proof no longer pings the payee; it alerts the admins.

-- Evidence can now be a receipt (submitted_at) without a reference id.
alter table fills drop constraint if exists fills_confirmation_needs_evidence;
alter table fills add constraint fills_confirmation_needs_evidence
  check (status <> 'awaiting_confirmation' or submitted_at is not null);

-- ─── Submit proof (ref optional, admin-reviewed) ────────────────────────────
-- p_notify defaults true so any non-bot caller still alerts an admin. The bot
-- passes false because it sends its own richer receipt card (image + Verify) the
-- instant the receipt uploads — see sendReceiptToReviewer — and one alert per
-- payment is enough.
create or replace function fill_submit_proof(
  p_fill_id     uuid,
  p_payment_ref text default null,
  p_note        text default null,
  p_notify      boolean default true
) returns fills
language plpgsql as $$
declare
  f      fills;
  d      deposit_requests;
  m      payment_methods;
  v_open int;
begin
  select * into f from fills where id = p_fill_id for update;
  if not found then
    raise exception 'fill % not found', p_fill_id;
  end if;

  -- Idempotent: a second receipt on an already-submitted fill just attaches
  -- (the caller adds the receipt row); nothing to transition here.
  if f.status = 'awaiting_confirmation' then
    return f;
  end if;
  if f.status <> 'locked' then
    if f.status = 'expired' then
      raise exception
        'that ran out of time and went back in the queue — please start a new add before sending anything'
        using errcode = 'invalid_parameter_value';
    end if;
    raise exception 'fill % is % — proof only applies to a locked slice', f.id, f.status
      using errcode = 'invalid_parameter_value';
  end if;

  select * into d from deposit_requests where id = f.deposit_id for update;
  select * into m from payment_methods where id = f.method_id;

  update fills
     set status       = 'awaiting_confirmation',
         payment_ref  = nullif(trim(coalesce(p_payment_ref, '')), ''),
         proof_note   = p_note,
         submitted_at = now(),
         hold_until   = hold_deadline(f.method_id)
   where id = f.id
  returning * into f;

  -- Move the parent deposit on only once every slice has evidence against it.
  select count(*) into v_open from fills where deposit_id = d.id and status = 'locked';
  if v_open = 0 then
    update deposit_requests set status = 'awaiting_confirmation' where id = d.id;
  end if;

  -- Admins are the only confirmers now — no payee ping. The bot sends the rich
  -- receipt card itself; other callers get this plain backstop alert.
  if p_notify then
    perform notify_admins('fill.needs_review', 'fill', f.id,
      jsonb_build_object('amount', f.amount, 'currency', f.currency,
                         'payment_ref', f.payment_ref, 'method', m.name,
                         'club_payee', f.withdraw_id is null));
  end if;
  return f;
end $$;
