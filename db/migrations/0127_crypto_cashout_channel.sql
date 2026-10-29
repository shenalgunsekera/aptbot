-- ═══════════════════════════════════════════════════════════════════════════
-- 0127 — a dedicated chat for CRYPTO cash-outs (per platform)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Crypto cash-outs (BTC/ETH/LTC/SOL/XRP/USDT/USDC — irreversible, club-settled)
-- are paid by staff from a wallet, often on a phone, so they get their own chat:
-- set it with /cryptochannel (Telegram group or Discord channel), exactly like
-- /paymentchannel. The "💸 Cash-out to pay … ✅ I paid it" card for a crypto
-- cash-out then lands THERE instead of the admin group; everything else is
-- unchanged. Until a chat is set, crypto cash-outs keep going to the admin group.
--
-- The card (kind withdraw.needs_payout) is created in several places, so rather
-- than touch each one, a trigger tags crypto ones as they're queued
-- (payload.crypto = true) and the delivery step routes on that tag.

alter table config add column if not exists crypto_cashout_chat_id bigint;
alter table config add column if not exists discord_crypto_cashout_channel_id text;

-- Is this cash-out paid out in crypto?
create or replace function withdraw_is_crypto(p_withdraw uuid)
returns boolean
language sql stable as $$
  select coalesce((
    select pm.reversibility = 'irreversible' and pm.settlement = 'club'
      from withdraw_requests w join payment_methods pm on pm.id = w.method_id
     where w.id = p_withdraw), false)
$$;

-- Tag crypto cash-out cards as they're queued.
create or replace function notifications_tag_crypto_cashout()
returns trigger
language plpgsql as $$
declare v_wid uuid;
begin
  if new.kind = 'withdraw.needs_payout' then
    begin
      v_wid := coalesce(nullif(new.payload->>'withdraw_id', '')::uuid,
                        case when new.ref_type = 'withdraw_request' then new.ref_id end);
    exception when others then v_wid := null;
    end;
    if v_wid is not null and withdraw_is_crypto(v_wid) then
      new.payload := coalesce(new.payload, '{}'::jsonb) || jsonb_build_object('crypto', true);
    end if;
  end if;
  return new;
end $$;

drop trigger if exists notifications_tag_crypto_cashout on notifications;
create trigger notifications_tag_crypto_cashout
  before insert on notifications
  for each row execute function notifications_tag_crypto_cashout();

-- Tag any crypto cash-out cards still waiting to be delivered.
update notifications n
   set payload = n.payload || jsonb_build_object('crypto', true)
 where n.kind = 'withdraw.needs_payout' and n.status = 'pending'
   and withdraw_is_crypto(coalesce(nullif(n.payload->>'withdraw_id', '')::uuid,
                                   case when n.ref_type = 'withdraw_request' then n.ref_id end));

-- Telegram: claim THIS chat as the crypto cash-out chat (mirrors escalation_channel_claim).
create or replace function crypto_cashout_channel_claim(p_chat_id bigint, p_telegram_id bigint)
returns boolean
language plpgsql as $$
declare adm admins;
begin
  select * into adm from admins where telegram_id = p_telegram_id and not disabled;
  if not found then return false; end if;
  update config set crypto_cashout_chat_id = p_chat_id where id;
  perform audit(adm.id, 'config.crypto_cashout_channel_set', 'config', null, jsonb_build_object('chat_id', p_chat_id));
  return true;
end $$;

-- Discord: the shared channel-setter gains 'crypto'.
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
  elsif p_which = 'crypto' then
    update config set discord_crypto_cashout_channel_id = p_channel where id;
  else
    update config set discord_admin_channel_id = p_channel where id;
  end if;
  perform audit(adm_id, 'config.discord_channel_set', 'config', null, jsonb_build_object('which', p_which, 'channel', p_channel));
  return true;
end $$;
