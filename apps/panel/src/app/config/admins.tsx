'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { upsertAdmin, setAdminDisabled } from '../../lib/actions';

/** Strip a stray "mailto:" a paste sometimes leaves on an email. */
const cleanEmail = (e: string | null) => (e ?? '').replace(/^mailto:/i, '').trim();

export function AdminsEditor({ admins }: { admins: any[] }) {
  const [adding, setAdding] = useState(false);
  const active = admins.filter((a) => !a.disabled);
  const disabled = admins.filter((a) => a.disabled);

  return (
    <>
      <div className="table-wrap" style={{ marginBottom: 12 }}>
        <table>
          <thead>
            <tr>
              <th>Admin</th>
              <th style={{ width: 140 }}>Telegram</th>
              <th style={{ width: 140 }}>Discord</th>
              <th style={{ width: 90 }}>Role</th>
              <th style={{ width: 70 }}>Status</th>
              <th style={{ width: 100 }}></th>
            </tr>
          </thead>
          <tbody>
            {active.map((a) => <AdminRow key={a.id} a={a} />)}

            {disabled.length > 0 && (
              <tr>
                <td colSpan={6} style={{ background: 'var(--surface-2)', color: 'var(--text-faint)', fontSize: 11, fontWeight: 650, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Disabled ({disabled.length})
                </td>
              </tr>
            )}
            {disabled.map((a) => <AdminRow key={a.id} a={a} dim />)}
          </tbody>
        </table>
      </div>

      {adding ? <AdminForm onDone={() => setAdding(false)} /> : <button onClick={() => setAdding(true)}>+ Add Telegram admin</button>}
    </>
  );
}

function AdminRow({ a, dim }: { a: any; dim?: boolean }) {
  return (
    <tr style={dim ? { opacity: 0.55 } : undefined}>
      <td>
        <strong>{a.display_name ?? '—'}</strong>
        <div className="mono" style={{ fontSize: 10, color: 'var(--text-faint)' }}>{cleanEmail(a.email) || 'no email'}</div>
      </td>
      <td>{a.telegram_id ? <span className="mono">{a.telegram_id}</span> : <span className="badge muted">—</span>}</td>
      <td>{a.discord_id ? <span className="mono">{a.discord_id}</span> : <span className="badge muted">—</span>}</td>
      <td><span className={`badge ${a.role === 'owner' ? 'warn' : 'muted'}`}>{a.role}</span></td>
      <td><span className={`badge ${a.disabled ? 'muted' : 'ok'}`}>{a.disabled ? 'off' : 'on'}</span></td>
      <td>{a.role !== 'owner' && <ToggleButton id={a.id} disabled={a.disabled} />}</td>
    </tr>
  );
}

function ToggleButton({ id, disabled }: { id: string; disabled: boolean }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const router = useRouter();
  return (
    <>
      <button
        className="sm"
        disabled={pending}
        onClick={() => start(async () => {
          const r = await setAdminDisabled(id, !disabled);
          setMsg(r.ok ? null : r.error);
          if (r.ok) router.refresh();
        })}
      >
        {pending ? '…' : disabled ? 'Enable' : 'Disable'}
      </button>
      {msg && <span className="mono" style={{ fontSize: 10, color: 'var(--red)' }}>{msg}</span>}
    </>
  );
}

function AdminForm({ onDone }: { onDone: () => void }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  return (
    <form
      className="card"
      style={{ marginBottom: 12 }}
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const telegramId = String(fd.get('telegram_id') ?? '').trim();
        const username = String(fd.get('username') ?? '').trim().replace(/^@/, '') || null;
        const email = cleanEmail(String(fd.get('email') ?? '')) || null;
        const role = (String(fd.get('role') ?? 'admin')) as 'admin' | 'owner';
        setMsg(null);
        start(async () => {
          const r = await upsertAdmin(telegramId, username, email, role);
          setMsg(r.ok ? { ok: true, text: r.message ?? 'Saved.' } : { ok: false, text: r.error });
          if (r.ok) { router.refresh(); onDone(); }
        });
      }}
    >
      <h2 style={{ marginTop: 0 }}>New Telegram admin</h2>
      <p className="field-hint" style={{ marginTop: -4, marginBottom: 12 }}>
        Discord admins are added from the Discord bot with <span className="mono">/setadmin</span>.
      </p>
      <div className="field-row">
        <div className="field">
          <label htmlFor="atid">Telegram ID</label>
          <input id="atid" name="telegram_id" type="number" placeholder="6715443137" required />
          <div className="field-hint">Their numeric Telegram user id.</div>
        </div>
        <div className="field">
          <label htmlFor="auser">Name</label>
          <input id="auser" name="username" placeholder="Their name" />
        </div>
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="aemail">Email (for panel login)</label>
          <input id="aemail" name="email" type="email" placeholder="name@gmail.com" />
        </div>
        <div className="field">
          <label htmlFor="arole">Role</label>
          <select id="arole" name="role" defaultValue="admin">
            <option value="admin">Admin</option>
            <option value="owner">Owner</option>
          </select>
        </div>
      </div>
      {msg && <div className={`alert ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}
      <div className="btn-row">
        <button type="submit" className="primary" disabled={pending}>{pending ? 'Saving…' : 'Add admin'}</button>
        <button type="button" className="ghost" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}
