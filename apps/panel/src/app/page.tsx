import Link from 'next/link';
import { redirect } from 'next/navigation';
import { db, platformTotals } from '@union/core';
import { Shell } from '../components/shell';
import { getSession } from '../lib/auth';
import { Money, Ago } from '../components/ui';
import { FlowChart, FlowStats, type Bucket } from '../components/flow-chart';

export const dynamic = 'force-dynamic';

interface Float {
  currency: string;
  owner_cash_held: number;
  wallets_total: number;
  escrow_total: number;
  house_rake: number;
  house_loss: number;
  on_tables: number;
  total_owed_to_players: number;
  net_position: number;
  ledger_balances: boolean;
}
interface InboxRow { kind: string; ref_id: string; created_at: string; detail: Record<string, any>; priority: number; }

export default async function Overview({
  searchParams,
}: {
  searchParams: Promise<{ flow?: string; from?: string; to?: string }>;
}) {
  // Check auth BEFORE any DB query — an unauthenticated hit should land on
  // /login, not run queries (and not crash if the DB is unreachable).
  const session = await getSession();
  if (!session) redirect('/login');

  const sql = db();
  const floats = await sql<Float[]>`select * from v_float_position`;
  const inbox = await sql<InboxRow[]>`select * from v_admin_inbox order by priority, created_at limit 30`;
  const problems = await sql<{ problem: string; detail: any }[]>`select * from ledger_verify()`;

  // ── Cash flow: money received (deposits) vs paid out (cash-outs) over time ──
  // Session TZ is GMT, so date_trunc aligns to UTC boundaries; we bucket to match.
  const { flow: flowParam, from, to } = await searchParams;
  const validDate = (s?: string) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
  const cFrom = validDate(from), cTo = validDate(to);
  const now = new Date();
  const DAY = 86400000, HOUR = 3600000;
  const today0 = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  let preset: '24h' | '7d' | '30d' | 'custom';
  let unit: 'hour' | 'day';
  let start: Date, seriesEnd: Date, end: Date;
  if (cFrom && cTo) {
    preset = 'custom'; unit = 'day';
    start = new Date(cFrom + 'T00:00:00Z');
    seriesEnd = new Date(cTo + 'T00:00:00Z');
    end = new Date(seriesEnd.getTime() + DAY);
  } else {
    preset = flowParam === '24h' ? '24h' : flowParam === '30d' ? '30d' : '7d';
    end = now;
    if (preset === '24h') {
      unit = 'hour';
      const thisHour = Math.floor(now.getTime() / HOUR) * HOUR;
      start = new Date(thisHour - 23 * HOUR);
      seriesEnd = new Date(thisHour);
    } else {
      unit = 'day';
      const days = preset === '30d' ? 29 : 6;
      start = new Date(today0 - days * DAY);
      seriesEnd = new Date(today0);
    }
  }
  const step = unit === 'hour' ? '1 hour' : '1 day';
  const buckets = await sql<Bucket[]>`
    with b as (
      select generate_series(${start}::timestamptz, ${seriesEnd}::timestamptz, ${step}::interval) as t
    ),
    fl as (
      select date_trunc(${unit}, released_at) as t,
             coalesce(sum(amount) filter (where deposit_id is not null), 0) as received,
             coalesce(sum(amount) filter (where withdraw_id is not null), 0) as paid
        from fills
       where status = 'released' and released_at >= ${start} and released_at < ${end}
       group by 1
    )
    select b.t, coalesce(fl.received, 0)::bigint as received, coalesce(fl.paid, 0)::bigint as paid
      from b left join fl on fl.t = b.t
     order by b.t`;
  const flowReceived = buckets.reduce((s, b) => s + Number(b.received), 0);
  const flowPaid = buckets.reduce((s, b) => s + Number(b.paid), 0);
  const flowHref = (f: string) => `/?flow=${f}`;

  // Money in / out per platform (ClubGG, Sportsbook, …) — same range as the chart.
  const totals = await platformTotals(start, end);
  const totalsCur = floats[0]?.currency ?? 'USD';
  const rangeLabel = preset === '24h' ? 'last 24 hours'
    : preset === '30d' ? 'last 30 days'
    : preset === 'custom' ? `${cFrom} → ${cTo}`
    : 'last 7 days';
  const grandIn = totals.reduce((s, t) => s + Number(t.deposited), 0);
  const grandOut = totals.reduce((s, t) => s + Number(t.withdrawn), 0);

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <p className="sub">Your money position, and everything waiting on a person.</p>
        </div>
      </div>

      {problems.length > 0 && (
        <div className="alarm">
          ⛔ SOMETHING IS WRONG WITH THE BOOKS — {problems.length} issue{problems.length > 1 ? 's' : ''}.
          Stop and investigate before processing anything.
          <pre className="mono" style={{ marginTop: 8, fontSize: 11, whiteSpace: 'pre-wrap' }}>
            {JSON.stringify(problems, null, 2)}
          </pre>
        </div>
      )}

      {floats.map((f) => (
        <section key={f.currency} style={{ marginBottom: 22 }}>
          <div className="grid cols-4">
            <div className="card">
              <div className="stat-label">Cash you're holding</div>
              <div className={`stat-value ${f.owner_cash_held > 0 ? 'pos' : f.owner_cash_held < 0 ? 'neg' : ''}`}>
                <Money minor={f.owner_cash_held} currency={f.currency} />
              </div>
              <div className="stat-note">{f.owner_cash_held >= 0 ? 'in your accounts' : "you're out of pocket"}</div>
            </div>
            <div className="card">
              <div className="stat-label">Owed to players</div>
              <div className="stat-value"><Money minor={f.total_owed_to_players} currency={f.currency} /></div>
              <div className="stat-note">money in play + waiting to pay out</div>
            </div>
            <div className="card">
              <div className="stat-label">Your position</div>
              <div className={`stat-value ${f.net_position >= 0 ? 'pos' : 'neg'}`}>
                <Money minor={f.net_position} currency={f.currency} />
              </div>
              <div className="stat-note">cash held − what you owe</div>
            </div>
            <div className="card">
              <div className="stat-label">Fees earned</div>
              <div className="stat-value pos"><Money minor={f.house_rake} currency={f.currency} /></div>
              <div className="stat-note">{f.house_loss !== 0 && <>losses <Money minor={f.house_loss} currency={f.currency} /></>}</div>
            </div>
          </div>
        </section>
      ))}

      {/* Cash flow */}
      <section style={{ marginBottom: 22 }}>
        <div className="flow-head">
          <div>
            <h2 style={{ margin: 0 }}>Cash flow</h2>
            <p className="sub">Money received (deposits) vs paid out (cash-outs).</p>
          </div>
          <div className="flow-controls">
            <div className="tabs" role="tablist" aria-label="Range">
              {([['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days']] as const).map(([k, lbl]) => (
                <Link key={k} href={flowHref(k)} role="tab" aria-selected={preset === k}
                      className={`tab ${preset === k ? 'active' : ''}`}>{lbl}</Link>
              ))}
            </div>
            <form className="flow-dates" method="get">
              <input type="date" name="from" defaultValue={cFrom ?? ''} aria-label="From date" />
              <span className="flow-dash">→</span>
              <input type="date" name="to" defaultValue={cTo ?? ''} aria-label="To date" />
              <button type="submit" className="sm">Apply</button>
            </form>
          </div>
        </div>
        <div className="grid cols-2" style={{ marginBottom: 16 }}>
          <FlowStats received={flowReceived} paid={flowPaid} currency={floats[0]?.currency ?? 'USD'} />
        </div>
        <div className="card">
          {flowReceived === 0 && flowPaid === 0 ? (
            <div className="empty" style={{ border: 'none' }}>No money moved in this range.</div>
          ) : (
            <FlowChart buckets={buckets} unit={unit} />
          )}
        </div>
      </section>

      {/* Per-platform totals */}
      <section style={{ marginBottom: 22 }}>
        <div className="flow-head">
          <div>
            <h2 style={{ margin: 0 }}>By platform</h2>
            <p className="sub">Money in (deposits) and out (cash-outs) per platform · {rangeLabel}.</p>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Platform</th>
                <th style={{ textAlign: 'right' }}>Deposited in</th>
                <th style={{ textAlign: 'right' }}>Cashed out</th>
                <th style={{ textAlign: 'right' }}>Net</th>
              </tr>
            </thead>
            <tbody>
              {totals.length === 0 ? (
                <tr><td colSpan={4}><div className="empty" style={{ border: 'none' }}>No platforms yet.</div></td></tr>
              ) : totals.map((t) => {
                const net = Number(t.deposited) - Number(t.withdrawn);
                return (
                  <tr key={t.id}>
                    <td style={{ fontWeight: 600 }}>{t.name}</td>
                    <td className="mono" style={{ textAlign: 'right' }}><Money minor={Number(t.deposited)} currency={totalsCur} /></td>
                    <td className="mono" style={{ textAlign: 'right' }}><Money minor={Number(t.withdrawn)} currency={totalsCur} /></td>
                    <td className="mono" style={{ textAlign: 'right', fontWeight: 600, color: net >= 0 ? 'var(--ok)' : 'var(--red)' }}><Money minor={net} currency={totalsCur} /></td>
                  </tr>
                );
              })}
            </tbody>
            {totals.length > 0 && (
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--border)' }}>
                  <td style={{ fontWeight: 700 }}>All platforms</td>
                  <td className="mono" style={{ textAlign: 'right', fontWeight: 700 }}><Money minor={grandIn} currency={totalsCur} /></td>
                  <td className="mono" style={{ textAlign: 'right', fontWeight: 700 }}><Money minor={grandOut} currency={totalsCur} /></td>
                  <td className="mono" style={{ textAlign: 'right', fontWeight: 700, color: grandIn - grandOut >= 0 ? 'var(--ok)' : 'var(--red)' }}><Money minor={grandIn - grandOut} currency={totalsCur} /></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </section>

      <h2>Waiting on a person</h2>
      <div className="table-wrap">
        {inbox.length === 0 ? (
          <div className="empty">All clear. 🎉</div>
        ) : (
          <table>
            <thead>
              <tr><th style={{ width: 130 }}>What</th><th>Details</th><th style={{ width: 90 }}>Waiting</th><th style={{ width: 90 }} /></tr>
            </thead>
            <tbody>
              {inbox.map((r) => (
                <tr key={`${r.kind}-${r.ref_id}`}>
                  <td><InboxBadge kind={r.kind} /></td>
                  <td className="mono" style={{ fontSize: 11 }}>{describe(r)}</td>
                  <td><Ago at={r.created_at} /></td>
                  <td><Link className="btn sm" href={hrefFor(r.kind)}>Open</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Shell>
  );
}

function InboxBadge({ kind }: { kind: string }) {
  const map: Record<string, [string, string]> = {
    dispute: ['red', 'Dispute'],
    needs_review: ['warn', 'Check payment'],
    club_review: ['warn', 'Verify money in'],
    pending_link: ['red', 'New player'],
    needs_club: ['warn', 'Assign club'],
    loader_work: ['muted', 'Add / take off'],
  };
  const [cls, label] = map[kind] ?? ['muted', kind];
  return <span className={`badge ${cls}`}>{label}</span>;
}

function hrefFor(kind: string): string {
  switch (kind) {
    case 'dispute': return '/disputes';
    case 'needs_review': case 'club_review': return '/transactions?filter=review';
    case 'pending_link': case 'needs_club': return '/players';
    case 'loader_work': return '/jobs';
    default: return '/';
  }
}

const fmt = (v: unknown) => {
  const n = Number(v ?? 0);
  return `$${(Math.abs(n) / 100).toFixed(2)}`;
};

function describe(r: InboxRow): string {
  const d = r.detail ?? {};
  switch (r.kind) {
    case 'dispute': return `${d.name ?? ''} · ${fmt(d.amount)} — "${d.reason ?? ''}"`;
    case 'needs_review': case 'club_review': return `${fmt(d.amount)} — ref ${d.payment_ref ?? '?'}`;
    case 'pending_link': return `${d.name ?? d.telegram_id} wants to link ${(d.claims ?? []).map((c: any) => `${c.platform} ${c.uid}`).join(', ')}`;
    case 'needs_club': return `${d.name} — ${d.platform} ${d.uid}`;
    case 'loader_work': return `${Number(d.delta) > 0 ? 'ADD' : 'TAKE OFF'} ${fmt(Math.abs(Number(d.delta)))} → ${d.name} (${d.platform_uid})${d.claimed_by ? ' · claimed' : ''}`;
    default: return JSON.stringify(d);
  }
}
