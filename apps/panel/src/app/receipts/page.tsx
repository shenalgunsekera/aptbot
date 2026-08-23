import Link from 'next/link';
import { db } from '@union/core';
import { Shell } from '../../components/shell';
import { getSession } from '../../lib/auth';
import { redirect } from 'next/navigation';
import { Money, Ago } from '../../components/ui';
import { ReceiptSearch } from './search';

export const dynamic = 'force-dynamic';

/**
 * Receipts, filed like folders: one per player, each opening into a folder per
 * transaction, with that transaction's screenshots inside. Filter by payment
 * method and by deposit vs cash-out, with a small dashboard of the totals on top.
 */
type Row = {
  id: string; reference: string | null; player_name: string | null; platform_uid: string | null;
  url: string | null; content_type: string | null; created_at: string;
  ref_type: string | null; ref_id: string | null; platform: string | null;
  amount: number | null; currency: string | null; method: string | null;
};
type Agg = { method: string; method_code: string; deposits: number; cashouts: number; total: number };

// A small, stable palette for the donut (readable on both themes).
const PIE = ['#5b5bd6', '#2f9e6b', '#c2790a', '#e5484d', '#0e7490', '#7c3aed', '#0284c7', '#ea580c', '#9295a8'];

export default async function ReceiptsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; type?: string; method?: string }>;
}) {
  if (!(await getSession())) redirect('/login');
  const { q, type, method } = await searchParams;
  const sql = db();

  const kind = type === 'deposits' ? 'deposits' : type === 'cashouts' ? 'cashouts' : 'all';
  const searchF = q
    ? sql`(r.player_name ilike ${'%' + q + '%'} or r.platform_uid ilike ${'%' + q + '%'} or r.reference ilike ${'%' + q + '%'})`
    : sql`true`;
  const typeF = kind === 'deposits' ? sql`f.deposit_id is not null`
    : kind === 'cashouts' ? sql`(f.withdraw_id is not null and f.deposit_id is null)`
    : sql`true`;
  const methodF = method && method !== 'all' ? sql`pm.code = ${method}` : sql`true`;

  // Dashboard aggregates — respect the search, so the numbers match what's shown.
  const agg = await sql<Agg[]>`
    select coalesce(pm.name, 'Other') as method, coalesce(pm.code, 'other') as method_code,
           count(*) filter (where f.deposit_id is not null)::int as deposits,
           count(*) filter (where f.withdraw_id is not null and f.deposit_id is null)::int as cashouts,
           count(*)::int as total
      from receipts r
      left join fills f on r.ref_type = 'fill' and f.id = r.ref_id
      left join payment_methods pm on pm.id = f.method_id
     where ${searchF}
     group by pm.name, pm.code
     order by count(*) desc`;

  const pickCount = (a: Agg) => (kind === 'deposits' ? a.deposits : kind === 'cashouts' ? a.cashouts : a.total);
  const methodTabs = agg.filter((a) => pickCount(a) > 0);
  const totalDeposits = agg.reduce((s, a) => s + a.deposits, 0);
  const totalCashouts = agg.reduce((s, a) => s + a.cashouts, 0);
  const grandTotal = kind === 'deposits' ? totalDeposits : kind === 'cashouts' ? totalCashouts : totalDeposits + totalCashouts;
  const pieData = methodTabs
    .map((a, i) => ({ label: a.method, value: pickCount(a), color: PIE[i % PIE.length]! }))
    .filter((d) => d.value > 0);

  const rows = await sql<Row[]>`
    select r.id, r.reference, r.player_name, r.platform_uid, r.url, r.content_type,
           r.created_at, r.ref_type, r.ref_id, pf.name as platform,
           f.amount, f.currency, pm.name as method
      from receipts r
      left join platforms pf on pf.id = r.platform_id
      left join fills f on r.ref_type = 'fill' and f.id = r.ref_id
      left join payment_methods pm on pm.id = f.method_id
     where ${searchF} and ${typeF} and ${methodF}
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

  // Build a URL keeping the other filters intact.
  const href = (over: { method?: string; type?: string }) => {
    const p = new URLSearchParams();
    const mm = over.method ?? method ?? 'all';
    const tt = over.type ?? kind;
    if (mm && mm !== 'all') p.set('method', mm);
    if (tt && tt !== 'all') p.set('type', tt);
    if (q) p.set('q', q);
    const s = p.toString();
    return `/receipts${s ? `?${s}` : ''}`;
  };

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>Receipts</h1>
          <p className="sub">Filed by player, then by transaction. Open a folder to see the screenshots.</p>
        </div>
        <ReceiptSearch initial={q ?? ''} type={kind} method={method ?? 'all'} />
      </div>

      {/* Dashboard */}
      <div className="grid cols-2" style={{ marginBottom: 20, alignItems: 'stretch' }}>
        <div className="card" style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
          <Donut data={pieData} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
            <div className="stat-label">{kind === 'deposits' ? 'Deposit' : kind === 'cashouts' ? 'Cash-out' : 'All'} receipts by method</div>
            {pieData.length === 0 ? <div className="stat-note">Nothing yet.</div> : pieData.map((d) => (
              <div key={d.label} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: d.color, flexShrink: 0 }} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.label}</span>
                <strong className="mono">{d.value}</strong>
              </div>
            ))}
          </div>
        </div>
        <div className="grid cols-2" style={{ gap: 12 }}>
          <div className="card"><div className="stat-label">Total receipts</div><div className="stat-value">{grandTotal}</div></div>
          <div className="card"><div className="stat-label">Deposits (sent)</div><div className="stat-value pos">{totalDeposits}</div></div>
          <div className="card"><div className="stat-label">Cash-outs (paid out)</div><div className="stat-value">{totalCashouts}</div></div>
          <div className="card"><div className="stat-label">Methods</div><div className="stat-value">{methodTabs.length}</div></div>
        </div>
      </div>

      {/* Method tabs */}
      <div className="tabs" role="tablist" aria-label="Payment method">
        <Link role="tab" aria-selected={!method || method === 'all'} className={`tab ${!method || method === 'all' ? 'active' : ''}`} href={href({ method: 'all' })}>
          All <span style={{ opacity: 0.55 }}>{methodTabs.reduce((s, a) => s + pickCount(a), 0)}</span>
        </Link>
        {methodTabs.map((a) => (
          <Link key={a.method_code} role="tab" aria-selected={method === a.method_code}
                className={`tab ${method === a.method_code ? 'active' : ''}`} href={href({ method: a.method_code })}>
            {a.method} <span style={{ opacity: 0.55 }}>{pickCount(a)}</span>
          </Link>
        ))}
      </div>

      {/* Deposit / cash-out tabs (within the method) */}
      <div className="tabs" role="tablist" aria-label="Receipt type" style={{ marginTop: -12 }}>
        {([['all', 'All'], ['deposits', 'Deposits'], ['cashouts', 'Cash-outs']] as const).map(([k, label]) => (
          <Link key={k} role="tab" aria-selected={kind === k} className={`tab ${kind === k ? 'active' : ''}`} href={href({ type: k })}>
            {label}
          </Link>
        ))}
      </div>

      {playerList.length === 0 ? (
        <div className="table-wrap"><div className="empty">No receipts match this filter.</div></div>
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

/** A small inline-SVG donut — no libraries, theme-aware track. */
function Donut({ data }: { data: { label: string; value: number; color: string }[] }) {
  const total = data.reduce((a, d) => a + d.value, 0) || 1;
  const R = 40;
  const C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <svg viewBox="0 0 100 100" width="118" height="118" role="img" aria-label="Receipts by method" style={{ transform: 'rotate(-90deg)', flexShrink: 0 }}>
      <circle cx="50" cy="50" r={R} fill="none" stroke="var(--surface-2)" strokeWidth="15" />
      {data.map((d, i) => {
        const len = (d.value / total) * C;
        const seg = (
          <circle key={i} cx="50" cy="50" r={R} fill="none" stroke={d.color} strokeWidth="15"
                  strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-offset} />
        );
        offset += len;
        return seg;
      })}
    </svg>
  );
}
