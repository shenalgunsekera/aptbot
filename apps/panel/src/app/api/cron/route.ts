import { db } from '@union/core';

/**
 * The sweepers, as a Vercel Cron target.
 *
 * Locally these run as a setInterval in the bot process. On Vercel there is no
 * forever, so Vercel Cron hits this endpoint on a schedule (see vercel.json) and
 * it runs the same sweep_all(): expired locks return to the queue, elapsed holds
 * release or escalate, unanswered payments escalate.
 *
 * WITHOUT THIS, MONEY SILENTLY STICKS. A depositor who takes a handle and never
 * pays would hold the slice forever; a hold would never release. The cron is not
 * optional — it is the clock.
 *
 * Protected by CRON_SECRET so only Vercel's scheduler (and you) can trigger it.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get('authorization');
  // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` when the env var is set.
  if (secret && auth !== `Bearer ${secret}`) {
    return new Response('unauthorized', { status: 401 });
  }

  try {
    const [r] = await db()<{ swept_locks: number; swept_holds: number; escalated: number }[]>`
      select * from sweep_all()`;
    // Also run the notification drainer inline — on Vercel there is no persistent
    // notifier loop, so the cron pushes any pending outbox messages too.
    await drainNotifications();
    return Response.json({ ok: true, ...r });
  } catch (err) {
    console.error('[cron] failed:', err);
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
}

/**
 * Drain a batch of the notification outbox by delivering via the bot's API.
 * Kept small per invocation; the cron runs frequently.
 */
async function drainNotifications(): Promise<void> {
  const { getBot } = await import('../../../lib/bot');
  const { renderNotification } = await import('@union/bot/build');
  const bot = await getBot();
  const sql = db();

  const [cfg] = await sql<{ admin_group_chat_id: number | null }[]>`select admin_group_chat_id from config where id`;
  const rows = await sql<any[]>`
    select n.*, p.telegram_id as player_tg, a.telegram_id as admin_tg
      from notifications n
      left join players p on p.id = n.player_id
      left join admins a on a.id = n.admin_id
     where n.status='pending' and n.send_after <= now()
     order by n.id limit 25 for update of n skip locked`;

  for (const n of rows) {
    const chatId = n.audience === 'admins' ? cfg?.admin_group_chat_id : (n.player_tg ?? n.admin_tg);
    const msg = renderNotification(n);
    if (!chatId || !msg) { await sql`update notifications set status='skipped' where id=${n.id}`; continue; }
    try {
      await bot.api.sendMessage(chatId, msg.text, { parse_mode: 'Markdown', ...(msg.keyboard ? { reply_markup: msg.keyboard } : {}) });
      await sql`update notifications set status='sent', sent_at=now() where id=${n.id}`;
    } catch (err) {
      const desc = String((err as any)?.description ?? err);
      const giveUp = /blocked|deactivated|chat not found|kicked/i.test(desc) || n.attempts >= 4;
      await sql`update notifications set status=${giveUp ? 'failed' : 'pending'}, attempts=${n.attempts + 1},
                last_error=${desc.slice(0, 300)}, send_after=now()+interval '2 minutes' where id=${n.id}`;
    }
  }
}
