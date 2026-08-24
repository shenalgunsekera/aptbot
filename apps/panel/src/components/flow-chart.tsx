'use client';

import { useRef, useState } from 'react';
import { Money } from './ui';

export type Bucket = { t: string; received: number; paid: number };

const GREEN = '#2f9e6b', INDIGO = '#5b5bd6';

/**
 * Received vs paid-out over time, as two overlaid area lines. The SVG draws the
 * areas/lines (scaled by viewBox to fill any width — no side-scroll on a phone);
 * an HTML overlay draws the hover guide, the point dots and the tooltip, all
 * positioned in percentages so they stay crisp and never distort. Move the mouse
 * or drag a finger across it to read the value at any point. No chart library.
 */
export function FlowChart({ buckets, unit }: { buckets: Bucket[]; unit: 'hour' | 'day' }) {
  const W = 760, H = 240, padL = 6, padR = 44, padT = 14, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = buckets.length;
  const max = Math.max(1, ...buckets.map((b) => Math.max(Number(b.received), Number(b.paid))));
  const x = (i: number) => (n <= 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW);
  const y = (v: number) => padT + plotH - (v / max) * plotH;
  const base = padT + plotH;

  const line = (key: 'received' | 'paid') => buckets.map((b, i) => `${x(i).toFixed(1)},${y(Number(b[key])).toFixed(1)}`).join(' ');
  const area = (key: 'received' | 'paid') =>
    n === 0 ? '' : `M ${x(0).toFixed(1)},${base} L ${line(key).split(' ').join(' L ')} L ${x(n - 1).toFixed(1)},${base} Z`;

  const label = (iso: string) => {
    const d = new Date(iso);
    return unit === 'hour'
      ? `${String(d.getUTCHours()).padStart(2, '0')}:00`
      : `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]} ${d.getUTCDate()}`;
  };
  const every = Math.max(1, Math.ceil(n / 6));
  const ticks = [0.5, 1].map((f) => ({ v: max * f, yy: y(max * f) }));

  // Percent helpers so the HTML overlay lines up with the SVG at any size.
  const leftPct = (i: number) => (x(i) / W) * 100;
  const topPct = (v: number) => (y(v) / H) * 100;

  const [hi, setHi] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const pick = (clientX: number) => {
    const el = wrapRef.current;
    if (!el || n === 0) return;
    const rect = el.getBoundingClientRect();
    const xv = ((clientX - rect.left) / rect.width) * W;
    const i = Math.round(((xv - padL) / plotW) * (n - 1));
    setHi(Math.max(0, Math.min(n - 1, i)));
  };

  const hb = hi != null ? buckets[hi] : null;
  const tipLeft = hi != null ? Math.min(88, Math.max(12, leftPct(hi))) : 0;

  return (
    <div
      ref={wrapRef}
      className="flow-wrap"
      onPointerMove={(e) => pick(e.clientX)}
      onPointerDown={(e) => pick(e.clientX)}
      onPointerLeave={() => setHi(null)}
      style={{ touchAction: 'pan-y' }}
    >
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="none"
           role="img" aria-label="Cash flow: received versus paid out over time"
           style={{ display: 'block', height: 'clamp(150px, 34vw, 240px)' }}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={t.yy} y2={t.yy} stroke="var(--border)" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
            <text x={W - padR + 6} y={t.yy + 3} fontSize="11" fill="var(--text-faint)">${Math.round(t.v / 100).toLocaleString('en-US')}</text>
          </g>
        ))}
        <path d={area('received')} fill={GREEN} fillOpacity={0.14} />
        <path d={area('paid')} fill={INDIGO} fillOpacity={0.12} />
        <polyline points={line('received')} fill="none" stroke={GREEN} strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        <polyline points={line('paid')} fill="none" stroke={INDIGO} strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        {buckets.map((b, i) => (
          (i % every === 0 || i === n - 1) && (
            <text key={b.t} x={x(i)} y={H - 8} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
                  fontSize="11" fill="var(--text-faint)">{label(b.t)}</text>
          )
        ))}
      </svg>

      {/* Hover / touch overlay */}
      {hb && (
        <>
          <div className="flow-guide" style={{ left: `${leftPct(hi!)}%`, top: `${(padT / H) * 100}%`, height: `${(plotH / H) * 100}%` }} />
          <div className="flow-dot" style={{ left: `${leftPct(hi!)}%`, top: `${topPct(Number(hb.received))}%`, background: GREEN }} />
          <div className="flow-dot" style={{ left: `${leftPct(hi!)}%`, top: `${topPct(Number(hb.paid))}%`, background: INDIGO }} />
          <div className="flow-tip" style={{ left: `${tipLeft}%` }}>
            <div className="flow-tip-date">{label(hb.t)}</div>
            <div className="flow-tip-row"><span className="dash-dot" style={{ background: GREEN }} /> Received <strong className="mono"><Money minor={Number(hb.received)} currency="USD" /></strong></div>
            <div className="flow-tip-row"><span className="dash-dot" style={{ background: INDIGO }} /> Paid out <strong className="mono"><Money minor={Number(hb.paid)} currency="USD" /></strong></div>
          </div>
        </>
      )}
    </div>
  );
}

/** The headline numbers for the selected range, as cards. */
export function FlowStats({ received, paid, currency = 'USD' }: { received: number; paid: number; currency?: string }) {
  return (
    <>
      <div className="card">
        <div className="stat-label"><span className="dash-dot" style={{ background: GREEN }} /> Received</div>
        <div className="stat-value pos"><Money minor={received} currency={currency} /></div>
        <div className="stat-note">deposits in this range</div>
      </div>
      <div className="card">
        <div className="stat-label"><span className="dash-dot" style={{ background: INDIGO }} /> Paid out</div>
        <div className="stat-value"><Money minor={paid} currency={currency} /></div>
        <div className="stat-note">cash-outs in this range</div>
      </div>
    </>
  );
}
