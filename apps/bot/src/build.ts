export { renderNotification } from './notifier.js';
import { Bot, session, GrammyError, HttpError } from 'grammy';
import { db, closeDb } from '@union/core';
import { type Ctx, type SessionData, initialSession } from './session.js';
import { currentPlayer } from './player.js';
import { dmOnly, groupIntro } from './guards.js';
import { Notifier } from './notifier.js';
import {
  start, registerName, registerPickPlatform, registerUid, me,
} from './commands/start.js';
import {
  addStart, addPickPlatform, addAmount, addPickMethod, addTxid, addReceipt, addSkipReceipt,
} from './commands/add.js';
import {
  cashoutStart, cashoutPickPlatform, cashoutAmount, cashoutPickMethod,
  cashoutSavedHandle, cashoutHandle,
} from './commands/cashout.js';
import { confirmList, handleConfirm, handleDidntArrive, disputeReason } from './commands/confirm.js';
import { loaderClaim, loaderDone, loaderShort, loaderFail, fillVerify } from './admin-actions.js';

/**
 * buildBot — constructs the fully-wired bot WITHOUT starting it.
 *
 * Split out so the same handlers drive two runtimes: long polling locally
 * (index.ts) and a Vercel webhook in production (apps/panel/src/lib/bot.ts).
 * Neither the notifier loop nor the sweep interval live here — on Vercel those
 * are cron endpoints, and locally index.ts starts them.
 */
export function buildBot(token: string): Bot<Ctx> {
  const bot = new Bot<Ctx>(token);
  
  // Key sessions by USER, not chat: money commands are DM-only, but a per-user key
  // means a stray group message can never corrupt an in-flight flow.
  bot.use(session<SessionData, Ctx>({
    initial: initialSession,
    getSessionKey: (ctx) => ctx.from?.id.toString(),
  }));
  
  // ─── Commands ────────────────────────────────────────────────────────────────
  bot.command('start', async (ctx) => {
    if (ctx.chat?.type !== 'private') return void (await groupIntro(ctx));
    await start(ctx);
  });
  bot.command('cancel', async (ctx) => {
    ctx.session.step = { name: 'idle' };
    await ctx.reply('Okay, stopped. 👍');
  });
  bot.command('skip', async (ctx) => {
    if (ctx.session.step.name === 'add:receipt') return void (await addSkipReceipt(ctx));
    await ctx.reply('Nothing to skip right now.');
  });
  bot.command('help', (ctx) =>
    ctx.reply(
      `💵 /add — add money\n💸 /cashout — cash out\n📋 /me — your account\n` +
        `✅ /confirm — confirm a payment you got\n/cancel — stop what you're doing`,
    ),
  );
  
  bot.command(['add', 'deposit'], dmOnly(addStart));
  bot.command(['cashout', 'withdraw'], dmOnly(cashoutStart));
  bot.command('me', dmOnly(me));
  bot.command('confirm', dmOnly(confirmList));
  
  // The admin group adopts the chat it is added to (never creates one). Only an
  // enabled admin's telegram_id can set it — the DB function is the whole check.
  bot.command('setadmingroup', async (ctx) => {
    if (ctx.chat?.type === 'private') {
      await ctx.reply('Run this inside your admin group, not here.');
      return;
    }
    const [row] = await db()<{ admin_group_claim: boolean }[]>`
      select admin_group_claim(${ctx.chat.id}::bigint, ${ctx.from!.id}::bigint)`;
    await ctx.reply(row?.admin_group_claim
      ? '✅ This group is now the admin group. All notifications and jobs will come here.'
      : '⛔ Only an admin can do that.');
  });
  
  // ─── Callbacks ───────────────────────────────────────────────────────────────
  // Registration
  bot.callbackQuery(/^reg:pf:(.+)$/, (ctx) => registerPickPlatform(ctx, ctx.match![1]!));
  
  // Add money
  bot.callbackQuery(/^add:pf:(.+)$/, (ctx) => addPickPlatform(ctx, ctx.match![1]!, false));
  bot.callbackQuery(/^add:pfsave:(.+)$/, (ctx) => addPickPlatform(ctx, ctx.match![1]!, true));
  bot.callbackQuery(/^add:pfremember:/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Okay, I'll ask each time." });
    const p = await currentPlayer(ctx);
    if (p) await db()`select prefs_set_platform(${p.id}::uuid, null)`;
  });
  bot.callbackQuery(/^add:m:(.+)$/, async (ctx) => {
    const s = ctx.session.step;
    if (s.name !== 'add:method') return void (await ctx.answerCallbackQuery({ text: 'That expired — /add again.' }));
    await addPickMethod(ctx, s.platformId, s.amount, ctx.match![1]!, false);
  });
  bot.callbackQuery(/^add:msave:(.+)$/, async (ctx) => {
    const s = ctx.session.step;
    if (s.name !== 'add:method') return void (await ctx.answerCallbackQuery({ text: 'That expired — /add again.' }));
    await addPickMethod(ctx, s.platformId, s.amount, ctx.match![1]!, true);
  });
  bot.callbackQuery(/^add:mremember:/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Okay, I'll ask each time." });
    const p = await currentPlayer(ctx);
    if (p) await db()`select prefs_set_method(${p.id}::uuid, null)`;
  });
  
  // Cash out
  bot.callbackQuery(/^out:pf:(.+)$/, (ctx) => cashoutPickPlatform(ctx, ctx.match![1]!, false));
  bot.callbackQuery(/^out:pfsave:(.+)$/, (ctx) => cashoutPickPlatform(ctx, ctx.match![1]!, true));
  bot.callbackQuery(/^out:pfremember:/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Okay, I'll ask each time." });
    const p = await currentPlayer(ctx);
    if (p) await db()`select prefs_set_platform(${p.id}::uuid, null)`;
  });
  bot.callbackQuery(/^out:m:(.+)$/, async (ctx) => {
    const s = ctx.session.step;
    if (s.name !== 'out:method') return void (await ctx.answerCallbackQuery({ text: 'That expired — /cashout again.' }));
    await cashoutPickMethod(ctx, s.platformId, s.amount, ctx.match![1]!, false);
  });
  bot.callbackQuery(/^out:msave:(.+)$/, async (ctx) => {
    const s = ctx.session.step;
    if (s.name !== 'out:method') return void (await ctx.answerCallbackQuery({ text: 'That expired — /cashout again.' }));
    await cashoutPickMethod(ctx, s.platformId, s.amount, ctx.match![1]!, true);
  });
  bot.callbackQuery(/^out:mremember:/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Okay, I'll ask each time." });
    const p = await currentPlayer(ctx);
    if (p) await db()`select prefs_set_method(${p.id}::uuid, null)`;
  });
  bot.callbackQuery(/^out:h:(.+)$/, async (ctx) => {
    const s = ctx.session.step;
    if (s.name !== 'out:handle') return void (await ctx.answerCallbackQuery({ text: 'That expired — /cashout again.' }));
    await cashoutSavedHandle(ctx, ctx.match![1]!, s.platformId, s.amount, s.methodId);
  });
  
  // Confirm
  bot.callbackQuery(/^cf:yes:(.+)$/, (ctx) => handleConfirm(ctx, ctx.match![1]!));
  bot.callbackQuery(/^cf:no:(.+)$/, (ctx) => handleDidntArrive(ctx, ctx.match![1]!));
  
  // Admin group actions (auth checked inside each handler by telegram_id)
  bot.callbackQuery(/^lo:claim:(.+)$/, (ctx) => loaderClaim(ctx, ctx.match![1]!));
  bot.callbackQuery(/^lo:done:([^:]+):(-?\d+)$/, (ctx) => loaderDone(ctx, ctx.match![1]!, Number(ctx.match![2])));
  bot.callbackQuery(/^lo:short:(.+)$/, (ctx) => loaderShort(ctx, ctx.match![1]!));
  bot.callbackQuery(/^lo:fail:(.+)$/, (ctx) => loaderFail(ctx, ctx.match![1]!));
  bot.callbackQuery(/^fl:verify:(.+)$/, (ctx) => fillVerify(ctx, ctx.match![1]!));
  bot.callbackQuery('noop', (ctx) => ctx.answerCallbackQuery({ text: 'Open the panel for full details.' }));
  
  // ─── Loader "different amount" reply in the admin group ──────────────────────
  // The loaderShort prompt used force_reply and stashed the order id. A reply in
  // the group with a number completes the job for that amount.
  bot.on('message:text', async (ctx, next) => {
    const orderId = (ctx.session as any)._loaderShortOrder as string | undefined;
    const replyText = ctx.message.reply_to_message?.text ?? '';
    if (orderId && /Reply to THIS message with the amount/.test(replyText)) {
      const n = parseFloat(ctx.message.text.trim());
      if (!Number.isFinite(n) || n < 0) {
        await ctx.reply('Send just the number, e.g. 30');
        return;
      }
      (ctx.session as any)._loaderShortOrder = undefined;
      await loaderDone(ctx, orderId, -Math.round(n * 100));
      return;
    }
    return next();
  });
  
  // ─── Free text — routed by conversation step ─────────────────────────────────
  bot.on('message:text', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;   // ignore group chatter
    const step = ctx.session.step;
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;
  
    switch (step.name) {
      case 'register:name': return void (await registerName(ctx, text));
      case 'register:platform_uid': return void (await registerUid(ctx, step.platformId, text));
      case 'add:amount': return void (await addAmount(ctx, step.platformId, text));
      case 'add:txid': return void (await addTxid(ctx, step.fillId, text));
      case 'out:amount': return void (await cashoutAmount(ctx, step.platformId, text));
      case 'out:handle': return void (await cashoutHandle(ctx, step.platformId, step.amount, step.methodId, text));
      case 'dispute:reason': return void (await disputeReason(ctx, step.fillId, text));
      default:
        await ctx.reply("Not sure what you mean — try /help.");
    }
  });
  
  // ─── Photos / documents (receipts) ───────────────────────────────────────────
  bot.on(['message:photo', 'message:document'], async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    const step = ctx.session.step;
  
    if (step.name === 'add:receipt') return void (await addReceipt(ctx, step.fillId));
  
    // A screenshot attached to an open dispute.
    const sql = db();
    const p = await currentPlayer(ctx);
    if (!p) return;
    const fileId = ctx.message.photo?.at(-1)?.file_id ?? ctx.message.document?.file_id;
    if (!fileId) return;
    const [d] = await sql<{ id: string }[]>`
      select di.id from disputes di join fills f on f.id = di.fill_id
        join withdraw_requests w on w.id = f.withdraw_id
       where w.player_id = ${p.id} and di.status = 'open'
       order by di.created_at desc limit 1`;
    if (d) {
      await sql`select dispute_add_evidence(${d.id}::uuid, 'receipt', ${fileId}, ${p.id}::uuid, null)`;
      await ctx.reply('📎 Added to your case, thanks.');
    } else {
      await ctx.reply("I'm not expecting a photo right now.");
    }
  });
  
  // ─── Errors ──────────────────────────────────────────────────────────────────
  bot.catch((err) => {
    const e = err.error;
    if (e instanceof GrammyError) console.error('[bot] telegram error:', e.description);
    else if (e instanceof HttpError) console.error('[bot] network error:', e);
    else console.error('[bot] unhandled:', e);
  });

  return bot;
}
