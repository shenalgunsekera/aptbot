import { db } from '@union/core';
import { Shell } from '../../components/shell';
import { getSession } from '../../lib/auth';
import { redirect } from 'next/navigation';
import { Ago } from '../../components/ui';

export const dynamic = 'force-dynamic';

/**
 * Every receipt, across all players — searchable by name, ID, or receipt code.
 * Admins get full access; a player only ever sees their own (via the bot).
 */
export default async function ReceiptsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  if (!(await getSession())) redirect('/login');
  const { q } = await searchParams;
  const sql = db();

  const where = q
    ? sql`where r.player_name ilike ${'%' + q + '%'} or r.platform_uid ilike ${'%' + q + '%'}
            or r.reference ilike ${'%' + q + '%'}`
    : sql``;

  const rows = await sql<any[]>`
    select r.id, r.reference, r.player_name, r.platform_uid, r.url, r.content_type,
           r.created_at, pf.name as platform
      from receipts r
      left join platforms pf on pf.id = r.platform_id
      ${where}
     order by r.created_at desc limit 200`;

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>Receipts</h1>
          <p className="sub">Every receipt players have uploaded. Click one to open it full size.</p>
        </div>
        <form className="btn-row">
          <input name="q" defaultValue={q ?? ''} placeholder="Search name, ID, or receipt code…" style={{ width: 240 }} />
          <button type="submit">Search</button>
          <a className="btn" href="/api/export?type=receipts">⬇ Excel</a>
        </form>
      </div>

      <div className="table-wrap">
        {rows.length === 0 ? (
          <div className="empty">No receipts{q ? ' match that search' : ' yet'}.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 80 }}>Receipt</th>
                <th>Code</th>
                <th>Player</th>
                <th>ID</th>
                <th style={{ width: 90 }}>Platform</th>
                <th style={{ width: 90 }}>When</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <a href={r.url} target="_blank" rel="noreferrer">
                      {r.content_type?.startsWith('image/')
                        ? <img src={r.url} alt="receipt" className="receipt-thumb" />
                        : <span className="badge muted">open 📄</span>}
                    </a>
                  </td>
                  <td className="mono">{r.reference}</td>
                  <td className="name">{r.player_name}</td>
                  <td className="mono">{r.platform_uid ?? '—'}</td>
                  <td>{r.platform ?? '—'}</td>
                  <td><Ago at={r.created_at} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Shell>
  );
}
