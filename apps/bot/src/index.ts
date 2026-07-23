import { db, closeDb } from '@union/core';
import { buildBot } from './build.js';
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

const PLAYER_COMMANDS = [
  { command: 'start', description: 'Set up your account' },
  { command: 'deposit', description: 'Add money' },
  { command: 'canceldeposit', description: 'Cancel your latest unpaid deposit' },
  { command: 'withdraw', description: 'Cash out' },
  { command: 'pending', description: 'Your pending cash-outs' },
  { command: 'payments', description: 'Completed payments & receipts' },
  { command: 'editplatform', description: 'Add or remove ClubGG / Sportsbook' },
  { command: 'editclubs', description: 'Change which clubs you play in' },
  { command: 'methods', description: 'Change your payment methods' },
  { command: 'payout', description: 'Change how you get paid' },
  { command: 'support', description: 'Message our team' },
  { command: 'help', description: 'What I can do' },
];
// In groups, admins also need the setup commands (harmless for players — the
// handlers check admin status and politely refuse otherwise).
const GROUP_COMMANDS = [
  ...PLAYER_COMMANDS,
  { command: 'setadmingroup', description: 'Make this the admin group (admins only)' },
  { command: 'setadmin', description: 'Add an admin (owner only)' },
  { command: 'p2p', description: 'Venmo/Zelle backstop handle (admins)' },
];
// Same core commands everywhere — the bot works right in the group, no private chat.
await bot.api.setMyCommands(PLAYER_COMMANDS, { scope: { type: 'default' } });
await bot.api.setMyCommands(GROUP_COMMANDS, { scope: { type: 'all_group_chats' } });
await bot.api.setMyCommands(PLAYER_COMMANDS, { scope: { type: 'all_private_chats' } });

notifier.start();
console.log('[bot] starting (long polling)…');
await bot.start({ onStart: (i) => console.log(`[bot] @${i.username} is live`) });
