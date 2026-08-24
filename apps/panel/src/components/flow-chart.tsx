import { Money } from './ui';

export type Bucket = { t: string; received: number; paid: number };

/**
 * Received vs paid-out over time, as two overlaid area lines. Pure inline SVG,
 * scaled by its viewBox so it fills the container at any width — no horizontal
 * scroll on a phone, no chart library (CSP-safe). Lines cope with 24 or 30
 * points far better than paired bars ever could on a narrow screen.
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
  const every = Math.max(1, Math.ceil(n / 6));           // ~6 x-labels, phone-safe
  const ticks = [0.5, 1].map((f) => ({ v: max * f, yy: y(max * f) }));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="none"
         role="img" aria-label="Cash flow: received versus paid out over time"
         style={{ display: 'block', height: 'clamp(150px, 34vw, 240px)' }}>
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={padL} x2={W - padR} y1={t.yy} y2={t.yy} stroke="var(--border)" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
          <text x={W - padR + 6} y={t.yy + 3} fontSize="11" fill="var(--text-faint)">${Math.round(t.v / 100).toLocaleString('en-US')}</text>
        </g>
      ))}
      <path d={area('received')} fill="#2f9e6b" fillOpacity={0.14} />
      <path d={area('paid')} fill="#5b5bd6" fillOpacity={0.12} />
      <polyline points={line('received')} fill="none" stroke="#2f9e6b" strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <polyline points={line('paid')} fill="none" stroke="#5b5bd6" strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      {buckets.map((b, i) => (
        (i % every === 0 || i === n - 1) && (
          <text key={b.t} x={x(i)} y={H - 8} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
                fontSize="11" fill="var(--text-faint)">{label(b.t)}</text>
        )
      ))}
    </svg>
  );
}

/** The headline numbers for the selected range, as cards. */
export function FlowStats({ received, paid, currency = 'USD' }: { received: number; paid: number; currency?: string }) {
  return (
    <>
      <div className="card">
        <div className="stat-label"><span className="dash-dot" style={{ background: '#2f9e6b' }} /> Received</div>
        <div className="stat-value pos"><Money minor={received} currency={currency} /></div>
        <div className="stat-note">deposits in this range</div>
      </div>
      <div className="card">
        <div className="stat-label"><span className="dash-dot" style={{ background: '#5b5bd6' }} /> Paid out</div>
        <div className="stat-value"><Money minor={paid} currency={currency} /></div>
        <div className="stat-note">cash-outs in this range</div>
      </div>
    </>
  );
}
