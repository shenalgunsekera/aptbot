'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import type { ReusableDraft } from './composer';

/** While any announcement is still delivering, refresh the history every few
 *  seconds so the delivered / failed counts tick up live. Idle otherwise. */
export function AutoRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(t);
  }, [active, router]);
  return null;
}

/** Load a past announcement back into the editor (to resend or tweak it). */
export function ReuseButton({ draft }: { draft: ReusableDraft }) {
  return (
    <button type="button" className="ghost sm"
      onClick={() => window.dispatchEvent(new CustomEvent<ReusableDraft>('ann:reuse', { detail: draft }))}>
      Use again
    </button>
  );
}
