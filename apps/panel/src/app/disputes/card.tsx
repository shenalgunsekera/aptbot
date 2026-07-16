'use client';

import { useState, useTransition } from 'react';
import { Money } from '../../components/ui';
import { resolveDispute } from '../../lib/actions';

type Resolution = 'release_to_depositor' | 'refund_to_payee' | 'split';

/**
 * The arbitration view.
 *
 * The money ruling and the risk ruling are separate controls on purpose: the
 * most common real outcome is "refund the victim AND flag the scammer", and a
 * single dropdown cannot express that.
 */
export function DisputeCard({ row }: { row: any }) {
  const [resolution, setResolution] = useState<Resolution>('refund_to_payee');
  const [note, setNote] = useState('');
  const [split, setSplit] = useState('');
  const [flagDep, setFlagDep] = useState(false);
  const [flagWd, setFlagWd] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = () => {
    const splitMinor = resolution === 'split' ? Math.round(parseFloat(split) * 100) : null;
    if (resolution === 'split' && (!Number.isFinite(splitMinor!) || splitMinor! < 0 || splitMinor! > row.amount)) {
      setMsg(`Split must be between 0 and ${(row.amount / 100).toFixed(2)}.`);
      return;
    }
    if (!note.trim()) { setMsg('A ruling needs a reason — it goes in the audit log.'); return; }

    const summary =
      resolution === 'release_to_depositor' ? `RELEASE ${(row.amount / 100).toFixed(2)} to the depositor as chips.`
      : resolution === 'refund_to_payee' ? `REFUND: the recipient's cash out goes back in line, depositor gets nothing.`
      : `SPLIT: ${(splitMinor! / 100).toFixed(2)} to the depositor, the rest back to the recipient.`;

    if (!window.confirm(`${summary}\n\nThis moves real money and cannot be undone.`)) return;

    setMsg(null);
    start(async () => {
      const r = await resolveDispute(row.id, resolution, note, splitMinor, flagDep, flagWd);
      setMsg(r.ok ? null : r.error);
    });
  };

  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <span className="badge danger">DISPUTED</span>{' '}
          <strong style={{ fontSize: 17 }}><Money minor={row.amount} currency={row.currency} /></strong>{' '}
          <span className="badge muted">{row.method_name}</span>{' '}
          {row.reversibility === 'reversible' && <span className="badge warn">reversible</span>}
        </div>
        <div className="mono" style={{ fontSize: 11, color: 'var(--text-faint)' }}>
          fill {String(row.fill_id).slice(0, 8)}
        </div>
      </div>

      <p style={{ margin: '10px 0', fontStyle: 'italic', color: 'var(--text-dim)' }}>
        “{row.reason}”
        <span style={{ fontSize: 11 }}> — opened by {row.opened_by_player ? 'the recipient' : 'an admin'}</span>
      </p>

      {/* Evidence, ordered by how much it is worth. */}
      <div className="card" style={{ background: 'var(--surface-2)', marginBottom: 12 }}>
        <div className="stat-label" style={{ marginBottom: 6 }}>Primary evidence</div>
        <dl className="kv">
          <dt>Payment ref</dt>
          <dd><strong style={{ fontSize: 14 }}>{row.payment_ref ?? '⚠️ NONE GIVEN'}</strong></dd>
          <dt>Claimed sent</dt>
          <dd>{row.submitted_at ? new Date(row.submitted_at).toUTCString() : '—'}</dd>
          <dt>Paid to</dt>
          <dd>{row.payout_handle}</dd>
        </dl>
        <p className="field-hint" style={{ marginTop: 8 }}>
          Look this reference up in {row.method_name} directly. If it does not exist, or the
          amount/recipient differ, the depositor is lying and this is a refund.
        </p>
        {(row.receipts && row.receipts.length) && (
          <p className="field-hint">
            📎 A screenshot was attached (Telegram file <span className="mono">{(row.receipts && row.receipts.length).slice(0, 16)}…</span>).
            Treat it as secondary — screenshots are trivially faked.
          </p>
        )}
      </div>

      <div className="grid cols-2" style={{ marginBottom: 12 }}>
        <div className="card" style={{ background: 'var(--surface-2)' }}>
          <div className="stat-label">Depositor (says they paid)</div>
          <div style={{ marginTop: 4 }}>
            {row.depositor_name ?? '—'}{' '}
            <span className="mono" style={{ fontSize: 11 }}>{row.depositor_uid}</span>
          </div>
          {row.depositor_flags > 0 && (
            <span className="badge danger" style={{ marginTop: 6 }}>{row.depositor_flags} risk flag(s)</span>
          )}
        </div>
        <div className="card" style={{ background: 'var(--surface-2)' }}>
          <div className="stat-label">Recipient (says nothing arrived)</div>
          <div style={{ marginTop: 4 }}>{row.payee_name ?? '—'}</div>
          {row.payee_flags > 0 && (
            <span className="badge danger" style={{ marginTop: 6 }}>{row.payee_flags} risk flag(s)</span>
          )}
        </div>
      </div>

      {row.pair_history > 2 && (
        <div className="alert warn">
          ⚠️ These two have settled with each other {row.pair_history} times before.
          Possible collusion — a manufactured dispute is one way to move money between accounts.
        </div>
      )}

      <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '14px 0' }} />

      <div className="field">
        <label>Money ruling</label>
        <select value={resolution} onChange={(e) => setResolution(e.target.value as Resolution)}>
          <option value="refund_to_payee">Refund — the payment never landed; slice returns to the queue</option>
          <option value="release_to_depositor">Release — the payment is verified; depositor gets their chips</option>
          <option value="split">Split — partial</option>
        </select>
      </div>

      {resolution === 'split' && (
        <div className="field">
          <label>Amount to the depositor (max {(row.amount / 100).toFixed(2)})</label>
          <input value={split} onChange={(e) => setSplit(e.target.value)} placeholder="0.00" />
          <div className="field-hint">The remainder goes back in the recipient's place in line. No rake is taken on a split.</div>
        </div>
      )}

      <div className="field">
        <label>Reason (goes in the audit log, permanently)</label>
        <textarea value={note} onChange={(e) => setNote(e.target.value)}
                  placeholder="e.g. Checked tx 0x3f… on-chain: 50.00 USDT received at 14:22 UTC to the correct address." />
      </div>

      <div className="field">
        <label>Risk ruling (independent of the money)</label>
        <div style={{ display: 'flex', gap: 16, marginTop: 4 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 400 }}>
            <input type="checkbox" checked={flagDep} onChange={(e) => setFlagDep(e.target.checked)} />
            Flag depositor
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 400 }}>
            <input type="checkbox" checked={flagWd} onChange={(e) => setFlagWd(e.target.checked)} />
            Flag recipient
          </label>
        </div>
        <div className="field-hint">Flag whoever acted in bad faith — that is usually not the same question as where the money goes.</div>
      </div>

      {msg && <div className="alert err">{msg}</div>}

      <button className="danger" onClick={submit} disabled={pending}>
        {pending ? 'Ruling…' : 'Resolve dispute'}
      </button>
    </div>
  );
}
