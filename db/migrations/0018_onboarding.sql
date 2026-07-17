-- ═══════════════════════════════════════════════════════════════════════════
-- 0018 — Guided onboarding: platforms, Sportsbook account creation, preferences
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The first-run flow now collects everything a player needs before their first
-- move, in one guided sequence:
--   name → platform(s) → (Sportsbook: existing account? else create one) →
--   account IDs → preferred deposit methods (multi) → preferred cash-out method
--   + where to send it → done.
--
-- Two new ideas in the schema:
--   • A Sportsbook account the player does NOT yet have: they pick a desired
--     username + password, we stash it and PAUSE, an admin creates it for real on
--     APT Sports and taps a button, and onboarding resumes. That "needs creating"
--     state lives on player_platforms.
--   • Preferences are now plural for deposits (a player can allow several methods
--     and only those are offered later) and singular-with-a-saved-handle for
--     cash-outs (so they never re-type a wallet address).

-- ─── Sportsbook credential state on the platform link ───────────────────────
alter table player_platforms
  add column if not exists secret          text,     -- desired Sportsbook password, until created
  add column if not exists needs_creation  boolean not null default false;

-- ─── Preferences: cash-out method + a completion marker ─────────────────────
alter table player_prefs
  add column if not exists default_withdraw_method_id uuid references payment_methods (id),
  add column if not exists onboarded_at timestamptz;

-- ─── Preferred deposit methods (multi-select) ───────────────────────────────
-- Empty set = the player never narrowed it, so offer everything. A non-empty set
-- restricts what /add shows to exactly these.
create table if not exists player_method_prefs (
  player_id uuid not null references players (id) on delete cascade,
  method_id uuid not null references payment_methods (id),
  created_at timestamptz not null default now(),
  primary key (player_id, method_id)
);

-- ─── Request a Sportsbook account we must create ────────────────────────────
create or replace function sb_request_creation(
  p_player_id   uuid,
  p_platform_id uuid,
  p_username    text,
  p_secret      text
) returns player_platforms
language plpgsql as $$
declare
  pp player_platforms;
  pf platforms;
  pl players;
begin
  select * into pf from platforms where id = p_platform_id;
  if not found or not pf.enabled then
    raise exception 'that platform is not available' using errcode = 'invalid_parameter_value';
  end if;
  if coalesce(trim(p_username), '') = '' then
    raise exception 'we need a username' using errcode = 'invalid_parameter_value';
  end if;
  if length(trim(p_username)) > 10 then
    raise exception 'the username can be at most 10 characters' using errcode = 'invalid_parameter_value';
  end if;
  if length(trim(p_secret)) > 10 then
    raise exception 'the password can be at most 10 characters' using errcode = 'invalid_parameter_value';
  end if;

  select * into pl from players where id = p_player_id;

  insert into player_platforms (player_id, platform_id, platform_uid_claimed, secret, needs_creation)
  values (p_player_id, p_platform_id, trim(p_username), p_secret, true)
  on conflict (player_id, platform_id) do update
    set platform_uid_claimed = case when player_platforms.platform_uid is null
                                    then excluded.platform_uid_claimed else player_platforms.platform_uid_claimed end,
        secret               = case when player_platforms.platform_uid is null
                                    then excluded.secret else player_platforms.secret end,
        needs_creation       = case when player_platforms.platform_uid is null
                                    then true else false end
  returning * into pp;

  -- Tell the admins to make it, with everything they need + a one-tap "done".
  if pp.platform_uid is null then
    perform notify_admins('sportsbook.create', 'player', p_player_id,
      jsonb_build_object('player_id', p_player_id, 'name', pl.display_name,
                         'username', pp.platform_uid_claimed, 'password', pp.secret,
                         'platform', pf.name));
  end if;
  return pp;
end $$;

-- ─── Admin marks the Sportsbook account created ─────────────────────────────
-- Activates the link (the username IS the uid) and tells the player to continue.
create or replace function sb_mark_created(
  p_player_id   uuid,
  p_platform_id uuid,
  p_admin       uuid,
  p_uid         text default null
) returns player_platforms
language plpgsql as $$
declare
  pp player_platforms;
begin
  select * into pp from player_platforms
   where player_id = p_player_id and platform_id = p_platform_id for update;
  if not found then
    raise exception 'no Sportsbook request for this player' using errcode = 'invalid_parameter_value';
  end if;

  -- player_link does the identity + activation work; the username is the uid.
  pp := player_link(p_player_id, p_platform_id, p_admin,
                    coalesce(nullif(trim(p_uid), ''), pp.platform_uid_claimed));

  update player_platforms set needs_creation = false where id = pp.id returning * into pp;

  -- Nudge the player to finish the rest of setup.
  perform notify_player(p_player_id, 'onboarding.resume', 'player', p_player_id,
    jsonb_build_object('reason', 'sportsbook_ready'));
  return pp;
end $$;

-- ─── Preference setters ─────────────────────────────────────────────────────
create or replace function prefs_set_withdraw_method(
  p_player_id uuid,
  p_method_id uuid
) returns player_prefs
language plpgsql as $$
declare p player_prefs;
begin
  insert into player_prefs (player_id, default_withdraw_method_id)
  values (p_player_id, p_method_id)
  on conflict (player_id) do update set default_withdraw_method_id = excluded.default_withdraw_method_id
  returning * into p;
  return p;
end $$;

create or replace function prefs_set_deposit_methods(
  p_player_id  uuid,
  p_method_ids uuid[]
) returns void
language plpgsql as $$
begin
  delete from player_method_prefs where player_id = p_player_id;
  if p_method_ids is not null and array_length(p_method_ids, 1) > 0 then
    insert into player_method_prefs (player_id, method_id)
    select p_player_id, unnest(p_method_ids)
    on conflict do nothing;
  end if;
end $$;

create or replace function player_finish_onboarding(p_player_id uuid)
returns player_prefs
language plpgsql as $$
declare p player_prefs;
begin
  insert into player_prefs (player_id, onboarded_at) values (p_player_id, now())
  on conflict (player_id) do update set onboarded_at = coalesce(player_prefs.onboarded_at, now())
  returning * into p;
  return p;
end $$;
