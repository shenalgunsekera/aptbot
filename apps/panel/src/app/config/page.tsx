import { db } from '@union/core';
import { Shell } from '../../components/shell';
import { requireOwner } from '../../lib/auth';
import { ConfigForm } from './form';
import { MethodsEditor } from './methods';

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
    </Shell>
  );
}
