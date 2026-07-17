import { db } from '@union/core';
import { Shell } from '../../components/shell';
import { Money, Ago } from '../../components/ui';
import { QueueActions } from './actions';

export const dynamic = 'force-dynamic';

export default async function QueuePage() {
  const sql = db();
  const rows = await sql<any[]>`select * from v_withdraw_queue order by method_name, queue_position`;

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>Withdrawal queue</h1>
          <p className="sub">
            Strict FIFO, oldest first. Depositors fill these automatically — or the owner can clear
            one directly from the float.
          </p>
        </div>
        <a className="btn" href="/api/export?type=cashouts">⬇ Excel</a>
      </div>

      <div className="table-wrap">
        {rows.length === 0 ? (
          <div className="empty">Queue is empty — nobody is waiting to be paid.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 40 }}>#</th>
                <th>Player</th>
                <th style={{ width: 110 }}>Method</th>
                <th className="num" style={{ width: 90 }}>Asked</th>
                <th className="num" style={{ width: 90 }}>Still owed</th>
                <th style={{ width: 120 }}>Progress</th>
                <th>Payout handle</th>
                <th style={{ width: 80 }}>Waiting</th>
                <th style={{ width: 180 }}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const pct = Math.round(((r.amount - r.amount_remaining) / r.amount) * 100);
                // Someone at the front of the queue for hours means the queue is
                // not clearing — that's the owner's cue to backstop.
                const stale = r.waiting_seconds > 3600 * 6;
                return (
                  <tr key={r.id} style={stale ? { background: 'var(--warn-dim)' } : undefined}>
                    <td className="mono">{r.queue_position}</td>
                    <td>{r.display_name ?? '—'}</td>
                    <td><span className="badge muted">{r.method_name}</span></td>
                    <td className="num"><Money minor={r.amount} currency={r.currency} /></td>
                    <td className="num"><strong><Money minor={r.amount_remaining} currency={r.currency} /></strong></td>
                    <td>
                      <div style={{ background: 'var(--surface-2)', borderRadius: 100, height: 6, overflow: 'hidden' }}>
                        <div style={{ width: `${pct}%`, height: '100%', background: 'var(--ok)' }} />
                      </div>
                      <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>{pct}% filled</span>
                    </td>
                    <td className="mono" style={{ fontSize: 11 }}>{r.payout_handle}</td>
                    <td>
                      <Ago at={r.created_at} />
                      {stale && <div className="badge warn" style={{ marginTop: 2 }}>slow</div>}
                    </td>
                    <td>
                      <QueueActions
                        w={{
                          id: r.id,
                          remaining: r.amount_remaining,
                          currency: r.currency,
                          handle: r.payout_handle,
                          name: r.display_name ?? 'player',
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </Shell>
  );
}
