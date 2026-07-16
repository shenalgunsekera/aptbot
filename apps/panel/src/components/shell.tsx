import Link from 'next/link';
import { db } from '@union/core';
import { getSession } from '../lib/auth';
import { SignOutButton } from './signout';

/**
 * The authenticated shell. Every page renders inside this, and it re-checks the
 * session — so a revoked admin loses access on their next navigation, not when
 * their token happens to expire.
 *
 * Plain language throughout: "Jobs", "Payments", "Cash outs" — never "loader
 * orders", "fills", "withdrawals".
 */
export async function Shell({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) {
    return (
      <div className="login-wrap">
        <div className="card login-card">
          <h1>Session expired</h1>
          <p className="sub" style={{ marginBottom: 16 }}>Please sign in again.</p>
          <Link className="btn" href="/login">Sign in</Link>
        </div>
      </div>
    );
  }

  const sql = db();
  const [counts] = await sql<{ disputes: number; review: number; jobs: number; links: number }[]>`
    select
      (select count(*) from disputes where status='open')::int as disputes,
      (select count(*) from fills where status='awaiting_confirmation' and (escalated_at is not null or withdraw_id is null))::int as review,
      (select count(*) from loader_orders where status in ('pending','claimed'))::int as jobs,
      (select count(*) from players where status='pending')::int as links`;

  const nav = [
    { href: '/', label: 'Overview' },
    { href: '/jobs', label: 'Jobs', count: counts?.jobs },
    { href: '/transactions', label: 'Payments' },
    { href: '/receipts', label: 'Receipts' },
    { href: '/queue', label: 'Cash outs' },
    { href: '/disputes', label: 'Disputes', count: counts?.disputes },
    { href: '/players', label: 'Players', count: counts?.links },
    { href: '/audit', label: 'History' },
    { href: '/config', label: 'Settings', ownerOnly: true },
  ];

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">
          <span className="dot" />
          <span>
            Union
            <small>{session.admin.role === 'owner' ? 'Owner' : 'Admin'} · {session.email}</small>
          </span>
        </div>
        {nav
          .filter((n) => !n.ownerOnly || session.admin.role === 'owner')
          .map((n) => (
            <Link key={n.href} href={n.href} className="nav-link">
              <span>{n.label}</span>
              {n.count ? <span className="badge red">{n.count}</span> : null}
            </Link>
          ))}
        <div className="nav-spacer" />
        {!session.mfa && (
          <div className="badge warn" style={{ margin: '0 10px 8px', textAlign: 'center' }}>2FA off</div>
        )}
        <SignOutButton />
      </nav>
      <main className="main">{children}</main>
    </div>
  );
}
