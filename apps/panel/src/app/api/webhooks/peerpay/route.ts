import crypto from 'node:crypto';
import { recordDetection } from '../../../../lib/detect';

/**
 * PeerPay (ZKP2P Pay) webhook — fires when a player's deposit checkout settles.
 *
 * We mint a checkout per PeerPay deposit with notes.merchantOrderId = the fill id,
 * so PAYMENT_SETTLED tells us EXACTLY which fill was paid. recordDetection →
 * payment_detect_fill submits proof (never releases — an admin still verifies) and
 * posts "payment.detected" to the payments channel on both platforms. Idempotent:
 * we dedupe on the PeerPay payment id.
 *
 * Signature (per PeerPay docs): HMAC-SHA256 with the raw webhook secret as key,
 * over `${timestamp}.${body}`, hex-encoded, sent in X-Webhook-Signature. We accept
 * the secret both as-given and with the `whsec_` prefix stripped, and reject
 * deliveries older than 5 minutes (replay guard).
 */
export const dynamic = 'force-dynamic';

const RAIL_LABEL: Record<string, string> = {
  venmo: 'Venmo', cashapp: 'Cash App', zelle: 'Zelle', paypal: 'PayPal',
  revolut: 'Revolut', wise: 'Wise', monzo: 'Monzo', chime: 'Chime',
};
const railLabel = (r?: string | null) =>
  r ? (RAIL_LABEL[r.toLowerCase()] ?? r.charAt(0).toUpperCase() + r.slice(1)) : '';

/** HMAC-SHA256(secret, `${timestamp}.${body}`) as hex, per PeerPay docs. Tolerant
 *  of an optional `vN,`/`sha256=` token prefix and of the whsec_ prefix on the key. */
function verify(secret: string, timestamp: string, body: string, sigHeader: string): boolean {
  if (!timestamp || !sigHeader) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const signed = `${timestamp}.${body}`;
  const keys = [secret, secret.replace(/^whsec_/, '')];
  // Header is normally a bare hex string; be liberal about separators / token prefixes.
  const tokens = sigHeader.split(/[\s,]+/).map((t) => (t.includes('=') ? t.split('=').pop()! : t)).filter(Boolean);
  for (const key of keys) {
    const expected = crypto.createHmac('sha256', key).update(signed).digest('hex');
    const expBuf = Buffer.from(expected);
    for (const tok of tokens) {
      const tokBuf = Buffer.from(tok.toLowerCase());
      if (tokBuf.length === expBuf.length && crypto.timingSafeEqual(tokBuf, expBuf)) return true;
    }
  }
  return false;
}

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.PEERPAY_WEBHOOK_SECRET;
  if (!secret) return new Response('peerpay webhook not configured', { status: 503 });

  const raw = await req.text();
  const h = req.headers;
  const timestamp = h.get('x-webhook-timestamp') ?? h.get('webhook-timestamp') ?? '';
  const sig = h.get('x-webhook-signature') ?? h.get('webhook-signature') ?? '';
  if (!verify(secret, timestamp, raw, sig)) return new Response('bad signature', { status: 401 });

  let evt: any;
  try { evt = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }

  // Money has landed only on PAYMENT_SETTLED; acknowledge everything else so it
  // isn't retried.
  if (evt?.type !== 'PAYMENT_SETTLED') return Response.json({ ok: true, ignored: evt?.type ?? 'unknown' });

  const order = evt?.data?.order ?? null;
  const payment = evt?.data?.payment ?? null;
  const fillId = String(order?.notes?.merchantOrderId ?? '').trim();
  const paymentId = String(payment?.id ?? evt?.id ?? '').trim();
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fillId);
  if (!isUuid || !paymentId) return Response.json({ ok: true, detected: false, reason: 'no matchable fill/payment id' });

  // Credit the FULL requested deposit (we absorb the PeerPay fee); the fill's own
  // gross_to_send is what actually shows on the alert.
  const requested = Number(order?.requestedUsdcAmount ?? payment?.paymentAmount ?? 0);
  const amountCents = Math.round(requested * 100);

  await recordDetection({
    source: 'peerpay',
    externalId: `peerpay:${paymentId}`,
    methodCode: '',                 // ignored on the fill-id path
    fillId,
    amount: amountCents,
    currency: 'USD',
    raw: {
      source_detail: `PeerPay${payment?.rail ? ` (${railLabel(payment.rail)})` : ''}`,
      order_id: order?.id ?? null, payment_id: paymentId, rail: payment?.rail ?? null,
      net_usdc: payment?.netSettledUsdcAmount ?? null, fee_usdc: payment?.totalUsdcFeeAmount ?? null,
    },
  });

  return Response.json({ ok: true, detected: true, fill_id: fillId });
}
