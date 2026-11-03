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
            or exists (select 1 from player_platforms x where x.player_id = p.id and x.platform_uid ilike ${'%' + q + '%'})
            or exists (select 1 from v_player_payout_tags t where t.player_id = p.id and t.handle_key = normalize_payout_handle(${q})))`
    : sql``;

  // Cash-out tags used by more than one account (0129) — usually one person
  // running several accounts for sign-up bonuses.
  const shared = await sql<{ handle_key: string; methods: string[]; accounts: { id: string; name: string | null; status: string; joined: string }[] }[]>`
    with t as (
      select distinct t.handle_key, t.player_id, m.name as method
        from v_player_payout_tags t
        join players p on p.id = t.player_id
        join payment_methods m on m.id = t.method_id
       where length(t.handle_key) >= 5 and not coalesce(p.is_house, false)
    ), k as (
      select handle_key from t group by handle_key having count(distinct player_id) > 1
    )
    select k.handle_key,
           (select array_agg(distinct method) from t where t.handle_key = k.handle_key) as methods,
           (select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.display_name, 'status', p.status, 'joined', p.created_at) order by p.created_at)
              from players p where p.id in (select player_id from t where t.handle_key = k.handle_key)) as accounts
      from k
     order by (select count(distinct player_id) from t where t.handle_key = k.handle_key) desc, k.handle_key`;
  const sharedBy = new Map<string, { tag: string; others: string[] }[]>();
  for (const g of shared) for (const a of g.accounts) {
    const list = sharedBy.get(a.id) ?? [];
    list.push({ tag: showTag(g.handle_key), others: g.accounts.filter((o) => o.id !== a.id).map((o) => o.name ?? 'Unnamed') });
    sharedBy.set(a.id, list);
  }

  const players = await sql<any[]>`
    select p.id, p.display_name, p.telegram_id, p.telegram_username, p.status,
           jsonb_array_length(p.risk_flags) as flag_count,
           coalesce((select jsonb_agg(jsonb_build_object('platform', pf.name, 'uid', pp.platform_uid, 'username', pp.platform_username, 'has_club', pp.club_id is not null))
                       from player_platforms pp join platforms pf on pf.id = pp.platform_id
                      where pp.player_id = p.id and pp.platform_uid is not null), '[]') as accounts,
           coalesce((select jsonb_agg(jsonb_build_object(
                        'platformId', pf.id, 'code', pf.code, 'name', pf.name,
                        'uid', pp.platform_uid, 'username', pp.platform_username, 'secret', pp.secret) order by pf.sort_order)
                       from player_platforms pp join platforms pf on pf.id = pp.platform_id
                      where pp.player_id = p.id and pp.platform_uid is not null), '[]') as edit_accounts
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
          <a className="btn" href="/api/export?type=players">⬇ Excel</a>
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

      {shared.length > 0 && (
        <details open={!q} style={{ marginBottom: 24 }}>
          <summary><h2 style={{ display: 'inline' }}>Same cash-out tag on several accounts ({shared.length})</h2></summary>
          <div className="alert warn" style={{ marginTop: 8 }}>
            These accounts have cashed out to — or saved — the same Zelle / Venmo / wallet. Often one person running several
            accounts for sign-up bonuses; sometimes family or a shared account. Staff get a 🚩 alert in the group the moment a new one appears.
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th style={{ width: 260 }}>Cash-out tag</th><th style={{ width: 140 }}>Method</th><th style={{ width: 80 }}>Accounts</th><th>Who</th></tr>
              </thead>
              <tbody>
                {shared.map((g) => (
                  <tr key={g.handle_key}>
                    <td className="mono"><a href={`?q=${encodeURIComponent(g.handle_key)}`}>{showTag(g.handle_key)}</a></td>
                    <td>{g.methods.join(', ')}</td>
                    <td><span className={`badge ${g.accounts.length > 2 ? 'red' : 'warn'}`}>{g.accounts.length}</span></td>
                    <td style={{ fontSize: 13 }}>
                      {g.accounts.map((a, i) => (
                        <span key={a.id}>
                          {i > 0 && ', '}
                          <a href={`?q=${encodeURIComponent(a.name ?? '')}`}>{a.name ?? 'Unnamed'}</a>
                          {a.status !== 'active' && <span className="badge muted" style={{ marginLeft: 3 }}>{a.status === 'frozen' ? 'on hold' : a.status}</span>}
                          <span style={{ color: 'var(--text-faint)', fontSize: 11 }}> · joined {new Date(a.joined).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <h2>All players</h2>
      <div className="table-wrap">
        {players.length === 0 ? (
          <div className="empty">No players yet.</div>
        ) : (
          <table>
            <thead>
              <tr><th>Name</th><th>Accounts</th><th style={{ width: 80 }}>Status</th><th style={{ width: 130 }}>Flags</th><th style={{ width: 220 }} /></tr>
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
                      <div key={i}>{a.platform}: {a.username ? <>{a.username}<span style={{ color: 'var(--text-faint)' }}> ({a.uid})</span></> : a.uid}{!a.has_club && <span className="badge warn" style={{ marginLeft: 4 }}>no club</span>}</div>
                    ))}
                  </td>
                  <td><span className={`badge ${p.status === 'active' ? 'ok' : p.status === 'frozen' ? 'warn' : 'red'}`}>{p.status === 'frozen' ? 'on hold' : p.status}</span></td>
                  <td>
                    {p.flag_count > 0 ? <span className="badge red">{p.flag_count}</span> : !sharedBy.has(p.id) && <span className="badge muted">clean</span>}
                    {sharedBy.get(p.id)?.map((x) => (
                      <a key={x.tag} href={`?q=${encodeURIComponent(x.tag)}`} className="badge red" style={{ marginLeft: 4, display: 'inline-block' }}
                         title={`Cash-out tag ${x.tag} is also on: ${x.others.join(', ')}`}>🚩 shares tag</a>
                    ))}
                  </td>
                  <td>
                    <PlayerActions
                      player={{ id: p.id, status: p.status, name: p.display_name ?? 'player', currency }}
                      isOwner={session?.admin.role === 'owner'}
                      platforms={platforms}
                      editAccounts={p.edit_accounts as any[]}
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

/** A normalised tag for display: phone numbers as 708-616-9009. */
function showTag(k: string): string {
  return /^d{10}$/.test(k) ? `${k.slice(0, 3)}-${k.slice(3, 6)}-${k.slice(6)}` : k;
}
