import { db } from '@union/core';
import { getBot, drainNotifications } from '../../../lib/bot';

/**
 * The sweepers + notification drain, as a scheduled target.
 *
 * On Vercel Hobby, Vercel's own cron only runs daily (a backstop). The real
 * cadence comes from GitHub Actions (.github/workflows/cron.yml) hitting this
 * endpoint every few minutes. Either way it runs the same thing.
 *
 * WITHOUT THIS RUNNING FREQUENTLY, MONEY SILENTLY STICKS: a depositor who takes
 * a handle and never pays would hold the slice forever, and holds would never
 * release. The cron is the clock.
 *
 * Protected by CRON_SECRET so only your scheduler can trigger it.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get('authorization');
  if (secret && auth !== `Bearer ${secret}`) {
    return new Response('unauthorized', { status: 401 });
  }

  try {
    const [swept] = await db()<{ swept_locks: number; swept_holds: number; escalated: number }[]>`
      select * from sweep_all()`;
    const bot = await getBot();
    const delivered = await drainNotifications(bot, 40);
    return Response.json({ ok: true, ...swept, delivered });
  } catch (err) {
    console.error('[cron] failed:', err);
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
