import { getBot, drainNotifications } from '../../../../lib/bot';

/**
 * TEMPORARY one-time recovery: run the full IMAP inbox scan (no timeout) to pick
 * up PayPal / Cash App emails that were missed while detection was broken, then
 * deliver them. Protected by CRON_SECRET. Delete after use.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get('authorization');
  if (secret && auth !== `Bearer ${secret}`) return new Response('unauthorized', { status: 401 });

  try {
    const { detectPaypalEmails } = await import('../../../../lib/paypal-email');
    const res = await detectPaypalEmails();   // no timeout — let it finish
    const bot = await getBot();
    const delivered = await drainNotifications(bot, 60);
    return Response.json({ ok: true, recorded: res.total, breakdown: res.breakdown, delivered });
  } catch (err) {
    return Response.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
