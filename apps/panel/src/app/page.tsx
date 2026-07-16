import Link from 'next/link';
import { db } from '@union/core';
import { Shell } from '../components/shell';
import { Money, Ago } from '../components/ui';

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

export default async function Overview() {
  const sql = db();
  const floats = await sql<Float[]>`select * from v_float_position`;
  const inbox = await sql<InboxRow[]>`select * from v_admin_inbox order by priority, created_at limit 30`;
  const problems = await sql<{ problem: string; detail: any }[]>`select * from ledger_verify()`;

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
