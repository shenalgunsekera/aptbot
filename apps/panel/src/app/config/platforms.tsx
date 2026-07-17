'use client';

import { useState, useTransition } from 'react';
import { upsertPlatform, deletePlatform } from '../../lib/actions';

export function PlatformsEditor({ platforms }: { platforms: any[] }) {
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <>
      <div className="table-wrap" style={{ marginBottom: 12 }}>
        <table>
          <thead>
            <tr>
              <th>Platform</th>
              <th style={{ width: 90 }}>Sort</th>
              <th style={{ width: 70 }}>On</th>
              <th style={{ width: 150 }}></th>
            </tr>
          </thead>
          <tbody>
            {platforms.map((p) => (
              <tr key={p.id}>
                <td>
                  <strong>{p.name}</strong>
                  <div className="mono" style={{ fontSize: 10, color: 'var(--text-faint)' }}>{p.code}</div>
                </td>
                <td className="mono">{p.sort_order}</td>
                <td><span className={`badge ${p.enabled ? 'ok' : 'muted'}`}>{p.enabled ? 'on' : 'off'}</span></td>
                <td style={{ display: 'flex', gap: 6 }}>
                  <button className="sm ghost" onClick={() => setEditing(editing === p.id ? null : p.id)}>
                    {editing === p.id ? 'Close' : 'Edit'}
                  </button>
                  <DeleteButton id={p.id} name={p.name} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {platforms.map((p) => (editing === p.id ? <PlatformForm key={p.id} platform={p} /> : null))}

      {editing === 'new' ? (
        <PlatformForm platform={null} />
      ) : (
        <button onClick={() => setEditing('new')}>+ Add platform</button>
      )}
    </>
  );
}

function DeleteButton({ id, name }: { id: string; name: string }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <>
      <button
        className="sm ghost danger"
        disabled={pending}
        onClick={() => {
          if (!confirm(`Delete ${name}? If it's in use it will be disabled instead.`)) return;
          start(async () => {
            const r = await deletePlatform(id);
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

function PlatformForm({ platform }: { platform: any | null }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  return (
    <form
      className="card"
      style={{ marginBottom: 12 }}
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const patch: Record<string, unknown> = { id: platform?.id };
        patch.name = String(fd.get('name') ?? '');
        if (!platform) patch.code = String(fd.get('code') ?? '');
        patch.sort_order = Number(fd.get('sort_order') ?? 0);
        patch.enabled = fd.get('enabled') === 'on';
        setMsg(null);
        start(async () => {
          const r = await upsertPlatform(patch);
          setMsg(r.ok ? { ok: true, text: r.message ?? 'Saved.' } : { ok: false, text: r.error });
        });
      }}
    >
      <h2 style={{ marginTop: 0 }}>{platform ? `Edit ${platform.name}` : 'New platform'}</h2>
      <div className="field-row">
        <div className="field">
          <label htmlFor="pname">Display name</label>
          <input id="pname" name="name" defaultValue={platform?.name} required />
        </div>
        {!platform && (
          <div className="field">
            <label htmlFor="pcode">Code</label>
            <input id="pcode" name="code" placeholder="clubgg" required />
            <div className="field-hint">Permanent — historical rows reference it.</div>
          </div>
        )}
        <div className="field">
          <label htmlFor="psort">Sort order</label>
          <input id="psort" name="sort_order" type="number" defaultValue={platform?.sort_order ?? 0} />
        </div>
      </div>
      <div className="field">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" name="enabled" defaultChecked={platform?.enabled ?? true} />
          Enabled — offered to players
        </label>
      </div>
      {msg && <div className={`alert ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}
      <button type="submit" className="primary" disabled={pending}>{pending ? 'Saving…' : 'Save platform'}</button>
    </form>
  );
}
