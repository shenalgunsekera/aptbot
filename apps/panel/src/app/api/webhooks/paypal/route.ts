import { recordDetection } from '../../../../lib/detect';

/**
 * PayPal webhook (Business account). We verify the signature against PayPal's
 * verify-webhook-signature API, then tell the admins a payment landed — we do NOT
 * release. Configure in Vercel: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET,
 * PAYPAL_WEBHOOK_ID, and optionally PAYPAL_API_BASE (defaults to live). Point a
 * PayPal webhook at https://<host>/api/webhooks/paypal for PAYMENT.CAPTURE.COMPLETED.
 */
export const dynamic = 'force-dynamic';

const API_BASE = process.env.PAYPAL_API_BASE ?? 'https://api-m.paypal.com';

export async function POST(req: Request): Promise<Response> {
  const body = await req.text();
  let event: any;
  try { event = JSON.parse(body); } catch { return new Response('bad json', { status: 400 }); }

  if (!(await verifyPaypal(req.headers, event))) {
    return new Response('unverified', { status: 400 });
  }

  if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
    const r = event.resource ?? {};
    const value = r.amount?.value;
    const amount = value ? Math.round(parseFloat(value) * 100) : 0;
    const currency = String(r.amount?.currency_code ?? 'USD').toUpperCase();
    if (amount > 0) {
      await recordDetection({
        source: 'paypal', externalId: String(event.id), methodCode: 'paypal',
        amount, currency, raw: { id: r.id },
      });
    }
  }
  return Response.json({ received: true });
}

async function verifyPaypal(headers: Headers, event: unknown): Promise<boolean> {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!webhookId || !clientId || !secret) return false;

  try {
    const tokenRes = await fetch(`${API_BASE}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${clientId}:${secret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    }).then((r) => r.json());

    const res = await fetch(`${API_BASE}/v1/notifications/verify-webhook-signature`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenRes.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        auth_algo: headers.get('paypal-auth-algo'),
        cert_url: headers.get('paypal-cert-url'),
        transmission_id: headers.get('paypal-transmission-id'),
        transmission_sig: headers.get('paypal-transmission-sig'),
        transmission_time: headers.get('paypal-transmission-time'),
        webhook_id: webhookId,
        webhook_event: event,
      }),
    }).then((r) => r.json());

    return res.verification_status === 'SUCCESS';
  } catch (err) {
    console.error('[paypal] verify failed:', err);
    return false;
  }
}
