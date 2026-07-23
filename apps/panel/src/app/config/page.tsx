import { db } from '@union/core';
import { Shell } from '../../components/shell';
import { requireOwner } from '../../lib/auth';
import { ConfigForm } from './form';
import { MethodsEditor } from './methods';
import { PlatformsEditor } from './platforms';
import { ClubsEditor } from './clubs';
import { AdminsEditor } from './admins';

export const dynamic = 'force-dynamic';

export default async function ConfigPage() {
  // Owner-only: this page sets every money rule in the system.
  try {
    await requireOwner();
  } catch {
    return (
      <Shell>
        <h1>Config</h1>
        <div className="alert err">Owner access required.</div>
      </Shell>
    );
  }

  const sql = db();
  const [cfg] = await sql<any[]>`select * from config where id`;
  const methods = await sql<any[]>`select * from payment_methods order by sort_order, name`;
  const platforms = await sql<any[]>`select * from platforms order by sort_order, name`;
  const clubs = await sql<any[]>`select id, platform_id, name, platform_club_id, enabled from clubs order by name`;
  const admins = await sql<any[]>`select id, telegram_id, display_name, email, role, disabled from admins order by role desc, created_at`;

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>Config</h1>
          <p className="sub">Every money rule in the system. Changes are audited and take effect immediately.</p>
        </div>
      </div>

      <div className="alert warn">
        Existing requests keep the terms they were created under — changing rake or fees here does
        not retroactively rewrite what a player was already quoted.
      </div>

      <ConfigForm cfg={cfg} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h2 style={{ marginBottom: 0 }}>Payment methods</h2>
        <a className="btn sm" href="/api/export?type=methods">⬇ Excel</a>
      </div>
      <MethodsEditor methods={methods} />

      <h2 style={{ marginTop: 32 }}>Platforms</h2>
      <PlatformsEditor platforms={platforms} />

      <h2 style={{ marginTop: 32 }}>Clubs</h2>
      <p className="sub">The clubs players route through. When a platform has more than one, players pick which they play in at signup and which each deposit/cash-out goes to.</p>
      <ClubsEditor clubs={clubs} platforms={platforms} />

      <h2 style={{ marginTop: 32 }}>Admins</h2>
      <AdminsEditor admins={admins} />
    </Shell>
  );
}
