import type { Context, SessionFlavor } from 'grammy';

/**
 * Conversation state for the multi-step flows.
 *
 * Holds NO money and NO decisions — only "which question am I answering". Every
 * amount, match and handle lives in the database from the moment it exists,
 * because a bot restart must never lose a deposit or leave a withdrawal
 * half-made.
 */
export type Step =
  | { name: 'idle' }
  // guided onboarding (first-run setup)
  | { name: 'ob:name' }
  | { name: 'ob:platforms' }
  | { name: 'ob:sb_hasacct' }
  | { name: 'ob:sb_user' }
  | { name: 'ob:sb_pass'; username: string }
  | { name: 'ob:sb_wait' }
  | { name: 'ob:sb_username' }
  | { name: 'ob:clubgg_id' }
  | { name: 'ob:clubs'; platformId: string }
  | { name: 'ob:dep_methods' }
  | { name: 'ob:wd_method' }
  | { name: 'ob:wd_handle'; methodId: string }
  // add money — method is chosen BEFORE amount, so Stripe (fixed link) can skip
  // the amount step entirely.
  | { name: 'add:platform' }
  | { name: 'add:club'; platformId: string }
  | { name: 'add:method'; platformId: string }
  | { name: 'add:amount'; platformId: string; methodId: string }
  | { name: 'add:receipt'; fillId: string }
  | { name: 'add:stripe'; platformId: string }
  // cash out
  | { name: 'out:platform' }
  | { name: 'out:club'; platformId: string }
  | { name: 'out:amount'; platformId: string }
  | { name: 'out:method'; platformId: string; amount: number }
  | { name: 'out:handle'; platformId: string; amount: number; methodId: string }
  | { name: 'dispute:reason'; fillId: string };

/** Scratch state for the guided onboarding, held across steps. Durable (the
 *  session lives in Postgres), so it survives the Sportsbook-creation pause. */
export interface OnboardingPlan {
  platforms: string[];        // platform ids the player chose
  sbHasAccount?: boolean;     // answered the "already have APT Sports?" question
  clubSel?: string[];         // club ids toggled so far (multi-club platforms)
  depSel?: string[];          // deposit method ids toggled so far (real ids, incl. coins)
  depView?: 'main' | 'crypto';// which screen of the deposit-method picker is showing
  wdSel?: string[];           // cash-out method ids toggled so far
  wdView?: 'main' | 'crypto'; // which screen of the cash-out-method picker is showing
  wdQueue?: string[];         // chosen cash-out methods still needing a saved handle
  // When set, we're editing one thing from a slash command, not first-run setup,
  // so the "Done" handlers save-and-stop instead of walking the whole sequence.
  mode?: 'methods' | 'payout' | 'addplatform';
}

export interface SessionData {
  step: Step;
  ob?: OnboardingPlan;
  lastQ?: number;   // message id of the last question, so we can tidy it away
}

export type Ctx = Context & SessionFlavor<SessionData>;

export const initialSession = (): SessionData => ({ step: { name: 'idle' } });
