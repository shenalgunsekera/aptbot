'use client';

import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import {
  getAuth, GoogleAuthProvider, signInWithPopup,
  signInWithEmailAndPassword, multiFactor,
  type Auth,
} from 'firebase/auth';

/**
 * Client-side Firebase. These values are public by design — they identify the
 * project, they do not authorise anything. All authority is checked server-side
 * against the `admins` table (see lib/auth.ts).
 */
function config() {
  return {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY!,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN!,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID!,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID!,
  };
}

let _app: FirebaseApp | undefined;

export function app(): FirebaseApp {
  if (_app) return _app;
  _app = getApps()[0] ?? initializeApp(config());
  return _app;
}

export function auth(): Auth {
  return getAuth(app());
}

export async function signInWithGoogle(): Promise<string> {
  const cred = await signInWithPopup(auth(), new GoogleAuthProvider());
  return cred.user.getIdToken();
}

export async function signInWithPassword(email: string, password: string): Promise<string> {
  const cred = await signInWithEmailAndPassword(auth(), email, password);
  return cred.user.getIdToken();
}

/** Whether the signed-in user has a second factor enrolled. */
export function hasMfa(): boolean {
  const u = auth().currentUser;
  return !!u && multiFactor(u).enrolledFactors.length > 0;
}

/** Exchange the Firebase ID token for our httpOnly session cookie. */
export async function establishSession(idToken: string): Promise<void> {
  const res = await fetch('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({ error: 'Sign-in failed' }));
    throw new Error(error);
  }
}

export async function signOutEverywhere(): Promise<void> {
  await fetch('/api/session', { method: 'DELETE' });
  await auth().signOut();
}
