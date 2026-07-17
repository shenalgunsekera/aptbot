/**
 * Create a Stripe Checkout link for one deposit fill.
 *
 * Unlike PayPal/CashApp/crypto (fixed handle you send to), Stripe needs a hosted
 * payment page generated per payment. We create a Checkout session for the exact
 * amount, tag it with the fill id, and hand the player the URL — it accepts card
 * AND Apple Pay. When they pay, the checkout.session.completed webhook matches it
 * back to this exact fill.
 *
 * Needs STRIPE_API_KEY with write access to Checkout Sessions (a restricted key
 * with "Checkout Sessions: Write" is enough). Returns null if unconfigured.
 */
export async function createStripeCheckout(fillId: string, amountCents: number): Promise<string | null> {
  const key = process.env.STRIPE_API_KEY;
  if (!key) return null;

  // A plain success page — NOT a link back into the bot. The player is in their
  // group chat; the "money added" confirmation reaches them there automatically.
  const back = process.env.STRIPE_SUCCESS_URL ?? 'https://aptbot-panel-virid.vercel.app/paid';
  const p = new URLSearchParams();
  p.set('mode', 'payment');
  p.set('success_url', back);
  p.set('cancel_url', back);
  p.set('line_items[0][quantity]', '1');
  p.set('line_items[0][price_data][currency]', 'usd');
  p.set('line_items[0][price_data][unit_amount]', String(amountCents));
  p.set('line_items[0][price_data][product_data][name]', 'Deposit');
  p.set('metadata[fill_id]', fillId);

  try {
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: p.toString(),
    });
    if (!res.ok) { console.error('[stripe] checkout create failed:', await res.text()); return null; }
    const s = (await res.json()) as { url?: string };
    return typeof s.url === 'string' ? s.url : null;
  } catch (err) {
    console.error('[stripe] checkout error:', err);
    return null;
  }
}
