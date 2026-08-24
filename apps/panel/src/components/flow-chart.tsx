import { Money } from './ui';

export type Bucket = { t: string; received: number; paid: number };

/**
 * A grouped bar chart of money in (received) vs money out (paid) per time
 * bucket. Pure inline SVG — no chart library, so it's CSP-safe. Scales to the
 * tallest bar; labels thin out automatically so they never collide.
 */
export function FlowChart({ buckets, unit, currency = 'USD' }: {
  buckets: Bucket[];
  unit: 'hour' | 'day';
  currency?: string;
}) {
  const W = 900, H = 220, padL = 8, padR = 8, padT = 12, padB = 26;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const n = Math.max(buckets.length, 1);
  const max = Math.max(1, ...buckets.map((b) => Math.max(b.received, b.paid)));
  const slot = plotW / n;
  const barW = Math.max(2, Math.min(14, slot / 2 - 2));
  const y = (v: number) => padT + plotH - (v / max) * plotH;

  const label = (iso: string) => {
    const d = new Date(iso);
    return unit === 'hour'
      ? `${String(d.getUTCHours()).padStart(2, '0')}:00`
      : `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]} ${d.getUTCDate()}`;
  };
  // Show at most ~10 x-axis labels so they never overlap.
  const every = Math.ceil(n / 10);

  // A couple of horizontal guide lines with money labels.
  const ticks = [0.5, 1].map((f) => ({ v: max * f, yy: y(max * f) }));

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet"
           role="img" aria-label="Cash flow: received versus paid out" style={{ display: 'block', minWidth: 520 }}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={t.yy} y2={t.yy} stroke="var(--border)" strokeDasharray="3 4" />
            <text x={W - padR} y={t.yy - 3} textAnchor="end" fontSize="10" fill="var(--text-faint)">
              ${Math.round(t.v / 100).toLocaleString('en-US')}
            </text>
          </g>
        ))}
        {buckets.map((b, i) => {
          const cx = padL + i * slot + slot / 2;
          const base = padT + plotH;
          return (
            <g key={b.t}>
              <title>{`${label(b.t)} — received $${(b.received / 100).toFixed(2)}, paid $${(b.paid / 100).toFixed(2)}`}</title>
              <rect x={cx - barW - 1} y={y(b.received)} width={barW} height={base - y(b.received)} rx={1.5} fill="#2f9e6b" />
              <rect x={cx + 1} y={y(b.paid)} width={barW} height={base - y(b.paid)} rx={1.5} fill="#5b5bd6" />
              {i % every === 0 && (
                <text x={cx} y={H - 9} textAnchor="middle" fontSize="10" fill="var(--text-faint)">{label(b.t)}</text>
              )}
            </g>
          );
        })}
        <line x1={padL} x2={W - padR} y1={padT + plotH} y2={padT + plotH} stroke="var(--border)" />
      </svg>
    </div>
  );
}

/** Legend + a compact "in / out / net" readout for the current range. */
export function FlowLegend({ received, paid, currency = 'USD' }: { received: number; paid: number; currency?: string }) {
  const net = received - paid;
  return (
    <div className="flow-legend">
      <span className="flow-key"><span className="dash-dot" style={{ background: '#2f9e6b' }} /> Received <strong className="mono"><Money minor={received} currency={currency} /></strong></span>
      <span className="flow-key"><span className="dash-dot" style={{ background: '#5b5bd6' }} /> Paid out <strong className="mono"><Money minor={paid} currency={currency} /></strong></span>
      <span className="flow-key">Net <strong className={`mono ${net >= 0 ? 'pos' : 'neg'}`}><Money minor={net} currency={currency} /></strong></span>
    </div>
  );
}
