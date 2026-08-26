'use client';

import { useState } from 'react';

export interface ClubRow { id: string; name: string; deposited: number; withdrawn: number }
export interface PlatformRow { id: string; name: string; deposited: number; withdrawn: number; clubs: ClubRow[] }

/**
 * The "By platform" table. A platform with more than one club (ClubGG) gets a
 * caret that expands into its clubs — which sum back to the platform row exactly.
 */
export function ByPlatform({ rows, symbol }: { rows: PlatformRow[]; symbol: string }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const fmt = (c: number) => `${symbol}${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const net = (c: number) => ({ color: c >= 0 ? 'var(--ok)' : 'var(--red)' });

  const grandIn = rows.reduce((s, r) => s + r.deposited, 0);
  const grandOut = rows.reduce((s, r) => s + r.withdrawn, 0);

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Platform</th>
            <th style={{ textAlign: 'right' }}>Deposited in</th>
            <th style={{ textAlign: 'right' }}>Cashed out</th>
            <th style={{ textAlign: 'right' }}>Net</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={4}><div className="empty" style={{ border: 'none' }}>No platforms yet.</div></td></tr>
          ) : rows.map((r) => {
            const expandable = r.clubs.length > 1;
            const isOpen = !!open[r.id];
            return (
              <FragmentRow
                key={r.id}
                row={r}
                expandable={expandable}
                isOpen={isOpen}
                onToggle={() => setOpen((o) => ({ ...o, [r.id]: !o[r.id] }))}
                fmt={fmt}
                net={net}
              />
            );
          })}
        </tbody>
        {rows.length > 0 && (
          <tfoot>
            <tr style={{ borderTop: '2px solid var(--border)' }}>
              <td style={{ fontWeight: 700 }}>All platforms</td>
              <td className="mono" style={{ textAlign: 'right', fontWeight: 700 }}>{fmt(grandIn)}</td>
              <td className="mono" style={{ textAlign: 'right', fontWeight: 700 }}>{fmt(grandOut)}</td>
              <td className="mono" style={{ textAlign: 'right', fontWeight: 700, ...net(grandIn - grandOut) }}>{fmt(grandIn - grandOut)}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function FragmentRow({
  row, expandable, isOpen, onToggle, fmt, net,
}: {
  row: PlatformRow; expandable: boolean; isOpen: boolean; onToggle: () => void;
  fmt: (c: number) => string; net: (c: number) => { color: string };
}) {
  return (
    <>
      <tr
        onClick={expandable ? onToggle : undefined}
        style={{ cursor: expandable ? 'pointer' : 'default', background: expandable && isOpen ? 'var(--surface-2, rgba(0,0,0,.02))' : undefined }}
      >
        <td style={{ fontWeight: 600 }}>
          {expandable && (
            <span aria-hidden style={{ display: 'inline-block', width: 16, transition: 'transform .15s', transform: isOpen ? 'rotate(90deg)' : 'none', color: 'var(--muted)' }}>▸</span>
          )}
          {row.name}
          {expandable && <span className="badge muted" style={{ marginLeft: 8, fontWeight: 600 }}>{row.clubs.length} clubs</span>}
        </td>
        <td className="mono" style={{ textAlign: 'right' }}>{fmt(row.deposited)}</td>
        <td className="mono" style={{ textAlign: 'right' }}>{fmt(row.withdrawn)}</td>
        <td className="mono" style={{ textAlign: 'right', fontWeight: 600, ...net(row.deposited - row.withdrawn) }}>{fmt(row.deposited - row.withdrawn)}</td>
      </tr>
      {expandable && isOpen && row.clubs.map((c) => (
        <tr key={c.id} style={{ background: 'var(--surface-2, rgba(0,0,0,.015))' }}>
          <td style={{ paddingLeft: 34, color: 'var(--ink-dim, inherit)' }}>{c.name}</td>
          <td className="mono" style={{ textAlign: 'right' }}>{fmt(c.deposited)}</td>
          <td className="mono" style={{ textAlign: 'right' }}>{fmt(c.withdrawn)}</td>
          <td className="mono" style={{ textAlign: 'right', ...net(c.deposited - c.withdrawn) }}>{fmt(c.deposited - c.withdrawn)}</td>
        </tr>
      ))}
    </>
  );
}
