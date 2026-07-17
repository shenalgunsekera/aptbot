import { db } from '@union/core';
import { requireAdmin } from '../../../lib/auth';

/**
 * CSV export for every table in the panel. `?type=<name>` picks the dataset; the
 * result downloads as a .csv that opens directly in Excel (UTF-8 BOM so icons and
 * symbols survive). Admin-only. Capped so a huge table can't time the function out.
 */
export const dynamic = 'force-dynamic';

const LIMIT = 10000;

type Exporter = { filename: string; run: (sql: ReturnType<typeof db>) => Promise<Record<string, unknown>[]> };

const EXPORTS: Record<string, Exporter> = {
  players: {
    filename: 'players',
    run: (sql) => sql`
      select p.display_name as name, p.status, p.telegram_id, p.telegram_username,
             coalesce((select string_agg(pf.name || ':' || coalesce(pp.platform_uid, pp.platform_uid_claimed), ' | ')
                         from player_platforms pp join platforms pf on pf.id = pp.platform_id
                        where pp.player_id = p.id), '') as accounts,
             p.created_at
        from players p order by p.created_at desc limit ${LIMIT}`,
  },
  payments: {
    filename: 'payments',
    run: (sql) => sql`
      select v.status, v.kind, v.amount, v.rake_amount, v.currency, v.method_name,
             v.depositor_name, v.payee_name, v.payout_handle, v.payment_ref,
             f.detected_source, f.detected_at, v.hold_until, v.created_at
        from v_fills_detail v left join fills f on f.id = v.id
       order by v.created_at desc limit ${LIMIT}`,
  },
  cashouts: {
    filename: 'cashouts',
    run: (sql) => sql`
      select w.status, w.requested_amount, w.gross_amount, w.rake_amount, w.amount,
             w.amount_remaining, w.currency, w.payout_handle, pl.display_name as player,
             pf.name as platform, pm.name as method, w.created_at, w.completed_at
        from withdraw_requests w
        join players pl on pl.id = w.player_id
        join platforms pf on pf.id = w.platform_id
        join payment_methods pm on pm.id = w.method_id
       order by w.created_at desc limit ${LIMIT}`,
  },
  deposits: {
    filename: 'deposits',
    run: (sql) => sql`
      select d.status, d.amount, d.currency, pl.display_name as player,
             pf.name as platform, pm.name as method, d.created_at, d.completed_at
        from deposit_requests d
        join players pl on pl.id = d.player_id
        join platforms pf on pf.id = d.platform_id
        join payment_methods pm on pm.id = d.method_id
       order by d.created_at desc limit ${LIMIT}`,
  },
  jobs: {
    filename: 'loader-jobs',
    run: (sql) => sql`
      select o.status, o.delta, o.actual_delta, o.currency, o.player_name, o.platform_uid,
             o.reason, o.note, o.failure_reason, o.created_at, o.done_at
        from loader_orders o order by o.created_at desc limit ${LIMIT}`,
  },
  disputes: {
    filename: 'disputes',
    run: (sql) => sql`
      select di.status, di.reason, di.resolution, di.split_to_depositor,
             di.flagged_depositor, di.flagged_payee, di.resolution_note, di.created_at, di.resolved_at
        from disputes di order by di.created_at desc limit ${LIMIT}`,
  },
  receipts: {
    filename: 'receipts',
    run: (sql) => sql`
      select r.reference, r.player_name, r.platform_uid, r.ref_type, r.url,
             r.content_type, r.bytes, r.created_at
        from receipts r order by r.created_at desc limit ${LIMIT}`,
  },
  detections: {
    filename: 'payment-detections',
    run: (sql) => sql`
      select e.source, e.method_code, e.amount, e.currency, e.external_id,
             (e.matched_fill_id is not null) as matched, e.created_at
        from payment_events e order by e.created_at desc limit ${LIMIT}`,
  },
  audit: {
    filename: 'audit-log',
    run: (sql) => sql`
      select a.created_at, ad.display_name as admin, a.action, a.ref_type, a.ref_id, a.detail
        from audit_log a left join admins ad on ad.id = a.admin_id
       order by a.created_at desc limit ${LIMIT}`,
  },
  methods: {
    filename: 'payment-methods',
    run: (sql) => sql`
      select code, name, currency, reversibility, settlement, enabled,
             min_amount, max_amount, club_handle, processor_fee_bps, processor_fee_flat, sort_order
        from payment_methods order by sort_order, name`,
  },
};

export async function GET(req: Request): Promise<Response> {
  try {
    await requireAdmin();
  } catch (err) {
    const m = (err as Error).message;
    return new Response(m === 'FORBIDDEN' ? 'forbidden' : 'sign in', { status: m === 'FORBIDDEN' ? 403 : 401 });
  }

  const type = new URL(req.url).searchParams.get('type') ?? '';
  const exp = EXPORTS[type];
  if (!exp) return new Response('unknown export type', { status: 400 });

  const rows = await exp.run(db());
  const csv = toCsv(rows);
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response('﻿' + csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${exp.filename}-${stamp}.csv"`,
    },
  });
}

function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]!);
  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    let s = v instanceof Date ? v.toISOString()
      : typeof v === 'object' ? JSON.stringify(v)
      : String(v);
    if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map((h) => cell(r[h])).join(','));
  return lines.join('\r\n');
}
