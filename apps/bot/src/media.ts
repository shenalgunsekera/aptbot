import type { Api } from 'grammy';
import { uploadReceipt, type StoredReceipt } from '@union/core';

/**
 * Downloading a receipt image is a chain of flaky network calls — Telegram's
 * getFile, fetching the bytes off Telegram's file CDN, then the Firebase upload.
 * Any one of them can blip, and a single failure used to dead-end the player with
 * "that image didn't upload" even though a retry a moment later would have worked.
 *
 * These helpers add the three things that were missing: bounded RETRIES with
 * backoff, an explicit res.ok / non-empty check (so we never silently store an
 * error page as a "receipt"), and a per-fetch timeout (so one hung download can't
 * eat the whole webhook budget).
 */

async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < tries) await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  throw lastErr;
}

/** Fetch a Telegram file's bytes, retried, with an ok-check and a 15s cap. */
export async function downloadTelegramFile(api: Api, fileId: string): Promise<Buffer> {
  return withRetry(async () => {
    const file = await api.getFile(fileId);
    if (!file.file_path) throw new Error('telegram getFile returned no file_path');
    const url = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`telegram file fetch failed: ${res.status} ${res.statusText}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length === 0) throw new Error('telegram file came back empty');
      return bytes;
    } finally {
      clearTimeout(timer);
    }
  });
}

/**
 * Download a Telegram file and store it as a receipt in Firebase. Download and
 * upload are retried independently, so a Firebase blip re-uploads the bytes we
 * already have rather than re-pulling the whole file.
 */
export async function storeTelegramReceipt(
  api: Api,
  fileId: string,
  contentType: string,
  scope: string,
  refId: string,
): Promise<StoredReceipt> {
  const bytes = await downloadTelegramFile(api, fileId);
  return withRetry(() => uploadReceipt(bytes, contentType, scope, refId));
}
