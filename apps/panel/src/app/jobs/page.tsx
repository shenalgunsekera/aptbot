import type { ReactNode } from 'react';
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
interface HeldJob { id: string; order_id: string; name: string; amount: number; currency: string; method: string; created_at: string; order_status: string; topup_amount: number; is_discord: boolean; }

type Tone = 'muted' | 'accent' | 'warn' | 'red' | 'ok';
interface Reminder { key: string; tone: Tone; type: string; what: string; amount: number | null; currency: string; who: string; at: string; via: boolean; }

const usd = (minor: number, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(minor / 100);

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

/** A collapsible section with a live count "ping". Native <details> so it works
 *  without client JS, and stays keyboard- and screen-reader-friendly. */
function Section({ title, sub, count, tone = 'muted', open, children }: {
  title: string; sub?: string; count: number; tone?: Tone; open?: boolean; children: ReactNode;
}) {
  return (
    <details className="job-sec" open={open}>
      <summary>
        <span className="job-sec-title">
          {title}{sub && <span className="job-sec-sub"> — {sub}</span>}
        </span>
        <span className={`ping ${tone}`}>{count}</span>
      </summary>
      <div className="job-sec-body">{children}</div>
    </details>
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

  // Cash-outs that are FULLY PAID but held open by an add-on take-off nobody has
  // worked (the /addtowithdraw loose end). Surfaced here — never auto-expired —
  // so an owner decides: work the add-on, or fail that job to close the cash-out.
  const heldOpen = await sql<HeldJob[]>`
    select w.id, o.id as order_id, coalesce(pl.display_name, '—') as name,
           w.amount, w.currency, coalesce(pm.name, '—') as method, w.created_at,
           o.status as order_status, abs(o.delta) as topup_amount,
           exists(select 1 from discord_players x where x.player_id = w.player_id) as is_discord
      from withdraw_requests w
      join players pl on pl.id = w.player_id
      left join payment_methods pm on pm.id = w.method_id
      join loader_orders o on o.ref_type = 'withdraw_request' and o.ref_id = w.id
           and o.reason = 'withdraw.topup' and o.status in ('pending','claimed')
     where w.status in ('queued','partially_filled','filled')
       and coalesce(w.amount_remaining, 0) <= 0
       and not exists (select 1 from fills f
                        where f.withdraw_id = w.id
                          and f.status in ('locked','awaiting_confirmation','disputed'))
     order by w.created_at`;

  // ── Build the "Reminders" list — loose ends that get lost in the main lists ──
  const now = Date.now();
  const H = 3_600_000;
  const olderThan = (t: string | null | undefined, hrs: number) =>
    t ? now - new Date(t).getTime() > hrs * H : false;

  const reminders: Reminder[] = [];
  const heldOrderIds = new Set(heldOpen.map((h) => h.order_id));

  for (const h of heldOpen) {
    reminders.push({
      key: `held-${h.id}`, tone: 'warn', type: 'Add-on holding it open',
      what: `Paid in full, but a ${usd(h.topup_amount, h.currency)} add-on job (${h.order_status}) is keeping it open — finish that job, or mark it "Couldn't do it", to close this cash-out.`,
      amount: h.amount, currency: h.currency, who: h.name, at: h.created_at, via: h.is_discord,
    });
  }

  for (const j of jobs) {
    if (heldOrderIds.has(j.id)) continue;  // already shown as a held-open cash-out
    const isReload = (j.reason || '').includes('reload');
    const who = j.account ?? j.player_name;
    if (j.stale) {
      reminders.push({
        key: `sc-${j.id}`, tone: 'red', type: 'Claimed, not finished',
        what: `Claimed by ${j.claimed_by_email?.split('@')[0] ?? 'someone'} over 15 min ago and still not done — check it's actually happening or put it back.`,
        amount: Math.abs(j.delta), currency: j.currency, who, at: j.claimed_at ?? j.created_at, via: j.is_discord,
      });
    } else if (isReload && olderThan(j.created_at, 2)) {
      reminders.push({
        key: `rl-${j.id}`, tone: 'warn', type: 'Chips owed back',
        what: `A re-load onto the player's table is still ${j.status} — they're waiting to get chips put back.`,
        amount: Math.abs(j.delta), currency: j.currency, who, at: j.created_at, via: j.is_discord,
      });
    } else if (j.status === 'pending' && olderThan(j.created_at, 6)) {
      reminders.push({
        key: `ap-${j.id}`, tone: 'warn', type: 'Waiting for a loader',
        what: `Unclaimed ${j.delta > 0 ? 'add' : 'take-off'} sitting for hours — nobody has picked it up.`,
        amount: Math.abs(j.delta), currency: j.currency, who, at: j.created_at, via: j.is_discord,
      });
    }
  }

  for (const p of toPay) {
    if (p.amount < 2000 && olderThan(p.created_at, 2)) {
      reminders.push({
        key: `sm-${p.id}`, tone: 'muted', type: 'Small cash-out waiting',
        what: `${usd(p.amount, p.currency)} via ${p.method} still unpaid — a small leftover the queue isn't clearing. Pay it from the float to close it out.`,
        amount: p.amount, currency: p.currency, who: p.name ?? '—', at: p.created_at, via: p.is_discord,
      });
    }
  }

  const rank: Record<Tone, number> = { red: 0, warn: 1, accent: 2, ok: 3, muted: 4 };
  reminders.sort((a, b) => rank[a.tone] - rank[b.tone] || new Date(a.at).getTime() - new Date(b.at).getTime());

  const nothing = jobs.length === 0 && toPay.length === 0 && toVerify.length === 0 && reminders.length === 0;
  // Big lists open collapsed so the page reads as a short stack of headers; small
  // ones open expanded so there's nothing to click when there's little to do.
  const OPEN_UNDER = 8;

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>Jobs</h1>
          <p className="sub">Everything waiting on someone, grouped. Tap a section to open it — the number is how many are inside.</p>
        </div>
        <a className="btn" href="/api/export?type=jobs">⬇ Excel</a>
      </div>

      {nothing && <div className="table-wrap"><div className="empty">Nothing to do right now. 🎉</div></div>}

      {reminders.length > 0 && (
        <Section title="⚠️ Reminders" sub="loose ends that need a human" count={reminders.length} tone="warn" open>
          <div className="table-wrap">
            <table>
              <thead><tr>
                <th style={{ width: 190 }}>What</th><th>Detail</th>
                <th className="num" style={{ width: 100 }}>Amount</th><th style={{ width: 160 }}>Player</th>
                <th style={{ width: 70 }}>Age</th>
              </tr></thead>
              <tbody>
                {reminders.map((r) => (
                  <tr key={r.key}>
                    <td><span className={`badge ${r.tone}`}>{r.type}</span></td>
                    <td style={{ fontSize: 12, color: 'var(--text-dim)' }}>{r.what}</td>
                    <td className="num">{r.amount != null ? <Money minor={r.amount} currency={r.currency} /> : '—'}</td>
                    <td><strong>{r.who}</strong> <Via discord={r.via} /></td>
                    <td><Ago at={r.at} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {toPay.length > 0 && (
        <Section title="Cash-outs to pay" count={toPay.length} tone="accent" open={toPay.length <= OPEN_UNDER}>
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
        </Section>
      )}

      {toVerify.length > 0 && (
        <Section title="Payments to verify" count={toVerify.length} tone="accent" open={toVerify.length <= OPEN_UNDER}>
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
        </Section>
      )}

      {jobs.length > 0 && (
        <Section title="Add / take off chips" count={jobs.length} tone="accent" open={jobs.length <= OPEN_UNDER}>
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
        </Section>
      )}

      {recent.length > 0 && (
        <Section title="Recently done" count={recent.length} tone="muted">
          <div className="table-wrap">
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
          </div>
        </Section>
      )}
    </Shell>
  );
}
