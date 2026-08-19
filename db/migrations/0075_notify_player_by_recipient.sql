-- ═══════════════════════════════════════════════════════════════════════════
-- 0075 — Player notifications route by the RECIPIENT's platform, not the actor's
-- ═══════════════════════════════════════════════════════════════════════════
--
-- notify_player stamped the notification with app.platform — the bot that happened
-- to run the transaction. That breaks cross-platform payments: when a Telegram
-- deposit settles a DISCORD player's cash-out (or vice-versa), the settlement runs
-- in the Telegram bot, so the Discord player's "your cash-out was paid" gets
-- stamped 'telegram' → the Telegram drain can't reach them → they hear nothing.
--
-- A player lives on exactly one platform (a Discord player has a discord_players
-- link and no telegram_id; a Telegram player the reverse). So stamp by the
-- RECIPIENT: Discord if they have a discord link, else Telegram. Now every player
-- notification lands on the player's own platform regardless of who triggered it.
create or replace function notify_player(
  p_player   uuid,
  p_kind     text,
  p_ref_type text,
  p_ref_id   uuid,
  p_payload  jsonb default '{}'::jsonb
) returns bigint
language sql as $$
  insert into notifications (player_id, kind, ref_type, ref_id, payload, platform)
  values (p_player, p_kind, p_ref_type, p_ref_id, coalesce(p_payload, '{}'::jsonb),
          case when exists (select 1 from discord_players dp where dp.player_id = p_player)
               then 'discord' else 'telegram' end)
  returning id;
$$;

-- Rescue any pending player notifications that the old actor-based stamp already
-- misrouted, so a Discord player waiting on a cross-platform payout still gets it.
update notifications n
   set platform = 'discord'
 where n.status = 'pending'
   and coalesce(n.audience, '') <> 'admins'
   and n.platform = 'telegram'
   and exists (select 1 from discord_players dp where dp.player_id = n.player_id);

update notifications n
   set platform = 'telegram'
 where n.status = 'pending'
   and coalesce(n.audience, '') <> 'admins'
   and n.platform = 'discord'
   and not exists (select 1 from discord_players dp where dp.player_id = n.player_id)
   and exists (select 1 from players p where p.id = n.player_id and p.telegram_id is not null);
