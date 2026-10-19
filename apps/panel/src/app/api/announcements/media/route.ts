import { db } from '@union/core';
import { requireAdmin } from '../../../../lib/auth';

/**
 * Upload one announcement image. Stored in Postgres (announcement_media) and served
 * from /api/media/<id> — a public, cache-forever URL Telegram and Discord can fetch,
 * with no dependency on external file storage. One image per request keeps each
 * upload under Vercel's 4.5 MB body limit (the composer shrinks big photos first).
 */
export const dynamic = 'force-dynamic';

const MAX_BYTES = 4 * 1024 * 1024;

/** The stable public origin for media links. Telegram/Discord must be able to fetch
 *  it, so never a protected per-deploy Vercel URL (those answer 401). */
function publicOrigin(req: Request): string {
  for (const v of [process.env.PANEL_URL, process.env.WEBHOOK_URL]) {
    if (v) { try { return new URL(v).origin; } catch { /* not a URL */ } }
  }
  const host = req.headers.get('x-forwarded-host') ?? new URL(req.url).host;
  return `https://${host}`;
}

export async function POST(req: Request): Promise<Response> {
  let adminId: string;
  try { adminId = (await requireAdmin()).admin.id; }
  catch { return Response.json({ ok: false, error: 'Please sign in again.' }, { status: 401 }); }

  let form: FormData;
  try { form = await req.formData(); }
  catch { return Response.json({ ok: false, error: 'That upload was too large or broken — try a smaller image.' }, { status: 400 }); }

  const file = form.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return Response.json({ ok: false, error: 'No image received.' }, { status: 400 });
  }
  const mime = file.type === 'image/png' ? 'image/png' : file.type === 'image/jpeg' ? 'image/jpeg' : null;
  if (!mime) return Response.json({ ok: false, error: 'Use a JPG or PNG image.' }, { status: 400 });
  if (file.size > MAX_BYTES) return Response.json({ ok: false, error: 'Image is over 4 MB — use a smaller one.' }, { status: 400 });

  const bytes = Buffer.from(await file.arrayBuffer());
  const [row] = await db()<{ id: string }[]>`
    insert into announcement_media (mime, bytes, size_bytes, created_by)
    values (${mime}, ${bytes}, ${bytes.length}, ${adminId}::uuid)
    returning id`;
  return Response.json({ ok: true, id: row!.id, url: `${publicOrigin(req)}/api/media/${row!.id}` });
}
