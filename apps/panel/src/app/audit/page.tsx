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
          <a className="btn" href="/api/export?type=audit">⬇ Excel</a>
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
                        {r.role === 'owner' && <span className="badge accent" style={{ marginLeft: 4 }}>owner</span>}
                      </>
                    ) : (
                      // Automated actions are logged too: "nobody did it, the
                      // clock did" is still an answer the log owes.
                      <span className="badge muted">system</span>
                    )}
                  </td>
                  <td title={r.action}>
                    <span style={{ fontWeight: 600 }}>{actionLabel(r.action)}</span>
                  </td>
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

/** Plain-English name for each logged action code. */
const ACTION_LABELS: Record<string, string> = {
  'fill.release': 'Released money', 'fill.admin_verify': 'Verified a payment',
  'fill.fast_path_confirm': 'Verified a payment', 'fill.discard': 'Discarded a payment',
  'fill.reversal': 'Reversed a payment', 'fill.escalated': 'Escalated a payment',
  'fill.payee_confirmed': 'Payee confirmed', 'fill.lock_expired': 'Payment window expired',
  'loader.claim': 'Claimed a job', 'loader.done': 'Completed a job',
  'loader.fail': 'Failed a job', 'loader.release': 'Put a job back',
  'withdraw.club_payout': 'Paid a cash-out', 'withdraw.owner_payout': 'Paid a cash-out from float',
  'withdraw.pause': 'Paused a cash-out', 'withdraw.resume': 'Resumed a cash-out',
  'withdraw.adjust': 'Adjusted a cash-out', 'withdraw.reduce': 'Reduced a cash-out',
  'withdraw.cancel': 'Cancelled a cash-out', 'deposit.cancel': 'Cancelled a deposit',
  'withdraw.reorder': 'Moved a cash-out in the queue', 'withdraw.set_min': 'Set a cash-out minimum',
  'dispute.open': 'Opened a dispute', 'dispute.resolve': 'Resolved a dispute',
  'player.link': 'Linked a player account', 'player.rename': 'Renamed a player',
  'player.set_club': 'Assigned a club', 'player.set_status': 'Changed player status',
  'player.flag': 'Flagged a player', 'player.delete': 'Deleted a player',
  'player.edit_account': 'Edited a player account',
  'admin.adjust': 'Manual adjustment', 'admin.upsert': 'Added / updated an admin',
  'admin.sign_in': 'Signed in', 'admin.firebase_bound': 'Linked panel login',
  'config.update': 'Changed settings', 'config.admin_group_set': 'Set the admin group',
  'config.payments_channel_set': 'Set the payments channel', 'config.discord_channel_set': 'Set a Discord channel',
  'method.backstop': 'Set a backstop handle', 'method.disable': 'Disabled a method',
  'method.delete': 'Removed a method', 'platform.disable': 'Disabled a platform',
  'platform.delete': 'Removed a platform', 'club.create': 'Added a club', 'club.update': 'Updated a club',
  'stripe.discard': 'Discarded a card payment',
};
function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action.replace(/[._]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** One-line, human-readable detail — pulls the fields that matter, in plain words. */
function summarise(r: any): string {
  const d = r.detail ?? {};
  const money = (v: unknown) => `$${(Math.abs(Number(v ?? 0)) / 100).toFixed(2)}`;
  const who = d.player_name ?? d.name ?? d.account ?? null;

  switch (r.action) {
    case 'dispute.resolve': return `${d.resolution ?? 'resolved'}${d.flagged_depositor ? ' + flagged depositor' : ''}`;
    case 'player.link': return `linked ClubGG ${d.clubgg_id ?? d.uid ?? ''}${d.overridden ? ' (corrected)' : ''}`;
    case 'config.update': return (d.changed?.length) ? `changed: ${(d.changed as string[]).join(', ')}` : 'settings changed';
    case 'loader.done': return `${Number(d.actual ?? d.delta ?? 0) >= 0 ? 'added' : 'took off'} ${money(d.actual ?? d.delta)}${who ? ` · ${who}` : ''}`;
    case 'loader.claim': return `${money(d.delta)}${who ? ` · ${who}` : ''}`;
    case 'loader.fail': return `${who ? who + ' — ' : ''}${d.reason ?? 'failed'}`;
    case 'withdraw.reorder': return d.direction === 'up' ? 'moved up one place' : 'moved down one place';
    case 'withdraw.set_min': return d.min ? `minimum raised to ${money(d.min)}` : 'minimum reset to default';
  }

  // Generic: amount / who / reference / reason, whichever are present.
  const parts: string[] = [];
  if (d.amount != null) parts.push(money(d.amount));
  else if (d.delta != null) parts.push(`${Number(d.delta) >= 0 ? '+' : '−'}${money(d.delta)}`);
  if (who) parts.push(`· ${who}`);
  if (d.payment_ref) parts.push(`ref ${d.payment_ref}`);
  if (d.reason && !/^[a-z_]+$/.test(String(d.reason))) parts.push(`— ${d.reason}`);
  return parts.length ? parts.join(' ') : '—';
}
