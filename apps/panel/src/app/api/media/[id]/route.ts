import { db } from '@union/core';

/**
 * Public image for announcements. Telegram and Discord fetch this to show the
 * picture, so it needs no sign-in — the id is an unguessable UUID, and the image is
 * being sent to every player anyway. Images never change, so it's cached forever
 * at Vercel's edge: hundreds of fetches cost one database read.
 */
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  if (!UUID.test(id)) return new Response('not found', { status: 404 });
  const [m] = await db()<{ mime: string; bytes: Buffer }[]>`
    select mime, bytes from announcement_media where id = ${id}::uuid`;
  if (!m) return new Response('not found', { status: 404 });
  return new Response(new Uint8Array(m.bytes), {
    headers: {
      'content-type': m.mime,
      'content-length': String(m.bytes.length),
      'cache-control': 'public, max-age=31536000, s-maxage=31536000, immutable',
    },
  });
}
