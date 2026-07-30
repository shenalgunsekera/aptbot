-- ═══════════════════════════════════════════════════════════════════════════
-- 0049 — Discard a payment-to-verify (silent reject, no credit)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The admin side of the "Payment to verify" card: if the payment didn't land,
-- discard it. Nothing is credited to the depositor and no one is messaged — the
-- fill is cancelled and, for a p2p fill, its slice goes back to the withdrawal
-- so the payee gets matched to someone else.
create or replace function fill_admin_discard(p_fill_id uuid, p_admin uuid)
returns fills
language plpgsql as $$
declare
  f   fills;
  adm admins;
begin
  select * into adm from admins where id = p_admin and not disabled;
  if not found then
    raise exception 'admin % not found or disabled', p_admin using errcode = 'insufficient_privilege';
  end if;

  select * into f from fills where id = p_fill_id for update;
  if not found then
    raise exception 'fill % not found', p_fill_id;
  end if;
  if f.status not in ('awaiting_confirmation', 'locked') then
    raise exception 'fill % is % — nothing to discard', f.id, f.status using errcode = 'invalid_parameter_value';
  end if;

  -- Give the payee's slice back to the queue (club-payee fills hold no slice).
  if f.withdraw_id is not null then
    perform withdraw_return_slice(f.withdraw_id, f.amount, 'discarded by admin');
  end if;

  update fills set status = 'cancelled' where id = f.id returning * into f;
  perform audit(p_admin, 'fill.discard', 'fill', f.id, '{}'::jsonb);
  return f;
end $$;
