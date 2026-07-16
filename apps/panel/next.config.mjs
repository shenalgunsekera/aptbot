import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Next only reads .env from its OWN directory, but this is a monorepo and the
// database URL, Firebase keys and bot token all live in one .env at the root —
// shared with the bot and the migration scripts. Without this, you would have to
// keep a second copy of your production credentials inside apps/panel and
// remember to update both. Load the root one instead.
//
// Real env vars always win, so a platform that injects config (Cloud Run, Vercel)
// is never overridden by a stray local file.
(() => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const file = join(root, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/i.exec(line);
    if (!m) continue;
    const [, k, raw] = m;
    if (process.env[k] !== undefined) continue;
    process.env[k] = raw.replace(/^["'](.*)["']$/s, '$1');
  }
})();

/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,

  // @union/core ships TypeScript source rather than a build artifact.
  transpilePackages: ['@union/core', '@union/bot'],

  serverExternalPackages: ['postgres', 'firebase-admin', 'grammy'],

  // @union/core is also consumed by the bot, which runs under Node's native ESM
  // and therefore REQUIRES explicit `.js` extensions on relative imports. Those
  // extensions point at files that only exist as `.ts` on disk, which webpack
  // will not resolve on its own. This teaches it the mapping, so one source of
  // truth can serve both a bundler and a bare Node process.
  webpack(config) {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },

  // This panel moves real money and is never meant to be indexed or framed.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
    ];
  },
};
