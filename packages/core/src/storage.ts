import { getApps, initializeApp, cert, applicationDefault, type App } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import { randomUUID } from 'node:crypto';

/**
 * FIREBASE STORAGE — receipt images
 * ═════════════════════════════════
 *
 * "I don't want them just uploading receipt numbers, I want them to upload the
 *  receipt, which can be viewed both from Telegram in the admin group and in
 *  the website."
 *
 * Telegram file_ids are the wrong home for this: only the bot can fetch one, and
 * they expire. So the bot downloads the image and hands the bytes to here, which
 * puts them in a Firebase Storage bucket and returns a permanent URL that both
 * the admin group and the panel render directly.
 *
 * The DB stores the URL + the storage path; the bytes live only in Storage. That
 * is the correct split — Postgres for the numbers, Storage for the files.
 */

let _app: App | undefined;

function storageApp(): App {
  if (_app) return _app;

  const existing = getApps();
  if (existing.length) {
    _app = existing[0]!;
    return _app;
  }

  const bucket = process.env.FIREBASE_STORAGE_BUCKET;
  if (!bucket) {
    throw new Error(
      'FIREBASE_STORAGE_BUCKET is not set. It looks like "your-project.appspot.com" ' +
        'or "your-project.firebasestorage.app" — find it in the Firebase console under Storage.',
    );
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  // Prefer explicit service-account creds (works on Vercel); fall back to
  // Application Default Credentials (works on GCP / a local gcloud login).
  const credential =
    projectId && clientEmail && privateKey
      ? cert({ projectId, clientEmail, privateKey })
      : applicationDefault();

  _app = initializeApp({ credential, storageBucket: bucket });
  return _app;
}

export interface StoredReceipt {
  storagePath: string;
  url: string;
  contentType: string;
  bytes: number;
}

/**
 * Upload a receipt image and return a permanent, directly-viewable URL.
 *
 * The object is made public-readable via a download token in the URL — the path
 * itself is an unguessable uuid, so the URL is the capability. That keeps the
 * panel and the Telegram group able to render `<img src=…>` with no signing
 * dance, while a receipt is not enumerable by anyone who wasn't handed the link.
 *
 * @param scope  a folder segment, e.g. 'fill' or 'dispute'
 * @param refId  the id the receipt belongs to, for a human-navigable path
 */
export async function uploadReceipt(
  bytes: Buffer,
  contentType: string,
  scope: string,
  refId: string,
): Promise<StoredReceipt> {
  const ext = extFor(contentType);
  const token = randomUUID();
  const storagePath = `receipts/${scope}/${refId}/${randomUUID()}${ext}`;

  const bucket = getStorage(storageApp()).bucket();
  const file = bucket.file(storagePath);

  await file.save(bytes, {
    contentType,
    resumable: false,
    metadata: {
      contentType,
      // This token is what makes the fixed download URL work without signing.
      metadata: { firebaseStorageDownloadTokens: token },
    },
  });

  const url =
    `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/` +
    `${encodeURIComponent(storagePath)}?alt=media&token=${token}`;

  return { storagePath, url, contentType, bytes: bytes.length };
}

/** Best-effort delete — used if a receipt row fails to write after upload, so a
 *  half-finished upload does not leak an orphan object. Never throws. */
export async function deleteReceipt(storagePath: string): Promise<void> {
  try {
    await getStorage(storageApp()).bucket().file(storagePath).delete();
  } catch {
    /* orphan cleanup is best-effort */
  }
}

function extFor(contentType: string): string {
  switch (contentType) {
    case 'image/jpeg': return '.jpg';
    case 'image/png': return '.png';
    case 'image/webp': return '.webp';
    case 'application/pdf': return '.pdf';
    default: return '';
  }
}

/** True when Storage is configured — lets callers degrade gracefully (keep the
 *  Telegram file_id) instead of crashing when it isn't set up yet. */
export function storageConfigured(): boolean {
  return Boolean(process.env.FIREBASE_STORAGE_BUCKET);
}
