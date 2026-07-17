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
  | { name: 'ob:dep_methods' }
  | { name: 'ob:wd_method' }
  | { name: 'ob:wd_handle'; methodId: string }
  // add money
  | { name: 'add:platform' }
  | { name: 'add:amount'; platformId: string }
  | { name: 'add:method'; platformId: string; amount: number }
  | { name: 'add:receipt'; fillId: string }
  // cash out
  | { name: 'out:platform' }
  | { name: 'out:amount'; platformId: string }
  | { name: 'out:method'; platformId: string; amount: number }
  | { name: 'out:handle'; platformId: string; amount: number; methodId: string }
  | { name: 'dispute:reason'; fillId: string };

/** Scratch state for the guided onboarding, held across steps. Durable (the
 *  session lives in Postgres), so it survives the Sportsbook-creation pause. */
export interface OnboardingPlan {
  platforms: string[];        // platform ids the player chose
  sbHasAccount?: boolean;     // answered the "already have APT Sports?" question
  depSel?: string[];          // deposit method ids toggled so far
  // When set, we're editing one thing from a slash command, not first-run setup,
  // so the "Done" handlers save-and-stop instead of walking the whole sequence.
  mode?: 'methods' | 'payout' | 'addplatform';
}

export interface SessionData {
  step: Step;
  ob?: OnboardingPlan;
}

export type Ctx = Context & SessionFlavor<SessionData>;

export const initialSession = (): SessionData => ({ step: { name: 'idle' } });
