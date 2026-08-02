import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

/**
 * TEMPORARY, read-only inbox probe — protected by CRON_SECRET. Answers "are Cash
 * App emails arriving, and from what sender/format?" without touching the mailbox
 * (no flag changes). Delete after diagnosis.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get('authorization');
  if (secret && auth !== `Bearer ${secret}`) return new Response('unauthorized', { status: 401 });

  const user = process.env.PAYPAL_IMAP_USER;
  const pass = process.env.PAYPAL_IMAP_PASSWORD;
  if (!user || !pass) return Response.json({ ok: false, reason: 'IMAP not configured' });

  const days = Math.min(Number(new URL(req.url).searchParams.get('days') ?? 7), 30);
  const client = new ImapFlow({
    host: process.env.PAYPAL_IMAP_HOST ?? 'imap.gmail.com',
    port: Number(process.env.PAYPAL_IMAP_PORT ?? 993),
    secure: true, auth: { user, pass }, logger: false,
  });

  const bySender: Record<string, number> = {};
  const recent: Array<{ date: string | null; from: string; subject: string; hasText: boolean; hasHtml: boolean; textSample: string }> = [];
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);

  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Envelope-only broad sweep: find anything cash/square in from or subject.
      const uids = await client.search({ since }, { uid: true });
      // Newest first, so `recent` captures the LATEST matches (higher uid = newer).
      for (const uid of (uids || []).slice(-250).reverse()) {
        const msg = await client.fetchOne(String(uid), { envelope: true }, { uid: true });
        if (!msg || !msg.envelope) continue;
        const from = (msg.envelope.from || []).map((a: { address?: string }) => a.address || '').join(',').toLowerCase();
        const subject = msg.envelope.subject || '';
        if (!/cash|square/i.test(from) && !/cash\s?app/i.test(subject)) continue;
        const dom = from.split('@')[1]?.split(',')[0] ?? from;
        bySender[dom] = (bySender[dom] || 0) + 1;
        if (recent.length < 12) {
          // Pull the body only for the newest few, to see text-vs-HTML.
          const full = await client.fetchOne(String(uid), { source: true }, { uid: true });
          const mail = full && full.source ? await simpleParser(full.source) : null;
          const rawText = (mail?.text ?? '').replace(/\s+/g, ' ').trim();
          recent.push({
            date: msg.envelope.date ? new Date(msg.envelope.date).toISOString() : null,
            from, subject,
            hasText: Boolean(mail?.text && mail.text.trim()),
            hasHtml: Boolean(mail?.html),
            textSample: rawText.slice(0, 500),
          });
        }
      }
    } finally { lock.release(); }
  } finally { await client.logout().catch(() => {}); }

  recent.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  return Response.json({ ok: true, days, scanned: 'INBOX', bySender, recent });
}
