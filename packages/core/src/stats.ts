import { db } from './db.js';

export interface PlatformTotals {
  id: string;
  name: string;
  deposited: number; // minor units — money received into this platform
  withdrawn: number; // minor units — money paid out of this platform
}

/**
 * Per-platform money in and out, all-time. Measured on RELEASED fills — the same
 * definition the Overview cash-flow chart uses — so a deposit fill counts toward
 * the platform it landed on and a withdraw fill toward the platform it came off.
 * A P2P fill (both ids set) counts on both sides, exactly as the chart totals do.
 */
export async function platformTotals(): Promise<PlatformTotals[]> {
  return db()<PlatformTotals[]>`
    with dep as (
      select d.platform_id, sum(f.amount)::bigint as amt
        from fills f join deposit_requests d on d.id = f.deposit_id
       where f.status = 'released' group by d.platform_id
    ), wd as (
      select w.platform_id, sum(f.amount)::bigint as amt
        from fills f join withdraw_requests w on w.id = f.withdraw_id
       where f.status = 'released' group by w.platform_id
    )
    select p.id, p.name,
           coalesce(dep.amt, 0)::bigint as deposited,
           coalesce(wd.amt, 0)::bigint as withdrawn
      from platforms p
      left join dep on dep.platform_id = p.id
      left join wd  on wd.platform_id = p.id
     order by p.sort_order, p.name`;
}
