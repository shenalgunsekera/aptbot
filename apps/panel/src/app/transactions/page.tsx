import Link from 'next/link';
import { db } from '@union/core';
import { Shell } from '../../components/shell';
import { Money, Ago } from '../../components/ui';
import { FillActions } from './actions';

export const dynamic = 'force-dynamic';

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'review', label: 'Needs a look' },
  { key: 'awaiting', label: 'Being checked' },
  { key: 'locked', label: 'Not paid yet' },
  { key: 'released', label: 'Done' },
  { key: 'club', label: 'Through us' },
];

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; q?: string }>;
}) {
  const { filter = 'all', q } = await searchParams;
  const sql = db();

  const where =
    filter === 'review' ? sql`v.status = 'awaiting_confirmation' and (v.escalated_at is not null or v.withdraw_id is null)`
    : filter === 'awaiting' ? sql`v.status = 'awaiting_confirmation'`
    : filter === 'locked' ? sql`v.status = 'locked'`
    : filter === 'released' ? sql`v.status = 'released'`
    : filter === 'club' ? sql`v.kind <> 'matched'`
    : sql`true`;

  const search = q
    ? sql`and (v.payment_ref ilike ${'%' + q + '%'}
            or v.depositor_name ilike ${'%' + q + '%'}
            or v.payee_name ilike ${'%' + q + '%'}
            or v.payout_handle ilike ${'%' + q + '%'}
            or v.depositor_uid ilike ${'%' + q + '%'})`
    : sql``;

  const rows = await sql<any[]>`
    select v.*, f.detected_at, f.detected_source
      from v_fills_detail v
      left join fills f on f.id = v.id
     where ${where} ${search}
     order by v.created_at desc limit 100`;

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>Payments</h1>
          <p className="sub">Every payment in full — who, how much, the reference, receipts, and the money trail.</p>
        </div>
        <form className="btn-row">
          <input name="q" defaultValue={q ?? ''} placeholder="Search ref, name, ID…" style={{ width: 220 }} />
          <input type="hidden" name="filter" value={filter} />
          <button type="submit">Search</button>
          <a className="btn" href="/api/export?type=payments">⬇ Excel</a>
        </form>
      </div>

      <div className="btn-row" style={{ marginBottom: 12 }}>
        {FILTERS.map((f) => (
          <Link key={f.key} href={`/transactions?filter=${f.key}`} className="btn"
                aria-current={filter === f.key ? 'page' : undefined}
                style={filter === f.key ? { background: 'var(--red)', color: '#fff', borderColor: 'var(--red)' } : undefined}>
            {f.label}
          </Link>
        ))}
      </div>

      <div className="table-wrap">
        {rows.length === 0 ? (
          <div className="empty">Nothing matches.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 100 }}>Status</th>
                <th className="num" style={{ width: 90 }}>Amount</th>
                <th style={{ width: 90 }}>Type</th>
                <th>From → To</th>
                <th>Reference</th>
                <th style={{ width: 80 }}>Receipt</th>
                <th style={{ width: 90 }}>Hold</th>
                <th style={{ width: 70 }}>Age</th>
                <th style={{ width: 200 }} />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <StatusBadge status={r.status} escalated={!!r.escalated_at} disputed={r.has_open_dispute} />
                    {r.detected_at && (
                      <div className="badge ok" style={{ marginTop: 4 }} title={`Auto-detected via ${r.detected_source}`}>
                        💚 payment detected
                      </div>
                    )}
                  </td>
                  <td className="num">
                    <Money minor={r.amount} currency={r.currency} />
                    {r.rake_amount > 0 && (
                      <div style={{ fontSize: 10, color: 'var(--text-faint)' }}>fee <Money minor={r.rake_amount} currency={r.currency} /></div>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${r.kind === 'matched' ? 'muted' : 'red'}`}>
                      {r.kind === 'matched' ? 'player→player' : r.kind === 'club_received' ? 'money in' : 'we paid'}
                    </span>
                    <div style={{ fontSize: 10, color: 'var(--text-faint)' }}>{r.method_name}</div>
                  </td>
                  <td style={{ fontSize: 12 }}>
                    <span className="name">{r.depositor_name ?? <em>us</em>}</span> → <span className="name">{r.payee_name ?? <em>us</em>}</span>
                    <div className="mono" style={{ fontSize: 10, color: 'var(--text-faint)' }}>{r.payout_handle}</div>
                  </td>
                  <td className="mono" style={{ fontSize: 11 }}>{r.payment_ref ?? '—'}</td>
                  <td>
                    {(r.receipts ?? []).length > 0
                      ? <a href={r.receipts[0].url} target="_blank" rel="noreferrer">
                          <img src={r.receipts[0].url} alt="receipt" className="receipt-thumb" />
                        </a>
                      : <span className="badge muted">none</span>}
                  </td>
                  <td>
                    {r.hold_until
                      ? new Date(r.hold_until) > new Date()
                        ? <span className="badge warn">until <Ago at={r.hold_until} /></span>
                        : <span className="badge muted">done</span>
                      : <span className="badge muted">—</span>}
                  </td>
                  <td><Ago at={r.created_at} /></td>
                  <td>
                    <FillActions fill={{ id: r.id, status: r.status, amount: r.amount, currency: r.currency, paymentRef: r.payment_ref, isClub: r.kind !== 'matched' }} />
                    <details className="row-detail" style={{ marginTop: 6 }}>
                      <summary>Money trail</summary>
                      {(r.ledger ?? []).length === 0
                        ? <div className="field-hint">Nothing moved yet.</div>
                        : (r.ledger as any[]).map((tx) => (
                            <div key={tx.tx_id} style={{ marginBottom: 8 }}>
                              <div className="mono" style={{ fontSize: 10, color: 'var(--text-faint)' }}>{tx.kind}</div>
                              {(tx.entries ?? []).map((e: any, i: number) => (
                                <div className="ledger-leg" key={i}>
                                  <span>{e.account_kind}</span>
                                  <span className={`amt ${e.amount > 0 ? 'pos' : 'neg'}`}>{e.amount > 0 ? '+' : ''}{(e.amount / 100).toFixed(2)}</span>
                                </div>
                              ))}
                            </div>
                          ))}
                    </details>
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

function StatusBadge({ status, escalated, disputed }: { status: string; escalated: boolean; disputed: boolean }) {
  if (disputed) return <span className="badge red">disputed</span>;
  if (escalated) return <span className="badge red">needs a look</span>;
  const map: Record<string, string> = {
    locked: 'warn', awaiting_confirmation: 'warn', released: 'ok',
    refunded: 'muted', expired: 'muted', cancelled: 'muted', disputed: 'red',
  };
  const label: Record<string, string> = {
    locked: 'not paid', awaiting_confirmation: 'checking', released: 'done',
  };
  return <span className={`badge ${map[status] ?? 'muted'}`}>{label[status] ?? status.replace(/_/g, ' ')}</span>;
}
