'use client';

import { useState, useEffect, useTransition } from 'react';
import type { Result } from '../lib/actions';

/**
 * A button wired to a server action, with the confirm/pending/error handling
 * that every money action in this panel needs.
 *
 * `confirm` is not decoration. Releasing a fill, reversing a payment, paying a
 * withdrawal from the float — none of these can be undone, and a mis-click at
 * 3am is real money. Anything irreversible gets a confirm string that states
 * the consequence, not "Are you sure?".
 */
export function ActionButton({
  action,
  label,
  confirm,
  variant = '',
  small,
  disabled,
}: {
  action: () => Promise<Result>;
  label: string;
  confirm?: string;
  variant?: '' | 'primary' | 'ok' | 'danger' | 'ghost';
  small?: boolean;
  disabled?: boolean;
}) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<Result | null>(null);

  return (
    <span>
      <button
        className={`${variant} ${small ? 'sm' : ''}`}
        disabled={pending || disabled}
        onClick={() => {
          if (confirm && !window.confirm(confirm)) return;
          setMsg(null);
          start(async () => setMsg(await action()));
        }}
      >
        {pending ? '…' : label}
      </button>
      {msg && !msg.ok && (
        <div className="alert err" style={{ marginTop: 6 }}>{msg.error}</div>
      )}
      {msg && msg.ok && msg.message && (
        <div className="alert ok" style={{ marginTop: 6 }}>{msg.message}</div>
      )}
    </span>
  );
}

/** A form that collects a reason/note before firing an action. */
export function PromptAction({
  label,
  title,
  fields,
  action,
  variant = '',
  confirm,
}: {
  label: string;
  title: string;
  fields: Array<{ name: string; label: string; type?: string; placeholder?: string; required?: boolean }>;
  action: (values: Record<string, string>) => Promise<Result>;
  variant?: '' | 'primary' | 'ok' | 'danger';
  confirm?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<Result | null>(null);

  if (!open) {
    return <button className={`${variant} sm`} onClick={() => setOpen(true)}>{label}</button>;
  }

  return (
    <div className="card" style={{ marginTop: 8 }}>
      <strong style={{ fontSize: 13 }}>{title}</strong>
      <form
        style={{ marginTop: 10 }}
        onSubmit={(e) => {
          e.preventDefault();
          const fd = new FormData(e.currentTarget);
          const values = Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v)]));
          if (confirm && !window.confirm(confirm)) return;
          setMsg(null);
          start(async () => {
            const r = await action(values);
            setMsg(r);
            if (r.ok) setOpen(false);
          });
        }}
      >
        {fields.map((f) => (
          <div className="field" key={f.name}>
            <label htmlFor={f.name}>{f.label}</label>
            {f.type === 'textarea' ? (
              <textarea id={f.name} name={f.name} placeholder={f.placeholder} required={f.required} />
            ) : (
              <input id={f.name} name={f.name} type={f.type ?? 'text'}
                     placeholder={f.placeholder} required={f.required} />
            )}
          </div>
        ))}
        {msg && !msg.ok && <div className="alert err">{msg.error}</div>}
        <div className="btn-row">
          <button type="submit" className={variant} disabled={pending}>
            {pending ? 'Working…' : 'Confirm'}
          </button>
          <button type="button" className="ghost" onClick={() => setOpen(false)}>Cancel</button>
        </div>
      </form>
    </div>
  );
}

export function Money({ minor, currency = 'USD', signed }: { minor: number; currency?: string; signed?: boolean }) {
  const neg = minor < 0;
  const abs = Math.abs(minor);
  const sym = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : currency + ' ';
  const s = `${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
  return (
    <span className="mono">
      {neg ? '−' : signed ? '+' : ''}{sym}{s}
    </span>
  );
}

/**
 * Relative timestamp — "24s ago".
 *
 * `now` is deliberately state rather than a plain Date.now() call at render.
 *
 * Relative time is a moving target: the server renders "23s ago", the client
 * hydrates a moment later and computes "24s ago", and React throws a hydration
 * mismatch because the HTML differs. Reading the clock during render makes the
 * component non-deterministic, and SSR requires determinism.
 *
 * So: the first paint (server AND client) shows a fixed UTC clock time derived
 * only from the prop — identical on both sides by construction. After mount we
 * have a clock, and switch to relative.
 *
 * The tick is a bonus that falls out of the fix: this is an ops panel where "how
 * long has this dispute been open" matters, and a stale number on a page nobody
 * reloaded is its own small lie.
 */
export function Ago({ at }: { at: string | Date | null }) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  if (!at) return <span className="mono">—</span>;

  const d = new Date(at);
  const iso = d.toISOString();

  // Pre-hydration: no clock, so render something derived purely from the prop.
  if (now === null) {
    return <span className="mono" title={iso}>{iso.slice(11, 16)}Z</span>;
  }

  const secs = Math.floor((now - d.getTime()) / 1000);
  const abs = Math.abs(secs);
  const t =
    abs < 60 ? `${abs}s` :
    abs < 3600 ? `${Math.floor(abs / 60)}m` :
    abs < 86400 ? `${Math.floor(abs / 3600)}h` :
    `${Math.floor(abs / 86400)}d`;

  return (
    <span className="mono" title={iso}>
      {secs < 0 ? `in ${t}` : `${t} ago`}
    </span>
  );
}
