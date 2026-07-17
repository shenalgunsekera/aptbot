-- ═══════════════════════════════════════════════════════════════════════════
-- 0028 — Auto-fill the Stripe amount so admins credit in one tap (no typing)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The webhook already told us the exact amount that arrived. So when the player
-- sends their receipt, we link it to the most recent unconsumed Stripe payment
-- and copy the amount onto the claim. The admin then sees "Verify & Credit $X"
-- and just taps it — no typing. (If the webhook hasn't landed yet, they can still
-- enter it manually.)

alter table stripe_claims add column if not exists payment_event_id uuid references payment_events (id);

-- Attach the newest Stripe payment that no claim has used yet, and copy its
-- amount onto the claim. Returns the amount (or null if none found).
create or replace function stripe_claim_autolink(p_claim uuid)
returns bigint
language plpgsql as $$
declare
  v_ev  uuid;
  v_amt bigint;
begin
  select e.id, e.amount into v_ev, v_amt
    from payment_events e
   where e.source = 'stripe'
     and e.created_at > now() - interval '2 hours'
     and not exists (select 1 from stripe_claims c where c.payment_event_id = e.id)
   order by e.created_at desc
   limit 1;

  if v_ev is not null then
    update stripe_claims set amount = v_amt, payment_event_id = v_ev where id = p_claim;
  end if;
  return v_amt;
end $$;

-- Credit uses the claim's stored amount when none is passed (the one-tap path).
create or replace function stripe_claim_credit(
  p_claim  uuid,
  p_admin  uuid,
  p_amount bigint default null
) returns fills
language plpgsql as $$
declare
  c  stripe_claims;
  m  payment_methods;
  d  deposit_requests;
  f  fills;
  v_amt bigint;
begin
  select * into c from stripe_claims where id = p_claim for update;
  if not found then
    raise exception 'claim % not found', p_claim;
  end if;
  if c.status <> 'pending' then
    raise exception 'that Stripe payment is already %', c.status using errcode = 'invalid_parameter_value';
  end if;

  v_amt := coalesce(p_amount, c.amount);
  if v_amt is null or v_amt <= 0 then
    raise exception 'no amount on file yet — enter the amount that was paid' using errcode = 'invalid_parameter_value';
  end if;

  select * into m from payment_methods where code = 'stripe';
  d := deposit_create(c.player_id, c.platform_id, m.id, v_amt);
  select * into f from fills where deposit_id = d.id order by seq limit 1;
  -- Unique per claim: 'stripe' as a literal ref collides on the 2nd Stripe deposit.
  perform fill_submit_proof(f.id, 'stripe:' || c.id::text, 'card via payment link', false);
  f := fill_admin_verify(f.id, p_admin, 'stripe receipt confirmed');

  update stripe_claims set status = 'credited', amount = v_amt, credited_fill = f.id where id = c.id;
  return f;
end $$;
