import 'server-only';

/**
 * Record an inbound payment signal (Stripe/PayPal webhook, or a crypto chain
 * poll) and let the admins know. This NEVER releases money — payment_detect only
 * matches the payment to a pending request and queues one admin message. An admin
 * still taps Verify. Idempotent: the same provider event twice is a no-op.
 */
export async function recordDetection(d: {
  source: 'stripe' | 'paypal' | 'crypto';
  externalId: string;
  methodCode: string;
  amount: number;         // minor units (cents)
  currency: string;
  toleranceBps?: number;  // >0 lets a near match count (volatile coins). 0 = exact.
  raw?: unknown;
}): Promise<void> {
  const { db } = await import('@union/core');
  const sql = db();
  await sql`select payment_detect(${d.source}, ${d.externalId}, ${d.methodCode},
                                  ${d.amount}::bigint, ${d.currency}, ${sql.json((d.raw ?? {}) as any)}::jsonb,
                                  ${d.toleranceBps ?? 0})`;
  // Push the admin message out now rather than waiting for the next cron.
  try {
    const { getBot, drainNotifications } = await import('./bot');
    const bot = await getBot();
    await drainNotifications(bot, 10);
  } catch (err) {
    console.error('[detect] drain failed:', err);
  }
}
