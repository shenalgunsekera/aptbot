-- ═══════════════════════════════════════════════════════════════════════════
-- 0104 — Stripe autolink must MATCH THE AMOUNT, never just recency
-- ═══════════════════════════════════════════════════════════════════════════
-- stripe_claim_autolink (0028) linked a claim to the most recent unclaimed Stripe
-- event within 2 hours — by recency ALONE, no player and no amount check. So a
-- $40 Cash App deposit could be linked to a stray $100 Stripe event that happened
-- to be the latest, and (with the Discord bot's coalesce reversed) credited as
-- $100. A player paid $40 and got $100.
--
-- Fix: only ever link a Stripe event whose amount EQUALS what the player entered
-- in the bot. Given no expected amount, link nothing and leave the in-bot amount
-- authoritative. The amount the player typed is a validated figure; a fuzzy
-- recency match must never override it.
--
-- Callers pass the in-bot amount: stripe_claim_autolink(claim, expected). The old
-- one-arg overload is dropped so a bare call resolves to this (with default null).

drop function if exists stripe_claim_autolink(uuid);

create or replace function stripe_claim_autolink(p_claim uuid, p_expected bigint default null)
returns bigint
language plpgsql as $$
declare
  v_ev  uuid;
  v_amt bigint;
begin
  if p_expected is null then
    return null;  -- nothing to match against → never guess
  end if;

  select e.id, e.amount into v_ev, v_amt
    from payment_events e
   where e.source = 'stripe'
     and e.created_at > now() - interval '2 hours'
     and e.amount = p_expected
     and not exists (select 1 from stripe_claims c where c.payment_event_id = e.id)
   order by e.created_at desc
   limit 1;

  if v_ev is not null then
    update stripe_claims set amount = v_amt, payment_event_id = v_ev where id = p_claim;
  end if;
  return v_amt;
end $$;
