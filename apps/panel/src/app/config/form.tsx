'use client';

import { useState, useTransition } from 'react';
import { updateConfig } from '../../lib/actions';

export function ConfigForm({ cfg }: { cfg: any }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const patch: Record<string, unknown> = {};
        for (const [k, v] of fd.entries()) {
          const s = String(v);
          if (NUMERIC.has(k)) patch[k] = s === '' ? null : Number(s);
          else if (BOOL.has(k)) patch[k] = s === 'on';
          else patch[k] = s;
        }
        // Unchecked checkboxes are absent from FormData entirely.
        for (const b of BOOL) if (!fd.has(b)) patch[b] = false;

        setMsg(null);
        start(async () => {
          const r = await updateConfig(patch);
          setMsg(r.ok ? { ok: true, text: r.message ?? 'Saved.' } : { ok: false, text: r.error });
        });
      }}
    >
      <div className="grid cols-2">
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Matching</h2>
          <Field name="match_timeout_seconds" label="Match timeout (seconds)" def={cfg.match_timeout_seconds}
                 hint="How long a depositor holds a revealed handle before the slice returns to the front of the queue. Spec default 1800 (30 min)." />
          <Field name="handle_reveals_per_hour" label="Handle reveals per hour, per player" def={cfg.handle_reveals_per_hour}
                 hint="Stops someone opening deposits in a loop just to harvest everyone's payout handles." />
          <Field name="max_open_deposits_per_player" label="Max open deposits per player" def={cfg.max_open_deposits_per_player} />
          <Field name="max_open_withdraws_per_player" label="Max open withdrawals per player" def={cfg.max_open_withdraws_per_player} />
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0 }}>Reversibility & holds</h2>
          <Check name="allow_reversible" label="Allow reversible methods (card, PayPal, bank)" def={cfg.allow_reversible}
                 hint="Turn off to accept crypto/cash only — the strongest chargeback defence there is." />
          <Field name="reversible_hold_seconds" label="Hold window (seconds)" def={cfg.reversible_hold_seconds}
                 hint="How long a reversible payment sits before chips release. 259200 = 72h. Irreversible methods never hold." />
          <Check name="auto_release_on_expiry" label="Auto-release when the hold expires" def={cfg.auto_release_on_expiry}
                 hint="ON: silence means consent once the money can no longer be clawed back. OFF: an admin decides. OFF is safer and slower." />
          <Field name="confirm_escalation_seconds" label="Escalate to admin after (seconds)" def={cfg.confirm_escalation_seconds}
                 hint="If the withdrawer never answers — offline, blocked the bot — the fill escalates rather than stalling forever. 86400 = 24h." />
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0 }}>Rake &amp; fees</h2>
          <div className="field-row">
            <Field name="rake_deposit_bps" label="Deposit rake (bps)" def={cfg.rake_deposit_bps} hint="100 bps = 1%" />
            <Field name="rake_deposit_flat" label="Deposit rake flat (cents)" def={cfg.rake_deposit_flat} />
          </div>
          <div className="field-row">
            <Field name="rake_withdraw_bps" label="Withdraw rake (bps)" def={cfg.rake_withdraw_bps} />
            <Field name="rake_withdraw_flat" label="Withdraw rake flat (cents)" def={cfg.rake_withdraw_flat} />
          </div>
          <div className="field">
            <label htmlFor="fee_bearer">Processor fee bearer</label>
            <select id="fee_bearer" name="fee_bearer" defaultValue={cfg.fee_bearer}>
              <option value="depositor">Depositor pays — they send gross so the withdrawer nets their ask</option>
              <option value="withdrawer">Withdrawer pays — depositor sends the ask, withdrawer eats the cut</option>
            </select>
            <div className="field-hint">
              The processor's cut never touches the ledger — it's taken outside our perimeter.
              This only changes the number we quote the depositor.
            </div>
          </div>
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0 }}>Limits</h2>
          <div className="field-row">
            <Field name="min_amount" label="Min per transaction (cents)" def={cfg.min_amount} />
            <Field name="max_amount" label="Max per transaction (cents)" def={cfg.max_amount} />
          </div>
          <Field name="daily_cap_per_player" label="Daily cap per player (cents, blank = none)" def={cfg.daily_cap_per_player} />
          <Field name="owner_approval_threshold" label="Owner sign-off threshold (cents, blank = none)"
                 def={cfg.owner_approval_threshold}
                 hint="At or above this, a plain admin cannot fast-path, pay out, or resolve a dispute alone." />
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0 }}>ClubGG balance check</h2>
          <Check name="require_live_chip_check" label="Require a live ClubGG balance before a withdrawal" def={cfg.require_live_chip_check}
                 hint="Needs a chip adapter that can read balances. Without one, leave OFF — there is nothing to read, and every withdrawal would be refused." />
          <Field name="live_chip_check_max_age_seconds" label="Max reading age (seconds)" def={cfg.live_chip_check_max_age_seconds}
                 hint="A player can lose a stack in one hand, so keep this in seconds, not minutes." />
          <Field name="reconcile_cron" label="Reconciliation schedule (cron)" def={cfg.reconcile_cron} type="text" />
        </div>
      </div>

      {msg && <div className={`alert ${msg.ok ? 'ok' : 'err'}`} style={{ marginTop: 12 }}>{msg.text}</div>}

      <button type="submit" className="primary" style={{ marginTop: 12 }} disabled={pending}>
        {pending ? 'Saving…' : 'Save config'}
      </button>
    </form>
  );
}

function Field({ name, label, def, hint, type = 'number' }: any) {
  return (
    <div className="field">
      <label htmlFor={name}>{label}</label>
      <input id={name} name={name} type={type} defaultValue={def ?? ''} />
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

function Check({ name, label, def, hint }: any) {
  return (
    <div className="field">
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
        <input type="checkbox" name={name} defaultChecked={def} />
        {label}
      </label>
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

const NUMERIC = new Set([
  'match_timeout_seconds', 'reversible_hold_seconds', 'confirm_escalation_seconds',
  'rake_deposit_bps', 'rake_deposit_flat', 'rake_withdraw_bps', 'rake_withdraw_flat',
  'min_amount', 'max_amount', 'daily_cap_per_player', 'max_open_deposits_per_player',
  'max_open_withdraws_per_player', 'handle_reveals_per_hour', 'owner_approval_threshold',
  'live_chip_check_max_age_seconds',
]);
const BOOL = new Set(['allow_reversible', 'auto_release_on_expiry', 'require_live_chip_check']);
