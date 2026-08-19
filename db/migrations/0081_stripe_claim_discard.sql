-- ═══════════════════════════════════════════════════════════════════════════
-- 0081 — Discard a Stripe receipt (so its admin card is Verify / Discard)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A Stripe deposit's admin card had "Credit / enter amount" and no way to reject
-- a bad receipt — unlike a Venmo/club receipt, which is a clean Verify / Discard.
-- With the amount now taken up front (stored on the claim), Verify one-taps via
-- stripe_claim_credit(c.amount); this adds the Discard side so the two are
-- symmetric. Discard just marks the claim rejected — no credit, nothing loaded,
-- exactly like fill_admin_discard for a P2P receipt.
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
  perform audit(p_admin, 'stripe.discard', 'stripe_claim', c.id, '{}'::jsonb);
  return c;
end $$;
