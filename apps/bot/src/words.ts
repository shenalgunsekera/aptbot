/**
 * PLAIN LANGUAGE
 * ══════════════
 *
 * "I don't like the big words like unload, load, blocked. Even a person logging
 *  in for the first time in their life should understand what's going on."
 *
 * The database speaks in precise terms — unload, escrow, fill, settlement. The
 * player never sees any of them. Every word a player reads is translated here,
 * in one place, so the whole bot stays consistent and nothing technical leaks.
 *
 *   deposit / load   → "add money" / "adding money"
 *   withdraw / unload→ "cash out" / "cashing out"
 *   escrow / queue   → "waiting to be paid"
 *   fill             → "payment"
 *   blocked / frozen → "on hold" (to the player) / "paused" (softer still)
 */

export const money = (minor: number, currency = 'USD') => {
  const neg = minor < 0;
  const abs = Math.abs(minor);
  const sym = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : currency + ' ';
  return `${neg ? '-' : ''}${sym}${(abs / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

/** Parse a typed amount into minor units. Strict: this is on the path where a
 *  player says how much money to move, and a lenient parser is a player who
 *  typed "100.5" meaning $100.50 and got charged $10050. */
export function parseAmount(input: string): number | null {
  const cleaned = input.trim().replace(/[$£€,\s]/g, '');
  if (!cleaned) return null;
  const m = /^\+?(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!m) return null;
  const whole = Number(m[1]);
  const frac = m[2] ? Number(m[2].padEnd(2, '0')) : 0;
  if (!Number.isSafeInteger(whole)) return null;
  const total = whole * 100 + frac;
  return Number.isSafeInteger(total) && total > 0 ? total : null;
}

/** Whole-dollar label, e.g. "$20" (no cents) — amounts are whole multiples of 5,
 *  so the ".00" is just noise in the prompts. */
export const whole = (minor: number, currency = 'USD') => money(minor, currency).replace(/\.00$/, '');

/**
 * Check a typed amount against the money rules (min, max, whole multiples of the
 * step). Returns a player-friendly problem string, or null if the amount is fine.
 */
export function amountProblem(
  minor: number,
  opts: { min: number; max: number; step: number },
): string | null {
  if (minor < opts.min) return `The smallest amount is ${whole(opts.min)}.`;
  if (minor > opts.max) return `The largest amount is ${whole(opts.max)}.`;
  if (opts.step > 0 && minor % opts.step !== 0) {
    const near = Math.max(opts.min, Math.round(minor / opts.step) * opts.step);
    return `Amounts must be in whole multiples of ${whole(opts.step)} — no cents. Try ${whole(near)}.`;
  }
  return null;
}

/**
 * The "where do we pay you?" question, worded per method so it's obvious what to
 * send — their OWN tag/address, never the club's.
 */
export function withdrawHandlePrompt(code: string, name: string, clubHandle?: string | null): string {
  const c = clubHandle ? '`' + clubHandle + '`' : 'our PayPal';
  switch (code) {
    case 'paypal':
      return `What's *your* PayPal email or tag? Send it here — that's who we pay when you cash out.\n` +
        `_(e.g. \`you@email.com\` or \`@yourtag\`)_\n\n` +
        `_When you request a cash out, send a PayPal money request to ${c} for the amount, and we'll pay it._`;
    case 'cashapp':
      return `What's *your* Cash App $cashtag? Send it here — that's where your cash-outs go.\n_(e.g. \`$yourtag\`)_`;
    case 'venmo':
      return `What's *your* Venmo username? Send it here — that's where your cash-outs go.\n_(e.g. \`@your-name\`)_`;
    case 'zelle':
      return `What's *your* Zelle? Send the *email or phone number* linked to your Zelle — that's where your cash-outs go.\n` +
        `_(e.g. \`you@email.com\` or \`555-123-4567\`)_`;
    default:
      return `What's *your* ${name} address? Send it here — that's where your cash-outs go.\n\n` +
        `⚠️ Double-check it — crypto sent to the wrong address can't come back.`;
  }
}

/** How many receipt images a method needs. PayPal wants two (the receipt AND the
 *  transaction-ID screen); everything else is one. */
export function receiptCount(code: string): number {
  return code === 'paypal' ? 2 : 1;
}

/** What proof to send for a deposit, worded per method. This is what we need to
 *  verify the payment, so it's spelled out exactly. */
export function receiptInstruction(code: string): string {
  switch (code) {
    case 'venmo':  return 'a screenshot showing the *amount* and the *transaction ID*';
    case 'paypal': return '*two* images — (1) your receipt showing the *amount sent*, and (2) the *transaction ID*';
    case 'zelle':  return 'a screenshot of your receipt showing the *amount sent*';
    case 'cashapp':return 'a screenshot of your receipt showing the *amount sent*';
    default:       return 'a screenshot of your receipt showing the *amount sent*';   // crypto
  }
}

/** The "cash out started" confirmation, worded per method. Some methods we send
 *  to the player's handle; PayPal/Cash App the player requests from our handle. */
export function cashoutConfirm(
  code: string, methodName: string, handle: string, amount: string, clubHandle?: string | null,
): string {
  const club = clubHandle ? '`' + clubHandle + '`' : 'our account';
  switch (code) {
    case 'cashapp':
      return `✅ *Cash out started!*\n\nPlease request *${amount}* from ${club} on Cash App. Your request will be fulfilled in less than 24 hours.`;
    case 'paypal':
      return `✅ *Cash out started!*\n\nPlease request *${amount}* from ${club} on PayPal. Your request will be fulfilled in less than 24 hours.`;
    case 'venmo':
      return `✅ *Cash out started!*\n\nYour Venmo \`${handle}\` has been added to the queue. You'll receive *${amount}* within 24 hours.`;
    case 'zelle':
      return `✅ *Cash out started!*\n\nYour Zelle \`${handle}\` has been added to the queue. You'll receive *${amount}* within 24 hours.`;
    default:
      return `✅ *Cash out started!*\n\nYour ${methodName} address \`${handle}\` has been added to the queue. You'll receive *${amount}* within 24 hours.`;
  }
}

/** A player-facing status label, never the internal one. */
export function friendlyStatus(kind: 'deposit' | 'withdraw', status: string): string {
  const map: Record<string, string> = {
    // deposit
    matching: 'setting up',
    awaiting_payment: 'waiting for your payment',
    awaiting_confirmation: 'checking your payment',
    // withdraw
    pending_unload: 'getting your money ready',
    queued: 'waiting to be paid',
    partially_filled: 'partly paid',
    filled: 'almost done',
    // both
    completed: 'done',
    cancelled: 'cancelled',
    expired: 'expired',
  };
  return map[status] ?? status.replace(/_/g, ' ');
}

/** Shorten a long handle for a button label without losing the ends. */
export const shortHandle = (s: string) => (s.length <= 24 ? s : `${s.slice(0, 10)}…${s.slice(-8)}`);
