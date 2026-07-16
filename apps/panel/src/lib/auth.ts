import 'server-only';
import { cookies } from 'next/headers';
import { initializeApp, getApps, cert, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { db, type Admin } from '@union/core';

/**
 * Firebase Auth for identity; Postgres for authority.
 *
 * Firebase answers "who is this?" — it verifies the session cookie and gives us
 * a uid. It does NOT answer "what may they do?". Role lives in the `admins`
 * table and is read fresh on every request.
 *
 * That split is deliberate. A custom claim baked into a token is a snapshot: it
 * keeps working after you revoke someone until the token expires. Money systems
 * cannot have a "you're fired, effective in one hour" window. Disabling an admin
 * row takes effect on their very next request.
 */

let _app: App | undefined;

function adminApp(): App {
  if (_app) return _app;
  const existing = getApps();
  if (existing.length) {
    _app = existing[0]!;
    return _app;
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  // Env vars mangle newlines; restore them.
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      'Firebase Admin is not configured. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL ' +
        'and FIREBASE_PRIVATE_KEY in .env (see .env.example).',
    );
  }

  _app = initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
  return _app;
}

export interface Session {
  uid: string;
  email: string;
  admin: Admin;
  /** True when Firebase asserts the sign-in used a second factor. */
  mfa: boolean;
}

/**
 * The gate. Returns null for anyone who is not a live, enabled admin.
 *
 * `checkRevoked: true` costs a round-trip to Firebase on every request and is
 * worth it here: it means "sign this person out everywhere" is immediate rather
 * than eventual.
 */
export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  const token = jar.get('session')?.value;
  if (!token) return null;

  let decoded;
  try {
    decoded = await getAuth(adminApp()).verifySessionCookie(token, true);
  } catch {
    return null;
  }

  const sql = db();
  const [admin] = await sql<Admin[]>`
    select * from admins where firebase_uid = ${decoded.uid} and not disabled`;
  if (!admin) return null;

  // Firebase reports second-factor sign-in via the sign_in_provider / amr claims.
  const factors = (decoded.firebase as { sign_in_second_factor?: string } | undefined);
  const mfa = Boolean(factors?.sign_in_second_factor);

  return { uid: decoded.uid, email: decoded.email ?? admin.email, admin, mfa };
}

/** Use in server components/actions that must not run for non-admins. */
export async function requireAdmin(): Promise<Session> {
  const s = await getSession();
  if (!s) throw new Error('UNAUTHENTICATED');
  if (process.env.REQUIRE_MFA === 'true' && !s.mfa) throw new Error('MFA_REQUIRED');
  return s;
}

/** Owner-only actions: config, backstop handles, bans, manual adjustments. */
export async function requireOwner(): Promise<Session> {
  const s = await requireAdmin();
  if (s.admin.role !== 'owner') throw new Error('FORBIDDEN');
  return s;
}

export async function createSessionCookie(idToken: string): Promise<string> {
  const expiresIn = 60 * 60 * 8 * 1000; // 8h — a working shift, not a month
  return getAuth(adminApp()).createSessionCookie(idToken, { expiresIn });
}

export async function verifyIdToken(idToken: string) {
  return getAuth(adminApp()).verifyIdToken(idToken, true);
}
