import { InlineKeyboard } from 'grammy';
import { db, type Platform, type PaymentMethod } from '@union/core';
import type { Ctx } from './session.js';

/**
 * FIRST-RUN PREFERENCES
 * ═════════════════════
 *
 * "for the first time they choose only, they will be given the option to choose
 *  whether they want to permanently only use ClubGG, or Sportsbook, or have the
 *  option every time. Same for the payment method."
 *
 * The rule, for both platform and method:
 *   1. If they set a permanent default → use it, don't ask.
 *   2. If there's only one option → use it, don't ask.
 *   3. If they've already been ASKED the "remember?" question → just ask which,
 *      no remember prompt.
 *   4. First time with a real choice → ask which, and offer "always use this".
 *
 * This module resolves a platform or method to either "here it is" or "ask the
 * player", so add/cashout flows don't each reimplement it.
 */

export type Resolved<T> =
  | { pick: T }                                  // use this, move on
  | { ask: T[]; offerRemember: boolean };        // ask the player to choose

// ─── Platform ────────────────────────────────────────────────────────────────
// Only platforms the player actually has a confirmed account on.
export async function resolvePlatform(playerId: string): Promise<Resolved<Platform>> {
  const sql = db();

  const linked = await sql<Platform[]>`
    select pf.* from platforms pf
     join player_platforms pp on pp.platform_id = pf.id
    where pp.player_id = ${playerId} and pp.platform_uid is not null and pp.active and pf.enabled
    order by pf.sort_order`;

  if (linked.length === 0) return { ask: [], offerRemember: false };
  if (linked.length === 1) return { pick: linked[0]! };

  const [prefs] = await sql<{ default_platform_id: string | null; platform_asked: boolean }[]>`
    select default_platform_id, platform_asked from player_prefs where player_id = ${playerId}`;

  if (prefs?.default_platform_id) {
    const chosen = linked.find((p) => p.id === prefs.default_platform_id);
    if (chosen) return { pick: chosen };
  }

  return { ask: linked, offerRemember: !prefs?.platform_asked };
}

// ─── Method ──────────────────────────────────────────────────────────────────
// Cash-out only, so it excludes deposit-only methods (e.g. Stripe can't pay out).
export async function resolveMethod(playerId: string): Promise<Resolved<PaymentMethod>> {
  const sql = db();

  const methods = await sql<PaymentMethod[]>`
    select * from payment_methods where enabled and payout_enabled order by sort_order, name`;

  if (methods.length === 0) return { ask: [], offerRemember: false };
  if (methods.length === 1) return { pick: methods[0]! };

  const [prefs] = await sql<{ default_method_id: string | null; method_asked: boolean }[]>`
    select default_method_id, method_asked from player_prefs where player_id = ${playerId}`;

  if (prefs?.default_method_id) {
    const chosen = methods.find((m) => m.id === prefs.default_method_id);
    if (chosen?.enabled) return { pick: chosen };
  }

  return { ask: methods, offerRemember: !prefs?.method_asked };
}

// ─── Keyboards ───────────────────────────────────────────────────────────────
// `flow` is 'add' or 'out' so the callback routes back to the right step.

// No "Always ask me" — players pick their platform(s) and methods during setup,
// so /add and /cashout just show what they actually have.
export function platformKeyboard(flow: 'add' | 'out', platforms: Platform[], _offerRemember: boolean) {
  const kb = new InlineKeyboard();
  for (const p of platforms) kb.text(p.name, `${flow}:pf:${p.id}`).row();
  return kb;
}

export function methodKeyboard(flow: 'add' | 'out', methods: PaymentMethod[], _offerRemember: boolean) {
  const kb = new InlineKeyboard();
  for (const m of methods) kb.text(m.name, `${flow}:m:${m.id}`).row();
  return kb;
}

/** After a first pick with the remember option, offer to make it permanent. */
export function rememberKeyboard(flow: 'add' | 'out', what: 'pf' | 'm', id: string) {
  return new InlineKeyboard()
    .text('✓ Always use this', `${flow}:${what}save:${id}`)
    .text('Just this time', `${flow}:${what === 'pf' ? 'pf' : 'm'}:${id}`);
}
