-- ═══════════════════════════════════════════════════════════════════════════
-- 0082 — Discarding a payment tells the depositor and clears it from pending
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Discard was a SILENT reject: the fill was cancelled and the payee re-queued,
-- but the depositor was never told and their deposit stayed in "checking your
-- payment" forever in /pending. Now a discard notifies the depositor and, when
-- nothing else on that deposit is still live, marks the deposit cancelled so it
-- leaves pending. Same for a discarded Stripe receipt (which has no deposit row
-- until credited, so it just notifies).
create or replace function fill_admin_discard(p_fill_id uuid, p_admin uuid)
returns fills
language plpgsql as $$
declare
  f   fills;
  adm admins;
  d   deposit_requests;
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

  -- Tell the depositor and clear the deposit from their pending list.
  if f.deposit_id is not null then
    select * into d from deposit_requests where id = f.deposit_id for update;
    if found then
      -- Nothing else on this deposit still processing → it's rejected outright.
      if not exists (select 1 from fills
                      where deposit_id = d.id and status in ('locked', 'awaiting_confirmation', 'released')) then
        update deposit_requests
           set status = 'cancelled', cancel_reason = 'discarded by admin', completed_at = now()
         where id = d.id and status not in ('completed', 'cancelled', 'expired');
      end if;
      perform notify_player(d.player_id, 'deposit.discarded', 'deposit', d.id,
        jsonb_build_object('amount', f.amount, 'currency', f.currency));
    end if;
  end if;

  perform audit(p_admin, 'fill.discard', 'fill', f.id, '{}'::jsonb);
  return f;
end $$;

-- Stripe discard: mark rejected AND tell the player (no deposit row exists yet).
create or replace function stripe_claim_discard(
  p_claim uuid,
  p_admin uuid
) returns stripe_claims
language plpgsql as $$
declare
  c stripe_claims;
begin
  select * into c from stripe_claims where id = p_claim for update;
  if not found then
    raise exception 'claim % not found', p_claim;
  end if;
  if c.status <> 'pending' then
    raise exception 'that Stripe payment is already %', c.status using errcode = 'invalid_parameter_value';
  end if;

  update stripe_claims set status = 'rejected' where id = c.id returning * into c;
  perform notify_player(c.player_id, 'deposit.discarded', 'stripe_claim', c.id,
    jsonb_build_object('amount', c.amount, 'currency', 'USD'));
  perform audit(p_admin, 'stripe.discard', 'stripe_claim', c.id, '{}'::jsonb);
  return c;
end $$;
