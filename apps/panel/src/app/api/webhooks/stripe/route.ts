import crypto from 'crypto';
import { recordDetection } from '../../../../lib/detect';

/**
 * Stripe webhook — covers card AND Apple Pay (both settle through Stripe).
 *
 * On a successful charge we tell the admins the money landed; we do NOT release.
 *
 * Keys (Vercel):
 *   STRIPE_WEBHOOK_SECRET  (whsec_…) — REQUIRED. This is the webhook *signing
 *     secret*, not an API key; it's what proves an event really came from Stripe.
 *   STRIPE_API_KEY  (rk_live_… RESTRICTED key, or sk_…) — OPTIONAL. If set, we
 *     re-fetch the event from Stripe as an extra authenticity check and use its
 *     authoritative amount. A restricted key with "Events: Read" is enough — no
 *     secret key needed.
 *
 * Point a Stripe webhook at https://<host>/api/webhooks/stripe for events
 * charge.succeeded and payment_intent.succeeded.
 */
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return new Response('stripe webhook not configured', { status: 503 });

  const body = await req.text();   // RAW body — required for signature verification
  const sig = req.headers.get('stripe-signature');
  if (!verifyStripe(body, sig, secret)) {
    return new Response('bad signature', { status: 400 });
  }

  let event: any;
  try { event = JSON.parse(body); } catch { return new Response('bad json', { status: 400 }); }

  // Optional belt-and-braces: with a restricted key, pull the event straight from
  // Stripe so a forged/replayed body can't get through even if the signing secret
  // ever leaked. Uses the authoritative amount from Stripe's own record.
  const apiKey = process.env.STRIPE_API_KEY;
  if (apiKey) {
    try {
      const res = await fetch(`https://api.stripe.com/v1/events/${event.id}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) return new Response('could not confirm event', { status: 400 });
      event = await res.json();
    } catch {
      return new Response('event confirm failed', { status: 400 });
    }
  }

  // ONE signal per payment: only checkout.session.completed. Stripe also fires
  // charge.succeeded and payment_intent.succeeded for the same payment — handling
  // those too would notify 3× per payment, so we ignore them. Dedup on the
  // payment_intent (stable across retries), NOT the event id, so a retried or
  // duplicated delivery can never post twice.
  if (event.type === 'checkout.session.completed') {
    const s = event.data?.object ?? {};
    const amount = Number(s.amount_total ?? 0);
    if (s.payment_status === 'paid' && amount > 0) {
      const fillId = s.metadata?.fill_id;
      const payerName = s.customer_details?.name ?? null;   // Stripe billing name
      await recordDetection({
        source: 'stripe',
        externalId: `pay:${s.payment_intent ?? s.id}`,
        methodCode: 'stripe',
        amount,
        currency: String(s.currency ?? 'usd').toUpperCase(),
        ...(fillId ? { fillId } : {}),
        raw: { session: s.id, name: payerName, email: s.customer_details?.email ?? null },
      });
    }
  }
  return Response.json({ received: true });
}

/** Verify Stripe's `t=…,v1=…` signature header with an HMAC (no SDK needed). */
function verifyStripe(payload: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const parts: Record<string, string> = {};
  for (const kv of header.split(',')) {
    const [k, v] = kv.split('=');
    if (k && v) parts[k.trim()] = v.trim();
  }
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;   // 5-min freshness
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected)); } catch { return false; }
}
