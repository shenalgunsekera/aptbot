import { db } from '@union/core';
import { Shell } from '../../components/shell';
import { DisputeCard } from './card';

export const dynamic = 'force-dynamic';

interface Row {
  id: string;
  fill_id: string;
  reason: string;
  evidence: any[];
  created_at: string;
  opened_by_player: string | null;
  amount: number;
  currency: string;
  payment_ref: string | null;
  submitted_at: string | null;
  method_name: string;
  reversibility: string;
  kind: string;
  depositor_name: string | null;
  depositor_id: string | null;
  depositor_uid: string | null;
  payee_name: string | null;
  payee_id: string | null;
  payout_handle: string;
  receipts: any[];
  depositor_flags: number;
  payee_flags: number;
  pair_history: number;
}

export default async function DisputesPage() {
  const sql = db();

  const rows = await sql<Row[]>`
    select di.id, di.fill_id, di.reason, di.evidence, di.created_at, di.opened_by_player,
           v.amount, v.currency, v.payment_ref, v.submitted_at,
           v.method_name, v.reversibility, v.kind,
           v.depositor_name, v.depositor_id, v.depositor_uid,
           v.payee_name, v.payee_id, v.payout_handle, v.receipts,
           coalesce(jsonb_array_length(dp.risk_flags), 0) as depositor_flags,
           coalesce(jsonb_array_length(wp.risk_flags), 0) as payee_flags,
           -- How many times have these two settled with each other before? Two
           -- strangers disagreeing is a dispute; two who transact constantly
           -- disagreeing is a pattern.
           (select count(*) from fills f2
              join deposit_requests d2 on d2.id = f2.deposit_id
              join withdraw_requests w2 on w2.id = f2.withdraw_id
             where d2.player_id = v.depositor_id and w2.player_id = v.payee_id
               and f2.id <> v.id)::int as pair_history
      from disputes di
      join v_fills_detail v on v.id = di.fill_id
      left join players dp on dp.id = v.depositor_id
      left join players wp on wp.id = v.payee_id
     where di.status = 'open'
     order by di.created_at`;

  return (
    <Shell>
      <div className="page-head">
        <div>
          <h1>Disputes</h1>
          <p className="sub">
            Both sides are paused until you decide. The transaction ID is your main evidence — check it
            against the payment provider. Screenshots come second; they're easy to fake.
          </p>
        </div>
        <a className="btn" href="/api/export?type=disputes">⬇ Excel</a>
      </div>

      {rows.length === 0 ? (
        <div className="table-wrap"><div className="empty">No open disputes. 🎉</div></div>
      ) : (
        <div className="grid" style={{ gap: 16 }}>
          {rows.map((r) => <DisputeCard key={r.id} row={r} />)}
        </div>
      )}
    </Shell>
  );
}
