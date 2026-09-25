import { recordDetection } from '../../../../lib/detect';
import { parsePaypal, parseCashapp, parseVenmo, parseZelle } from '../../../../lib/paypal-email';

/**
 * Instant inbound-email webhook — the SINGLE detection path for PayPal / Cash App /
 * Venmo / Zelle.
 *
 * A Google Apps Script bound to the Gmail inbox fires every new payment email at
 * this endpoint within seconds; we parse + record + alert right then. This is the
 * ONE source of truth: the IMAP cron poll used to also record the same emails
 * (under a different id → duplicate alerts) and its slow connect timed the cron
 * out, so it's been retired. Idempotent: we dedupe on messageId.
 *
 * WHY WE MATCH BY CONTENT, NOT SENDER: these emails often arrive FORWARDED into the
 * inbox from another account (Venmo/Zelle live on different addresses). Forwarding
 * rewrites the `From`, so "from:paypal.com" stops matching — which is why PayPal
 * went quiet and Venmo/Zelle were never seen. The rail word ("Venmo", "Zelle",
 * "PayPal", "Cash App") survives forwarding in the subject/body, so we key off that.
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
  // Strip forward/reply prefixes ("Fwd:", "FW:", "Re:") — these emails often arrive
  // forwarded, and the prefix would otherwise leak into the parsed sender name
  // ("Fwd: Ethan Katz" instead of "Ethan Katz").
  const subject = String(body.subject ?? '').replace(/^(?:\s*(?:fwd?|re)\s*:\s*)+/i, '').trim();
  const text = String(body.text ?? '');
  const messageId = String(body.messageId ?? '').trim();
  if (!messageId) return new Response('missing messageId', { status: 400 });

  // Which rail? Detect from the whole email (sender + subject + body) so a FORWARDED
  // notice — whose `From` is the forwarder, not the provider — is still recognised.
  // Order matters: Zelle & Venmo name themselves distinctively; check them before the
  // more generic Cash App / PayPal markers.
  const hay = `${from} ${subject} ${text}`.toLowerCase();
  const rail: 'paypal' | 'cashapp' | 'venmo' | 'zelle' | null =
      /zelle/.test(hay) ? 'zelle'
    : /venmo/.test(hay) ? 'venmo'
    : /paypal/.test(hay) ? 'paypal'
    : /cash\s?app|square\.com|cash\.app/.test(hay) ? 'cashapp'
    : null;
  if (!rail) return Response.json({ ok: true, detected: false, reason: 'not a known payment rail' });

  const parsed = rail === 'paypal' ? parsePaypal(subject, text)
    : rail === 'cashapp' ? parseCashapp(subject, text)
    : rail === 'venmo' ? parseVenmo(subject, text)
    : parseZelle(subject, text);
  if (!parsed) return Response.json({ ok: true, detected: false, reason: 'not a money-received email' });

  await recordDetection({
    source: rail,
    externalId: messageId,
    methodCode: rail,
    amount: parsed.amount,
    currency: parsed.currency,
    // A push is always a fresh arrival — never mark it stale, always announce.
    raw: { subject, name: parsed.name, stale: false, kind: parsed.kind },
  });

  return Response.json({ ok: true, detected: true, rail, kind: parsed.kind, amount: parsed.amount, name: parsed.name });
}
