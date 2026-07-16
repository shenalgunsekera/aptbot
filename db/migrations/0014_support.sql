-- ═══════════════════════════════════════════════════════════════════════════
-- 0014 — Support relay
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Each player has their own DM with the bot — that is where /start happened and
-- where everything they do lives. When a player has a question, it should be
-- answerable IN THAT CHAT, without anyone creating a separate one.
--
-- So: a player's question is forwarded into the admin group; an admin replies to
-- it there; the bot relays that reply straight back to the player's DM. This
-- table maps the message in the group to the player, so a reply finds its way
-- home.
create table support_threads (
  id                 bigserial primary key,
  group_message_id   bigint not null,       -- the message the bot posted in the group
  player_id          uuid not null references players (id),
  player_telegram_id bigint not null,
  created_at         timestamptz not null default now()
);

create index support_threads_msg_idx on support_threads (group_message_id);
create index support_threads_player_idx on support_threads (player_id, created_at desc);
