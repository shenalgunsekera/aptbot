/** Row shapes mirroring the v2 schema. Hand-written (no codegen step); these are
 *  read models — the DB functions are the write API. */

export type Reversibility = 'irreversible' | 'reversible';
export type SettlementMode = 'p2p' | 'club';
export type PlayerStatus = 'pending' | 'active' | 'frozen' | 'banned';
export type AdminRole = 'admin' | 'owner';

export type DepositStatus =
  | 'matching' | 'awaiting_payment' | 'awaiting_confirmation'
  | 'completed' | 'cancelled' | 'expired';

export type WithdrawStatus =
  | 'pending_unload' | 'queued' | 'partially_filled'
  | 'filled' | 'completed' | 'cancelled';

export type FillStatus =
  | 'locked' | 'awaiting_confirmation' | 'released'
  | 'disputed' | 'refunded' | 'expired' | 'cancelled';

export type OrderStatus = 'pending' | 'claimed' | 'done' | 'failed' | 'cancelled';

export interface Platform {
  id: string;
  code: string;
  name: string;
  enabled: boolean;
  sort_order: number;
}

export interface Player {
  id: string;
  telegram_id: number;
  telegram_username: string | null;
  display_name: string | null;
  status: PlayerStatus;
  risk_flags: Array<{ code: string; note: string; at: string; by: string | null }>;
  created_at: string;
}

export interface PlayerPlatform {
  id: string;
  player_id: string;
  platform_id: string;
  platform_uid_claimed: string | null;
  platform_uid: string | null;
  club_id: string | null;
  linked_at: string | null;
}

export interface Admin {
  id: string;
  firebase_uid: string;
  email: string;
  display_name: string | null;
  role: AdminRole;
  telegram_id: number | null;
  disabled: boolean;
}

export interface PaymentMethod {
  id: string;
  code: string;
  name: string;
  currency: string;
  reversibility: Reversibility;
  settlement: SettlementMode;
  enabled: boolean;
  min_amount: number | null;
  max_amount: number | null;
  club_handle: string | null;
  hold_seconds: number | null;
  processor_fee_bps: number;
  processor_fee_flat: number;
  handle_hint: string | null;
  handle_pattern: string | null;
  sort_order: number;
}

export interface Config {
  base_currency: string;
  admin_group_chat_id: number | null;
  match_timeout_seconds: number;
  allow_reversible: boolean;
  reversible_hold_seconds: number;
  auto_release_on_expiry: boolean;
  rake_deposit_bps: number;
  rake_deposit_flat: number;
  rake_withdraw_bps: number;
  rake_withdraw_flat: number;
  fee_bearer: 'depositor' | 'withdrawer';
  min_amount: number;
  max_amount: number;
  daily_cap_per_player: number | null;
  max_open_deposits_per_player: number;
  max_open_withdraws_per_player: number;
  handle_reveals_per_hour: number;
  owner_approval_threshold: number | null;
  confirm_escalation_seconds: number;
}

export interface Fill {
  id: string;
  seq: number;
  deposit_id: string | null;
  withdraw_id: string | null;
  method_id: string;
  currency: string;
  amount: number;
  rake_amount: number;
  credit_amount: number;
  gross_to_send: number;
  payout_handle: string;
  status: FillStatus;
  lock_expires_at: string;
  payment_ref: string | null;
  proof_note: string | null;
  submitted_at: string | null;
  hold_until: string | null;
  payee_confirmed_at: string | null;
  released_at: string | null;
  release_reason: string | null;
  created_at: string;
}

export interface DepositRequest {
  id: string;
  player_id: string;
  platform_id: string;
  method_id: string;
  currency: string;
  amount: number;
  status: DepositStatus;
  created_at: string;
}

export interface WithdrawRequest {
  id: string;
  player_id: string;
  platform_id: string;
  method_id: string;
  currency: string;
  requested_amount: number;
  gross_amount: number | null;
  rake_amount: number;
  amount: number | null;
  amount_remaining: number;
  payout_handle: string;
  status: WithdrawStatus;
  unload_order_id: string | null;
  created_at: string;
}

export interface LoaderOrder {
  id: string;
  player_id: string;
  platform_id: string;
  club_id: string;
  platform_uid: string;
  player_name: string;
  delta: number;
  currency: string;
  reason: string;
  status: OrderStatus;
  actual_delta: number | null;
  created_at: string;
}

export interface Receipt {
  id: string;
  reference: string;
  player_id: string;
  player_name: string;
  platform_uid: string | null;
  ref_type: string;
  ref_id: string;
  storage_path: string;
  url: string;
  created_at: string;
}

export interface PlayerSummary {
  player_id: string;
  telegram_id: number;
  display_name: string | null;
  status: PlayerStatus;
  awaiting_payment: number;
  being_confirmed: number;
}

export interface Notification {
  id: number;
  player_id: string | null;
  admin_id: string | null;
  audience: 'admins' | null;
  kind: string;
  payload: Record<string, unknown>;
  ref_type: string | null;
  ref_id: string | null;
  status: 'pending' | 'sent' | 'failed' | 'skipped';
  attempts: number;
}
