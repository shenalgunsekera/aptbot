import { db } from '@union/core';
import { Shell } from '../../components/shell';
import { getSession } from '../../lib/auth';
import { redirect } from 'next/navigation';
import { Money, Ago } from '../../components/ui';

export const dynamic = 'force-dynamic';

/**
 * Receipts, filed like folders: one per player, each opening into a folder per
 * transaction (deposit / cash-out), with that transaction's screenshots inside.
 * Admins see everyone; a player only ever sees their own (via the bot).
 */
type Row = {
  id: string; reference: string | null; player_name: string | null; platform_uid: string | null;
  url: string | null; content_type: string | null; created_at: string;
  ref_type: string | null; ref_id: string | null; platform: string | null;
  amount: number | null; currency: string | null; method: string | null;
};

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

  const rows = await sql<Row[]>`
    select r.id, r.reference, r.player_name, r.platform_uid, r.url, r.content_type,
           r.created_at, r.ref_type, r.ref_id, pf.name as platform,
           f.amount, f.currency, pm.name as method
      from receipts r
      left join platforms pf on pf.id = r.platform_id
      left join fills f on r.ref_type = 'fill' and f.id = r.ref_id
      left join payment_methods pm on pm.id = f.method_id
      ${where}
     order by r.player_name nulls last, r.created_at desc
     limit 800`;

  // Group: player → transaction → its receipts.
  const players = new Map<string, {
    name: string; uid: string | null; platform: string | null; count: number; latest: string;
    txns: Map<string, { id: string; amount: number | null; currency: string | null; method: string | null; when: string; rows: Row[] }>;
  }>();
  for (const r of rows) {
    const pkey = `${r.player_name ?? '—'}|${r.platform_uid ?? ''}`;
    let pl = players.get(pkey);
    if (!pl) {
      pl = { name: r.player_name ?? 'Unknown', uid: r.platform_uid, platform: r.platform, count: 0, latest: r.created_at, txns: new Map() };
      players.set(pkey, pl);
    }
    pl.count++;
    if (r.created_at > pl.latest) pl.latest = r.created_at;
    const tkey = r.ref_id ?? r.id;
    let tx = pl.txns.get(tkey);
    if (!tx) {
      tx = { id: tkey, amount: r.amount, currency: r.currency, method: r.method, when: r.created_at, rows: [] };
      pl.txns.set(tkey, tx);
    }
    tx.rows.push(r);
  }
  const playerList = [...players.values()].sort((a, b) => +new Date(b.latest) - +new Date(a.latest));

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>Receipts</h1>
          <p className="sub">Filed by player, then by transaction. Open a folder to see the screenshots.</p>
        </div>
        <form className="btn-row">
          <input name="q" defaultValue={q ?? ''} placeholder="Search name, ID, or receipt code…" style={{ width: 240 }} />
          <button type="submit">Search</button>
          <a className="btn" href="/api/export?type=receipts">⬇ Excel</a>
        </form>
      </div>

      {playerList.length === 0 ? (
        <div className="table-wrap"><div className="empty">No receipts{q ? ' match that search' : ' yet'}.</div></div>
      ) : (
        <div className="folders">
          {playerList.map((pl) => (
            <details className="folder" key={`${pl.name}-${pl.uid}`}>
              <summary>
                <span className="folder-icon">📁</span>
                <span className="folder-name">{pl.name}</span>
                {pl.uid && <span className="mono folder-sub">{pl.uid}</span>}
                {pl.platform && <span className="badge muted">{pl.platform}</span>}
                <span className="folder-count">{pl.count} receipt{pl.count > 1 ? 's' : ''} · <Ago at={pl.latest} /></span>
              </summary>
              <div className="folder-body">
                {[...pl.txns.values()].map((tx) => (
                  <details className="folder sub" key={tx.id} open={pl.txns.size <= 2}>
                    <summary>
                      <span className="folder-icon">🧾</span>
                      <span className="folder-name">
                        {tx.amount != null
                          ? <><Money minor={tx.amount} currency={tx.currency ?? 'USD'} />{tx.method ? ` · ${tx.method}` : ''}</>
                          : <span className="mono">{tx.id.slice(0, 8)}</span>}
                      </span>
                      <span className="folder-count">{tx.rows.length} · <Ago at={tx.when} /></span>
                    </summary>
                    <div className="receipt-grid">
                      {tx.rows.map((r) => {
                        const viewable = !!r.url && /^https?:\/\//i.test(r.url);
                        return (
                          <figure className="receipt-item" key={r.id}>
                            {viewable ? (
                              <a href={r.url!} target="_blank" rel="noreferrer">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={r.url!} alt={r.reference ?? 'receipt'} className="receipt-thumb lg" />
                              </a>
                            ) : (
                              <div className="receipt-thumb lg receipt-nofile">no preview</div>
                            )}
                            <figcaption className="mono">{r.reference ?? '—'}</figcaption>
                          </figure>
                        );
                      })}
                    </div>
                  </details>
                ))}
              </div>
            </details>
          ))}
        </div>
      )}
    </Shell>
  );
}
