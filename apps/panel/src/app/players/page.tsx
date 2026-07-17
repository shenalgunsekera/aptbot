import { db } from '@union/core';
import { Shell } from '../../components/shell';
import { getSession } from '../../lib/auth';
import { Ago } from '../../components/ui';
import { ConfirmAction, PlayerActions, SportsbookCreateAction } from './actions';

export const dynamic = 'force-dynamic';

export default async function PlayersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const sql = db();
  const session = await getSession();

  const platforms = await sql<{ id: string; name: string }[]>`
    select id, name from platforms where enabled order by sort_order`;

  // Pending: claimed a platform account, not yet approved.
  const pending = await sql<any[]>`
    select p.id, p.display_name, p.telegram_id, p.telegram_username, p.created_at,
           pp.platform_id, pp.platform_uid_claimed, pp.needs_creation, pp.secret, pf.name as platform_name
      from players p
      join player_platforms pp on pp.player_id = p.id
      join platforms pf on pf.id = pp.platform_id
     where pp.platform_uid is null and pp.platform_uid_claimed is not null
     order by p.created_at`;

  const search = q
    ? sql`and (p.display_name ilike ${'%' + q + '%'} or p.telegram_username ilike ${'%' + q + '%'}
            or exists (select 1 from player_platforms x where x.player_id = p.id and x.platform_uid ilike ${'%' + q + '%'}))`
    : sql``;

  const players = await sql<any[]>`
    select p.id, p.display_name, p.telegram_id, p.telegram_username, p.status,
           jsonb_array_length(p.risk_flags) as flag_count,
           coalesce((select jsonb_agg(jsonb_build_object('platform', pf.name, 'uid', pp.platform_uid, 'has_club', pp.club_id is not null))
                       from player_platforms pp join platforms pf on pf.id = pp.platform_id
                      where pp.player_id = p.id and pp.platform_uid is not null), '[]') as accounts
      from players p
     where p.status <> 'pending' ${search}
     order by p.created_at desc limit 100`;

  const currency = 'USD';

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>Players</h1>
          <p className="sub">Approve new accounts, review flags, put people on hold.</p>
        </div>
        <form className="btn-row">
          <input name="q" defaultValue={q ?? ''} placeholder="Search name or ID…" style={{ width: 200 }} />
          <button type="submit">Search</button>
        </form>
      </div>

      {pending.length > 0 && (
        <>
          <h2>Waiting for approval ({pending.length})</h2>
          <div className="alert warn">
            The ID below is what the <strong>player typed</strong>. Check it against the roster before approving —
            money gets sent to this exact ID and can't come back.
          </div>
          <div className="table-wrap" style={{ marginBottom: 24 }}>
            <table>
              <thead>
                <tr><th>Name</th><th>Telegram</th><th>Platform</th><th>Their ID</th><th style={{ width: 70 }}>Age</th><th style={{ width: 280 }} /></tr>
              </thead>
              <tbody>
                {pending.map((p) => (
                  <tr key={p.id + p.platform_id}>
                    <td className="name">{p.display_name ?? '—'}</td>
                    <td className="mono">{p.telegram_username ? '@' + p.telegram_username : p.telegram_id}</td>
                    <td>
                      {p.platform_name}
                      {p.needs_creation && <span className="badge warn" style={{ marginLeft: 4 }}>create</span>}
                    </td>
                    <td className="mono">
                      <strong>{p.platform_uid_claimed}</strong>
                      {p.needs_creation && p.secret && (
                        <div style={{ fontSize: 10, color: 'var(--text-faint)' }}>pass: <strong>{p.secret}</strong></div>
                      )}
                    </td>
                    <td><Ago at={p.created_at} /></td>
                    <td>
                      {p.needs_creation
                        ? <SportsbookCreateAction playerId={p.id} username={p.platform_uid_claimed} />
                        : <ConfirmAction playerId={p.id} platformId={p.platform_id} uid={p.platform_uid_claimed} platformName={p.platform_name} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h2>All players</h2>
      <div className="table-wrap">
        {players.length === 0 ? (
          <div className="empty">No players yet.</div>
        ) : (
          <table>
            <thead>
              <tr><th>Name</th><th>Accounts</th><th style={{ width: 80 }}>Status</th><th style={{ width: 90 }}>Flags</th><th style={{ width: 220 }} /></tr>
            </thead>
            <tbody>
              {players.map((p) => (
                <tr key={p.id}>
                  <td>
                    <span className="name">{p.display_name ?? '—'}</span>
                    <div className="mono" style={{ fontSize: 10, color: 'var(--text-faint)' }}>
                      {p.telegram_username ? '@' + p.telegram_username : p.telegram_id}
                    </div>
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {(p.accounts as any[]).map((a, i) => (
                      <div key={i}>{a.platform}: {a.uid}{!a.has_club && <span className="badge warn" style={{ marginLeft: 4 }}>no club</span>}</div>
                    ))}
                  </td>
                  <td><span className={`badge ${p.status === 'active' ? 'ok' : p.status === 'frozen' ? 'warn' : 'red'}`}>{p.status === 'frozen' ? 'on hold' : p.status}</span></td>
                  <td>{p.flag_count > 0 ? <span className="badge red">{p.flag_count}</span> : <span className="badge muted">clean</span>}</td>
                  <td>
                    <PlayerActions
                      player={{ id: p.id, status: p.status, name: p.display_name ?? 'player', currency }}
                      isOwner={session?.admin.role === 'owner'}
                      platforms={platforms}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Shell>
  );
}
