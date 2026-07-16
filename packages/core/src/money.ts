/**
 * Money is bigint MINOR UNITS (cents) everywhere — in the DB, in the bot, in
 * the panel. It is never a float, and it is never a decimal string that gets
 * parsed "just this once".
 *
 * These helpers exist so that the only place a human-readable amount turns into
 * a number, or back, is here.
 */

/** 12345 → "123.45" */
export function formatMinor(minor: number, currency = 'USD'): string {
  const neg = minor < 0;
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100);
  const cents = abs % 100;
  const s = `${whole.toLocaleString('en-US')}.${String(cents).padStart(2, '0')}`;
  return `${neg ? '-' : ''}${symbolFor(currency)}${s}`;
}

export function symbolFor(currency: string): string {
  switch (currency.toUpperCase()) {
    case 'USD': return '$';
    case 'EUR': return '€';
    case 'GBP': return '£';
    default: return `${currency.toUpperCase()} `;
  }
}

/**
 * Parse user input into minor units. Deliberately strict: this sits on the path
 * where a player types how much money to move, and a lenient parser here is a
 * player who typed "100.5" meaning $100.50 and got charged $10050.
 *
 * Returns null on anything it is not certain about. Callers must handle null —
 * never coerce.
 */
export function parseMinor(input: string): number | null {
  const cleaned = input.trim().replace(/[$£€,\s]/g, '');
  if (!cleaned) return null;

  // Optional leading +, digits, optional . and 1-2 decimals. Nothing else.
  const m = /^\+?(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!m) return null;

  const whole = Number(m[1]);
  const frac = m[2] ? Number(m[2].padEnd(2, '0')) : 0;
  if (!Number.isSafeInteger(whole)) return null;

  const total = whole * 100 + frac;
  if (!Number.isSafeInteger(total) || total <= 0) return null;
  return total;
}

/** For log lines and admin displays where the currency is already obvious. */
export function bare(minor: number): string {
  const neg = minor < 0;
  const abs = Math.abs(minor);
  return `${neg ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
