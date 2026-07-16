import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { db, type Admin } from '@union/core';
import { createSessionCookie, verifyIdToken } from '../../../lib/auth';

/**
 * Exchange a Firebase ID token for an httpOnly session cookie.
 *
 * The cookie is httpOnly + sameSite=strict + secure: it is never readable from
 * JS, so an XSS in the panel cannot exfiltrate an admin session and start
 * approving payouts.
 */
export async function POST(req: Request) {
  let idToken: string;
  try {
    ({ idToken } = await req.json());
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }
  if (!idToken) return NextResponse.json({ error: 'Missing token' }, { status: 400 });

  let decoded;
  try {
    decoded = await verifyIdToken(idToken);
  } catch {
    return NextResponse.json({ error: 'Invalid sign-in.' }, { status: 401 });
  }

  // Being a valid Firebase user is not being an admin. Anyone can create a
  // Firebase account; only rows in `admins` may enter.
  //
  // First login by an admin added via /setadmin: the row has their email but no
  // Firebase uid yet. admin_bind_firebase claims it — matching on the VERIFIED
  // email from the Google token — so they just sign in and it works, no manual
  // uid wiring. Only a verified email may bind (Google emails are verified).
  const sql = db();
  let admin: Admin | undefined;
  if (decoded.email && decoded.email_verified) {
    const [bound] = await sql<Admin[]>`
      select * from admin_bind_firebase(${decoded.uid}, ${decoded.email})`;
    admin = bound ?? undefined;
  } else {
    const [a] = await sql<Admin[]>`
      select * from admins where firebase_uid = ${decoded.uid} and not disabled`;
    admin = a;
  }

  if (!admin) {
    // Deliberately vague: do not confirm to a stranger whether an email is an
    // admin of this club.
    console.warn(`[panel] rejected sign-in for uid=${decoded.uid} email=${decoded.email}`);
    return NextResponse.json({ error: 'This account does not have panel access.' }, { status: 403 });
  }

  if (process.env.REQUIRE_MFA === 'true' && !decoded.firebase?.sign_in_second_factor) {
    return NextResponse.json(
      { error: 'Two-factor authentication is required. Enrol a second factor, then sign in again.' },
      { status: 403 },
    );
  }

  const cookie = await createSessionCookie(idToken);
  const jar = await cookies();
  jar.set('session', cookie, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: 60 * 60 * 8,
  });

  await sql`select audit(${admin.id}::uuid, 'admin.sign_in', 'admin', ${admin.id}::uuid,
                         ${sql.json({ email: decoded.email, mfa: !!decoded.firebase?.sign_in_second_factor })}::jsonb)`;

  return NextResponse.json({ ok: true, role: admin.role });
}

export async function DELETE() {
  const jar = await cookies();
  jar.delete('session');
  return NextResponse.json({ ok: true });
}
