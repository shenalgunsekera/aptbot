-- ═══════════════════════════════════════════════════════════════════════════
-- 0045 — Hard-delete a player and everything tied to them
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Removes the player and ALL their records: deposits, withdrawals, the fills on
-- them, ledger transactions touching their accounts, receipts, disputes, stripe
-- claims, loader orders, support threads, notifications, prefs, handles, club/
-- platform links, and both platform identities (Telegram + Discord).
--
-- This is a P2P ledger, so a fill/transaction can be SHARED with a counterparty.
-- Deleting the player removes those shared rows too — intended for test or
-- mistaken accounts, not for unwinding a real player mid-activity. Irreversible;
-- run inside one transaction so a missed dependency rolls the whole thing back.
create or replace function player_delete(p_player uuid, p_admin uuid default null)
returns void language plpgsql as $$
declare
  v_deposits  uuid[];
  v_withdraws uuid[];
  v_fills     uuid[];
  v_accounts  uuid[];
  v_txns      uuid[];
  v_tg        bigint;
begin
  if not exists (select 1 from players where id = p_player) then
    raise exception 'player % not found', p_player using errcode = 'no_data_found';
  end if;

  -- The ledger and receipts are append-only (a user trigger blocks DELETE). This
  -- is a deliberate hard-delete, so suspend those USER triggers (FK enforcement is
  -- a system trigger and stays on). On rollback the ALTERs are undone with it.
  alter table receipts             disable trigger user;
  alter table ledger_entries       disable trigger user;
  alter table ledger_transactions  disable trigger user;

  select telegram_id into v_tg from players where id = p_player;

  select coalesce(array_agg(id), '{}') into v_deposits  from deposit_requests  where player_id = p_player;
  select coalesce(array_agg(id), '{}') into v_withdraws from withdraw_requests where player_id = p_player;
  select coalesce(array_agg(id), '{}') into v_fills from fills
    where deposit_id = any(v_deposits) or withdraw_id = any(v_withdraws);
  select coalesce(array_agg(id), '{}') into v_accounts from accounts where player_id = p_player;
  select coalesce(array_agg(distinct tx_id), '{}') into v_txns from ledger_entries where account_id = any(v_accounts);

  -- Keep global payment detections; just drop their link to a fill we're deleting.
  update payment_events set matched_fill_id = null where matched_fill_id = any(v_fills);

  delete from stripe_claims where player_id = p_player or credited_fill = any(v_fills);
  delete from disputes      where opened_by_player = p_player or fill_id = any(v_fills);
  delete from receipts      where player_id = p_player or uploaded_by_player = p_player
                                or (ref_type = 'fill' and ref_id = any(v_fills));

  -- Whole ledger transactions that touch this player's accounts.
  delete from ledger_entries      where tx_id = any(v_txns);
  delete from ledger_transactions where id    = any(v_txns);
  delete from accounts            where player_id = p_player;

  delete from fills             where id = any(v_fills);
  delete from deposit_requests  where player_id = p_player;
  delete from withdraw_requests where player_id = p_player;   -- references loader_orders; must go first
  delete from loader_orders     where player_id = p_player;

  delete from support_threads     where player_id = p_player;
  delete from notifications       where player_id = p_player;
  delete from payout_handles      where player_id = p_player;
  delete from player_platforms    where player_id = p_player;
  delete from player_prefs        where player_id = p_player;
  delete from player_method_prefs where player_id = p_player;
  delete from player_clubs        where player_id = p_player;
  delete from discord_players     where player_id = p_player;
  if v_tg is not null then delete from bot_sessions where key = v_tg::text; end if;

  perform audit(p_admin, 'player.delete', 'player', p_player,
                jsonb_build_object('fills', coalesce(array_length(v_fills,1),0),
                                   'deposits', coalesce(array_length(v_deposits,1),0),
                                   'withdraws', coalesce(array_length(v_withdraws,1),0)));
  delete from players where id = p_player;

  alter table receipts             enable trigger user;
  alter table ledger_entries       enable trigger user;
  alter table ledger_transactions  enable trigger user;
end $$;
