/**
 * Mint a PeerPay (ZKP2P Pay) checkout link for a deposit. The player pays through
 * the returned URL (via Venmo / Cash App / …) and USDC settles to the merchant's
 * connected Base wallet. Settlement fires the PAYMENT_SETTLED webhook, which
 * matches back to this fill via notes.merchantOrderId.
 *
 * feePayer / destinationAddress / chain all come from the merchant account, so we
 * only pass the amount, the fill id, and (optionally) the rail to pre-select.
 *
 * Returns the checkout URL, or null if PeerPay isn't configured or the call fails
 * — the caller then falls back to the backup tag.
 *
 * The SDK is imported LAZILY (inside the call) on purpose: @zkp2p/pay-sdk is
 * ESM-only, and a top-level import made every module that pulls in @union/core
 * (the panel's API routes, the Telegram bot) crash at load if the SDK failed to
 * initialise in the serverless runtime. Loading it only when a PeerPay checkout is
 * actually minted keeps auth, the bots, and everything else working regardless.
 */
const API_BASE = 'https://api.pay.peer.xyz';
const CHECKOUT_BASE = 'https://pay.peer.xyz';

// Rails PeerPay currently supports for us. Only these get pre-selected.
const PEERPAY_RAILS = new Set(['venmo', 'cashapp']);

export function peerpayConfigured(): boolean {
  return !!process.env.PEERPAY_API_KEY;
}

export async function peerpayCheckout(opts: {
  amountCents: number;
  fillId: string;
  rail?: string | null;
}): Promise<string | null> {
  const apiKey = process.env.PEERPAY_API_KEY;
  if (!apiKey) return null;

  const rail = opts.rail && PEERPAY_RAILS.has(opts.rail.toLowerCase()) ? opts.rail.toLowerCase() : undefined;
  const usdc = (opts.amountCents / 100).toFixed(2);

  try {
    const { createCheckout } = await import('@zkp2p/pay-sdk');
    const r = await createCheckout(
      {
        requestedUsdcAmount: usdc,
        notes: { merchantOrderId: opts.fillId, source: 'apt-bot' },
        successUrl: process.env.PEERPAY_RETURN_URL ?? null,
        cancelUrl: process.env.PEERPAY_RETURN_URL ?? null,
      },
      {
        apiBaseUrl: API_BASE,
        checkoutBaseUrl: CHECKOUT_BASE,
        apiKey,
        ...(rail ? { preselectedMethod: rail as any } : {}),
        signal: AbortSignal.timeout(15000),
      },
    );
    return r.checkoutUrl ?? null;
  } catch (err) {
    console.error('[peerpay] createCheckout failed:', err);
    return null;
  }
}
