-- ═══════════════════════════════════════════════════════════════════════════
-- 0120 — a "staff attention" escalation channel (per platform)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A dedicated channel where overdue / small / manual work is surfaced so staff
-- get nudged without watching the panel. Set per platform with a command, exactly
-- like /paymentchannel. It's a HEADS-UP feed: plain messages (no buttons), so
-- there is nothing to keep in sync — you still action items on their real cards in
-- the admin group. Fully dormant until a channel is set (the sweep no-ops), so
-- nothing changes for anyone who doesn't opt in.
--
-- What lands here (each item at most once per ~20h → posted promptly, then
-- re-pinged about daily until it's resolved):
--   • Overdue loader jobs — pending/claimed and unfinished for over a day.
--   • Small cash-outs — remaining below the effective minimum (float-pay leftovers).
--   • Manual / club cash-outs — an admin must pay them directly.
--   • Cash-outs stuck open by an abandoned /addtowithdraw add-on.

alter table config add column if not exists escalation_channel_chat_id bigint;
alter table config add column if not exists discord_escalation_channel_id text;

-- Telegram: claim THIS chat as the escalation feed (mirrors payment_channel_claim).
create or replace function escalation_channel_claim(p_chat_id bigint, p_telegram_id bigint)
returns boolean
language plpgsql as $$
declare adm admins;
begin
  select * into adm from admins where telegram_id = p_telegram_id and not disabled;
  if not found then return false; end if;
  update config set escalation_channel_chat_id = p_chat_id where id;
  perform audit(adm.id, 'config.escalation_channel_set', 'config', null, jsonb_build_object('chat_id', p_chat_id));
  return true;
end $$;

-- Discord: extend the existing channel-setter to also handle 'escalation'.
create or replace function discord_channel_set(p_which text, p_channel text, p_discord_id text)
returns boolean
language plpgsql as $$
declare adm_id uuid;
begin
  select a.id into adm_id from admins a join discord_admins da on da.admin_id = a.id
   where da.discord_id = p_discord_id and not a.disabled;
  if adm_id is null then return false; end if;
  if p_which = 'payments' then
    update config set discord_payments_channel_id = p_channel where id;
  elsif p_which = 'escalation' then
    update config set discord_escalation_channel_id = p_channel where id;
  else
    update config set discord_admin_channel_id = p_channel where id;
  end if;
  perform audit(adm_id, 'config.discord_channel_set', 'config', null, jsonb_build_object('which', p_which, 'channel', p_channel));
  return true;
end $$;

-- ── The sweep: enqueue escalation posts for overdue/small/manual/stuck items ──
-- Runs from the cron. Each qualifying item is posted at most once per ~20h (so it
-- appears promptly and then re-pings about daily). The text is rendered here; the
-- bots just print payload.text to whichever escalation channel is configured.
create or replace function sweep_staff_escalations()
returns integer
language plpgsql as $$
declare
  cfg         config;
  v_platforms text[] := '{}';
  v_count     int := 0;
begin
  select * into cfg from config where id;
  if cfg.escalation_channel_chat_id is not null then v_platforms := array_append(v_platforms, 'telegram'); end if;
  if cfg.discord_escalation_channel_id is not null then v_platforms := array_append(v_platforms, 'discord'); end if;
  if array_length(v_platforms, 1) is null then
    return 0;   -- dormant: no escalation channel set anywhere
  end if;

  with items as (
    -- 1) Overdue loader jobs (unfinished > 1 day)
    select 1 as pri, 'loader_order'::text as ref_type, o.id as ref_id,
           format('⏳ *Overdue task* — %s $%s for %s%s. %s and over a day old. Handle it in the admin group.',
             case when o.delta > 0 then 'ADD' else 'TAKE OFF' end,
             to_char(abs(o.delta) / 100.0, 'FM999999990.00'),
             coalesce(o.player_name, 'player'),
             coalesce(' (' || pf.name || ')', ''),
             case when o.status = 'claimed' then 'Claimed but not finished' else 'Still unclaimed' end
           ) as txt
      from loader_orders o
      left join platforms pf on pf.id = o.platform_id
     where o.status in ('pending', 'claimed')
       and o.created_at < now() - interval '1 day'

    union all
    -- 2) Cash-outs stuck open by an abandoned add-on (fully paid, held by a topup)
    select 2, 'withdraw_request', w.id,
           format('⏳ *Cash-out stuck* — %s''s cash-out is fully paid but held open by an unworked add-on. Mark the add-on job "Couldn''t do it" to close it.',
             coalesce(pl.display_name, 'a player'))
      from withdraw_requests w
      join players pl on pl.id = w.player_id
     where w.status in ('queued', 'partially_filled', 'filled')
       and coalesce(w.amount_remaining, 0) <= 0
       and exists (select 1 from loader_orders o
                    where o.ref_type = 'withdraw_request' and o.ref_id = w.id
                      and o.reason = 'withdraw.topup' and o.status in ('pending', 'claimed'))
       and not exists (select 1 from fills f
                        where f.withdraw_id = w.id
                          and f.status in ('locked', 'awaiting_confirmation', 'disputed'))

    union all
    -- 3) Manual / club cash-outs — an admin must pay them
    select 3, 'withdraw_request', w.id,
           format('🏦 *Manual cash-out* — $%s to %s via %s needs an admin to pay it.',
             to_char(w.amount_remaining / 100.0, 'FM999999990.00'),
             coalesce(w.payout_handle, '—'), coalesce(pm.name, 'a method'))
      from withdraw_requests w
      left join payment_methods pm on pm.id = w.method_id
     where w.status in ('queued', 'partially_filled') and w.amount_remaining > 0
       and (pm.settlement = 'club' or coalesce((w.terms->>'club_payout')::boolean, false))

    union all
    -- 4) Small cash-outs — remaining below the effective minimum
    select 4, 'withdraw_request', w.id,
           format('💵 *Small cash-out* — $%s to %s via %s. Below the minimum, so the queue can''t clear it — pay it from the float.',
             to_char(w.amount_remaining / 100.0, 'FM999999990.00'),
             coalesce(pl.display_name, 'a player'), coalesce(pm.name, 'a method'))
      from withdraw_requests w
      join players pl on pl.id = w.player_id
      left join payment_methods pm on pm.id = w.method_id,
           config c
     where w.status in ('queued', 'partially_filled') and w.amount_remaining > 0
       and pm.settlement = 'p2p'
       and w.amount_remaining < greatest(coalesce(w.min_override, 0), c.min_amount)
  ),
  -- One row per item (a cash-out can match several buckets → keep the top priority),
  -- and only if it hasn't already been escalated in the last ~20h.
  fresh as (
    select distinct on (i.ref_type, i.ref_id) i.ref_type, i.ref_id, i.txt
      from items i
     where not exists (
       select 1 from notifications n
        where n.kind = 'escalation.item'
          and n.ref_type = i.ref_type and n.ref_id = i.ref_id
          and n.created_at > now() - interval '20 hours')
     order by i.ref_type, i.ref_id, i.pri
  ),
  ins as (
    -- audience must be 'admins' (table constraint); the escalation.item KIND is what
    -- routes it to the escalation channel in the drain, like payment.detected does.
    insert into notifications (audience, kind, ref_type, ref_id, payload, platform)
    select 'admins', 'escalation.item', f.ref_type, f.ref_id,
           jsonb_build_object('text', f.txt), p
      from fresh f
      cross join unnest(v_platforms) as p
    returning 1
  )
  select count(*) into v_count from ins;
  return v_count;
end $$;

-- Run it from the cron alongside the other sweeps.
create or replace function sweep_all()
returns table(swept_locks integer, swept_holds integer, escalated integer)
language plpgsql as $$
begin
  swept_locks := sweep_expired_locks();
  swept_holds := sweep_holds();
  escalated   := sweep_escalations();
  perform sweep_orphaned_deposits();
  perform sweep_stuck_withdraws();
  perform sweep_staff_escalations();   -- staff attention feed (no-op unless a channel is set)
  return next;
end $$;
