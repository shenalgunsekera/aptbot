-- ═══════════════════════════════════════════════════════════════════════════
-- 0093 — Per-method "Cash-out payout" mode for company-settled withdrawals
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A company-settled method's cash-out is paid by an admin. Until now the CARD
-- style was hard-coded by name: PayPal showed "they send you a money request,
-- approve it"; everything else showed "send to <handle>, then I-paid-it + upload
-- a screenshot" (the crypto style). Make it a per-method choice instead:
--
--   'request'    — the player sends a money request from the club account; an
--                  admin approves & pays it (the old PayPal flow).
--   'admin_paid' — an admin sends the money to the player's handle and uploads a
--                  screenshot as proof (the old crypto / default flow).
--
-- P2P methods don't use this: a p2p cash-out joins the matching queue and is paid
-- by a depositor, so the column is only meaningful for settlement='club' and the
-- panel only shows the dropdown there. NULL = fall back to the old name-based
-- behaviour, so nothing changes for a method until an admin sets it.
alter table payment_methods
  add column if not exists withdraw_payout_mode text
    check (withdraw_payout_mode is null or withdraw_payout_mode in ('request', 'admin_paid'));

-- Backfill to exactly today's behaviour for company-settled methods.
update payment_methods
   set withdraw_payout_mode = case when lower(name) like '%paypal%' then 'request' else 'admin_paid' end
 where settlement = 'club' and withdraw_payout_mode is null;

-- Surface the method's payout mode on the "cash-out to pay" card (0091 already
-- merges this helper into both withdraw.needs_payout payloads). Same body as 0091
-- plus join payment_methods for withdraw_payout_mode.
create or replace function withdraw_payout_extra(p_withdraw_id uuid) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'account', coalesce(
      case when pf.code = 'clubgg' then pp.platform_username else pp.platform_uid end,
      pl.display_name),
    'club', cl.name,
    'platform', pf.name,
    'payout_mode', m.withdraw_payout_mode)
    from withdraw_requests w
    join players pl on pl.id = w.player_id
    left join payment_methods m on m.id = w.method_id
    left join platforms pf on pf.id = w.platform_id
    left join player_platforms pp on pp.player_id = w.player_id and pp.platform_id = w.platform_id
    left join clubs cl on cl.id = pp.club_id
   where w.id = p_withdraw_id;
$$;
