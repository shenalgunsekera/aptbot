/**
 * Public payment-success page — where Stripe returns a player after they pay.
 * Deliberately NO auth and NO link back into the bot: the player started in their
 * group chat, so we just tell them it worked and to head back there. The real
 * confirmation ("money added") arrives in that same group automatically once the
 * payment is detected and an admin verifies.
 */
export const dynamic = 'force-static';

export default function PaidPage() {
  return (
    <main style={{
      minHeight: '100dvh', display: 'grid', placeItems: 'center',
      background: '#0b0b0c', color: '#fff', fontFamily: 'system-ui, sans-serif', padding: 24,
    }}>
      <div style={{ textAlign: 'center', maxWidth: 380 }}>
        <div style={{ fontSize: 64, lineHeight: 1 }}>✅</div>
        <h1 style={{ fontSize: 24, margin: '16px 0 8px' }}>Payment successful</h1>
        <p style={{ color: '#b9b9c3', fontSize: 15, lineHeight: 1.5 }}>
          Thanks! We&apos;ve received your payment. You can close this page and head back to your chat —
          we&apos;ll confirm it there and add your money shortly.
        </p>
      </div>
    </main>
  );
}
