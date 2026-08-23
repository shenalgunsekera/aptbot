'use client';

import { useState, useEffect, useRef, useTransition } from 'react';
import { useRouter } from 'next/navigation';

/** Live receipt search — filters as you type (debounced), no button needed. */
export function ReceiptSearch({ initial, type, method }: { initial: string; type?: string; method?: string }) {
  const [q, setQ] = useState(initial);
  const router = useRouter();
  const [pending, start] = useTransition();
  const first = useRef(true);

  useEffect(() => {
    if (first.current) { first.current = false; return; }   // don't re-fetch on mount
    const t = setTimeout(() => {
      const p = new URLSearchParams();
      if (method && method !== 'all') p.set('method', method);
      if (type && type !== 'all') p.set('type', type);
      if (q.trim()) p.set('q', q.trim());
      const qs = p.toString();
      start(() => router.replace(`/receipts${qs ? `?${qs}` : ''}`, { scroll: false }));
    }, 250);
    return () => clearTimeout(t);
  }, [q, router, type, method]);

  return (
    <div className="btn-row">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search name, ID, or receipt code…"
        style={{ width: 240 }}
        aria-label="Search receipts"
      />
      {pending && <span className="mono" style={{ fontSize: 11, color: 'var(--text-faint)' }}>searching…</span>}
      <a className="btn" href="/api/export?type=receipts">⬇ Excel</a>
    </div>
  );
}
