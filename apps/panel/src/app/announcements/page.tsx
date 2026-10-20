import { redirect } from 'next/navigation';
import { db } from '@union/core';
import { Shell } from '../../components/shell';
import { Ago } from '../../components/ui';
import { getSession } from '../../lib/auth';
import { Composer } from './composer';
import { AutoRefresh, ReuseButton } from './live';
import { loadExclusionLists } from '../../lib/announce-data';

export const dynamic = 'force-dynamic';
// The send action pushes the first wave of messages before returning.
export const maxDuration = 60;

/**
 * Announcements: write once, deliver to every registered player in THEIR chat
 * (Telegram chat or Discord ticket) — because players read their tickets, not
 * announcement channels. Below the composer, every past send with live delivery
 * counts.
 */
type Row = {
  id: string; title: string | null; body: string; images: string[]; buttons: { label: string; url: string }[];
  reel: string | null; link_preview: boolean; audience: string; is_test: boolean; recipients: number;
  created_at: string; by: string | null; delivered: number; failed: number; pending: number; last_error: string | null;
  excluded: number; excluded_lists: string[];
};

const AUDIENCE: Record<string, string> = { all: 'Everyone', telegram: 'Telegram', discord: 'Discord' };

export default async function AnnouncementsPage() {
  if (!(await getSession())) redirect('/login');
  const sql = db();

  const [counts, history, lists] = await Promise.all([
    sql<{ platform: string; n: number }[]>`
      select platform, count(*)::int as n from announcement_targets('all', false, false) group by platform`,
    sql<Row[]>`
      select a.id, a.title, a.body, a.images, a.buttons, a.reel, a.link_preview, a.audience, a.is_test,
             a.recipients, a.created_at, coalesce(ad.display_name, ad.email) as by,
             cardinality(a.excluded_players)::int as excluded, a.excluded_lists,
             count(n.id) filter (where n.status = 'sent')::int    as delivered,
             count(n.id) filter (where n.status = 'failed')::int  as failed,
             count(n.id) filter (where n.status = 'pending')::int as pending,
             max(n.last_error) filter (where n.status = 'failed') as last_error
        from announcements a
        left join admins ad on ad.id = a.created_by
        left join notifications n on n.ref_type = 'announcement' and n.ref_id = a.id
       where a.sent_at is not null
       group by a.id, ad.display_name, ad.email
       order by a.created_at desc
       limit 40`,
    loadExclusionLists(),
  ]);
  const initialCounts = {
    telegram: counts.find((c) => c.platform === 'telegram')?.n ?? 0,
    discord: counts.find((c) => c.platform === 'discord')?.n ?? 0,
  };
  const sending = history.some((h) => h.pending > 0);

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>Announcements</h1>
          <p className="sub">
            Message every registered player at once — it lands in their own chat (Telegram or their Discord ticket),
            where they actually read it. Payment messages always go out first, so a big send never slows them down.
          </p>
        </div>
      </div>

      <Composer initialCounts={initialCounts} lists={lists} />

      <h2>Sent</h2>
      <AutoRefresh active={sending} />
      {history.length === 0 ? (
        <div className="card empty">Nothing sent yet. Your announcements and their delivery will show up here.</div>
      ) : (
        <div className="card table-wrap" style={{ padding: 0 }}>
          <table>
            <thead><tr>
              <th style={{ width: 90 }}>When</th>
              <th>Announcement</th>
              <th style={{ width: 100 }}>To</th>
              <th style={{ width: 210 }}>Delivery</th>
              <th style={{ width: 120 }}>By</th>
              <th style={{ width: 90 }} />
            </tr></thead>
            <tbody>
              {history.map((h) => {
                const done = h.delivered + h.failed;
                const pct = h.recipients ? Math.round((done / h.recipients) * 100) : 0;
                const first = (h.title || h.body || '').split('\n')[0]!.replace(/\*\*|__|~~|\|\||`/g, '');
                return (
                  <tr key={h.id}>
                    <td><Ago at={h.created_at} /></td>
                    <td>
                      <div className="ann-hist-title">
                        {h.is_test && <span className="badge muted">Test</span>}
                        <strong>{first.length > 90 ? first.slice(0, 90) + '…' : (first || '(images only)')}</strong>
                      </div>
                      <div className="ann-hist-tags">
                        {h.images.length > 0 && <span>🖼 {h.images.length}</span>}
                        {h.reel && <span>▶️ reel</span>}
                        {h.buttons.length > 0 && <span>🔘 {h.buttons.length}</span>}
                        {h.excluded > 0 && (
                          <span title={h.excluded_lists.length ? `Lists: ${h.excluded_lists.join(', ')}` : undefined}>
                            🚫 {h.excluded} left out{h.excluded_lists.length ? ` (${h.excluded_lists.join(', ')})` : ''}
                          </span>
                        )}
                      </div>
                    </td>
                    <td>{h.is_test ? 'Admin group' : AUDIENCE[h.audience] ?? h.audience}</td>
                    <td>
                      <div className="ann-progress" aria-label={`${pct}% delivered`}><span style={{ width: `${pct}%` }} /></div>
                      <div className="ann-hist-stats">
                        <span className="ok">{h.delivered.toLocaleString()} delivered</span>
                        {h.pending > 0 && <span>{h.pending.toLocaleString()} sending…</span>}
                        {h.failed > 0 && (
                          <span className="err" title={h.last_error ?? undefined}>
                            {h.failed.toLocaleString()} couldn&apos;t be reached
                          </span>
                        )}
                        <span className="muted">of {h.recipients.toLocaleString()}</span>
                      </div>
                    </td>
                    <td className="ann-by">{h.by ?? '—'}</td>
                    <td>
                      <ReuseButton draft={{
                        title: h.title ?? '', body: h.body, images: h.images, buttons: h.buttons,
                        reel: h.reel ?? '', preview: h.link_preview,
                      }} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="field-hint" style={{ marginTop: 10 }}>
        &ldquo;Couldn&apos;t be reached&rdquo; is usually a player who blocked the bot or whose ticket was deleted — hover it for the reason.
      </p>
    </Shell>
  );
}
