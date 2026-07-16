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
  | { name: 'register:name' }
  | { name: 'register:platform_uid'; platformId: string }
  // add money
  | { name: 'add:platform' }
  | { name: 'add:amount'; platformId: string }
  | { name: 'add:method'; platformId: string; amount: number }
  | { name: 'add:txid'; fillId: string }
  | { name: 'add:receipt'; fillId: string }
  // cash out
  | { name: 'out:platform' }
  | { name: 'out:amount'; platformId: string }
  | { name: 'out:method'; platformId: string; amount: number }
  | { name: 'out:handle'; platformId: string; amount: number; methodId: string }
  | { name: 'dispute:reason'; fillId: string };

export interface SessionData {
  step: Step;
}

export type Ctx = Context & SessionFlavor<SessionData>;

export const initialSession = (): SessionData => ({ step: { name: 'idle' } });
