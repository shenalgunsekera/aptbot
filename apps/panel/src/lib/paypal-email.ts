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
/** Per-sender { found in inbox, parsed as money } — surfaced by the cron so we
 *  can tell "Cash App emails aren't arriving" apart from "arriving but not
 *  parsed". `found` counts messages the sender search returned; `parsed` counts
 *  those recognised as a payment/request/cancel. */
export interface EmailScanResult {
  total: number;
  breakdown: Record<string, { found: number; parsed: number }>;
}

export async function detectPaypalEmails(): Promise<EmailScanResult> {
  const empty: EmailScanResult = { total: 0, breakdown: {} };
  const user = process.env.PAYPAL_IMAP_USER;
  const pass = process.env.PAYPAL_IMAP_PASSWORD;
  if (!user || !pass) return empty;

  const client = new ImapFlow({
    host: process.env.PAYPAL_IMAP_HOST ?? 'imap.gmail.com',
    port: Number(process.env.PAYPAL_IMAP_PORT ?? 993),
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  const { db } = await import('@union/core');
  const sql = db();
  const [cfg] = await sql<{ email_watermark: Date | null }[]>`select email_watermark from config where id`;
  const watermark = cfg?.email_watermark ? new Date(cfg.email_watermark) : null;
  const seen = { max: watermark };   // newest email date we've come across this run

  const breakdown: EmailScanResult['breakdown'] = {};
  let count = 0;
  const run = async (from: string, parse: typeof parsePaypal, source: 'paypal' | 'cashapp', method: string) => {
    const r = await scan(client, since, from, parse, source, method, watermark, seen);
    breakdown[from] = r;
    count += r.parsed;
  };
  const since = new Date(Date.now() - 2 * 24 * 3600 * 1000);   // last 2 days
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      // PayPal, then Cash App — same inbox, one login. Message-ID dedupe means a
      // provider we scan twice (Cash App uses more than one sender domain) is safe.
      await run(process.env.PAYPAL_IMAP_FROM ?? 'paypal.com', parsePaypal, 'paypal', 'paypal');
      await run(process.env.CASHAPP_IMAP_FROM ?? 'square.com', parseCashapp, 'cashapp', 'cashapp');
      await run('cash.app', parseCashapp, 'cashapp', 'cashapp');
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }

  // Advance the watermark past everything we saw, so next run only announces mail
  // newer than this. Never moves backwards.
  if (seen.max && (!watermark || seen.max > watermark)) {
    await sql`update config set email_watermark = ${seen.max} where id`;
  }
  return { total: count, breakdown };
}

type Parsed = { amount: number; currency: string; name: string | null; kind: 'payment' | 'request' | 'cancel' };

/** Search one sender, parse each match, and record any money-received emails.
 *  An email is ANNOUNCED only when it's newer than the watermark — so a real
 *  payment is never held back by cron lag, and a re-scan of old mail stays quiet. */
async function scan(
  client: ImapFlow,
  since: Date,
  from: string,
  parse: (subject: string, text: string) => Parsed | null,
  source: 'paypal' | 'cashapp',
  methodCode: string,
  watermark: Date | null,
  seen: { max: Date | null },
): Promise<{ found: number; parsed: number }> {
  const uids = await client.search({ since, from }, { uid: true });
  if (!uids || uids.length === 0) return { found: 0, parsed: 0 };
  let count = 0;
  for (const uid of uids.slice(-30)) {
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!msg || !msg.source) continue;
    const mail = await simpleParser(msg.source);
    const parsed = parse(mail.subject ?? '', bodyText(mail.text, mail.html));
    if (!parsed) continue;
    const date = mail.date ?? null;
    if (date && (!seen.max || date > seen.max)) seen.max = date;
    // New (announce) unless the watermark is set and this email isn't newer. A
    // missing date always announces — never hold back a possible fresh payment.
    const stale = !!watermark && !!date && date <= watermark;
    await recordDetection({
      source,
      externalId: mail.messageId ?? `imap-uid:${uid}`,
      methodCode,
      amount: parsed.amount,
      currency: parsed.currency,
      raw: { subject: mail.subject, name: parsed.name, stale, kind: parsed.kind },
    });
    count++;
  }
  return { found: uids.length, parsed: count };
}

/** Pull the sender/requester name out of a payment email — it lives in different
 *  places per provider and per kind. Names can be lower-case ("jennifer Setton"),
 *  so the subject-start patterns are case-insensitive; the last-resort "from X"
 *  is constrained and provider words ("PayPal", "Cash App") are rejected so we
 *  never show "From: PayPal". */
// Words that are never a person's name — they show up in PayPal/Cash App
// boilerplate ("…from PayPal will always be shown in your Activity") and were
// leaking through the last-resort "from X" match as bogus names like "will always".
const NON_NAME_WORDS = new Set([
  'always', 'your', 'you', 'been', 'being', 'shown', 'show', 'shows', 'the', 'this', 'that',
  'request', 'requests', 'requested', 'requesting', 'payment', 'payments', 'money', 'sent',
  'receipt', 'activity', 'please', 'click', 'here', 'view', 'with', 'and', 'for', 'has', 'have',
  'will', 'account', 'balance', 'transaction', 'notification', 'summary', 'details',
  // Subject/boilerplate words that can lead a body name match ("Payment received\nJohn …").
  'received', 'receive', 'canceled', 'cancelled', 'declined', 'via', 'new', 'pay', 'paid', 'completed',
]);

function cleanName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim()   // collapse newlines/runs so no "\n" lands in a name
    .replace(/[,;:.]+$/, '')
    .replace(/^(paypal|cash\s?app|venmo|zelle|square)\s+/i, '')   // "PayPal Brady Peters" → "Brady Peters"
    .trim();
}

/** A plausible person's name: 1–3 word tokens, not a provider, and free of the
 *  boilerplate words above (so "will always" / "your Activity" are rejected). */
function isPlausibleName(name: string): boolean {
  if (!name) return false;
  if (/^(paypal|cash\s?app|venmo|zelle|square)$/i.test(name)) return false;
  const words = name.split(/\s+/);
  if (words.length < 1 || words.length > 3) return false;
  return !words.some((w) => NON_NAME_WORDS.has(w.toLowerCase()));
}

/** Prefer the plain-text part, but fall back to the HTML body (stripped to text)
 *  when it's missing or empty. Cash App moved to HTML-only notification emails —
 *  no text/plain part — so `mail.text` is empty and the amount, which lives in
 *  the body, was never seen. PayPal still sends a text part, so this only kicks
 *  in where it's needed. */
function bodyText(text: string | undefined, html: string | false | undefined): string {
  const t = (text ?? '').trim();
  if (t) return t;
  if (typeof html === 'string' && html) return htmlToText(html);
  return '';
}

/** Minimal HTML→text: drop script/style, turn tags into spaces, decode the few
 *  entities that show up in money emails ($, &, spaces), and collapse runs. Good
 *  enough to surface "$50", "sent you", "requested", "canceled a request". */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#0*36;|&dollar;/gi, '$')
    .replace(/&#x?0*[0-9a-f]+;/gi, ' ')   // any other numeric entity → space
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function senderName(subject: string, text: string): string | null {
  // Search the subject and the body SEPARATELY — never a `subject + "\n" + body`
  // join. A joined haystack lets a name match run across the boundary and swallow
  // the subject's trailing word (e.g. body "chris Boyett …" under subject "Payment
  // received" was captured as "received chris Boyett"). A name always sits within
  // one line, so matching per-side is both correct and safer.
  const body = text;
  const candidates: Array<string | undefined> = [
    // "jennifer Setton sent you …" / "… is requesting" — name leads the subject.
    subject.match(/^(.{2,40}?)\s+(?:sent you|is requesting|wants\b)/i)?.[1],
    // "Michael Luvish requested $30" / "… canceled a request" — name leads the subject.
    subject.match(/^([A-Za-z][A-Za-z'.-]*(?:\s+[A-Za-z][A-Za-z'.-]*){0,2})\s+(?:requested\b|cancel(?:l)?ed|declined)/i)?.[1],
    // Same phrasing but anywhere in the BODY (Isaac's request had no name in the subject).
    body.match(/([A-Za-z][A-Za-z'.-]*(?:\s+[A-Za-z][A-Za-z'.-]*){0,2})\s+(?:sent you|is requesting|requested\b|has\s+cancel(?:l)?ed)/i)?.[1],
    // Cash App payment body: "You were sent $100 by cake." / "… by John Doe. Receipt".
    body.match(/sent\s+\$[\d,.]+\s+by\s+([A-Za-z][A-Za-z'. -]*?)(?:[.\n]|$)/i)?.[1],
    // "the $60 request from Ali Salem for …".
    body.match(/\brequest\s+from\s+([A-Za-z][A-Za-z'. -]*?)(?:\s+for\b|[.\n]|$)/i)?.[1],
    // "requested $30 from jennifer" / "requesting … from NAME".
    body.match(/request(?:ed|ing)?\b[^.\n]*?\bfrom\s+([A-Za-z][A-Za-z'.-]*(?:\s+[A-Za-z][A-Za-z'.-]*){0,2})/i)?.[1],
    // Last resort: "from Name" (body first, then subject).
    body.match(/\bfrom\s+([A-Za-z][A-Za-z'.-]*(?:\s+[A-Za-z][A-Za-z'.-]*){0,2})/i)?.[1]
      ?? subject.match(/\bfrom\s+([A-Za-z][A-Za-z'.-]*(?:\s+[A-Za-z][A-Za-z'.-]*){0,2})/i)?.[1],
  ];

  for (const raw of candidates) {
    if (!raw) continue;
    const name = cleanName(raw);
    if (isPlausibleName(name)) return name;
  }
  return null;
}

/** Parse a PayPal email into payment received / money REQUEST / CANCELLED request.
 *  Null if it's outgoing, a receipt, or has no amount. */
export function parsePaypal(subject: string, text: string): Parsed | null {
  const hay = `${subject}\n${text}`;
  // Direction is in the SUBJECT — check exclusions there ONLY. A word like
  // "receipt" in the email body/footer must not drop a real incoming payment.
  if (/(you sent|payment sent|you'?ve sent|receipt for your payment|you paid|authori[sz]ed a payment)/i.test(subject)) return null;

  const m = hay.match(/\$\s?([\d,]+\.\d{2})/) ?? hay.match(/([\d,]+\.\d{2})\s?USD/i);
  if (!m) return null;   // no amount → a login/security/marketing email, not money
  const amount = Math.round(parseFloat(m[1]!.replace(/,/g, '')) * 100);
  if (amount <= 0) return null;

  const isCancel = /(cancel(l)?ed|declined)/i.test(subject) && /request/i.test(hay);
  const isRequest = /(money request|requested \$|requesting \$|requests \$|is requesting|sent you a request|wants \$)/i.test(hay);

  return { amount, currency: 'USD', name: senderName(subject, text), kind: isCancel ? 'cancel' : isRequest ? 'request' : 'payment' };
}

/** Same for Cash App. Amounts are often whole ($50). */
export function parseCashapp(subject: string, text: string): Parsed | null {
  const hay = `${subject}\n${text}`;
  // Subject-only exclusion — Cash App bodies carry "receipt" links and other
  // words that would otherwise drop real incoming payments/requests.
  if (/(you sent|payment sent|you paid|payment to|refund)/i.test(subject)) return null;

  // Cents optional: "$50" or "$50.00".
  const m = hay.match(/\$\s?([\d,]+(?:\.\d{2})?)/) ?? hay.match(/([\d,]+(?:\.\d{2})?)\s?USD/i);
  if (!m) return null;
  const amount = Math.round(parseFloat(m[1]!.replace(/,/g, '')) * 100);
  if (amount <= 0) return null;

  const isCancel = /(cancel(l)?ed|declined)/i.test(subject) && /request/i.test(hay);
  const isRequest = /(requested \$|is requesting|request for \$|money request|sent you a request|request received|request from)/i.test(hay);

  return { amount, currency: 'USD', name: senderName(subject, text), kind: isCancel ? 'cancel' : isRequest ? 'request' : 'payment' };
}
