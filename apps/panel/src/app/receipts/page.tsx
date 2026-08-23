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
type Raw = {
  id: string; reference: string | null; url: string | null; content_type: string | null; created_at: string;
  ref_id: string | null; player_id: string; player_name: string | null; platform_uid: string | null; up_platform: string | null;
  amount: number | null; currency: string | null; deposit_id: string | null; withdraw_id: string | null;
  method: string | null; method_code: string;
  payee_id: string | null; payee_name: string | null; payee_account: string | null; payee_platform: string | null; payee_club: string | null;
  w_amount: number | null; w_remaining: number | null; w_status: string | null;
};
type Dir = 'deposit' | 'cashout' | 'received' | 'other';
type Agg = { code: string; name: string; deposits: number; cashouts: number; total: number };

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
  const like = q ? '%' + q + '%' : null;
  const searchF = like
    ? sql`(r.player_name ilike ${like} or r.platform_uid ilike ${like} or r.reference ilike ${like} or wp.display_name ilike ${like})`
    : sql`true`;

  // Every receipt with its fill, the depositor side (who uploaded it) and — for a
  // peer-to-peer deposit — the payee side (the player who actually got the money).
  // One physical receipt is therefore BOTH the sender's proof they sent it AND the
  // payee's proof they received it; we expand it into per-side entries below.
  const rows = await sql<Raw[]>`
    select r.id, r.reference, r.url, r.content_type, r.created_at, r.ref_id,
           r.player_id, r.player_name, r.platform_uid, upf.name as up_platform,
           f.amount, f.currency, f.deposit_id, f.withdraw_id,
           pm.name as method, coalesce(pm.code, 'other') as method_code,
           w.player_id as payee_id, wp.display_name as payee_name,
           coalesce(case when wpf.code = 'clubgg' then wpp.platform_username else wpp.platform_uid end, wp.display_name) as payee_account,
           wpf.name as payee_platform, wcl.name as payee_club,
           w.amount as w_amount, w.amount_remaining as w_remaining, w.status as w_status
      from receipts r
      left join platforms upf on upf.id = r.platform_id
      left join fills f on r.ref_type = 'fill' and f.id = r.ref_id
      left join payment_methods pm on pm.id = f.method_id
      left join withdraw_requests w on w.id = f.withdraw_id
      left join players wp on wp.id = w.player_id
      left join platforms wpf on wpf.id = w.platform_id
      left join player_platforms wpp on wpp.player_id = w.player_id and wpp.platform_id = w.platform_id
      left join clubs wcl on wcl.id = wpp.club_id
     where ${searchF}
     order by r.created_at desc
     limit 1500`;

  type Entry = {
    ownerId: string; ownerName: string; ownerAccount: string | null; platform: string | null; club: string | null;
    dir: Dir; groupKind: 'withdraw' | 'txn'; groupId: string;
    wAmount: number | null; wRemaining: number | null; wStatus: string | null;
    reference: string | null; url: string | null; content_type: string | null;
    created_at: string; amount: number | null; currency: string | null; method: string | null; method_code: string;
  };
  const entries: Entry[] = [];
  for (const r of rows) {
    const baseDir: Dir = r.deposit_id ? 'deposit' : r.withdraw_id ? 'cashout' : 'other';
    const shared = {
      reference: r.reference, url: r.url, content_type: r.content_type, created_at: r.created_at,
      amount: r.amount, currency: r.currency, method: r.method, method_code: r.method_code,
    };
    // A cash-out receipt (a paid slice or a p2p match) is grouped by the WHOLE
    // cash-out it belongs to, so a $1,500 cash-out paid in pieces reads as one
    // folder. A deposit stays grouped by its own transaction.
    entries.push({
      ownerId: r.player_id, ownerName: r.player_name ?? 'Unknown', ownerAccount: r.platform_uid,
      platform: r.up_platform, club: null, dir: baseDir,
      groupKind: baseDir === 'cashout' ? 'withdraw' : 'txn',
      groupId: (baseDir === 'cashout' ? r.withdraw_id : r.ref_id) ?? r.id,
      wAmount: r.w_amount, wRemaining: r.w_remaining, wStatus: r.w_status, ...shared,
    });
    // Peer-to-peer: the sender's screenshot is also the payee's proof of receipt,
    // so it shows in the payee's own cash-out folder as money RECEIVED.
    if (r.deposit_id && r.withdraw_id && r.payee_id) {
      entries.push({
        ownerId: r.payee_id, ownerName: r.payee_name ?? 'Unknown', ownerAccount: r.payee_account,
        platform: r.payee_platform, club: r.payee_club, dir: 'received',
        groupKind: 'withdraw', groupId: r.withdraw_id,
        wAmount: r.w_amount, wRemaining: r.w_remaining, wStatus: r.w_status, ...shared,
      });
    }
  }
  const inKind = (d: Dir) => kind === 'all' ? true : kind === 'deposits' ? d === 'deposit' : (d === 'cashout' || d === 'received');

  // Method tabs + dashboard, counted from the entries so the tab numbers always
  // match the folders shown. "Received / paid out" is the cash-out side.
  const mAgg = new Map<string, Agg>();
  for (const e of entries) {
    const a = mAgg.get(e.method_code) ?? { code: e.method_code, name: e.method ?? 'Other', deposits: 0, cashouts: 0, total: 0 };
    if (e.dir === 'deposit') a.deposits++;
    else if (e.dir === 'cashout' || e.dir === 'received') a.cashouts++;
    a.total++;
    mAgg.set(e.method_code, a);
  }
  const pickCount = (a: Agg) => (kind === 'deposits' ? a.deposits : kind === 'cashouts' ? a.cashouts : a.total);
  const methodTabs = [...mAgg.values()].filter((a) => pickCount(a) > 0).sort((x, y) => y.total - x.total);
  const selAgg = method && method !== 'all' ? mAgg.get(method) ?? null : null;

  const tDep = selAgg ? selAgg.deposits : [...mAgg.values()].reduce((s, a) => s + a.deposits, 0);
  const tCash = selAgg ? selAgg.cashouts : [...mAgg.values()].reduce((s, a) => s + a.cashouts, 0);
  const tTotal = tDep + tCash;

  const donutTitle = selAgg
    ? `${selAgg.name} — sent vs received`
    : `${kind === 'deposits' ? 'Deposit' : kind === 'cashouts' ? 'Received' : 'All'} receipts by method`;
  const pieData = selAgg
    ? [{ label: 'Deposits (sent)', value: selAgg.deposits, color: '#2f9e6b' },
       { label: 'Received / paid', value: selAgg.cashouts, color: '#5b5bd6' }].filter((d) => d.value > 0)
    : methodTabs.map((a, i) => ({ label: a.name, value: pickCount(a), color: PIE[i % PIE.length]! })).filter((d) => d.value > 0);

  // Filter to what's shown, then group: player → cash-out / deposit → receipts.
  // A cash-out group carries the WHOLE request's totals so we can show how much
  // of it has been paid and whether it's done.
  type Group = {
    id: string; kind: 'withdraw' | 'txn'; dir: Dir; when: string; rows: Entry[];
    amount: number | null; currency: string | null; method: string | null;
    wAmount: number | null; wRemaining: number | null; wStatus: string | null;
  };
  const shown = entries.filter((e) => (!method || method === 'all' || e.method_code === method) && inKind(e.dir));
  const players = new Map<string, {
    id: string; name: string; account: string | null; platform: string | null; club: string | null;
    count: number; latest: string; groups: Map<string, Group>;
  }>();
  for (const e of shown) {
    let pl = players.get(e.ownerId);
    if (!pl) {
      pl = { id: e.ownerId, name: e.ownerName, account: e.ownerAccount, platform: e.platform, club: e.club, count: 0, latest: e.created_at, groups: new Map() };
      players.set(e.ownerId, pl);
    }
    pl.count++;
    if (e.created_at > pl.latest) pl.latest = e.created_at;
    if (!pl.account && e.ownerAccount) pl.account = e.ownerAccount;
    if (!pl.club && e.club) pl.club = e.club;
    let g = pl.groups.get(e.groupId);
    if (!g) {
      g = { id: e.groupId, kind: e.groupKind, dir: e.dir, when: e.created_at, rows: [],
            amount: e.amount, currency: e.currency, method: e.method,
            wAmount: e.wAmount, wRemaining: e.wRemaining, wStatus: e.wStatus };
      pl.groups.set(e.groupId, g);
    }
    if (e.created_at > g.when) g.when = e.created_at;
    g.rows.push(e);
  }
  // Within a player: cash-outs first, then deposits, newest first.
  const rank = (g: Group) => (g.kind === 'withdraw' ? 0 : 1);
  const playerList = [...players.values()]
    .map((pl) => ({ ...pl, groupList: [...pl.groups.values()].sort((a, b) => rank(a) - rank(b) || +new Date(b.when) - +new Date(a.when)) }))
    .sort((a, b) => +new Date(b.latest) - +new Date(a.latest));

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
          <p className="sub">Filed by player, then by transaction. A peer-to-peer payment shows for both sides — the sender (deposit) and the payee (received).</p>
        </div>
        <ReceiptSearch initial={q ?? ''} type={kind} method={method ?? 'all'} />
      </div>

      {/* Dashboard — one compact row: donut + legend, then the headline numbers. */}
      <div className="card receipts-dash">
        <div className="dash-chart">
          <Donut data={pieData} size={90} />
          <div className="dash-legend">
            <div className="stat-label">{donutTitle}</div>
            {pieData.length === 0 ? <div className="stat-note">Nothing yet.</div> : pieData.map((d) => (
              <div key={d.label} className="dash-legend-row">
                <span className="dash-dot" style={{ background: d.color }} />
                <span className="dash-legend-name">{d.label}</span>
                <strong className="mono">{d.value}</strong>
              </div>
            ))}
          </div>
        </div>
        <div className="dash-stats">
          <div><div className="stat-label">{selAgg ? `${selAgg.name} receipts` : 'Total receipts'}</div><div className="stat-value">{tTotal}</div></div>
          <div><div className="stat-label">Deposits (sent)</div><div className="stat-value pos">{tDep}</div></div>
          <div><div className="stat-label">Received / paid out</div><div className="stat-value">{tCash}</div></div>
        </div>
      </div>

      {/* Method tabs */}
      <div className="tabs" role="tablist" aria-label="Payment method">
        <Link scroll={false} role="tab" aria-selected={!method || method === 'all'} className={`tab ${!method || method === 'all' ? 'active' : ''}`} href={href({ method: 'all' })}>
          All <span style={{ opacity: 0.55 }}>{methodTabs.reduce((s, a) => s + pickCount(a), 0)}</span>
        </Link>
        {methodTabs.map((a) => (
          <Link scroll={false} key={a.code} role="tab" aria-selected={method === a.code}
                className={`tab ${method === a.code ? 'active' : ''}`} href={href({ method: a.code })}>
            {a.name} <span style={{ opacity: 0.55 }}>{pickCount(a)}</span>
          </Link>
        ))}
      </div>

      {/* Deposit / cash-out tabs (within the method) */}
      <div className="tabs" role="tablist" aria-label="Receipt type" style={{ marginTop: -12 }}>
        {([['all', 'All'], ['deposits', 'Deposits'], ['cashouts', 'Cash-outs']] as const).map(([k, label]) => (
          <Link scroll={false} key={k} role="tab" aria-selected={kind === k} className={`tab ${kind === k ? 'active' : ''}`} href={href({ type: k })}>
            {label}
          </Link>
        ))}
      </div>

      {playerList.length === 0 ? (
        <div className="table-wrap"><div className="empty">No receipts match this filter.</div></div>
      ) : (
        <div className="folders">
          {playerList.map((pl) => (
            <details className="folder" key={pl.id}>
              <summary>
                <span className="folder-icon">📁</span>
                <span className="folder-name">{pl.name}</span>
                {pl.account && pl.account !== pl.name && <span className="mono folder-sub">{pl.account}</span>}
                {[pl.platform, pl.club].filter(Boolean).length > 0 && (
                  <span className="badge muted">{[pl.platform, pl.club].filter(Boolean).join(' · ')}</span>
                )}
                <span className="folder-count">{pl.count} receipt{pl.count > 1 ? 's' : ''} · <Ago at={pl.latest} /></span>
              </summary>
              <div className="folder-body">
                {pl.groupList.map((g) => {
                  const isCashout = g.kind === 'withdraw';
                  const total = g.wAmount ?? 0;
                  const paid = total - (g.wRemaining ?? 0);
                  const done = isCashout && (g.wStatus === 'filled' || (g.wRemaining ?? 0) <= 0);
                  return (
                  <details className="folder sub" key={g.id} open={pl.groupList.length <= 2}>
                    <summary>
                      <span className="folder-icon">{isCashout ? '💵' : '🧾'}</span>
                      <span className="folder-name">
                        {isCashout && g.wAmount != null
                          ? <><Money minor={g.wAmount} currency={g.currency ?? 'USD'} /> cash-out</>
                          : g.amount != null
                          ? <><Money minor={g.amount} currency={g.currency ?? 'USD'} />{g.method ? ` · ${g.method}` : ''}</>
                          : <span className="mono">{g.id.slice(0, 8)}</span>}
                      </span>
                      {isCashout
                        ? (done
                            ? <span className="badge ok">✓ paid in full</span>
                            : <span className="badge warn"><Money minor={paid} currency={g.currency ?? 'USD'} /> of <Money minor={total} currency={g.currency ?? 'USD'} /> paid</span>)
                        : <DirBadge dir={g.dir} />}
                      <span className="folder-count">{g.rows.length} receipt{g.rows.length > 1 ? 's' : ''} · <Ago at={g.when} /></span>
                    </summary>
                    <div className="receipt-grid">
                      {g.rows.map((r, i) => {
                        const viewable = !!r.url && /^https?:\/\//i.test(r.url);
                        return (
                          <figure className="receipt-item" key={r.reference ?? i}>
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
                  );
                })}
              </div>
            </details>
          ))}
        </div>
      )}
    </Shell>
  );
}

/** A little tag on each transaction saying which side of the money it was. */
function DirBadge({ dir }: { dir: Dir }) {
  if (dir === 'deposit') return <span className="badge ok">deposit</span>;
  if (dir === 'received') return <span className="badge accent">received</span>;
  if (dir === 'cashout') return <span className="badge accent">paid out</span>;
  return null;
}

/** A small inline-SVG donut — no libraries, theme-aware track. */
function Donut({ data, size = 118 }: { data: { label: string; value: number; color: string }[]; size?: number }) {
  const total = data.reduce((a, d) => a + d.value, 0) || 1;
  const R = 40;
  const C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} role="img" aria-label="Receipts by method" style={{ transform: 'rotate(-90deg)', flexShrink: 0 }}>
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
