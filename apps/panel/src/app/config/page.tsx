import { db } from '@union/core';
import { Shell } from '../../components/shell';
import { requireOwner } from '../../lib/auth';
import { ConfigForm } from './form';
import { MethodsEditor } from './methods';
import { PlatformsEditor } from './platforms';
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
  const admins = await sql<any[]>`select id, telegram_id, telegram_username, email, role, disabled from admins order by role desc, created_at`;

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

      <h2>Payment methods</h2>
      <MethodsEditor methods={methods} />

      <h2 style={{ marginTop: 32 }}>Platforms</h2>
      <PlatformsEditor platforms={platforms} />

      <h2 style={{ marginTop: 32 }}>Admins</h2>
      <AdminsEditor admins={admins} />
    </Shell>
  );
}
