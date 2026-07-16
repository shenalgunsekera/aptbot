import 'server-only';
import { webhookCallback } from 'grammy';
import type { buildBot as BuildBot } from '@union/bot/build';

/**
 * The bot, as a Vercel webhook — not a long-running process.
 *
 * The old bot used long polling: an open connection that lives forever. Vercel
 * has no forever — functions run per request and freeze. So on Vercel the bot is
 * a webhook: Telegram POSTs each update to /api/telegram, the function handles
 * it and returns. The sweepers, which used to be setInterval loops, become
 * Vercel Cron hitting /api/cron.
 *
 * The bot's handlers live in @union/bot. Here we import the configured Bot and
 * hand it to grammY's webhook adapter. One codebase, two runtimes: `pnpm dev`
 * runs it as long polling locally; Vercel runs this webhook.
 */

type BotT = ReturnType<typeof BuildBot>;
let _bot: BotT | undefined;

export async function getBot(): Promise<BotT> {
  if (_bot) return _bot;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not set');

  // The bot's wiring is exported from @union/bot as a factory so it can be
  // driven by either polling (local) or webhook (Vercel) without duplication.
  const { buildBot } = await import('@union/bot/build');
  _bot = buildBot(token);
  await _bot.init();
  return _bot;
}

export async function telegramWebhook(req: Request): Promise<Response> {
  const bot = await getBot();
  // Verify the secret token Telegram echoes back, so nobody can POST fake
  // updates to the public endpoint.
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.headers.get('x-telegram-bot-api-secret-token') !== secret) {
    return new Response('unauthorized', { status: 401 });
  }
  const handler = webhookCallback(bot, 'std/http');
  return handler(req);
}
