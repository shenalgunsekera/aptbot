'use client';

import { useState, useTransition } from 'react';
import { createClub, updateClub } from '../../lib/actions';

type Club = { id: string; platform_id: string; name: string; platform_club_id: string; enabled: boolean };
type Platform = { id: string; name: string };

export function ClubsEditor({ clubs, platforms }: { clubs: Club[]; platforms: Platform[] }) {
  const [editing, setEditing] = useState<string | null>(null);
  const platName = (id: string) => platforms.find((p) => p.id === id)?.name ?? '—';

  return (
    <>
      <div className="table-wrap" style={{ marginBottom: 12 }}>
        <table>
          <thead>
            <tr>
              <th>Club</th>
              <th>Platform</th>
              <th>ClubGG club id</th>
              <th style={{ width: 70 }}>On</th>
              <th style={{ width: 90 }}></th>
            </tr>
          </thead>
          <tbody>
            {clubs.map((c) => (
              <tr key={c.id}>
                <td><strong>{c.name}</strong></td>
                <td>{platName(c.platform_id)}</td>
                <td className="mono" style={{ fontSize: 11 }}>{c.platform_club_id}</td>
                <td><span className={`badge ${c.enabled ? 'ok' : 'muted'}`}>{c.enabled ? 'on' : 'off'}</span></td>
                <td>
                  <button className="sm ghost" onClick={() => setEditing(editing === c.id ? null : c.id)}>
                    {editing === c.id ? 'Close' : 'Edit'}
                  </button>
                </td>
              </tr>
            ))}
            {clubs.length === 0 && (
              <tr><td colSpan={5} className="mono" style={{ color: 'var(--text-faint)' }}>No clubs yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {clubs.map((c) => (editing === c.id ? <ClubForm key={c.id} club={c} platforms={platforms} /> : null))}

      {editing === 'new' ? (
        <ClubForm club={null} platforms={platforms} />
      ) : (
        <button onClick={() => setEditing('new')}>+ Add club</button>
      )}
    </>
  );
}

function ClubForm({ club, platforms }: { club: Club | null; platforms: Platform[] }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  return (
    <form
      className="card"
      style={{ marginBottom: 12 }}
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const name = String(fd.get('name') ?? '');
        const platformClubId = String(fd.get('platform_club_id') ?? '');
        setMsg(null);
        start(async () => {
          const r = club
            ? await updateClub(club.id, name, platformClubId, fd.get('enabled') === 'on')
            : await createClub(String(fd.get('platform_id') ?? ''), name, platformClubId);
          setMsg(r.ok ? { ok: true, text: r.message ?? 'Saved.' } : { ok: false, text: r.error });
        });
      }}
    >
      <h2 style={{ marginTop: 0 }}>{club ? `Edit ${club.name}` : 'New club'}</h2>
      <div className="field-row">
        <div className="field">
          <label htmlFor="cname">Club name</label>
          <input id="cname" name="name" defaultValue={club?.name} placeholder="Vegas Club" required />
          <div className="field-hint">What players see when they pick a club.</div>
        </div>
        {!club && (
          <div className="field">
            <label htmlFor="cplat">Platform</label>
            <select id="cplat" name="platform_id" defaultValue={platforms[0]?.id} required>
              {platforms.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor="cpcid">ClubGG club id</label>
          <input id="cpcid" name="platform_club_id" defaultValue={club?.platform_club_id} placeholder="e.g. 123456" />
          <div className="field-hint">The id loaders use on the platform. Can set later.</div>
        </div>
      </div>
      {club && (
        <div className="field">
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" name="enabled" defaultChecked={club.enabled} />
            Enabled — offered to players
          </label>
        </div>
      )}
      {msg && <div className={`alert ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}
      <button type="submit" className="primary" disabled={pending}>{pending ? 'Saving…' : 'Save club'}</button>
    </form>
  );
}
