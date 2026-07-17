'use client';

import { useState, useTransition } from 'react';
import { upsertAdmin, setAdminDisabled } from '../../lib/actions';

export function AdminsEditor({ admins }: { admins: any[] }) {
  const [adding, setAdding] = useState(false);

  return (
    <>
      <div className="table-wrap" style={{ marginBottom: 12 }}>
        <table>
          <thead>
            <tr>
              <th>Admin</th>
              <th style={{ width: 130 }}>Telegram ID</th>
              <th style={{ width: 90 }}>Role</th>
              <th style={{ width: 80 }}>Status</th>
              <th style={{ width: 110 }}></th>
            </tr>
          </thead>
          <tbody>
            {admins.map((a) => (
              <tr key={a.id}>
                <td>
                  <strong>{a.telegram_username ? '@' + a.telegram_username : '—'}</strong>
                  <div className="mono" style={{ fontSize: 10, color: 'var(--text-faint)' }}>{a.email ?? 'no email'}</div>
                </td>
                <td className="mono">{a.telegram_id ?? '—'}</td>
                <td><span className={`badge ${a.role === 'owner' ? 'warn' : 'muted'}`}>{a.role}</span></td>
                <td><span className={`badge ${a.disabled ? 'muted' : 'ok'}`}>{a.disabled ? 'off' : 'on'}</span></td>
                <td>
                  {a.role !== 'owner' && <ToggleButton id={a.id} disabled={a.disabled} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {adding ? <AdminForm onDone={() => setAdding(false)} /> : <button onClick={() => setAdding(true)}>+ Add admin</button>}
    </>
  );
}

function ToggleButton({ id, disabled }: { id: string; disabled: boolean }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <>
      <button
        className="sm ghost"
        disabled={pending}
        onClick={() => start(async () => {
          const r = await setAdminDisabled(id, !disabled);
          setMsg(r.ok ? null : r.error);
        })}
      >
        {pending ? '…' : disabled ? 'Enable' : 'Disable'}
      </button>
      {msg && <span className="mono" style={{ fontSize: 10, color: 'var(--danger)' }}>{msg}</span>}
    </>
  );
}

function AdminForm({ onDone }: { onDone: () => void }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  return (
    <form
      className="card"
      style={{ marginBottom: 12 }}
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const telegramId = String(fd.get('telegram_id') ?? '').trim();
        const username = String(fd.get('username') ?? '').trim().replace(/^@/, '') || null;
        const email = String(fd.get('email') ?? '').trim() || null;
        const role = (String(fd.get('role') ?? 'admin')) as 'admin' | 'owner';
        setMsg(null);
        start(async () => {
          const r = await upsertAdmin(telegramId, username, email, role);
          setMsg(r.ok ? { ok: true, text: r.message ?? 'Saved.' } : { ok: false, text: r.error });
          if (r.ok) onDone();
        });
      }}
    >
      <h2 style={{ marginTop: 0 }}>New admin</h2>
      <div className="field-row">
        <div className="field">
          <label htmlFor="atid">Telegram ID</label>
          <input id="atid" name="telegram_id" type="number" placeholder="6715443137" required />
          <div className="field-hint">Their numeric Telegram user id.</div>
        </div>
        <div className="field">
          <label htmlFor="auser">Username</label>
          <input id="auser" name="username" placeholder="@handle" />
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
      <button type="submit" className="primary" disabled={pending}>{pending ? 'Saving…' : 'Add admin'}</button>
    </form>
  );
}
