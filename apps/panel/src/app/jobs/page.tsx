import { db } from '@union/core';
import { Shell } from '../../components/shell';
import { Money, Ago } from '../../components/ui';
import { JobRow } from './row';

export const dynamic = 'force-dynamic';

interface Job {
  id: string; player_id: string; player_name: string; platform_uid: string;
  platform: string; club_name: string; delta: number; currency: string;
  reason: string; status: string; claimed_by: string | null;
  claimed_by_email: string | null; claimed_at: string | null; created_at: string; stale: boolean;
}

export default async function JobsPage() {
  const sql = db();

  const jobs = await sql<Job[]>`
    select lo.id, lo.player_id, lo.player_name, lo.platform_uid,
           pf.name as platform, c.name as club_name,
           lo.delta, lo.currency, lo.reason, lo.status,
           lo.claimed_by, a.email as claimed_by_email, lo.claimed_at, lo.created_at,
           (lo.status='claimed' and lo.claimed_at < now() - interval '15 minutes') as stale
      from loader_orders lo
      join platforms pf on pf.id = lo.platform_id
      join clubs c on c.id = lo.club_id
      left join admins a on a.id = lo.claimed_by
     where lo.status in ('pending','claimed')
     order by lo.created_at limit 100`;

  const recent = await sql<Job[]>`
    select lo.id, lo.player_name, lo.platform_uid, pf.name as platform,
           '' as club_name, coalesce(lo.actual_delta, lo.delta) as delta,
           lo.currency, lo.reason, lo.status, null as claimed_by, null as claimed_by_email,
           null as claimed_at, lo.created_at, false as stale
      from loader_orders lo join platforms pf on pf.id = lo.platform_id
     where lo.status in ('done','failed','cancelled')
     order by lo.done_at desc nulls last limit 20`;

  const stale = jobs.filter((j) => j.stale).length;

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>Jobs</h1>
          <p className="sub">Add money to a player's table, or take it off. Claim one, do it, then say what actually moved.</p>
        </div>
      </div>

      {stale > 0 && (
        <div className="alert warn">
          ⚠️ {stale} job{stale > 1 ? 's have' : ' has'} been claimed for over 15 minutes — check they're actually being done.
        </div>
      )}

      <div className="table-wrap">
        {jobs.length === 0 ? (
          <div className="empty">Nothing to do right now. 🎉</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 100 }}>Action</th>
                <th className="num" style={{ width: 100 }}>Amount</th>
                <th>Player</th>
                <th>ID</th>
                <th style={{ width: 90 }}>Where</th>
                <th style={{ width: 100 }}>Status</th>
                <th style={{ width: 70 }}>Age</th>
                <th style={{ width: 260 }} />
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} style={j.stale ? { background: 'var(--warn-dim)' } : undefined}>
                  <td>
                    <span className={`badge ${j.delta > 0 ? 'ok' : 'red'}`}>
                      {j.delta > 0 ? '↓ ADD' : '↑ TAKE OFF'}
                    </span>
                  </td>
                  <td className="num"><Money minor={Math.abs(j.delta)} currency={j.currency} /></td>
                  <td className="name">{j.player_name}</td>
                  <td className="mono"><strong>{j.platform_uid}</strong></td>
                  <td>{j.platform}</td>
                  <td>
                    {j.status === 'pending'
                      ? <span className="badge muted">open</span>
                      : <span className={`badge ${j.stale ? 'red' : 'warn'}`}>{j.stale ? 'STALE' : 'claimed'}</span>}
                    {j.claimed_by_email && (
                      <div className="mono" style={{ fontSize: 10, color: 'var(--text-faint)' }}>{j.claimed_by_email.split('@')[0]}</div>
                    )}
                  </td>
                  <td><Ago at={j.created_at} /></td>
                  <td><JobRow job={{ id: j.id, delta: j.delta, status: j.status, name: j.player_name, uid: j.platform_uid }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2>Recently done</h2>
      <div className="table-wrap">
        {recent.length === 0 ? (
          <div className="empty">Nothing yet.</div>
        ) : (
          <table>
            <thead>
              <tr><th style={{ width: 100 }}>Action</th><th className="num" style={{ width: 100 }}>Amount</th><th>Player</th><th style={{ width: 100 }}>Status</th></tr>
            </thead>
            <tbody>
              {recent.map((j) => (
                <tr key={j.id}>
                  <td><span className="badge muted">{j.delta > 0 ? 'ADD' : 'TAKE OFF'}</span></td>
                  <td className="num"><Money minor={Math.abs(j.delta)} currency={j.currency} /></td>
                  <td className="name">{j.player_name} <span className="mono" style={{ fontSize: 10, color: 'var(--text-faint)' }}>{j.platform_uid}</span></td>
                  <td><span className={`badge ${j.status === 'done' ? 'ok' : j.status === 'failed' ? 'red' : 'muted'}`}>{j.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Shell>
  );
}
