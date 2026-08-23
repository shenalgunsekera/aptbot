import { db } from '@union/core';
import { Shell } from '../../components/shell';
import { requireOwner } from '../../lib/auth';
import { ConfigForm } from './form';
import { MethodsEditor } from './methods';
import { PlatformsEditor } from './platforms';
import { ClubsEditor } from './clubs';
import { AdminsEditor } from './admins';
import { SettingsTabs } from './tabs';

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
  const admins = await sql<any[]>`
    select a.id, a.telegram_id, da.discord_id, a.display_name, a.email, a.role, a.disabled
      from admins a
      left join discord_admins da on da.admin_id = a.id
     order by a.disabled asc, a.role desc, a.created_at`;

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="sub">Every money rule in the system. Changes are audited and take effect immediately.</p>
        </div>
      </div>

      <SettingsTabs
        tabs={[
          {
            id: 'general',
            label: 'General',
            node: (
              <>
                <div className="alert warn">
                  Existing requests keep the terms they were created under — changing rake or fees here
                  doesn't rewrite what a player was already quoted.
                </div>
                <ConfigForm cfg={cfg} />
              </>
            ),
          },
          {
            id: 'methods',
            label: 'Payment methods',
            node: (
              <>
                <div className="page-head" style={{ marginBottom: 16 }}>
                  <p className="sub" style={{ margin: 0 }}>How players deposit and get paid — matching, tiers, and fees per method.</p>
                  <a className="btn sm" href="/api/export?type=methods">⬇ Excel</a>
                </div>
                <MethodsEditor methods={methods} />
              </>
            ),
          },
          { id: 'platforms', label: 'Platforms', node: <PlatformsEditor platforms={platforms} /> },
          {
            id: 'clubs',
            label: 'Clubs',
            node: (
              <>
                <p className="sub" style={{ marginBottom: 16 }}>The clubs players route through. When a platform has more than one, players pick which they play in at signup and which each deposit / cash-out goes to.</p>
                <ClubsEditor clubs={clubs} platforms={platforms} />
              </>
            ),
          },
          { id: 'admins', label: 'Admins', node: <AdminsEditor admins={admins} /> },
        ]}
      />
    </Shell>
  );
}
