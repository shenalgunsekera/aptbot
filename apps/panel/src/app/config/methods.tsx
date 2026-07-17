'use client';

import { useState, useTransition } from 'react';
import { upsertMethod, deleteMethod } from '../../lib/actions';

export function MethodsEditor({ methods }: { methods: any[] }) {
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <>
      <div className="table-wrap" style={{ marginBottom: 12 }}>
        <table>
          <thead>
            <tr>
              <th>Method</th>
              <th style={{ width: 70 }}>Currency</th>
              <th style={{ width: 110 }}>Tier</th>
              <th style={{ width: 130 }}>Bounds</th>
              <th style={{ width: 110 }}>Processor fee</th>
              <th>Backstop handle</th>
              <th style={{ width: 70 }}>On</th>
              <th style={{ width: 60 }}></th>
            </tr>
          </thead>
          <tbody>
            {methods.map((m) => (
              <tr key={m.id}>
                <td>
                  <strong>{m.name}</strong>
                  <div className="mono" style={{ fontSize: 10, color: 'var(--text-faint)' }}>{m.code}</div>
                </td>
                <td className="mono">{m.currency}</td>
                <td>
                  <span className={`badge ${m.reversibility === 'irreversible' ? 'ok' : 'warn'}`}>
                    {m.reversibility === 'irreversible' ? '⚡ instant' : '🕒 holds'}
                  </span>
                </td>
                <td className="mono" style={{ fontSize: 11 }}>
                  {m.min_amount ? (m.min_amount / 100).toFixed(2) : '—'} – {m.max_amount ? (m.max_amount / 100).toFixed(2) : '—'}
                </td>
                <td className="mono" style={{ fontSize: 11 }}>
                  {(m.processor_fee_bps / 100).toFixed(2)}% + {(m.processor_fee_flat / 100).toFixed(2)}
                </td>
                <td className="mono" style={{ fontSize: 11 }}>
                  {m.club_handle ?? <span className="badge muted">not set</span>}
                </td>
                <td>
                  <span className={`badge ${m.enabled ? 'ok' : 'muted'}`}>{m.enabled ? 'on' : 'off'}</span>
                </td>
                <td style={{ display: 'flex', gap: 6 }}>
                  <button className="sm ghost" onClick={() => setEditing(editing === m.id ? null : m.id)}>
                    {editing === m.id ? 'Close' : 'Edit'}
                  </button>
                  <DeleteMethodButton id={m.id} name={m.name} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {methods.map((m) => (editing === m.id ? <MethodForm key={m.id} method={m} /> : null))}

      {editing === 'new' ? (
        <MethodForm method={null} />
      ) : (
        <button onClick={() => setEditing('new')}>+ Add payment method</button>
      )}
    </>
  );
}

function DeleteMethodButton({ id, name }: { id: string; name: string }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <>
      <button
        className="sm ghost danger"
        disabled={pending}
        onClick={() => {
          if (!confirm(`Delete ${name}? If it has history it will be disabled instead.`)) return;
          start(async () => {
            const r = await deleteMethod(id);
            setMsg(r.ok ? (r.message ?? 'Done.') : r.error);
          });
        }}
      >
        {pending ? '…' : 'Delete'}
      </button>
      {msg && <span className="mono" style={{ fontSize: 10 }}>{msg}</span>}
    </>
  );
}

function MethodForm({ method }: { method: any | null }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  return (
    <form
      className="card"
      style={{ marginBottom: 12 }}
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const patch: Record<string, unknown> = { id: method?.id };
        for (const [k, v] of fd.entries()) {
          const s = String(v);
          if (NUM.has(k)) patch[k] = s === '' ? null : Number(s);
          else if (k === 'enabled') patch[k] = s === 'on';
          else patch[k] = s === '' ? null : s;
        }
        if (!fd.has('enabled')) patch.enabled = false;

        setMsg(null);
        start(async () => {
          const r = await upsertMethod(patch);
          setMsg(r.ok ? { ok: true, text: r.message ?? 'Saved.' } : { ok: false, text: r.error });
        });
      }}
    >
      <h2 style={{ marginTop: 0 }}>{method ? `Edit ${method.name}` : 'New payment method'}</h2>

      <div className="field-row">
        <div className="field">
          <label htmlFor="name">Display name</label>
          <input id="name" name="name" defaultValue={method?.name} required />
        </div>
        {!method && (
          <div className="field">
            <label htmlFor="code">Code</label>
            <input id="code" name="code" placeholder="usdt_trc20" required />
            <div className="field-hint">Permanent — historical rows reference it.</div>
          </div>
        )}
        <div className="field">
          <label htmlFor="currency">Currency</label>
          <input id="currency" name="currency" defaultValue={method?.currency ?? 'USD'} maxLength={3} required />
        </div>
      </div>

      <div className="field">
        <label htmlFor="reversibility">Reversibility tier</label>
        <select id="reversibility" name="reversibility" defaultValue={method?.reversibility ?? 'irreversible'}>
          <option value="irreversible">Irreversible — crypto, cash. No hold; chips release on confirmation.</option>
          <option value="reversible">Reversible — card, PayPal, bank. Holds before release.</option>
        </select>
        <div className="field-hint">
          Get this right. Marking a chargeback-able method as irreversible removes the only
          defence you have against a depositor pulling their money back after taking the chips.
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="min_amount">Min (cents)</label>
          <input id="min_amount" name="min_amount" type="number" defaultValue={method?.min_amount ?? ''} />
        </div>
        <div className="field">
          <label htmlFor="max_amount">Max (cents)</label>
          <input id="max_amount" name="max_amount" type="number" defaultValue={method?.max_amount ?? ''} />
        </div>
        <div className="field">
          <label htmlFor="hold_seconds">Hold override (secs)</label>
          <input id="hold_seconds" name="hold_seconds" type="number" defaultValue={method?.hold_seconds ?? ''} />
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="processor_fee_bps">Processor fee (bps)</label>
          <input id="processor_fee_bps" name="processor_fee_bps" type="number"
                 defaultValue={method?.processor_fee_bps ?? 0} />
          <div className="field-hint">PayPal ≈ 349 (3.49%)</div>
        </div>
        <div className="field">
          <label htmlFor="processor_fee_flat">Processor fee flat (cents)</label>
          <input id="processor_fee_flat" name="processor_fee_flat" type="number"
                 defaultValue={method?.processor_fee_flat ?? 0} />
        </div>
      </div>

      <div className="field">
        <label htmlFor="club_handle">Club account (where money goes/comes from)</label>
        <input id="club_handle" name="club_handle" defaultValue={method?.club_handle ?? ''} />
        <div className="field-hint">
          ⚠️ Where a depositor pays YOU when nobody is in the queue. Triple-check it — this string
          is shown to players and real money is sent to it. Leave blank to refuse unmatched
          deposits on this method entirely.
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="handle_hint">Handle hint (shown to withdrawers)</label>
          <input id="handle_hint" name="handle_hint" defaultValue={method?.handle_hint ?? ''}
                 placeholder="your USDT TRC-20 address (starts with T)" />
        </div>
        <div className="field">
          <label htmlFor="handle_pattern">Handle regex (optional)</label>
          <input id="handle_pattern" name="handle_pattern" defaultValue={method?.handle_pattern ?? ''} />
          <div className="field-hint">Catches typos, not fraud.</div>
        </div>
        <div className="field">
          <label htmlFor="sort_order">Sort order</label>
          <input id="sort_order" name="sort_order" type="number" defaultValue={method?.sort_order ?? 0} />
        </div>
      </div>

      <div className="field">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" name="enabled" defaultChecked={method?.enabled ?? true} />
          Enabled — shown to players
        </label>
      </div>

      {msg && <div className={`alert ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}
      <button type="submit" className="primary" disabled={pending}>
        {pending ? 'Saving…' : 'Save method'}
      </button>
    </form>
  );
}

const NUM = new Set(['min_amount', 'max_amount', 'hold_seconds', 'processor_fee_bps', 'processor_fee_flat', 'sort_order']);
