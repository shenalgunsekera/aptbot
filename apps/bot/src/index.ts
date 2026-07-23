import { db, closeDb } from '@union/core';
import { buildBot, syncCommands } from './build.js';
import { Notifier } from './notifier.js';

/**
 * Long-polling entrypoint.
 *
 * ⚠️ THIS DELETES THE PRODUCTION WEBHOOK. Starting long polling requires the bot
 * to have NO webhook, so grammY calls deleteWebhook on start — which instantly
 * kills the live bot on Vercel. Run in watch mode, and every file change
 * restarts it and re-kills production.
 *
 * Because that footgun cost real downtime, this entrypoint now REFUSES to run
 * unless you explicitly opt in with ALLOW_LOCAL_POLLING=true. Production is the
 * Vercel webhook (apps/panel/api/telegram); you should almost never need this.
 */
if (process.env.ALLOW_LOCAL_POLLING !== 'true') {
  console.error(
    '\n  ⛔ Refusing to start the bot in local polling mode.\n\n' +
      '  Polling DELETES the production webhook and takes the live bot offline.\n' +
      '  Production runs on Vercel — you do not need to run the bot locally.\n\n' +
      '  If you truly need local polling (it WILL break production until you\n' +
      '  re-set the webhook), run with:  ALLOW_LOCAL_POLLING=true\n',
  );
  process.exit(1);
}

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is not set — get one from @BotFather and put it in .env');
  process.exit(1);
}

const bot = buildBot(token);
const notifier = new Notifier(bot);

// The sweepers are the clock as an actor: expired locks, elapsed holds,
// unanswered payments. On Vercel this is /api/cron; here it's an interval.
const SWEEP_MS = Number(process.env.SWEEP_INTERVAL_MS ?? 60_000);
const sweepTimer = setInterval(async () => {
  try {
    const [r] = await db()<{ swept_locks: number; swept_holds: number; escalated: number }[]>`select * from sweep_all()`;
    if (r && (r.swept_locks || r.swept_holds || r.escalated)) {
      console.log(`[sweep] locks=${r.swept_locks} holds=${r.swept_holds} escalated=${r.escalated}`);
    }
  } catch (err) { console.error('[sweep] failed:', err); }
}, SWEEP_MS);

async function shutdown(sig: string) {
  console.log(`\n[bot] ${sig} — shutting down`);
  clearInterval(sweepTimer);
  notifier.stop();
  await bot.stop();
  await closeDb();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

// Same core commands everywhere — one source of truth in build.ts, shared with
// the webhook runtime so the "/" menu never drifts between the two.
await syncCommands(bot);

notifier.start();
console.log('[bot] starting (long polling)…');
await bot.start({ onStart: (i) => console.log(`[bot] @${i.username} is live`) });
