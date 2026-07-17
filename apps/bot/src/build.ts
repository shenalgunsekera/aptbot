export { renderNotification, sendRendered } from './notifier.js';
import { Bot, session, GrammyError, HttpError } from 'grammy';
import { db, closeDb } from '@union/core';
import { type Ctx, type SessionData, initialSession } from './session.js';
import { currentPlayer } from './player.js';
import { dmOnly, playerOnly, isAdminGroup } from './guards.js';
import { Notifier } from './notifier.js';
import { start, me } from './commands/start.js';
import {
  advance, obName, obSbUser, obSbPass, obSbUsername, obClubggId, obWdHandle,
  obTogglePlatform, obPlatformsDone, obSbHasAccount, obToggleDepMethod, obDepView, obDepMethodsDone,
  obPickWithdrawMethod, obResume, updateMethods, updatePayout, addPlatform,
} from './commands/onboarding.js';
import { sbCreated } from './admin-actions.js';
import {
  addStart, addPickPlatform, addPickCrypto, addAmount, addPickMethod, addReceipt, addDone,
} from './commands/add.js';
import {
  cashoutStart, cashoutPickPlatform, cashoutAmount, cashoutPickMethod,
  cashoutSavedHandle, cashoutHandle, cashoutRetract,
} from './commands/cashout.js';
import { disputeReason } from './commands/confirm.js';
import { payments } from './commands/payments.js';
import { supportStart, relayInquiryToAdmins, maybeRelayAdminReply } from './commands/support.js';
import { setAdmin, approvePlayer } from './admin-mgmt.js';
import { loaderClaim, loaderDone, loaderShort, loaderFail, fillVerify, withdrawPayPrompt, withdrawPayConfirm } from './admin-actions.js';
import { pgSessionStorage } from './session-store.js';

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
  //
  // Storage is Postgres (Neon), NOT the in-memory default — otherwise a serverless
  // webhook forgets the conversation between /start and the next message, because
  // each invocation is a fresh function instance.
  bot.use(session<SessionData, Ctx>({
    initial: initialSession,
    getSessionKey: (ctx) => ctx.from?.id.toString(),
    storage: pgSessionStorage<SessionData>(),
  }));
  
  // ─── Commands ────────────────────────────────────────────────────────────────
  // /start runs the registration flow IN PLACE — in a DM or the member's own
  // group — never bouncing them to a separate chat. Only the admin group is
  // excluded (it is for admin work, not player onboarding).
  bot.command('start', async (ctx) => {
    if (await isAdminGroup(ctx)) return;
    await start(ctx);
  });
  bot.command('cancel', async (ctx) => {
    ctx.session.step = { name: 'idle' };
    await ctx.reply('Okay, stopped. 👍');
  });
  bot.command(['done', 'skip'], async (ctx) => {
    if (ctx.session.step.name === 'add:receipt') return void (await addDone(ctx, ctx.session.step.fillId));
    await ctx.reply('Nothing to finish right now.');
  });
  bot.command('help', (ctx) =>
    ctx.reply(
      `💵 /add — add money\n💸 /cashout — cash out\n📋 /me — your account\n` +
        `📄 /payments — your payments & receipts\n` +
        `➕ /addplatform · 💳 /methods · 🏦 /payout — update your setup\n` +
        `💬 /support — message our team\n/cancel — stop what you're doing`,
    ),
  );
  
  bot.command(['add', 'deposit'], dmOnly(addStart));
  bot.command(['cashout', 'withdraw'], dmOnly(cashoutStart));
  bot.command('me', dmOnly(me));
  bot.command(['payments', 'history', 'receipts'], dmOnly(payments));
  bot.command(['support', 'help_me', 'contact'], dmOnly(supportStart));

  // Update your setup later.
  bot.command(['methods', 'depositmethods'], dmOnly(updateMethods));
  bot.command(['payout', 'cashoutmethod'], dmOnly(updatePayout));
  bot.command('addplatform', dmOnly(addPlatform));

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
      : '⛔ Only an admin can do that. (Your Telegram account must be linked as an admin first.)');
  });

  // Owner adds admins by tagging them. Works in the group or a DM.
  bot.command('setadmin', setAdmin);

  // ─── Only admins may add the bot to a group ──────────────────────────────────
  // When the bot is added somewhere, check who added it. If they are not an
  // enabled admin, leave immediately — the bot works only in player DMs and the
  // one admin group an admin explicitly sets.
  bot.on('my_chat_member', async (ctx) => {
    const status = ctx.myChatMember.new_chat_member.status;
    const chat = ctx.chat;
    if (chat.type === 'private') return;
    if (status !== 'member' && status !== 'administrator') return;   // only care about being added

    const addedBy = ctx.from?.id;
    const [adm] = await db()<{ id: string }[]>`
      select id from admins where telegram_id = ${addedBy ?? 0}::bigint and not disabled`;

    if (!adm) {
      try {
        await ctx.api.sendMessage(chat.id, 'This bot is for authorised admins only. Leaving.');
        await ctx.api.leaveChat(chat.id);
      } catch { /* already gone */ }
      return;
    }
    await ctx.reply('👋 Added. An admin can run /setadmingroup here to make this the admin group.');
  });
  
  // ─── Callbacks ───────────────────────────────────────────────────────────────
  // Onboarding
  bot.callbackQuery(/^ob:pf:(.+)$/, (ctx) => obTogglePlatform(ctx, ctx.match![1]!));
  bot.callbackQuery('ob:pfdone', (ctx) => obPlatformsDone(ctx));
  bot.callbackQuery('ob:sb:yes', (ctx) => obSbHasAccount(ctx, true));
  bot.callbackQuery('ob:sb:no', (ctx) => obSbHasAccount(ctx, false));
  bot.callbackQuery('ob:dmcrypto', (ctx) => obDepView(ctx, 'crypto'));
  bot.callbackQuery('ob:dmback', (ctx) => obDepView(ctx, 'main'));
  bot.callbackQuery(/^ob:dm:(.+)$/, (ctx) => obToggleDepMethod(ctx, ctx.match![1]!));
  bot.callbackQuery('ob:dmdone', (ctx) => obDepMethodsDone(ctx));
  bot.callbackQuery(/^ob:wm:(.+)$/, (ctx) => obPickWithdrawMethod(ctx, ctx.match![1]!));
  bot.callbackQuery('ob:resume', (ctx) => obResume(ctx));
  
  // Add money
  bot.callbackQuery(/^add:pf:(.+)$/, (ctx) => addPickPlatform(ctx, ctx.match![1]!, false));
  bot.callbackQuery(/^add:pfsave:(.+)$/, (ctx) => addPickPlatform(ctx, ctx.match![1]!, true));
  bot.callbackQuery(/^add:pfremember:/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Okay, I'll ask each time." });
    const p = await currentPlayer(ctx);
    if (p) await db()`select prefs_set_platform(${p.id}::uuid, null)`;
  });
  bot.callbackQuery('add:crypto', (ctx) => addPickCrypto(ctx));
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
  bot.callbackQuery(/^wd:retract:(.+)$/, (ctx) => cashoutRetract(ctx, ctx.match![1]!));
  bot.callbackQuery(/^out:h:(.+)$/, async (ctx) => {
    const s = ctx.session.step;
    if (s.name !== 'out:handle') return void (await ctx.answerCallbackQuery({ text: 'That expired — /cashout again.' }));
    await cashoutSavedHandle(ctx, ctx.match![1]!, s.platformId, s.amount, s.methodId);
  });
  
  
  // Admin group actions (auth checked inside each handler by telegram_id)
  bot.callbackQuery(/^lo:claim:(.+)$/, (ctx) => loaderClaim(ctx, ctx.match![1]!));
  bot.callbackQuery(/^lo:done:([^:]+):(-?\d+)$/, (ctx) => loaderDone(ctx, ctx.match![1]!, Number(ctx.match![2])));
  bot.callbackQuery(/^lo:short:(.+)$/, (ctx) => loaderShort(ctx, ctx.match![1]!));
  bot.callbackQuery(/^lo:fail:(.+)$/, (ctx) => loaderFail(ctx, ctx.match![1]!));
  bot.callbackQuery(/^fl:verify:(.+)$/, (ctx) => fillVerify(ctx, ctx.match![1]!));
  bot.callbackQuery(/^pl:approve:(.+)$/, (ctx) => approvePlayer(ctx, ctx.match![1]!));
  bot.callbackQuery(/^wd:pay:(.+)$/, (ctx) => withdrawPayPrompt(ctx, ctx.match![1]!));
  bot.callbackQuery(/^sb:made:(.+)$/, (ctx) => sbCreated(ctx, ctx.match![1]!));
  bot.callbackQuery('noop', (ctx) => ctx.answerCallbackQuery({ text: 'Open the panel for full details.' }));
  
  // ─── Loader "different amount" reply in the admin group ──────────────────────
  // The loaderShort prompt used force_reply and stashed the order id. A reply in
  // the group with a number completes the job for that amount.
  bot.on('message:text', async (ctx, next) => {
    const replyText = ctx.message.reply_to_message?.text ?? '';

    // Loader reporting a short unload amount.
    const orderId = (ctx.session as any)._loaderShortOrder as string | undefined;
    if (orderId && /Reply to THIS message with the amount/.test(replyText)) {
      const n = parseFloat(ctx.message.text.trim());
      if (!Number.isFinite(n) || n < 0) { await ctx.reply('Send just the number, e.g. 30'); return; }
      (ctx.session as any)._loaderShortOrder = undefined;
      await loaderDone(ctx, orderId, -Math.round(n * 100));
      return;
    }

    // Admin giving the tx id for a club-mediated cash out they paid.
    const payId = (ctx.session as any)._payWithdraw as string | undefined;
    if (payId && /Reply to THIS message with the transaction ID/.test(replyText)) {
      (ctx.session as any)._payWithdraw = undefined;
      await withdrawPayConfirm(ctx, payId, ctx.message.text.trim());
      return;
    }

    return next();
  });
  
  // ─── Free text — routed by conversation step ─────────────────────────────────
  bot.on('message:text', async (ctx) => {
    // In the ADMIN GROUP: an admin replying to a forwarded question relays it
    // back to the player. No player flows run there.
    if (await isAdminGroup(ctx)) {
      await maybeRelayAdminReply(ctx);
      return;
    }
    // Everywhere else (DM or a member's own group) the player flow runs in place.

    const step = ctx.session.step;
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) return;

    // A pending support question: capture it and send it to the team.
    if ((ctx.session as any)._support) {
      return void (await relayInquiryToAdmins(ctx, text));
    }

    switch (step.name) {
      // Onboarding
      case 'ob:name': return void (await obName(ctx, text));
      case 'ob:sb_user': return void (await obSbUser(ctx, text));
      case 'ob:sb_pass': return void (await obSbPass(ctx, step.username, text));
      case 'ob:sb_username': return void (await obSbUsername(ctx, text));
      case 'ob:clubgg_id': return void (await obClubggId(ctx, text));
      case 'ob:wd_handle': return void (await obWdHandle(ctx, step.methodId, text));
      case 'ob:sb_wait':
        return void (await ctx.reply("We're still setting up your Sportsbook account — you'll get a message here the moment it's ready. 🙏"));
      // Money flows
      case 'add:amount': return void (await addAmount(ctx, step.platformId, text));
      case 'out:amount': return void (await cashoutAmount(ctx, step.platformId, text));
      case 'out:handle': return void (await cashoutHandle(ctx, step.platformId, step.amount, step.methodId, text));
      case 'dispute:reason': return void (await disputeReason(ctx, step.fillId, text));
      default:
        // Anything else is treated as a question for the team.
        await relayInquiryToAdmins(ctx, text);
    }
  });
  
  // ─── Photos / documents (receipts) ───────────────────────────────────────────
  bot.on(['message:photo', 'message:document'], async (ctx) => {
    if (await isAdminGroup(ctx)) return;
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
