import 'server-only';
import { db } from '@union/core';

/** A player as shown in the "don't send to" picker. */
export interface PlayerBrief {
  id: string;
  name: string;
  /** "@username · ClubGG account" — how admins actually recognise people. */
  detail: string;
  platform: 'telegram' | 'discord';
  status: string;
}

export interface ExclusionList {
  id: string;
  name: string;
  members: PlayerBrief[];
}

// One projection for every place a player is listed, so search results and list
// members always look the same.
const BRIEF = (sql: ReturnType<typeof db>) => sql`
  p.id,
  coalesce(nullif(btrim(p.display_name), ''), p.telegram_username, dp.discord_username, 'Unnamed player') as name,
  case when dp.player_id is not null then 'discord' else 'telegram' end as platform,
  p.status::text as status,
  concat_ws(' · ',
    case when dp.discord_username is not null then '@' || dp.discord_username
         when p.telegram_username is not null then '@' || p.telegram_username end,
    (select string_agg(distinct coalesce(pp.platform_username, pp.platform_uid), ', ')
       from player_platforms pp
      where pp.player_id = p.id and coalesce(pp.platform_username, pp.platform_uid) is not null)
  ) as detail`;

/** Search players by display name, Telegram/Discord username, or platform account. */
export async function searchPlayerBriefs(q: string): Promise<PlayerBrief[]> {
  const term = q.trim().slice(0, 60);
  if (term.length < 2) return [];
  const sql = db();
  const esc = term.replace(/[\\%_]/g, '\\$&');
  const like = `%${esc}%`;
  const prefix = `${esc}%`;
  return sql<PlayerBrief[]>`
    select ${BRIEF(sql)}
      from players p
      left join discord_players dp on dp.player_id = p.id
     where not coalesce(p.is_house, false)
       and p.status <> 'banned'
       and (p.display_name ilike ${like}
            or p.telegram_username ilike ${like}
            or dp.discord_username ilike ${like}
            or exists (select 1 from player_platforms pp
                        where pp.player_id = p.id
                          and (pp.platform_username ilike ${like} or pp.platform_uid ilike ${like})))
     order by (p.display_name ilike ${prefix}) desc, p.display_name nulls last
     limit 20`;
}

/** Every saved exclusion list with its members, alphabetical. */
export async function loadExclusionLists(): Promise<ExclusionList[]> {
  const sql = db();
  const lists = await sql<{ id: string; name: string }[]>`
    select id, name from announcement_lists order by lower(name)`;
  if (!lists.length) return [];
  const members = await sql<(PlayerBrief & { list_id: string })[]>`
    select m.list_id, ${BRIEF(sql)}
      from announcement_list_members m
      join players p on p.id = m.player_id
      left join discord_players dp on dp.player_id = p.id
     where m.list_id = any(${sql.array(lists.map((l) => l.id))}::uuid[])
     order by name`;
  return lists.map((l) => ({
    id: l.id,
    name: l.name,
    members: members.filter((m) => m.list_id === l.id)
      .map(({ list_id: _l, ...b }) => b),
  }));
}
