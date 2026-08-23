import Link from 'next/link';
import { db } from '@union/core';
import { Shell } from '../../components/shell';
import { Money, Ago } from '../../components/ui';
import { QueueActions } from './actions';

export const dynamic = 'force-dynamic';

export default async function QueuePage({
  searchParams,
}: {
  searchParams: Promise<{ method?: string }>;
}) {
  const { method } = await searchParams;
  const sql = db();
  const all = await sql<any[]>`
    select q.*,
           coalesce(case when pf.code = 'clubgg' then pp.platform_username else pp.platform_uid end, q.display_name) as account,
           cl.name as club, pf.code as platform_code, wr.min_override,
           coalesce((select sum(f.amount) from fills f where f.withdraw_id = q.id and f.status = 'released'), 0) as paid,
           coalesce((select sum(f.amount) from fills f where f.withdraw_id = q.id and f.status in ('locked', 'awaiting_confirmation')), 0) as locked
      from v_withdraw_queue q
      left join withdraw_requests wr on wr.id = q.id
      left join platforms pf on pf.id = wr.platform_id
      left join player_platforms pp on pp.player_id = q.player_id and pp.platform_id = wr.platform_id
      left join clubs cl on cl.id = pp.club_id
     order by q.method_name, q.queue_position`;

  // Filter tabs by payment method — one clean list at a time instead of every
  // method mixed together. Counts come from the full queue.
  const counts = new Map<string, number>();
  for (const r of all) counts.set(r.method_name, (counts.get(r.method_name) ?? 0) + 1);
  const methodTabs = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const active = method && counts.has(method) ? method : 'all';
  const rows = active === 'all' ? all : all.filter((r) => r.method_name === active);

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>Withdrawals</h1>
          <p className="sub">
            Strict FIFO, oldest first. Depositors fill these automatically — or the owner can clear
            one directly from the float.
          </p>
        </div>
        <a className="btn" href="/api/export?type=cashouts">⬇ Excel</a>
      </div>

      {methodTabs.length > 0 && (
        <div className="tabs" role="tablist" aria-label="Filter by payment method">
          <Link href="/queue" role="tab" aria-selected={active === 'all'} className={`tab ${active === 'all' ? 'active' : ''}`}>
            All <span style={{ opacity: 0.55 }}>{all.length}</span>
          </Link>
          {methodTabs.map(([m, c]) => (
            <Link key={m} href={`/queue?method=${encodeURIComponent(m)}`} role="tab" aria-selected={active === m}
                  className={`tab ${active === m ? 'active' : ''}`}>
              {m} <span style={{ opacity: 0.55 }}>{c}</span>
            </Link>
          ))}
        </div>
      )}

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
                // Base "owed" and progress on money actually PAID (released), never
                // on amount_remaining — a slice that's merely locked by a depositor
                // (and may expire) must not make the number jump around on refresh.
                const paid = Number(r.paid ?? 0);
                const locked = Number(r.locked ?? 0);
                const owed = r.amount - paid;
                const pct = Math.round((paid / r.amount) * 100);
                const lockedPct = Math.round((locked / r.amount) * 100);
                // Someone at the front of the queue for hours means the queue is
                // not clearing — that's the owner's cue to backstop.
                const stale = r.waiting_seconds > 3600 * 6;
                return (
                  <tr key={r.id} style={stale ? { background: 'var(--warn-dim)' } : undefined}>
                    <td className="mono">{r.queue_position}</td>
                    <td>
                      <strong>{r.account ?? r.display_name ?? '—'}</strong>
                      {[r.platform, r.club].filter(Boolean).length > 0 && (
                        <span className="badge muted" style={{ marginLeft: 6 }}>{[r.platform, r.club].filter(Boolean).join(' · ')}</span>
                      )}
                      {r.account && r.account !== r.display_name && (
                        <div style={{ fontSize: 10, color: 'var(--text-faint)' }}>{r.display_name}</div>
                      )}
                      {r.min_override && (
                        <span className="badge accent" style={{ marginTop: 4 }}>min ${(r.min_override / 100).toFixed(2)}</span>
                      )}
                    </td>
                    <td><span className="badge muted">{r.method_name}</span></td>
                    <td className="num"><Money minor={r.amount} currency={r.currency} /></td>
                    <td className="num">
                      <strong><Money minor={owed} currency={r.currency} /></strong>
                      {locked > 0 && (
                        <div className="badge warn" style={{ marginTop: 2, fontSize: 10 }}>
                          <Money minor={locked} currency={r.currency} /> being paid
                        </div>
                      )}
                    </td>
                    <td>
                      <div style={{ display: 'flex', background: 'var(--surface-2)', borderRadius: 100, height: 6, overflow: 'hidden' }}>
                        <div style={{ width: `${pct}%`, height: '100%', background: 'var(--ok)' }} />
                        <div style={{ width: `${lockedPct}%`, height: '100%', background: 'var(--warn)' }} title="in progress" />
                      </div>
                      <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>
                        {pct}% paid{lockedPct > 0 ? ` · ${lockedPct}% in progress` : ''}
                      </span>
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
                          minOverride: r.min_override ?? null,
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
