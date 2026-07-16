import { db } from '@union/core';
import { Shell } from '../../components/shell';
import { Ago } from '../../components/ui';

export const dynamic = 'force-dynamic';

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; admin?: string }>;
}) {
  const { q, admin } = await searchParams;
  const sql = db();

  const filters = [
    q ? sql`and (l.action ilike ${'%' + q + '%'} or l.detail::text ilike ${'%' + q + '%'})` : sql``,
    admin ? sql`and l.admin_id = ${admin}::uuid` : sql``,
  ];

  const rows = await sql<any[]>`
    select l.*, a.email, a.role
      from audit_log l
      left join admins a on a.id = l.admin_id
     where true ${filters[0]} ${filters[1]}
     order by l.created_at desc
     limit 200`;

  const admins = await sql<any[]>`select id, email from admins order by email`;

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>Audit log</h1>
          <p className="sub">
            Every admin action, permanently. This table is append-only — the database rejects
            UPDATE and DELETE on it, including from an admin with full DB access.
          </p>
        </div>
        <form className="btn-row">
          <select name="admin" defaultValue={admin ?? ''} style={{ width: 180 }}>
            <option value="">All admins</option>
            {admins.map((a) => <option key={a.id} value={a.id}>{a.email}</option>)}
          </select>
          <input name="q" defaultValue={q ?? ''} placeholder="Search action or detail…" style={{ width: 200 }} />
          <button type="submit">Filter</button>
        </form>
      </div>

      <div className="table-wrap">
        {rows.length === 0 ? (
          <div className="empty">Nothing logged yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 70 }}>When</th>
                <th style={{ width: 180 }}>Who</th>
                <th style={{ width: 190 }}>Action</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><Ago at={r.created_at} /></td>
                  <td>
                    {r.email ? (
                      <>
                        {r.email}
                        {r.role === 'owner' && <span className="badge info" style={{ marginLeft: 4 }}>owner</span>}
                      </>
                    ) : (
                      // Automated actions are logged too: "nobody did it, the
                      // clock did" is still an answer the log owes.
                      <span className="badge muted">system</span>
                    )}
                  </td>
                  <td className="mono" style={{ fontSize: 11 }}>{r.action}</td>
                  <td>
                    <details className="row-detail">
                      <summary>{summarise(r)}</summary>
                      <pre className="mono" style={{ fontSize: 10, whiteSpace: 'pre-wrap', margin: 0 }}>
                        {JSON.stringify(r.detail, null, 2)}
                      </pre>
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

function summarise(r: any): string {
  const d = r.detail ?? {};
  const money = (v: unknown) => `$${(Number(v ?? 0) / 100).toFixed(2)}`;
  switch (r.action) {
    case 'fill.release': return `${money(d.amount)} released — ${d.reason}`;
    case 'fill.fast_path_confirm': return `verified ref ${d.payment_ref} — ${money(d.amount)}`;
    case 'fill.reversal': return `⚠️ ${money(d.amount)} reversed — ${d.reason}`;
    case 'dispute.resolve': return `${d.resolution}${d.flagged_depositor ? ' + flagged depositor' : ''}`;
    case 'player.link': return `linked ClubGG ${d.clubgg_id}${d.overridden ? ' (corrected)' : ''}`;
    case 'chip_order.done': return `${Number(d.ordered) > 0 ? 'loaded' : 'unloaded'} ${money(Math.abs(Number(d.actual)))}`;
    case 'withdraw.owner_payout': return `paid ${money(d.amount)} from float`;
    case 'admin.adjust': return `${money(d.amount)} → ${d.kind} — ${d.reason}`;
    case 'config.update': return `changed: ${(d.changed ?? []).join(', ')}`;
    default: return Object.keys(d).length ? `${Object.keys(d).slice(0, 3).join(', ')}…` : '—';
  }
}
