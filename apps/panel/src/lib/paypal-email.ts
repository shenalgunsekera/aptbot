import 'server-only';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { recordDetection } from './detect';

/**
 * PayPal detection for a PERSONAL account (no webhooks). We read the inbox that
 * receives PayPal's "you've got money" emails over IMAP, parse the amount, and
 * match it exactly like the other rails. It never releases — an admin still
 * verifies. Idempotent: payment_detect dedupes on the email's Message-ID, so
 * re-reading the same email does nothing (we don't touch/flag your inbox).
 *
 * Env (all required to turn it on; unset = no-op):
 *   PAYPAL_IMAP_USER, PAYPAL_IMAP_PASSWORD  (Gmail: an App Password)
 *   PAYPAL_IMAP_HOST  (default imap.gmail.com), PAYPAL_IMAP_PORT (default 993)
 *   PAYPAL_IMAP_FROM  (default paypal.com)
 */
export async function detectPaypalEmails(): Promise<number> {
  const user = process.env.PAYPAL_IMAP_USER;
  const pass = process.env.PAYPAL_IMAP_PASSWORD;
  if (!user || !pass) return 0;

  const client = new ImapFlow({
    host: process.env.PAYPAL_IMAP_HOST ?? 'imap.gmail.com',
    port: Number(process.env.PAYPAL_IMAP_PORT ?? 993),
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  let count = 0;
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const since = new Date(Date.now() - 2 * 24 * 3600 * 1000);   // last 2 days
      const from = process.env.PAYPAL_IMAP_FROM ?? 'paypal.com';
      const uids = await client.search({ since, from }, { uid: true });
      if (!uids || uids.length === 0) return 0;

      for (const uid of uids.slice(-30)) {
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!msg || !msg.source) continue;
        const mail = await simpleParser(msg.source);
        const parsed = parsePaypal(mail.subject ?? '', mail.text ?? '');
        if (!parsed) continue;
        await recordDetection({
          source: 'paypal',
          externalId: mail.messageId ?? `imap-uid:${uid}`,
          methodCode: 'paypal',
          amount: parsed.amount,
          currency: parsed.currency,
          raw: { subject: mail.subject, name: parsed.name },
        });
        count++;
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return count;
}

/** Pull the amount AND who sent it out of a PayPal "you've got money" email.
 *  Returns null if it's not a money-received email or we can't find an amount. */
function parsePaypal(subject: string, text: string): { amount: number; currency: string; name: string | null } | null {
  const hay = `${subject}\n${text}`;
  // Must read like money coming IN…
  if (!/(sent you|you'?ve got money|you got money|you received|received \$)/i.test(hay)) return null;
  // …and NOT like money going out or a plain receipt.
  if (/(you sent|payment sent|you'?ve sent|receipt for your payment|you paid|authori[sz]ed a payment)/i.test(hay)) return null;

  const m = hay.match(/\$\s?([\d,]+\.\d{2})/) ?? hay.match(/([\d,]+\.\d{2})\s?USD/i);
  if (!m) return null;
  const amount = Math.round(parseFloat(m[1]!.replace(/,/g, '')) * 100);
  if (amount <= 0) return null;

  // Who sent it: "Bob Smith sent you …" or "… received $X from Bob Smith".
  const nm = subject.match(/^([A-Za-z][\w .'-]{1,40}?)\s+sent you/i)
    ?? hay.match(/([A-Za-z][\w .'-]{1,40}?)\s+sent you/i)
    ?? hay.match(/from\s+([A-Za-z][\w .'-]{1,40})/i);
  const name = nm ? nm[1]!.trim() : null;

  return { amount, currency: 'USD', name };
}
