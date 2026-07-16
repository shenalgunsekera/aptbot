'use client';

import { useRouter } from 'next/navigation';
import { signOutEverywhere } from '../lib/firebase-client';

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      className="ghost"
      onClick={async () => {
        await signOutEverywhere();
        router.push('/login');
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
