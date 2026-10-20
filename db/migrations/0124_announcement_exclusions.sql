-- ═══════════════════════════════════════════════════════════════════════════
-- 0124 — Announcement exclusions: "don't send to" players + saved lists
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Admins pick players who should NOT get an announcement — one-off, or saved as a
-- named list ("Staff", "No promos") reused across sends. The send resolves lists +
-- one-off picks into a single excluded set and SNAPSHOTS it on the announcement
-- (who was left out, and which lists by name), so history stays accurate even if a
-- list is edited later.

create table if not exists announcement_lists (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_by  uuid references admins (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists announcement_lists_name_key on announcement_lists (lower(name));

create table if not exists announcement_list_members (
  list_id    uuid not null references announcement_lists (id) on delete cascade,
  player_id  uuid not null references players (id) on delete cascade,
  added_at   timestamptz not null default now(),
  primary key (list_id, player_id)
);

alter table announcements add column if not exists excluded_players uuid[] not null default '{}';
alter table announcements add column if not exists excluded_lists   text[] not null default '{}';

-- Lists + one-off picks → one de-duplicated set of player ids.
create or replace function announcement_exclusions(p_lists uuid[], p_players uuid[])
returns uuid[]
language sql stable as $$
  select coalesce(array_agg(distinct x), '{}')
    from (
      select m.player_id as x from announcement_list_members m where m.list_id = any(coalesce(p_lists, '{}'))
      union
      select unnest(coalesce(p_players, '{}'))
    ) s
   where x is not null
$$;

-- Targeting now honours an exclusion set (default empty = unchanged behaviour).
drop function if exists announcement_targets(text, boolean, boolean);
create or replace function announcement_targets(
  p_audience text, p_on_hold boolean, p_pending boolean, p_exclude uuid[] default '{}'
)
returns table (player_id uuid, platform text)
language sql stable as $$
  with eligible as (
    select p.id, p.chat_id, p.telegram_id
      from players p
     where not coalesce(p.is_house, false)
       and (p.status = 'active'
            or (p_on_hold and p.status = 'frozen')
            or (p_pending and p.status = 'pending'))
       and p.id <> all(coalesce(p_exclude, '{}'))
  )
  select e.id, 'telegram'::text
    from eligible e
   where p_audience in ('all', 'telegram')
     and coalesce(e.chat_id, e.telegram_id) is not null
     and not exists (select 1 from discord_players dp where dp.player_id = e.id)
  union all
  select e.id, 'discord'::text
    from eligible e
    join discord_players dp on dp.player_id = e.id
   where p_audience in ('all', 'discord')
     and dp.ticket_channel_id is not null
$$;

-- announcement_create gains the exclusions (resolved + snapshotted here).
drop function if exists announcement_create(text, text, jsonb, jsonb, text, boolean, text, boolean, boolean, boolean, uuid);
create or replace function announcement_create(
  p_title text, p_body text, p_images jsonb, p_buttons jsonb, p_reel text,
  p_link_preview boolean, p_audience text, p_on_hold boolean, p_pending boolean,
  p_is_test boolean, p_admin uuid,
  p_exclude_lists uuid[] default '{}', p_exclude_players uuid[] default '{}'
) returns uuid
language plpgsql as $$
declare
  v_id uuid;
  v_images jsonb := coalesce(p_images, '[]'::jsonb);
  v_buttons jsonb := coalesce(p_buttons, '[]'::jsonb);
begin
  if jsonb_typeof(v_images) <> 'array' or jsonb_typeof(v_buttons) <> 'array' then
    raise exception 'images and buttons must be lists' using errcode = 'invalid_parameter_value';
  end if;
  if coalesce(btrim(p_body), '') = '' and coalesce(btrim(p_title), '') = '' and jsonb_array_length(v_images) = 0 then
    raise exception 'An announcement needs a message or at least one image.' using errcode = 'invalid_parameter_value';
  end if;
  if jsonb_array_length(v_images) > 10 then
    raise exception 'At most 10 images per announcement.' using errcode = 'invalid_parameter_value';
  end if;
  if jsonb_array_length(v_buttons) > 10 then
    raise exception 'At most 10 buttons per announcement.' using errcode = 'invalid_parameter_value';
  end if;
  if exists (select 1 from jsonb_array_elements_text(v_images) u where u !~ '^https://') then
    raise exception 'Every image must be an https link.' using errcode = 'invalid_parameter_value';
  end if;
  if exists (select 1 from jsonb_array_elements(v_buttons) b
              where coalesce(btrim(b->>'label'), '') = '' or coalesce(b->>'url', '') !~ '^https?://') then
    raise exception 'Every button needs a label and an http(s) link.' using errcode = 'invalid_parameter_value';
  end if;
  if p_reel is not null and btrim(p_reel) <> '' and p_reel !~ '^https?://' then
    raise exception 'The reel link must start with http(s)://' using errcode = 'invalid_parameter_value';
  end if;
  if length(coalesce(p_body, '')) > 3500 then
    raise exception 'The message is too long (max 3,500 characters).' using errcode = 'invalid_parameter_value';
  end if;

  insert into announcements (title, body, images, buttons, reel, link_preview, audience,
                             include_on_hold, include_pending, is_test, created_by,
                             excluded_players, excluded_lists)
  values (nullif(btrim(p_title), ''), coalesce(p_body, ''), v_images, v_buttons, nullif(btrim(p_reel), ''),
          coalesce(p_link_preview, true), coalesce(p_audience, 'all'),
          coalesce(p_on_hold, false), coalesce(p_pending, false), coalesce(p_is_test, false), p_admin,
          announcement_exclusions(p_exclude_lists, p_exclude_players),
          coalesce((select array_agg(l.name order by l.name) from announcement_lists l
                     where l.id = any(coalesce(p_exclude_lists, '{}'))), '{}'))
  returning id into v_id;
  return v_id;
end $$;

-- announcement_send: identical to 0123 except it passes the snapshot exclusions.
create or replace function announcement_send(p_id uuid, p_admin uuid)
returns int
language plpgsql as $$
declare
  a         announcements;
  cfg       config;
  v_payload jsonb;
  v_n       int := 0;
begin
  select * into a from announcements where id = p_id for update;
  if not found then
    raise exception 'announcement not found' using errcode = 'invalid_parameter_value';
  end if;
  if a.sent_at is not null then
    raise exception 'That announcement was already sent.' using errcode = 'invalid_parameter_value';
  end if;
  select * into cfg from config where id;

  v_payload := jsonb_build_object(
    'title', a.title, 'body', a.body, 'images', a.images, 'buttons', a.buttons,
    'reel', a.reel, 'preview', a.link_preview, 'test', a.is_test);

  if a.is_test then
    insert into notifications (audience, kind, ref_type, ref_id, payload, platform)
    select 'admins', 'announcement', 'announcement', a.id, v_payload, p
      from unnest(array['telegram', 'discord']) as p
     where (p = 'telegram' and cfg.admin_group_chat_id is not null)
        or (p = 'discord'  and cfg.discord_admin_channel_id is not null);
  else
    insert into notifications (player_id, kind, ref_type, ref_id, payload, platform)
    select t.player_id, 'announcement', 'announcement', a.id, v_payload, t.platform
      from announcement_targets(a.audience, a.include_on_hold, a.include_pending, a.excluded_players) t;
  end if;
  get diagnostics v_n = row_count;

  update announcements set recipients = v_n, sent_at = now() where id = a.id;
  perform audit(p_admin, case when a.is_test then 'announcement.test' else 'announcement.send' end,
                'announcement', a.id,
                jsonb_build_object('recipients', v_n, 'audience', a.audience, 'title', a.title,
                                   'excluded', cardinality(a.excluded_players), 'excluded_lists', a.excluded_lists));
  return v_n;
end $$;

-- Create or update a saved list (replaces its members). Audited.
create or replace function announcement_list_save(p_id uuid, p_name text, p_players uuid[], p_admin uuid)
returns uuid
language plpgsql as $$
declare v_id uuid; v_name text := btrim(coalesce(p_name, ''));
begin
  if v_name = '' then
    raise exception 'Give the list a name.' using errcode = 'invalid_parameter_value';
  end if;
  if length(v_name) > 60 then
    raise exception 'List names can be at most 60 characters.' using errcode = 'invalid_parameter_value';
  end if;
  if exists (select 1 from announcement_lists where lower(name) = lower(v_name) and id is distinct from p_id) then
    raise exception 'A list called "%" already exists.', v_name using errcode = 'invalid_parameter_value';
  end if;

  if p_id is null then
    insert into announcement_lists (name, created_by) values (v_name, p_admin) returning id into v_id;
  else
    update announcement_lists set name = v_name, updated_at = now() where id = p_id returning id into v_id;
    if v_id is null then
      raise exception 'That list no longer exists.' using errcode = 'invalid_parameter_value';
    end if;
  end if;

  delete from announcement_list_members where list_id = v_id;
  insert into announcement_list_members (list_id, player_id)
  select v_id, x from (select distinct unnest(coalesce(p_players, '{}')) x) s
   where exists (select 1 from players p where p.id = s.x);

  perform audit(p_admin, case when p_id is null then 'announcement_list.create' else 'announcement_list.update' end,
                'announcement_list', v_id,
                jsonb_build_object('name', v_name, 'members', cardinality(coalesce(p_players, '{}'))));
  return v_id;
end $$;

create or replace function announcement_list_delete(p_id uuid, p_admin uuid)
returns void
language plpgsql as $$
declare v_name text;
begin
  delete from announcement_lists where id = p_id returning name into v_name;
  if v_name is null then
    raise exception 'That list no longer exists.' using errcode = 'invalid_parameter_value';
  end if;
  perform audit(p_admin, 'announcement_list.delete', 'announcement_list', p_id, jsonb_build_object('name', v_name));
end $$;
