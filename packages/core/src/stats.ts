import { db } from './db.js';

export interface PlatformTotals {
  id: string;
  name: string;
  deposited: number; // minor units — money received into this platform
  withdrawn: number; // minor units — money paid out of this platform
}

/**
 * Per-platform money in and out. Measured on RELEASED fills — the same definition
 * the Overview cash-flow chart uses — so a deposit fill counts toward the platform
 * it landed on and a withdraw fill toward the platform it came off. A P2P fill
 * (both ids set) counts on both sides, exactly as the chart totals do.
 *
 * Pass [from, to) to scope to a window (released_at in range), matching the chart's
 * range selector. Omit both for all-time.
 */
export async function platformTotals(from?: Date, to?: Date): Promise<PlatformTotals[]> {
  const sql = db();
  const range = from && to ? sql`and f.released_at >= ${from} and f.released_at < ${to}` : sql``;
  return sql<PlatformTotals[]>`
    with dep as (
      select d.platform_id, sum(f.amount)::bigint as amt
        from fills f join deposit_requests d on d.id = f.deposit_id
       where f.status = 'released' ${range} group by d.platform_id
    ), wd as (
      select w.platform_id, sum(f.amount)::bigint as amt
        from fills f join withdraw_requests w on w.id = f.withdraw_id
       where f.status = 'released' ${range} group by w.platform_id
    )
    select p.id, p.name,
           coalesce(dep.amt, 0)::bigint as deposited,
           coalesce(wd.amt, 0)::bigint as withdrawn
      from platforms p
      left join dep on dep.platform_id = p.id
      left join wd  on wd.platform_id = p.id
     order by p.sort_order, p.name`;
}

export interface ClubTotals {
  platformId: string;
  clubId: string;
  name: string;
  deposited: number;
  withdrawn: number;
}

/**
 * The same money, split by CLUB (ClubGG has several). Each released fill is tied
 * to the club its loader order serviced — deposit fills via ref_type 'fill', cash
 * -out fills via 'withdraw_request' — so a platform's clubs sum back to its total.
 * A picked-one-per-ref subquery guards against a fill with more than one loader
 * order double-counting. Same optional [from, to) window as platformTotals.
 */
export async function clubTotals(from?: Date, to?: Date): Promise<ClubTotals[]> {
  const sql = db();
  const dr = from && to ? sql`and f.released_at >= ${from} and f.released_at < ${to}` : sql``;
  return sql<ClubTotals[]>`
    with dep as (
      select club_id, sum(amount)::bigint as amt from (
        select f.amount,
               (select lo.club_id from loader_orders lo
                 where lo.ref_type = 'fill' and lo.ref_id = f.id order by lo.created_at limit 1) as club_id
          from fills f
         where f.status = 'released' and f.deposit_id is not null ${dr}
      ) x where club_id is not null group by club_id
    ), wd as (
      select club_id, sum(amount)::bigint as amt from (
        select f.amount,
               (select lo.club_id from loader_orders lo
                 where lo.ref_type = 'withdraw_request' and lo.ref_id = f.withdraw_id order by lo.created_at limit 1) as club_id
          from fills f
         where f.status = 'released' and f.withdraw_id is not null ${dr}
      ) x where club_id is not null group by club_id
    )
    select c.platform_id as "platformId", c.id as "clubId", c.name,
           coalesce(dep.amt, 0)::bigint as deposited,
           coalesce(wd.amt, 0)::bigint as withdrawn
      from clubs c
      left join dep on dep.club_id = c.id
      left join wd  on wd.club_id  = c.id
     order by c.name`;
}
