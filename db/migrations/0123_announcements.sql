-- ═══════════════════════════════════════════════════════════════════════════
-- 0123 — Announcements: broadcast a message to every registered player
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Players read their own ticket/chat but not announcement channels, so an
-- announcement is fanned out into the notification outbox — ONE row per player,
-- on the platform they actually use (Telegram chat or Discord ticket channel).
-- The existing drains deliver them with retries, and the drains order
-- announcements BEHIND everything else, so a big blast never delays a payment
-- message. Delivery is tracked per row (sent / failed / pending).
--
-- Images are stored here (bytea) and served from a public, cache-forever panel
-- route — no dependency on external file storage.

create table if not exists announcement_media (
  id          uuid primary key default gen_random_uuid(),
  mime        text not null check (mime in ('image/jpeg', 'image/png')),
  bytes       bytea not null,
  size_bytes  int  not null,
  created_by  uuid references admins (id),
  created_at  timestamptz not null default now()
);

create table if not exists announcements (
  id               uuid primary key default gen_random_uuid(),
  title            text,
  body             text not null default '',
  images           jsonb not null default '[]'::jsonb,   -- public image URLs, in order
  buttons          jsonb not null default '[]'::jsonb,   -- [{ "label": "...", "url": "https://..." }]
  reel             text,                                  -- Instagram reel / video link
  link_preview     boolean not null default true,
  audience         text not null default 'all' check (audience in ('all', 'telegram', 'discord')),
  include_on_hold  boolean not null default false,
  include_pending  boolean not null default false,
  is_test          boolean not null default false,       -- test = admin group/channel only
  recipients       int not null default 0,
  created_by       uuid references admins (id),
  created_at       timestamptz not null default now(),
  sent_at          timestamptz
);
create index if not exists announcements_created_idx on announcements (created_at desc);

-- Who receives a broadcast: one row per player, on THEIR platform. A player with a
-- discord_players row lives on Discord (their players.telegram_id is only a
-- placeholder — NOT NULL in the schema), so they're never sent a Telegram message;
-- everyone else gets it in their Telegram chat. House accounts never receive it,
-- banned players never do, on-hold / awaiting-approval only when opted in.
create or replace function announcement_targets(p_audience text, p_on_hold boolean, p_pending boolean)
returns table (player_id uuid, platform text)
language sql stable as $$
  with eligible as (
    select p.id, p.chat_id, p.telegram_id
      from players p
     where not coalesce(p.is_house, false)
       and (p.status = 'active'
            or (p_on_hold and p.status = 'frozen')
            or (p_pending and p.status = 'pending'))
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

-- Create a draft. Validates shape so a malformed broadcast can't be queued.
create or replace function announcement_create(
  p_title text, p_body text, p_images jsonb, p_buttons jsonb, p_reel text,
  p_link_preview boolean, p_audience text, p_on_hold boolean, p_pending boolean,
  p_is_test boolean, p_admin uuid
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
                             include_on_hold, include_pending, is_test, created_by)
  values (nullif(btrim(p_title), ''), coalesce(p_body, ''), v_images, v_buttons, nullif(btrim(p_reel), ''),
          coalesce(p_link_preview, true), coalesce(p_audience, 'all'),
          coalesce(p_on_hold, false), coalesce(p_pending, false), coalesce(p_is_test, false), p_admin)
  returning id into v_id;
  return v_id;
end $$;

-- Queue it. A test goes to the admin group (Telegram) / admin channel (Discord);
-- a real send fans out to announcement_targets. Sends exactly once.
create or replace function announcement_send(p_id uuid, p_admin uuid)
returns int
language plpgsql as $$
declare
  a        announcements;
  cfg      config;
  v_payload jsonb;
  v_n      int := 0;
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
      from announcement_targets(a.audience, a.include_on_hold, a.include_pending) t;
  end if;
  get diagnostics v_n = row_count;

  update announcements set recipients = v_n, sent_at = now() where id = a.id;
  perform audit(p_admin, case when a.is_test then 'announcement.test' else 'announcement.send' end,
                'announcement', a.id,
                jsonb_build_object('recipients', v_n, 'audience', a.audience, 'title', a.title));
  return v_n;
end $$;
