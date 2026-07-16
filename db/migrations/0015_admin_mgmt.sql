-- ═══════════════════════════════════════════════════════════════════════════
-- 0015 — Admins by Telegram + email, self-service; approve buttons
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Two things this enables:
--
-- 1. /setadmin @user email — the owner adds an admin by tagging them in the
--    group and giving an email. The person can act in the group immediately
--    (matched by telegram id) AND, when they Google-log-in to the site with
--    that email, their Firebase account binds to the row automatically. No more
--    hand-creating admin records.
--
-- 2. Approve-from-Telegram — the player-claim notification carries the id the
--    approve BUTTON needs, so an admin taps ✅ in the group instead of opening
--    the panel.

-- An admin can now exist BEFORE their first Google login: email is set, but the
-- Firebase uid is filled in later when they actually sign in. So the uid must be
-- nullable (it is still unique when present — Postgres treats NULLs as distinct).
alter table admins alter column firebase_uid drop not null;

-- Email is the login claim key: at most one active admin per email.
create unique index if not exists admins_email_uniq
  on admins (lower(email)) where not disabled;

-- ─── Add / update an admin ──────────────────────────────────────────────────
-- Owner-only. Idempotent across three keys: an existing row is found by telegram
-- id first, then by email (so you can attach a Telegram to an email-only admin,
-- or vice versa), otherwise a new row is created with no Firebase uid yet.
create or replace function admin_upsert(
  p_telegram_id bigint,
  p_username    text,
  p_email       text,
  p_role        text,
  p_by          uuid
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

  select * into a from admins where telegram_id = p_telegram_id;
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
         set telegram_id = p_telegram_id,
             display_name = coalesce(nullif(trim(p_username), ''), display_name),
             role = p_role
       where id = a.id
      returning * into a;
    else
      insert into admins (firebase_uid, email, display_name, telegram_id, role)
      values (null, trim(p_email), nullif(trim(p_username), ''), p_telegram_id, p_role)
      returning * into a;
    end if;
  end if;

  perform audit(p_by, 'admin.upsert', 'admin', a.id,
    jsonb_build_object('telegram_id', p_telegram_id, 'email', p_email, 'role', p_role));
  return a;
end $$;

-- ─── Bind a Firebase uid to an email-only admin on first login ──────────────
-- Called by the panel's sign-in route. If an admin row has this email but no
-- Firebase uid yet, claim it. Returns the admin row (or null if not an admin).
create or replace function admin_bind_firebase(
  p_firebase_uid text,
  p_email        text
) returns admins
language plpgsql as $$
declare
  a admins;
begin
  -- Already bound?
  select * into a from admins where firebase_uid = p_firebase_uid and not disabled;
  if found then return a; end if;

  -- An email-only row waiting to be claimed?
  select * into a from admins
   where lower(email) = lower(trim(p_email)) and firebase_uid is null and not disabled
   for update;
  if found then
    update admins set firebase_uid = p_firebase_uid where id = a.id returning * into a;
    perform audit(a.id, 'admin.firebase_bound', 'admin', a.id,
                  jsonb_build_object('email', p_email));
    return a;
  end if;

  return null;
end $$;

-- ─── Player claim carries the id the approve button needs ───────────────────
-- Replaces the 0010 version: same behaviour, but the notification now includes
-- the player_platforms row id so an admin can approve straight from Telegram.
create or replace function player_claim_platform(
  p_player_id   uuid,
  p_platform_id uuid,
  p_uid         text
) returns player_platforms
language plpgsql as $$
declare
  pp player_platforms;
  pf platforms;
begin
  select * into pf from platforms where id = p_platform_id;
  if not found or not pf.enabled then
    raise exception 'that platform is not available'
      using errcode = 'invalid_parameter_value';
  end if;
  if coalesce(trim(p_uid), '') = '' then
    raise exception 'we need your % ID', pf.name
      using errcode = 'invalid_parameter_value';
  end if;

  insert into player_platforms (player_id, platform_id, platform_uid_claimed)
  values (p_player_id, p_platform_id, trim(p_uid))
  on conflict (player_id, platform_id) do update
    set platform_uid_claimed = case
          when player_platforms.platform_uid is null then excluded.platform_uid_claimed
          else player_platforms.platform_uid_claimed end
  returning * into pp;

  if pp.platform_uid is null then
    perform notify_admins('player.claim', 'player_platform', pp.id,
      jsonb_build_object('pp_id', pp.id, 'player_id', p_player_id,
                         'platform_id', p_platform_id, 'platform', pf.name,
                         'uid_claimed', pp.platform_uid_claimed,
                         'name', (select display_name from players where id = p_player_id)));
  end if;
  return pp;
end $$;

-- ─── Approve a claim by its player_platform id (for the Telegram button) ────
create or replace function player_link_pp(
  p_pp_id uuid,
  p_admin uuid
) returns player_platforms
language plpgsql as $$
declare
  pp player_platforms;
begin
  select * into pp from player_platforms where id = p_pp_id;
  if not found then
    raise exception 'that request no longer exists';
  end if;
  return player_link(pp.player_id, pp.platform_id, p_admin, null, null);
end $$;
