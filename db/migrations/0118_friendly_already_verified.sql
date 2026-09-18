-- ═══════════════════════════════════════════════════════════════════════════
-- 0118 — a friendly message when a payment is already handled (not "fill <uuid>…")
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Admin verify cards are shared across the whole admin group and also actioned
-- from the panel, so a card can go stale: one admin (or the panel) verifies a
-- payment, and a moment — or an hour — later another admin taps the Verify button
-- that hadn't refreshed. fill_admin_verify then raised
--   "fill cdeb742d-…-8fb802a88dfe is released — cannot verify"
-- a raw uuid + status that looks like the bot is broken, when the payment was
-- simply already handled. (The card DOES refresh to its real state right after
-- the tap — see advanceToLoaderStep — so nothing is actually wrong.)
--
-- Same guard, human message. Only the not-awaiting_confirmation branch changes.
create or replace function fill_admin_verify(p_fill_id uuid, p_admin uuid, p_note text default null)
returns fills
language plpgsql as $$
declare
  f   fills;
  cfg config;
  adm admins;
begin
  select * into adm from admins where id = p_admin and not disabled;
  if not found then
    raise exception 'admin % not found or disabled', p_admin
      using errcode = 'insufficient_privilege';
  end if;

  select * into f from fills where id = p_fill_id for update;
  if not found then
    raise exception 'fill % not found', p_fill_id;
  end if;
  if f.status <> 'awaiting_confirmation' then
    raise exception '%',
      case f.status
        when 'released'  then 'That payment was already verified — nothing more to do here. ✅'
        when 'cancelled' then 'That payment was discarded, so it can no longer be verified.'
        when 'disputed'  then 'That payment is under dispute — resolve the dispute before verifying.'
        when 'locked'    then 'That payment has not been submitted for verification yet.'
        else 'That payment is no longer waiting to be verified.'
      end
      using errcode = 'invalid_parameter_value';
  end if;

  -- Owner sign-off threshold: above it, a plain admin may not act alone.
  select * into cfg from config where id;
  if cfg.owner_approval_threshold is not null
     and f.amount >= cfg.owner_approval_threshold
     and adm.role <> 'owner' then
    raise exception 'payments of % or more need the owner', cfg.owner_approval_threshold
      using errcode = 'insufficient_privilege';
  end if;

  perform audit(p_admin, 'fill.admin_verify', 'fill', f.id,
    jsonb_build_object('note', p_note, 'payment_ref', f.payment_ref, 'amount', f.amount,
                       'hold_overridden', f.hold_until is not null and f.hold_until > now()));

  return fill_release(
    f.id,
    case when f.withdraw_id is null then 'club_verified' else 'admin_verified' end,
    p_admin);
end $$;
