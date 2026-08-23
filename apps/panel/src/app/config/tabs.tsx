'use client';

import { useState } from 'react';

/**
 * Settings sections as tabs — one focused panel at a time instead of one long
 * scroll. Each section is a server-rendered node passed in; we just toggle which
 * is visible, so no data-fetching or behaviour changes.
 */
export function SettingsTabs({ tabs }: { tabs: { id: string; label: string; node: React.ReactNode }[] }) {
  const [active, setActive] = useState(tabs[0]?.id ?? '');
  return (
    <>
      <div className="tabs" role="tablist" aria-label="Settings sections">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={active === t.id}
            className={`tab ${active === t.id ? 'active' : ''}`}
            onClick={() => setActive(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div key={t.id} role="tabpanel" hidden={active !== t.id}>
          {t.node}
        </div>
      ))}
    </>
  );
}
