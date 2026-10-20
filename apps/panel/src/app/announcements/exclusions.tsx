'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { deleteAnnouncementList, saveAnnouncementList, searchAnnouncementPlayers } from '../../lib/actions';
import type { ExclusionList, PlayerBrief } from '../../lib/announce-data';

/** Search box → click a player to pick them. Shared by the composer and the list editor. */
function PlayerSearch({ picked, onPick, placeholder }: {
  picked: (id: string) => boolean;
  onPick: (p: PlayerBrief) => void;
  placeholder: string;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<PlayerBrief[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setResults([]); setLoading(false); return; }
    setLoading(true);
    let live = true;
    const t = setTimeout(() => {
      searchAnnouncementPlayers(term)
        .then((r) => { if (live) { setResults(r); setOpen(true); } })
        .catch(() => { if (live) setResults([]); })
        .finally(() => { if (live) setLoading(false); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [q]);

  useEffect(() => {
    const close = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  return (
    <div className="ex-search" ref={boxRef}>
      <input
        type="search" value={q} placeholder={placeholder} aria-label={placeholder}
        onChange={(e) => setQ(e.target.value)} onFocus={() => results.length && setOpen(true)}
        onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}
      />
      {open && q.trim().length >= 2 && (
        <div className="ex-results" role="listbox">
          {loading && results.length === 0 && <div className="ex-empty">Searching…</div>}
          {!loading && results.length === 0 && <div className="ex-empty">No players match “{q.trim()}”.</div>}
          {results.map((p) => {
            const on = picked(p.id);
            return (
              <button type="button" key={p.id} role="option" aria-selected={on}
                className={`ex-result ${on ? 'on' : ''}`} disabled={on}
                onClick={() => { onPick(p); setQ(''); setResults([]); setOpen(false); }}>
                <span className="ex-result-main">
                  <strong>{p.name}</strong>
                  {p.detail && <span className="ex-detail">{p.detail}</span>}
                </span>
                <span className="ex-result-side">
                  <span className={`badge ${p.platform === 'discord' ? 'muted' : 'muted'}`}>{p.platform === 'discord' ? '💬 Discord' : '📱 Telegram'}</span>
                  {p.status !== 'active' && <span className="badge warn">{p.status === 'frozen' ? 'on hold' : p.status}</span>}
                  <span className="ex-add">{on ? '✓ Left out' : '+ Leave out'}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Chip({ p, onRemove }: { p: PlayerBrief; onRemove: () => void }) {
  return (
    <span className="ex-chip" title={p.detail || p.name}>
      {p.platform === 'discord' ? '💬' : '📱'} {p.name}
      <button type="button" aria-label={`Put ${p.name} back`} onClick={onRemove}>✕</button>
    </span>
  );
}

/** Create / edit one saved list in a dialog. */
function ListEditor({ list, onClose, onSaved }: {
  list: ExclusionList | null;          // null = new list
  onClose: () => void;
  onSaved: (id: string | undefined) => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(list?.name ?? '');
  const [members, setMembers] = useState<PlayerBrief[]>(list?.members ?? []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [busy, onClose]);

  async function save() {
    setBusy(true); setErr(null);
    const r = await saveAnnouncementList(list?.id ?? null, name, members.map((m) => m.id));
    setBusy(false);
    if (!r.ok) { setErr(r.error); return; }
    router.refresh();
    onSaved(r.id);
  }
  async function remove() {
    if (!list) return;
    if (!window.confirm(`Delete the list "${list.name}"? The players stay — only the list goes.`)) return;
    setBusy(true);
    const r = await deleteAnnouncementList(list.id);
    setBusy(false);
    if (!r.ok) { setErr(r.error); return; }
    router.refresh();
    onSaved(undefined);
  }

  return (
    <div className="ex-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="card ex-dialog" role="dialog" aria-modal="true" aria-labelledby="ex-dlg-title">
        <h3 id="ex-dlg-title">{list ? 'Edit list' : 'New list'}</h3>
        <div className="field">
          <label htmlFor="ex-name">List name</label>
          <input id="ex-name" ref={nameRef} value={name} maxLength={60} placeholder="e.g. Staff, VIPs — no promos"
            onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label>People in this list <span className="ann-opt">{members.length}</span></label>
          <PlayerSearch
            placeholder="Add someone — name, @username or account"
            picked={(id) => members.some((m) => m.id === id)}
            onPick={(p) => setMembers((cur) => [...cur, p])}
          />
          <div className="ex-chips">
            {members.length === 0
              ? <span className="ex-empty-inline">No one yet — search above to add people.</span>
              : members.map((m) => <Chip key={m.id} p={m} onRemove={() => setMembers((cur) => cur.filter((x) => x.id !== m.id))} />)}
          </div>
        </div>
        {err && <div className="alert err" role="alert">{err}</div>}
        <div className="btn-row ex-dialog-actions">
          <button type="button" className="primary" disabled={busy || !name.trim()} onClick={save}>{busy ? 'Saving…' : 'Save list'}</button>
          <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
          {list && <button type="button" className="ghost ex-delete" disabled={busy} onClick={remove}>Delete list</button>}
        </div>
      </div>
    </div>
  );
}

/** The composer's "Don't send to" section. */
export function Exclusions({
  lists, selectedLists, setSelectedLists, picked, setPicked,
}: {
  lists: ExclusionList[];
  selectedLists: string[];
  setSelectedLists: (ids: string[]) => void;
  picked: PlayerBrief[];
  setPicked: (p: PlayerBrief[]) => void;
}) {
  const [editing, setEditing] = useState<ExclusionList | null | 'new'>(null);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; msg: string } | null>(null);
  const router = useRouter();

  // Everyone left out, de-duplicated across lists and one-off picks.
  const leftOut = new Set<string>([
    ...lists.filter((l) => selectedLists.includes(l.id)).flatMap((l) => l.members.map((m) => m.id)),
    ...picked.map((p) => p.id),
  ]);

  async function saveAsList() {
    const name = window.prompt(`Name this list of ${picked.length} player${picked.length === 1 ? '' : 's'} (e.g. "Staff")`);
    if (!name || !name.trim()) return;
    setSaving(true); setNote(null);
    const r = await saveAnnouncementList(null, name, picked.map((p) => p.id));
    setSaving(false);
    if (!r.ok) { setNote({ ok: false, msg: r.error }); return; }
    // The picks now live in the list — select it and clear the one-offs.
    if (r.id) setSelectedLists([...selectedLists, r.id]);
    setPicked([]);
    setNote({ ok: true, msg: r.message ?? 'List saved.' });
    router.refresh();
  }

  return (
    <div className="field ex-wrap">
      <label>Don&apos;t send to <span className="ann-opt">optional</span></label>

      {lists.length > 0 && (
        <div className="ex-lists">
          {lists.map((l) => {
            const on = selectedLists.includes(l.id);
            return (
              <div key={l.id} className={`ex-list ${on ? 'on' : ''}`}>
                <label className="ann-check ex-list-check">
                  <input type="checkbox" checked={on}
                    onChange={(e) => setSelectedLists(e.target.checked ? [...selectedLists, l.id] : selectedLists.filter((x) => x !== l.id))} />
                  <span><strong>{l.name}</strong> <span className="ex-count">{l.members.length} {l.members.length === 1 ? 'person' : 'people'}</span></span>
                </label>
                <button type="button" className="ghost sm" onClick={() => setEditing(l)}>Edit</button>
              </div>
            );
          })}
        </div>
      )}

      <PlayerSearch
        placeholder="Leave someone out — search name, @username or account"
        picked={(id) => leftOut.has(id)}
        onPick={(p) => setPicked([...picked, p])}
      />

      {picked.length > 0 && (
        <>
          <div className="ex-chips">
            {picked.map((p) => <Chip key={p.id} p={p} onRemove={() => setPicked(picked.filter((x) => x.id !== p.id))} />)}
          </div>
          <div className="btn-row">
            <button type="button" className="sm" disabled={saving} onClick={saveAsList}>
              {saving ? 'Saving…' : `💾 Save ${picked.length === 1 ? 'this person' : `these ${picked.length}`} as a list`}
            </button>
            <button type="button" className="ghost sm" onClick={() => setPicked([])}>Clear</button>
          </div>
        </>
      )}

      <div className="ex-foot">
        <span>
          {leftOut.size === 0
            ? 'Everyone in the audience gets it.'
            : <>Leaving out <strong>{leftOut.size}</strong> player{leftOut.size === 1 ? '' : 's'}.</>}
        </span>
        <button type="button" className="ghost sm" onClick={() => setEditing('new')}>+ New list</button>
      </div>
      {note && <div className={`alert ${note.ok ? 'ok' : 'err'}`} role="status">{note.msg}</div>}

      {editing && (
        <ListEditor
          list={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(id) => {
            if (editing === 'new' && id) setSelectedLists([...selectedLists, id]);
            if (editing !== 'new' && !id) setSelectedLists(selectedLists.filter((x) => x !== (editing as ExclusionList).id));
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}
