'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  announcementRecipients, broadcastAnnouncement,
  type AnnouncementAudience, type AnnouncementDraft,
} from '../../lib/actions';
import { previewHtml, plainLength } from './format';
import { AudienceSet } from './exclusions';
import type { ExclusionList, PlayerBrief } from '../../lib/announce-data';

type Img = { key: string; url?: string; local: string; name: string; status: 'uploading' | 'ready' | 'error'; error?: string };
type Btn = { label: string; url: string };
type Counts = { telegram: number; discord: number };

/** What "Use again" in the history hands the composer. */
export interface ReusableDraft {
  title: string; body: string; images: string[]; buttons: Btn[]; reel: string; preview: boolean;
}

const MAX_IMAGES = 10;
const MAX_BUTTONS = 6;
const MAX_CHARS = 2000;                       // Discord's per-message limit
const CAPTION_FITS = 1000;                    // Telegram caption (with photos)
const DRAFT_KEY = 'apt.announcement.draft.v1';
const EXCL_KEY = 'apt.announcement.exclusions.v1';
const EMOJI = ['📣', '🔥', '🎉', '💰', '♠️', '♥️', '🏆', '🎁', '⚡', '✅', '⏰', '🚀', '💎', '🍀'];
const isHttp = (u: string) => /^https?:\/\/\S+\.\S+/i.test(u.trim());
let seq = 0;
const newKey = () => `img${Date.now()}${seq++}`;

/** Make an image safe to upload: JPG/PNG, longest side ≤ 2560px, ≤ 3.5 MB (under
 *  Vercel's body limit and Telegram's photo rules). Re-encodes to JPEG if needed. */
async function shrink(file: File): Promise<Blob> {
  const LIMIT = 3.5 * 1024 * 1024;
  const MAX_DIM = 2560;
  let bmp: ImageBitmap;
  try { bmp = await createImageBitmap(file); }
  catch { throw new Error("Couldn't read that image — use a JPG or PNG."); }
  const big = Math.max(bmp.width, bmp.height);
  if ((file.type === 'image/jpeg' || file.type === 'image/png') && file.size <= LIMIT && big <= MAX_DIM) {
    bmp.close();
    return file;
  }
  const scale = Math.min(1, MAX_DIM / big);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error("Your browser couldn't process that image.");
  ctx.fillStyle = '#ffffff';                  // JPEG has no transparency — flatten onto white
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  for (const q of [0.9, 0.82, 0.74, 0.65, 0.55]) {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', q));
    if (blob && blob.size <= LIMIT) return blob;
  }
  throw new Error('That image is too large even after shrinking it.');
}

export function Composer({ initialCounts, lists }: { initialCounts: Counts; lists: ExclusionList[] }) {
  const router = useRouter();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [images, setImages] = useState<Img[]>([]);
  const [reel, setReel] = useState('');
  const [buttons, setButtons] = useState<Btn[]>([]);
  const [preview, setPreview] = useState(true);
  const [audience, setAudience] = useState<AnnouncementAudience>('all');
  const [onHold, setOnHold] = useState(false);
  const [pending, setPending] = useState(false);
  const [counts, setCounts] = useState<Counts | null>(initialCounts);
  const [busy, setBusy] = useState<null | 'test' | 'send'>(null);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [view, setView] = useState<'telegram' | 'discord'>('telegram');
  const [loaded, setLoaded] = useState(false);
  const [exLists, setExLists] = useState<string[]>([]);
  const [exPicked, setExPicked] = useState<PlayerBrief[]>([]);
  const [inLists, setInLists] = useState<string[]>([]);
  const [inPicked, setInPicked] = useState<PlayerBrief[]>([]);

  // ── Draft: restore on load, autosave on every change (survives a refresh). ──
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (raw) applyDraft(JSON.parse(raw) as ReusableDraft);
      const ex = localStorage.getItem(EXCL_KEY);
      if (ex) {
        const e = JSON.parse(ex) as { lists?: string[]; picked?: PlayerBrief[]; inLists?: string[]; inPicked?: PlayerBrief[] };
        setExLists(Array.isArray(e.lists) ? e.lists : []);
        setExPicked(Array.isArray(e.picked) ? e.picked : []);
        setInLists(Array.isArray(e.inLists) ? e.inLists : []);
        setInPicked(Array.isArray(e.inPicked) ? e.inPicked : []);
      }
    } catch { /* storage blocked — start empty */ }
    setLoaded(true);
    const onReuse = (e: Event) => {
      applyDraft((e as CustomEvent<ReusableDraft>).detail);
      setResult({ ok: true, msg: 'Loaded into the editor — review it, then send.' });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
    window.addEventListener('ann:reuse', onReuse);
    return () => window.removeEventListener('ann:reuse', onReuse);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const d: ReusableDraft = {
      title, body, reel, preview, buttons,
      images: images.filter((i) => i.status === 'ready' && i.url).map((i) => i.url!),
    };
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch { /* ignore */ }
  }, [loaded, title, body, reel, preview, buttons, images]);

  useEffect(() => {
    if (!loaded) return;
    try { localStorage.setItem(EXCL_KEY, JSON.stringify({ lists: exLists, picked: exPicked, inLists, inPicked })); } catch { /* ignore */ }
  }, [loaded, exLists, exPicked, inLists, inPicked]);

  // A list deleted elsewhere can't stay selected.
  useEffect(() => {
    setExLists((cur) => cur.filter((id) => lists.some((l) => l.id === id)));
    setInLists((cur) => cur.filter((id) => lists.some((l) => l.id === id)));
  }, [lists]);

  function applyDraft(d: ReusableDraft) {
    setTitle(d.title ?? '');
    setBody(d.body ?? '');
    setReel(d.reel ?? '');
    setPreview(d.preview !== false);
    setButtons(Array.isArray(d.buttons) ? d.buttons.slice(0, MAX_BUTTONS) : []);
    setImages((Array.isArray(d.images) ? d.images : []).slice(0, MAX_IMAGES)
      .map((u) => ({ key: newKey(), url: u, local: u, name: 'image', status: 'ready' as const })));
  }

  function clearDraft() {
    setTitle(''); setBody(''); setReel(''); setButtons([]); setImages([]); setPreview(true);
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
  }

  // ── Live recipient count ──
  const exPlayerIds = exPicked.map((p) => p.id);
  const inPlayerIds = inPicked.map((p) => p.id);
  const exKey = exLists.join(',') + '|' + exPlayerIds.join(',') + '|' + inLists.join(',') + '|' + inPlayerIds.join(',')
    + '|' + lists.map((l) => l.id + ':' + l.memberIds.length).join(',');
  useEffect(() => {
    let live = true;
    const noEx = exLists.length === 0 && exPlayerIds.length === 0 && inLists.length === 0 && inPlayerIds.length === 0;
    if (audience === 'all' && !onHold && !pending && noEx) { setCounts(initialCounts); }
    else setCounts(null);
    announcementRecipients(audience, onHold, pending, exLists, exPlayerIds, inLists, inPlayerIds)
      .then((c) => { if (live) setCounts(c); })
      .catch(() => { if (live) setCounts(null); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audience, onHold, pending, initialCounts, exKey]);

  const total = counts ? counts.telegram + counts.discord : null;

  // How "only send to" and "don't send to" combine, in plain words.
  const resolution = useMemo(() => {
    const setOf = (ids: string[], picks: PlayerBrief[]) => new Set<string>([
      ...lists.filter((l) => ids.includes(l.id)).flatMap((l) => l.memberIds), ...picks.map((p) => p.id)]);
    const inc = setOf(inLists, inPicked);
    const exc = setOf(exLists, exPicked);
    if (inc.size === 0 && exc.size === 0) return null;
    const names = (ids: string[], picks: PlayerBrief[]) => [
      ...lists.filter((l) => ids.includes(l.id)).map((l) => l.name),
      ...(picks.length ? [`${picks.length} picked player${picks.length === 1 ? '' : 's'}`] : []),
    ].join(' + ');
    if (inc.size === 0) return `Everyone except ${names(exLists, exPicked)}.`;
    if (exc.size === 0) return `Only ${names(inLists, inPicked)}.`;
    let overlap = 0;
    for (const id of exc) if (inc.has(id)) overlap++;
    return `Only ${names(inLists, inPicked)}, except ${names(exLists, exPicked)} — ` +
      (overlap === 0
        ? `nobody is on both, so nothing extra is removed.`
        : `${overlap.toLocaleString()} player${overlap === 1 ? ' is' : 's are'} on both, so ${overlap === 1 ? 'that player is' : 'they’re'} skipped.`);
  }, [lists, inLists, inPicked, exLists, exPicked]);

  // ── Formatting ──
  function wrap(left: string, right = left, placeholder = 'text') {
    const ta = taRef.current;
    if (!ta) return;
    const { selectionStart: a, selectionEnd: b, value } = ta;
    const sel = value.slice(a, b) || placeholder;
    const next = (value.slice(0, a) + left + sel + right + value.slice(b)).slice(0, MAX_CHARS);
    setBody(next);
    requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(a + left.length, a + left.length + sel.length); });
  }
  function insert(text: string) {
    const ta = taRef.current;
    if (!ta) { setBody((v) => (v + text).slice(0, MAX_CHARS)); return; }
    const { selectionStart: a, selectionEnd: b, value } = ta;
    setBody((value.slice(0, a) + text + value.slice(b)).slice(0, MAX_CHARS));
    requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(a + text.length, a + text.length); });
  }
  function addLink() {
    const url = window.prompt('Paste the link (starting with https://)');
    if (!url) return;
    if (!isHttp(url)) { setResult({ ok: false, msg: 'Links must start with http:// or https://' }); return; }
    wrap('[', `](${url.trim()})`, 'link text');
  }

  // ── Images ──
  function addFiles(list: FileList | File[]) {
    const files = Array.from(list).filter((f) => f.type.startsWith('image/'));
    if (!files.length) { setResult({ ok: false, msg: 'Only images can be attached here — add a reel as a link below.' }); return; }
    const room = MAX_IMAGES - images.length;
    if (room <= 0) { setResult({ ok: false, msg: `Up to ${MAX_IMAGES} images per announcement.` }); return; }
    const take = files.slice(0, room);
    if (files.length > room) setResult({ ok: false, msg: `Only the first ${room} image${room === 1 ? '' : 's'} were added (max ${MAX_IMAGES}).` });
    const fresh: Img[] = take.map((f) => ({ key: newKey(), local: URL.createObjectURL(f), name: f.name, status: 'uploading' }));
    setImages((cur) => [...cur, ...fresh]);
    take.forEach((f, i) => void upload(fresh[i]!.key, f));
  }
  async function upload(key: string, file: File) {
    try {
      const blob = await shrink(file);
      const ext = blob.type === 'image/png' ? '.png' : '.jpg';
      const fd = new FormData();
      fd.append('file', new File([blob], file.name.replace(/\.[^.]+$/, '') + ext, { type: blob.type || 'image/jpeg' }));
      const res = await fetch('/api/announcements/media', { method: 'POST', body: fd });
      const j = await res.json().catch(() => null) as { ok?: boolean; url?: string; error?: string } | null;
      if (!res.ok || !j?.ok || !j.url) throw new Error(j?.error ?? 'Upload failed — try again.');
      setImages((cur) => cur.map((x) => (x.key === key ? { ...x, url: j.url, status: 'ready' } : x)));
    } catch (e) {
      setImages((cur) => cur.map((x) => (x.key === key ? { ...x, status: 'error', error: (e as Error).message } : x)));
    }
  }
  function moveImage(i: number, dir: -1 | 1) {
    setImages((cur) => {
      const j = i + dir;
      if (j < 0 || j >= cur.length) return cur;
      const next = cur.slice();
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  }

  // ── Validation ──
  const chars = title.length + body.length;
  const visible = plainLength(title, body);
  const readyImages = images.filter((i) => i.status === 'ready' && i.url).map((i) => i.url!);
  const uploading = images.some((i) => i.status === 'uploading');
  const problems = useMemo(() => {
    const p: string[] = [];
    if (!title.trim() && !body.trim() && readyImages.length === 0) p.push('Write a message or add an image.');
    if (uploading) p.push('Wait for the images to finish uploading.');
    if (images.some((i) => i.status === 'error')) p.push('Remove the images that failed to upload.');
    if (reel.trim() && !isHttp(reel)) p.push('The reel link must start with https://');
    buttons.forEach((b, i) => {
      if (!b.label.trim() && !b.url.trim()) return;
      if (!b.label.trim()) p.push(`Button ${i + 1} needs a label.`);
      if (!isHttp(b.url)) p.push(`Button ${i + 1} needs a link starting with https://`);
    });
    if (chars > MAX_CHARS) p.push(`Too long — ${chars}/${MAX_CHARS} characters.`);
    return p;
  }, [title, body, readyImages.length, uploading, images, reel, buttons, chars]);

  function draft(): AnnouncementDraft {
    return {
      title: title.trim(), body, images: readyImages,
      buttons: buttons.filter((b) => b.label.trim() || b.url.trim()).map((b) => ({ label: b.label.trim(), url: b.url.trim() })),
      reel: reel.trim(), preview, audience, includeOnHold: onHold, includePending: pending,
      excludeListIds: exLists, excludePlayerIds: exPlayerIds,
      includeListIds: inLists, includePlayerIds: inPlayerIds,
    };
  }

  async function go(test: boolean) {
    if (problems.length) { setResult({ ok: false, msg: problems[0]! }); return; }
    if (!test) {
      const n = total ?? 0;
      if (!n) { setResult({ ok: false, msg: 'No players match that audience.' }); return; }
      const ok = window.confirm(
        `Send this announcement to ${n} player${n === 1 ? '' : 's'} now?\n\n` +
        `Each player gets it in their own chat. This can't be undone.`);
      if (!ok) return;
    }
    setBusy(test ? 'test' : 'send');
    setResult(null);
    try {
      const r = await broadcastAnnouncement(draft(), test);
      setResult(r.ok ? { ok: true, msg: r.message ?? 'Sent.' } : { ok: false, msg: r.error });
      if (r.ok && !test) clearDraft();
      router.refresh();
    } catch {
      setResult({ ok: false, msg: 'Lost connection while sending — check the history below before trying again.' });
    } finally {
      setBusy(null);
    }
  }

  const btnList = buttons.filter((b) => b.label.trim() && isHttp(b.url));
  const html = previewHtml(body);
  const longForCaption = readyImages.length > 0 && visible > CAPTION_FITS;

  return (
    <div className="ann-layout">
      {/* ── Editor ─────────────────────────────────────────────────────── */}
      <div className="card ann-editor">
        <div className="field">
          <label htmlFor="ann-title">Title <span className="ann-opt">optional</span></label>
          <input id="ann-title" value={title} maxLength={120} placeholder="e.g. Weekend freeroll this Saturday"
            onChange={(e) => setTitle(e.target.value)} />
        </div>

        <div className="field">
          <label htmlFor="ann-body">Message</label>
          <div className="ann-toolbar" role="toolbar" aria-label="Formatting">
            <button type="button" title="Bold" onClick={() => wrap('**')}><b>B</b></button>
            <button type="button" title="Italic" onClick={() => wrap('_')}><i>I</i></button>
            <button type="button" title="Underline" onClick={() => wrap('__')}><u>U</u></button>
            <button type="button" title="Strikethrough" onClick={() => wrap('~~')}><s>S</s></button>
            <button type="button" title="Spoiler (tap to reveal)" onClick={() => wrap('||')}>Spoiler</button>
            <button type="button" title="Code" onClick={() => wrap('`')}>{'</>'}</button>
            <button type="button" title="Link" onClick={addLink}>🔗 Link</button>
            <span className="ann-toolbar-sep" aria-hidden />
            {EMOJI.map((em) => (
              <button type="button" key={em} className="ann-emoji" title={`Insert ${em}`} onClick={() => insert(em)}>{em}</button>
            ))}
          </div>
          <textarea id="ann-body" ref={taRef} rows={9} value={body} maxLength={MAX_CHARS}
            placeholder="Write your announcement. Select text and use the buttons above to style it."
            onChange={(e) => setBody(e.target.value)} />
          <div className="ann-meta">
            <span className={chars > MAX_CHARS * 0.92 ? 'ann-warn' : ''}>{chars.toLocaleString()} / {MAX_CHARS.toLocaleString()}</span>
            {longForCaption && <span className="ann-warn">With photos, Telegram fits ~1,000 characters under the picture — the rest arrives as a second message right after.</span>}
          </div>
        </div>

        <div className="field">
          <label>Images <span className="ann-opt">up to {MAX_IMAGES} · JPG or PNG · shown as an album</span></label>
          {images.length > 0 && (
            <div className="ann-images">
              {images.map((img, i) => (
                <div key={img.key} className={`ann-thumb ${img.status}`} title={img.error ?? img.name}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={img.url ?? img.local} alt={`Image ${i + 1}`} />
                  {img.status === 'uploading' && <div className="ann-thumb-state">Uploading…</div>}
                  {img.status === 'error' && <div className="ann-thumb-state err">{img.error ?? 'Failed'}</div>}
                  <div className="ann-thumb-bar">
                    <span>
                      <button type="button" aria-label="Move left" disabled={i === 0} onClick={() => moveImage(i, -1)}>‹</button>
                      <button type="button" aria-label="Move right" disabled={i === images.length - 1} onClick={() => moveImage(i, 1)}>›</button>
                    </span>
                    <button type="button" aria-label="Remove image" onClick={() => setImages((cur) => cur.filter((x) => x.key !== img.key))}>✕</button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {images.length < MAX_IMAGES && (
            <div
              className={`ann-drop ${dragOver ? 'over' : ''}`}
              role="button" tabIndex={0}
              onClick={() => fileRef.current?.click()}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click(); } }}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
            >
              <strong>Drop images here</strong> or click to choose · big photos are shrunk automatically
            </div>
          )}
          <input ref={fileRef} type="file" accept="image/*" multiple hidden
            onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
        </div>

        <div className="field">
          <label htmlFor="ann-reel">Instagram reel / video link <span className="ann-opt">optional</span></label>
          <input id="ann-reel" value={reel} placeholder="https://www.instagram.com/reel/…" inputMode="url"
            onChange={(e) => setReel(e.target.value)} />
          <div className="field-hint">
            Shown as a large link preview with a <b>▶️ Watch the reel</b> button. Instagram doesn&apos;t allow reels to be
            re-uploaded, so players tap through to watch it.
          </div>
        </div>

        <div className="field">
          <label>Buttons <span className="ann-opt">optional · link buttons under the message</span></label>
          {buttons.map((b, i) => (
            <div className="ann-btn-edit" key={i}>
              <input aria-label={`Button ${i + 1} label`} value={b.label} maxLength={40} placeholder="Label, e.g. Join the table"
                onChange={(e) => setButtons((cur) => cur.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
              <input aria-label={`Button ${i + 1} link`} value={b.url} placeholder="https://…" inputMode="url"
                onChange={(e) => setButtons((cur) => cur.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} />
              <button type="button" className="ghost sm" aria-label={`Remove button ${i + 1}`}
                onClick={() => setButtons((cur) => cur.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          {buttons.length < MAX_BUTTONS && (
            <button type="button" className="sm" onClick={() => setButtons((cur) => [...cur, { label: '', url: '' }])}>+ Add button</button>
          )}
        </div>

        <div className="field-row">
          <div className="field">
            <label htmlFor="ann-aud">Send to</label>
            <select id="ann-aud" value={audience} onChange={(e) => setAudience(e.target.value as AnnouncementAudience)}>
              <option value="all">Everyone — Telegram and Discord</option>
              <option value="telegram">Telegram players only</option>
              <option value="discord">Discord players only</option>
            </select>
          </div>
          <div className="field">
            <label>Options</label>
            <label className="ann-check"><input type="checkbox" checked={preview} onChange={(e) => setPreview(e.target.checked)} /> Show link previews</label>
            <label className="ann-check"><input type="checkbox" checked={onHold} onChange={(e) => setOnHold(e.target.checked)} /> Include players on hold</label>
            <label className="ann-check"><input type="checkbox" checked={pending} onChange={(e) => setPending(e.target.checked)} /> Include players awaiting approval</label>
          </div>
        </div>

        <AudienceSet
          mode="only" lists={lists}
          selectedLists={inLists} setSelectedLists={setInLists}
          picked={inPicked} setPicked={setInPicked}
          otherSideLists={exLists}
        />
        <AudienceSet
          mode="exclude" lists={lists}
          selectedLists={exLists} setSelectedLists={setExLists}
          picked={exPicked} setPicked={setExPicked}
          otherSideLists={inLists}
        />
        {resolution && <div className="ann-resolve">{resolution}</div>}

        <div className="ann-reach" aria-live="polite">
          {counts == null
            ? 'Counting players…'
            : <>Reaches <strong>{(total ?? 0).toLocaleString()}</strong> player{total === 1 ? '' : 's'} — {counts.telegram.toLocaleString()} on Telegram, {counts.discord.toLocaleString()} on Discord. Each gets it in their own chat. Banned players never do.</>}
        </div>

        {result && <div className={`alert ${result.ok ? 'ok' : 'err'}`} role="status">{result.msg}</div>}

        <div className="btn-row ann-actions">
          <button type="button" className="primary" disabled={!!busy || problems.length > 0 || !total} onClick={() => go(false)}>
            {busy === 'send' ? 'Sending…' : `Send to ${total == null ? '…' : total.toLocaleString()} players`}
          </button>
          <button type="button" disabled={!!busy || problems.length > 0} onClick={() => go(true)}>
            {busy === 'test' ? 'Sending test…' : 'Send test to admin group'}
          </button>
          <button type="button" className="ghost" disabled={!!busy} onClick={() => {
            if (window.confirm('Clear the editor? Your draft will be removed.')) { clearDraft(); setResult(null); }
          }}>Clear</button>
        </div>
        {problems.length > 0 && !busy && (title || body || images.length > 0) && (
          <div className="field-hint ann-problems">{problems[0]}</div>
        )}
      </div>

      {/* ── Preview ────────────────────────────────────────────────────── */}
      <div className="ann-preview-col">
        <div className="tabs" role="tablist" aria-label="Preview">
          <button type="button" role="tab" aria-selected={view === 'telegram'} className={`tab ${view === 'telegram' ? 'active' : ''}`} onClick={() => setView('telegram')}>Telegram</button>
          <button type="button" role="tab" aria-selected={view === 'discord'} className={`tab ${view === 'discord' ? 'active' : ''}`} onClick={() => setView('discord')}>Discord</button>
        </div>

        {view === 'telegram' ? (
          <div className="ann-tg">
            <div className="ann-tg-bubble">
              {readyImages.length > 0 && (
                <div className={`ann-gallery n${Math.min(readyImages.length, 4)}`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {readyImages.slice(0, 4).map((u, i) => <img key={i} src={u} alt="" />)}
                  {readyImages.length > 4 && <span className="ann-more">+{readyImages.length - 4}</span>}
                </div>
              )}
              {(title.trim() || body.trim()) ? (
                <div className="ann-text">
                  {title.trim() && <b className="ann-title">{title.trim()}</b>}
                  {body.trim() && <div dangerouslySetInnerHTML={{ __html: html }} />}
                </div>
              ) : readyImages.length === 0 && <div className="ann-text ann-empty">Your message preview appears here.</div>}
              {preview && isHttp(reel) && (
                <div className="ann-linkcard"><span className="ann-linkcard-site">Instagram</span><span>Reel · large preview</span></div>
              )}
              <span className="ann-tg-time">now</span>
            </div>
            {(isHttp(reel) || btnList.length > 0) && (
              <div className="ann-tg-kb">
                {isHttp(reel) && <span>▶️ Watch the reel ↗</span>}
                {btnList.map((b, i) => <span key={i}>{b.label} ↗</span>)}
              </div>
            )}
          </div>
        ) : (
          <div className="ann-dc">
            <div className="ann-dc-msg">
              <div className="ann-dc-avatar" aria-hidden>A</div>
              <div className="ann-dc-main">
                <div className="ann-dc-head"><b>APT BOT</b><span className="ann-dc-app">APP</span><span className="ann-dc-time">Today</span></div>
                {title.trim() && <div className="ann-dc-title">{title.trim()}</div>}
                {body.trim()
                  ? <div className="ann-text" dangerouslySetInnerHTML={{ __html: html }} />
                  : !title.trim() && readyImages.length === 0 && <div className="ann-text ann-empty">Your message preview appears here.</div>}
                {preview && isHttp(reel) && <div className="ann-dc-embed"><span className="ann-linkcard-site">Instagram</span>Reel link preview</div>}
                {readyImages.length > 0 && (
                  <div className={`ann-gallery n${Math.min(readyImages.length, 4)}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {readyImages.slice(0, 4).map((u, i) => <img key={i} src={u} alt="" />)}
                    {readyImages.length > 4 && <span className="ann-more">+{readyImages.length - 4}</span>}
                  </div>
                )}
                {(isHttp(reel) || btnList.length > 0) && (
                  <div className="ann-dc-btns">
                    {isHttp(reel) && <span>▶️ Watch the reel ↗</span>}
                    {btnList.map((b, i) => <span key={i}>{b.label} ↗</span>)}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
        <div className="field-hint">
          Formatting: <code>**bold**</code> <code>_italic_</code> <code>__underline__</code> <code>~~strike~~</code>{' '}
          <code>||spoiler||</code> <code>[text](https://link)</code> — works the same on both apps.
        </div>
      </div>
    </div>
  );
}
