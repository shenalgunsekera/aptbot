'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { signInWithGoogle, signInWithPassword, establishSession } from '../../lib/firebase-client';

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  async function go(getToken: () => Promise<string>) {
    setBusy(true);
    setError(null);
    try {
      await establishSession(await getToken());
      router.push('/');
      router.refresh();
    } catch (e) {
      setError((e as Error).message || 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="card login-card">
        <h1>Union Settlement</h1>
        <p className="sub" style={{ marginBottom: 20 }}>Admin access only.</p>

        {error && <div className="alert err">{error}</div>}

        <button className="primary" style={{ width: '100%' }} disabled={busy}
                onClick={() => go(signInWithGoogle)}>
          Continue with Google
        </button>

        <div style={{ textAlign: 'center', color: 'var(--text-faint)', fontSize: 11, margin: '14px 0' }}>
          or
        </div>

        <form onSubmit={(e) => { e.preventDefault(); void go(() => signInWithPassword(email, password)); }}>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" type="email" value={email} autoComplete="username"
                   onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input id="password" type="password" value={password} autoComplete="current-password"
                   onChange={(e) => setPassword(e.target.value)} required />
          </div>
          <button type="submit" style={{ width: '100%' }} disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
