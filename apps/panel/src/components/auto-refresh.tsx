'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Re-fetches the current page's server data on an interval, so items created
 * elsewhere (a new job from the bot, a payment that just landed) appear without
 * a manual reload. router.refresh() is a soft refresh — it re-runs the server
 * components but preserves client state, so a form you're mid-edit stays put.
 * Pauses while the tab is hidden to avoid pointless queries.
 */
export function AutoRefresh({ seconds = 20 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') router.refresh(); };
    const id = setInterval(tick, seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return null;
}
