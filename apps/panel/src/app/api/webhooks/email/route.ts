import { recordDetection } from '../../../../lib/detect';
import { parsePaypal, parseCashapp } from '../../../../lib/paypal-email';

/**
 * Instant inbound-email webhook — the SINGLE detection path for PayPal / Cash App.
 *
 * A Google Apps Script bound to the Gmail inbox fires every new payment email at
 * this endpoint within seconds; we parse + record + alert right then. This is the
 * ONE source of truth: the IMAP cron poll used to also record the same emails
 * (under a different id → duplicate alerts) and its slow connect timed the cron
 * out, so it's been retired. Idempotent: we dedupe on messageId.
 */
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.EMAIL_WEBHOOK_SECRET;
  if (!secret) return new Response('email webhook not configured', { status: 503 });

  let body: any;
  try { body = await req.json(); } catch { return new Response('bad json', { status: 400 }); }

  const given = req.headers.get('x-webhook-secret') ?? body?.secret;
  if (given !== secret) return new Response('unauthorized', { status: 401 });

  const from = String(body.from ?? '').toLowerCase();
  const subject = String(body.subject ?? '');
  const text = String(body.text ?? '');
  const messageId = String(body.messageId ?? '').trim();
  if (!messageId) return new Response('missing messageId', { status: 400 });

  // Which rail? PayPal vs Cash App, by sender.
  const isCashApp = /square\.com|cash\.app|cashapp/.test(from);
  const isPaypal = /paypal\.com/.test(from);
  if (!isCashApp && !isPaypal) return Response.json({ ok: true, detected: false, reason: 'sender not a payment rail' });

  const parsed = isPaypal ? parsePaypal(subject, text) : parseCashapp(subject, text);
  if (!parsed) return Response.json({ ok: true, detected: false, reason: 'not a money-received email' });

  await recordDetection({
    source: isPaypal ? 'paypal' : 'cashapp',
    externalId: messageId,
    methodCode: isPaypal ? 'paypal' : 'cashapp',
    amount: parsed.amount,
    currency: parsed.currency,
    // A push is always a fresh arrival — never mark it stale, always announce.
    raw: { subject, name: parsed.name, stale: false, kind: parsed.kind },
  });

  return Response.json({ ok: true, detected: true, kind: parsed.kind, amount: parsed.amount, name: parsed.name });
}
