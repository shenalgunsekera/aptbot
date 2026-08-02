import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

/**
 * TEMPORARY, read-only inbox probe — protected by CRON_SECRET. Answers "are Cash
 * App emails arriving, and where?" by checking Inbox, Spam, and All Mail for the
 * newest square.com message. Never touches the mailbox. Delete after diagnosis.
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

  const days = Math.min(Number(new URL(req.url).searchParams.get('days') ?? 10), 30);
  const client = new ImapFlow({
    host: process.env.PAYPAL_IMAP_HOST ?? 'imap.gmail.com',
    port: Number(process.env.PAYPAL_IMAP_PORT ?? 993),
    secure: true, auth: { user, pass }, logger: false,
  });

  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  // Where Cash App mail could be if a filter is diverting it: Inbox, Spam, or the
  // catch-all All Mail (holds everything regardless of label).
  const boxes = ['INBOX', '[Gmail]/Spam', '[Gmail]/All Mail'];
  type BoxInfo = { squareCount: number; newest: { date: string | null; subject: string } | null; latestSample: string | null; error?: string };
  const perBox: Record<string, BoxInfo> = {};

  await client.connect();
  try {
    for (const box of boxes) {
      const info: BoxInfo = { squareCount: 0, newest: null, latestSample: null };
      perBox[box] = info;
      let lock;
      try { lock = await client.getMailboxLock(box); } catch (e) { info.error = String((e as Error).message ?? e); continue; }
      try {
        const uids = await client.search({ since }, { uid: true });
        for (const uid of (uids || []).slice(-400).reverse()) {   // newest first
          const msg = await client.fetchOne(String(uid), { envelope: true }, { uid: true });
          if (!msg || !msg.envelope) continue;
          const from = (msg.envelope.from || []).map((a: { address?: string }) => a.address || '').join(',').toLowerCase();
          const subject = msg.envelope.subject || '';
          if (!/cash|square/i.test(from) && !/cash\s?app/i.test(subject)) continue;
          info.squareCount++;
          if (!info.newest) {   // first hit = newest
            info.newest = { date: msg.envelope.date ? new Date(msg.envelope.date).toISOString() : null, subject };
            const full = await client.fetchOne(String(uid), { source: true }, { uid: true });
            const mail = full && full.source ? await simpleParser(full.source) : null;
            info.latestSample = (mail?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
          }
        }
      } finally { lock.release(); }
    }
  } finally { await client.logout().catch(() => {}); }

  return Response.json({ ok: true, days, now: new Date().toISOString(), perBox });
}
