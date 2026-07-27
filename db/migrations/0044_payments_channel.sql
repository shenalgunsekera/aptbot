-- ═══════════════════════════════════════════════════════════════════════════
-- 0044 — A dedicated "payments received" feed, separate from the ops/admin group
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The money-in feed (detected PayPal/Cash App/etc. payments) was landing in the
-- same group as cash-out/buy-in adjustments and every other alert. Split it out:
-- a dedicated payments channel per platform, claimed by a command in that
-- channel, and payment.detected routed there. Everything else stays in admin.
--
-- Payment detections also now fan out to BOTH platforms, so the Telegram and the
-- Discord payments channels each show every payment.

alter table config add column if not exists payments_channel_chat_id  bigint;
alter table config add column if not exists discord_payments_channel_id text;

-- Telegram: claim the current chat as the payments feed (admins only, by tg id).
create or replace function payment_channel_claim(p_chat_id bigint, p_telegram_id bigint)
returns boolean language plpgsql as $$
declare adm admins;
begin
  select * into adm from admins where telegram_id = p_telegram_id and not disabled;
  if not found then return false; end if;
  update config set payments_channel_chat_id = p_chat_id where id;
  perform audit(adm.id, 'config.payments_channel_set', 'config', null, jsonb_build_object('chat_id', p_chat_id));
  return true;
end $$;

-- Discord: set the admin or payments channel (admins only, by discord id).
create or replace function discord_channel_set(p_which text, p_channel text, p_discord_id text)
returns boolean language plpgsql as $$
declare adm_id uuid;
begin
  select a.id into adm_id from admins a join discord_admins da on da.admin_id = a.id
   where da.discord_id = p_discord_id and not a.disabled;
  if adm_id is null then return false; end if;
  if p_which = 'payments' then
    update config set discord_payments_channel_id = p_channel where id;
  else
    update config set discord_admin_channel_id = p_channel where id;
  end if;
  perform audit(adm_id, 'config.discord_channel_set', 'config', null, jsonb_build_object('which', p_which, 'channel', p_channel));
  return true;
end $$;

-- notify_admins now fans the payments feed out to BOTH platforms, so each
-- platform's payments channel shows every detected payment. All other admin
-- notifications stay Telegram-default (Discord makes its own via discord_*).
create or replace function notify_admins(
  p_kind     text,
  p_ref_type text,
  p_ref_id   uuid,
  p_payload  jsonb default '{}'::jsonb
) returns bigint
language plpgsql as $$
declare v_id bigint;
begin
  insert into notifications (audience, kind, ref_type, ref_id, payload, platform)
  values ('admins', p_kind, p_ref_type, p_ref_id, coalesce(p_payload, '{}'::jsonb), 'telegram')
  returning id into v_id;

  if p_kind = 'payment.detected' then
    insert into notifications (audience, kind, ref_type, ref_id, payload, platform)
    values ('admins', p_kind, p_ref_type, p_ref_id, coalesce(p_payload, '{}'::jsonb), 'discord');
  end if;
  return v_id;
end $$;
