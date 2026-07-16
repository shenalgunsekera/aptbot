import { db, closeDb } from '@union/core';
import { buildBot } from './build.js';
import { Notifier } from './notifier.js';

/**
 * Long-polling entrypoint — for local development (`pnpm --filter @union/bot dev`).
 *
 * In production the bot runs as a Vercel webhook (see apps/panel), and the
 * notifier + sweepers become cron endpoints. This file is the "run it as one
 * always-on process" path: same handlers via buildBot, plus the two background
 * loops that Vercel replaces with cron.
 */
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

await bot.api.setMyCommands([
  { command: 'add', description: 'Add money' },
  { command: 'cashout', description: 'Cash out' },
  { command: 'me', description: 'Your account' },
  { command: 'confirm', description: 'Confirm a payment you got' },
  { command: 'help', description: 'What I can do' },
], { scope: { type: 'all_private_chats' } });

notifier.start();
console.log('[bot] starting (long polling)…');
await bot.start({ onStart: (i) => console.log(`[bot] @${i.username} is live`) });
