import 'server-only';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { recordDetection } from './detect';

/**
 * Inbox-based detection for the rails that don't do webhooks: PayPal AND Cash App
 * both email a "you've got money" notice, and they land in the SAME mailbox. We
 * read it over IMAP, parse the amount + sender, and match exactly like the other
 * rails. It never releases — an admin still verifies. Idempotent: payment_detect
 * dedupes on the email's Message-ID, so re-reading the same email does nothing
 * (we don't touch or flag your inbox).
 *
 * Env (all required to turn it on; unset = no-op):
 *   PAYPAL_IMAP_USER, PAYPAL_IMAP_PASSWORD  (Gmail: an App Password)
 *   PAYPAL_IMAP_HOST  (default imap.gmail.com), PAYPAL_IMAP_PORT (default 993)
 *   PAYPAL_IMAP_FROM   (default paypal.com)
 *   CASHAPP_IMAP_FROM  (default square.com — Cash App sends from cash@square.com)
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
      // PayPal, then Cash App — same inbox, one login. Message-ID dedupe means a
      // provider we scan twice (Cash App uses more than one sender domain) is safe.
      count += await scan(client, since, process.env.PAYPAL_IMAP_FROM ?? 'paypal.com', parsePaypal, 'paypal', 'paypal');
      count += await scan(client, since, process.env.CASHAPP_IMAP_FROM ?? 'square.com', parseCashapp, 'cashapp', 'cashapp');
      count += await scan(client, since, 'cash.app', parseCashapp, 'cashapp', 'cashapp');
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return count;
}

type Parsed = { amount: number; currency: string; name: string | null };

/** Search one sender, parse each match, and record any money-received emails. */
async function scan(
  client: ImapFlow,
  since: Date,
  from: string,
  parse: (subject: string, text: string) => Parsed | null,
  source: 'paypal' | 'cashapp',
  methodCode: string,
): Promise<number> {
  const uids = await client.search({ since, from }, { uid: true });
  if (!uids || uids.length === 0) return 0;
  // Only NEW arrivals should ping the admins. An email older than this is
  // recorded (so it dedupes) but announced silently — otherwise a re-scan after
  // a data reset or fresh deploy would replay days of old payments at once.
  const FRESH_MS = Number(process.env.EMAIL_FRESH_MINUTES ?? 30) * 60 * 1000;
  let count = 0;
  for (const uid of uids.slice(-30)) {
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!msg || !msg.source) continue;
    const mail = await simpleParser(msg.source);
    const parsed = parse(mail.subject ?? '', mail.text ?? '');
    if (!parsed) continue;
    // Stale ONLY when the email has a date header and it's clearly old. A brand
    // new email (or one with no date) always notifies — new payments must never
    // be held back; the gate exists purely to mute a re-scan of old mail.
    const stale = !!mail.date && Date.now() - mail.date.getTime() > FRESH_MS;
    await recordDetection({
      source,
      externalId: mail.messageId ?? `imap-uid:${uid}`,
      methodCode,
      amount: parsed.amount,
      currency: parsed.currency,
      raw: { subject: mail.subject, name: parsed.name, stale },
    });
    count++;
  }
  return count;
}

/** Pull the amount AND who sent it out of a PayPal "you've got money" email.
 *  Returns null if it's not a money-received email or we can't find an amount. */
function parsePaypal(subject: string, text: string): Parsed | null {
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

/** Same idea for Cash App. Its emails read "John Doe sent you $50" or "You
 *  received $50.00 from John Doe" — and amounts are often whole ($50, no cents). */
function parseCashapp(subject: string, text: string): Parsed | null {
  const hay = `${subject}\n${text}`;
  if (!/(sent you|you received|received \$|paid you)/i.test(hay)) return null;
  if (/(you sent|you paid|payment to|receipt|refund)/i.test(hay)) return null;

  // Cents optional: "$50" or "$50.00".
  const m = hay.match(/\$\s?([\d,]+(?:\.\d{2})?)/) ?? hay.match(/([\d,]+(?:\.\d{2})?)\s?USD/i);
  if (!m) return null;
  const amount = Math.round(parseFloat(m[1]!.replace(/,/g, '')) * 100);
  if (amount <= 0) return null;

  const nm = subject.match(/^([A-Za-z][\w .'-]{1,40}?)\s+sent you/i)
    ?? hay.match(/([A-Za-z][\w .'-]{1,40}?)\s+sent you/i)
    ?? hay.match(/from\s+([A-Za-z][\w .'-]{1,40})/i);
  const name = nm ? nm[1]!.trim() : null;

  return { amount, currency: 'USD', name };
}
