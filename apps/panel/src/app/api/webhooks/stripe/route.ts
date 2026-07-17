import crypto from 'crypto';
import { recordDetection } from '../../../../lib/detect';

/**
 * Stripe webhook — covers card AND Apple Pay (both settle through Stripe).
 *
 * On a successful charge we tell the admins the money landed; we do NOT release
 * anything. Set STRIPE_WEBHOOK_SECRET in Vercel and point a Stripe webhook at
 * https://<host>/api/webhooks/stripe for events charge.succeeded and
 * payment_intent.succeeded.
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

  if (event.type === 'charge.succeeded' || event.type === 'payment_intent.succeeded') {
    const obj = event.data?.object ?? {};
    const amount = Number(obj.amount_received ?? obj.amount ?? 0);   // already in cents
    const currency = String(obj.currency ?? 'usd').toUpperCase();
    if (amount > 0) {
      await recordDetection({
        source: 'stripe', externalId: String(event.id), methodCode: 'stripe',
        amount, currency, raw: { type: event.type, id: obj.id },
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
