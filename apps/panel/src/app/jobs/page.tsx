import { db } from '@union/core';
import { Shell } from '../../components/shell';
import { Money, Ago } from '../../components/ui';
import { JobRow } from './row';

export const dynamic = 'force-dynamic';

interface Job {
  id: string; player_id: string; player_name: string; platform_uid: string;
  platform: string; club_name: string | null; account: string | null; delta: number; currency: string;
  reason: string; status: string; claimed_by: string | null;
  claimed_by_email: string | null; claimed_at: string | null; created_at: string; stale: boolean;
  is_discord: boolean;
}
interface PayJob { id: string; name: string | null; amount: number; currency: string; platform: string; method: string; handle: string | null; created_at: string; is_discord: boolean; }
interface VerifyJob { id: string; name: string | null; amount: number; currency: string; method: string; money_in: boolean; created_at: string; is_discord: boolean; }

/** Which bot the player is on: a discord_players row means Discord, else Telegram. */
function Via({ discord }: { discord: boolean }) {
  return <span className="badge muted">{discord ? '💬 Discord' : '📱 Telegram'}</span>;
}

/** "account [platform · club]" — the ClubGG/Sportsbook account, its platform, and
 *  club, exactly like the bot cards. */
function PlayerCell({ j }: { j: Job }) {
  const tag = [j.platform, j.club_name].filter(Boolean).join(' · ');
  return (
    <div>
      <strong>{j.account ?? j.player_name}</strong>
      {tag && <span className="badge muted" style={{ marginLeft: 6 }}>{tag}</span>}
      {j.account && j.account !== j.player_name && (
        <div style={{ fontSize: 10, color: 'var(--text-faint)' }}>{j.player_name}</div>
      )}
    </div>
  );
}

export default async function JobsPage() {
  const sql = db();

  const jobs = await sql<Job[]>`
    select lo.id, lo.player_id, lo.player_name, lo.platform_uid,
           pf.name as platform, c.name as club_name,
           coalesce(case when pf.code = 'clubgg' then pp.platform_username else pp.platform_uid end, lo.player_name) as account,
           lo.delta, lo.currency, lo.reason, lo.status,
           lo.claimed_by, a.email as claimed_by_email, lo.claimed_at, lo.created_at,
           (lo.status='claimed' and lo.claimed_at < now() - interval '15 minutes') as stale,
           exists(select 1 from discord_players x where x.player_id = lo.player_id) as is_discord
      from loader_orders lo
      left join platforms pf on pf.id = lo.platform_id
      left join clubs c on c.id = lo.club_id
      left join player_platforms pp on pp.player_id = lo.player_id and pp.platform_id = lo.platform_id
      left join admins a on a.id = lo.claimed_by
     where lo.status in ('pending','claimed')
     order by lo.created_at limit 100`;

  const recent = await sql<Job[]>`
    select lo.id, lo.player_name, lo.platform_uid, pf.name as platform,
           '' as club_name, coalesce(lo.actual_delta, lo.delta) as delta,
           lo.currency, lo.reason, lo.status, null as claimed_by, null as claimed_by_email,
           null as claimed_at, lo.created_at, false as stale
      from loader_orders lo left join platforms pf on pf.id = lo.platform_id
     where lo.status in ('done','failed','cancelled')
     order by lo.done_at desc nulls last limit 20`;

  // Cash-outs waiting to be paid (the "cash-out to pay" cards in the bots).
  const toPay = await sql<PayJob[]>`
    select q.id, q.display_name as name, q.amount_remaining as amount, q.currency,
           q.platform, q.method_name as method, q.payout_handle as handle, q.created_at,
           exists(select 1 from discord_players x where x.player_id = q.player_id) as is_discord
      from v_withdraw_queue q order by q.created_at limit 100`;

  // Payments waiting to be verified (the "payment to verify — Verify/Discard" cards).
  const toVerify = await sql<VerifyJob[]>`
    select f.id, coalesce(dp.display_name, wp.display_name) as name, f.amount, f.currency,
           pm.name as method, (f.withdraw_id is null) as money_in, f.submitted_at as created_at,
           exists(select 1 from discord_players x where x.player_id = coalesce(d.player_id, w.player_id)) as is_discord
      from fills f
      join payment_methods pm on pm.id = f.method_id
      left join deposit_requests d on d.id = f.deposit_id
      left join players dp on dp.id = d.player_id
      left join withdraw_requests w on w.id = f.withdraw_id
      left join players wp on wp.id = w.player_id
     where f.status = 'awaiting_confirmation' order by f.submitted_at limit 100`;

  const stale = jobs.filter((j) => j.stale).length;
  const nothing = jobs.length === 0 && toPay.length === 0 && toVerify.length === 0;

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>Jobs</h1>
          <p className="sub">Add money to a player's table, or take it off. Claim one, do it, then say what actually moved.</p>
        </div>
        <a className="btn" href="/api/export?type=jobs">⬇ Excel</a>
      </div>

      {stale > 0 && (
        <div className="alert warn">
          ⚠️ {stale} job{stale > 1 ? 's have' : ' has'} been claimed for over 15 minutes — check they're actually being done.
        </div>
      )}

      {nothing && <div className="table-wrap"><div className="empty">Nothing to do right now. 🎉</div></div>}

      {toPay.length > 0 && (
        <>
          <h2>Cash-outs to pay ({toPay.length})</h2>
          <div className="table-wrap">
            <table>
              <thead><tr>
                <th className="num" style={{ width: 110 }}>Amount</th><th>Player</th>
                <th style={{ width: 90 }}>Platform</th><th>Method</th><th>Send to</th>
                <th style={{ width: 120 }}>Via</th><th style={{ width: 70 }}>Age</th>
              </tr></thead>
              <tbody>
                {toPay.map((j) => (
                  <tr key={j.id}>
                    <td className="num"><Money minor={j.amount} currency={j.currency} /></td>
                    <td><strong>{j.name ?? '—'}</strong></td>
                    <td>{j.platform}</td>
                    <td><span className="badge muted">{j.method}</span></td>
                    <td className="mono" style={{ fontSize: 11 }}>{j.handle ?? '—'}</td>
                    <td><Via discord={j.is_discord} /></td>
                    <td><Ago at={j.created_at} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {toVerify.length > 0 && (
        <>
          <h2>Payments to verify ({toVerify.length})</h2>
          <div className="table-wrap">
            <table>
              <thead><tr>
                <th className="num" style={{ width: 110 }}>Amount</th><th>Player</th>
                <th>Method</th><th style={{ width: 120 }}>Direction</th>
                <th style={{ width: 120 }}>Via</th><th style={{ width: 70 }}>Age</th>
              </tr></thead>
              <tbody>
                {toVerify.map((j) => (
                  <tr key={j.id}>
                    <td className="num"><Money minor={j.amount} currency={j.currency} /></td>
                    <td><strong>{j.name ?? '—'}</strong></td>
                    <td><span className="badge muted">{j.method}</span></td>
                    <td><span className={`badge ${j.money_in ? 'ok' : 'warn'}`}>{j.money_in ? 'money in' : 'cash-out'}</span></td>
                    <td><Via discord={j.is_discord} /></td>
                    <td><Ago at={j.created_at} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {jobs.length > 0 && (
        <>
          <h2>Add / take off chips ({jobs.length})</h2>
          <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 100 }}>Action</th>
                <th className="num" style={{ width: 100 }}>Amount</th>
                <th>Player</th>
                <th>ID</th>
                <th style={{ width: 90 }}>Where</th>
                <th style={{ width: 120 }}>Via</th>
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
                  <td><PlayerCell j={j} /></td>
                  <td className="mono"><strong>{j.platform_uid}</strong></td>
                  <td>{j.platform}</td>
                  <td><Via discord={j.is_discord} /></td>
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
          </div>
        </>
      )}

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
