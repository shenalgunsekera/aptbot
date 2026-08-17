-- ═══════════════════════════════════════════════════════════════════════════
-- 0069 — /setadmin on Discord (owner adds an admin by @mentioning them)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Telegram has admin_upsert (0015) keyed by telegram_id. This is the Discord
-- twin, keyed by discord_id. A slash-command mention hands us the Discord user id
-- directly (no reply-trick needed like Telegram), so the bot just passes it here.
--
-- Same rules as the Telegram version: owner-only, an email is required (it is how
-- they sign in to the panel — admins.email is NOT NULL), role must be admin/owner.
-- Idempotent across three keys: an existing admin is found by their Discord link
-- first, then by email (so a Discord account can be attached to an email-only or a
-- Telegram-only admin, unifying them), otherwise a fresh row is created.
--
-- discord_admins is strictly 1:1 (admin_id UNIQUE, discord_id UNIQUE), so we keep
-- exactly one link per admin.

create or replace function admin_upsert_discord(
  p_discord_id text,
  p_username   text,
  p_email      text,
  p_role       text,
  p_by         uuid
) returns admins
language plpgsql as $$
declare
  a      admins;
  caller admins;
begin
  select * into caller from admins where id = p_by and not disabled;
  if not found or caller.role <> 'owner' then
    raise exception 'only the owner can add admins'
      using errcode = 'insufficient_privilege';
  end if;
  if p_role not in ('admin', 'owner') then
    raise exception 'role must be admin or owner'
      using errcode = 'invalid_parameter_value';
  end if;
  if coalesce(trim(p_email), '') = '' then
    raise exception 'an email is required — it is how they sign in to the site'
      using errcode = 'invalid_parameter_value';
  end if;

  -- 1) already linked on Discord?  2) an admin with this email?  3) brand new.
  select a2.* into a from admins a2
    join discord_admins da on da.admin_id = a2.id
   where da.discord_id = p_discord_id;
  if found then
    update admins
       set email = trim(p_email),
           display_name = coalesce(nullif(trim(p_username), ''), display_name),
           role = p_role, disabled = false
     where id = a.id
    returning * into a;
  else
    select * into a from admins where lower(email) = lower(trim(p_email)) and not disabled;
    if found then
      update admins
         set display_name = coalesce(nullif(trim(p_username), ''), display_name),
             role = p_role
       where id = a.id
      returning * into a;
    else
      insert into admins (firebase_uid, email, display_name, role)
      values (null, trim(p_email), nullif(trim(p_username), ''), p_role)
      returning * into a;
    end if;
  end if;

  -- Keep the Discord link 1:1: drop any other link this admin had, then point
  -- this discord_id at them (reassigning it if it somehow belonged elsewhere).
  delete from discord_admins where admin_id = a.id and discord_id <> p_discord_id;
  insert into discord_admins (admin_id, discord_id)
  values (a.id, p_discord_id)
  on conflict (discord_id) do update set admin_id = excluded.admin_id;

  perform audit(p_by, 'admin.upsert', 'admin', a.id,
    jsonb_build_object('discord_id', p_discord_id, 'email', p_email, 'role', p_role));
  return a;
end $$;
