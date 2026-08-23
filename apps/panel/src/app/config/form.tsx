'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { updateConfig } from '../../lib/actions';

export function ConfigForm({ cfg }: { cfg: any }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

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
          if (r.ok) router.refresh();
        });
      }}
    >
      <div className="grid cols-2">
        <div className="card">
          <h2 style={{ marginTop: 0 }}>Matching</h2>
          <TimeField name="match_timeout_seconds" label="Payment window" def={cfg.match_timeout_seconds}
                     hint="How long a depositor has to pay before their slice returns to the queue. This is the countdown the bot shows players." />
          <Field name="handle_reveals_per_hour" label="Handle reveals per hour, per player" def={cfg.handle_reveals_per_hour}
                 hint="Stops someone opening deposits in a loop just to harvest everyone's payout handles." />
          <Field name="max_open_deposits_per_player" label="Max open deposits per player" def={cfg.max_open_deposits_per_player} />
          <Field name="max_open_withdraws_per_player" label="Max open withdrawals per player" def={cfg.max_open_withdraws_per_player} />
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0 }}>Reversibility &amp; holds</h2>
          <Check name="allow_reversible" label="Allow reversible methods (card, PayPal, bank)" def={cfg.allow_reversible}
                 hint="Turn off to accept crypto/cash only — the strongest chargeback defence there is." />
          <TimeField name="reversible_hold_seconds" label="Hold window" def={cfg.reversible_hold_seconds}
                     hint="How long a reversible payment sits before chips release. Irreversible methods never hold." />
          <Check name="auto_release_on_expiry" label="Auto-release when the hold expires" def={cfg.auto_release_on_expiry}
                 hint="ON: silence means consent once the money can no longer be clawed back. OFF: an admin decides. OFF is safer and slower." />
          <TimeField name="confirm_escalation_seconds" label="Escalate to an admin after" def={cfg.confirm_escalation_seconds}
                     hint="If the withdrawer never answers — offline, blocked the bot — the payment escalates rather than stalling forever." />
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0 }}>Limits</h2>
          <div className="field-row">
            <DollarField name="min_amount" label="Min per transaction" def={cfg.min_amount} />
            <DollarField name="max_amount" label="Max per transaction" def={cfg.max_amount} />
          </div>
          <DollarField name="daily_cap_per_player" label="Daily cap per player (blank = none)" def={cfg.daily_cap_per_player} />
          <DollarField name="owner_approval_threshold" label="Owner sign-off threshold (blank = none)"
                       def={cfg.owner_approval_threshold}
                       hint="At or above this, a plain admin cannot fast-path, pay out, or resolve a dispute alone." />
        </div>

        <div className="card">
          <h2 style={{ marginTop: 0 }}>Launch status</h2>
          <Check name="dev_notice_enabled" label="Show the “still in development” notice after setup" def={cfg.dev_notice_enabled}
                 hint="ON: players who finish setup are told not to deposit/cash-out yet, the bot is still in development. Turn OFF the moment you go live." />
        </div>
      </div>

      {msg && <div className={`alert ${msg.ok ? 'ok' : 'err'}`} style={{ marginTop: 12 }}>{msg.text}</div>}

      <button type="submit" className="primary" style={{ marginTop: 12 }} disabled={pending}>
        {pending ? 'Saving…' : 'Save settings'}
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

/** A money amount shown in DOLLARS but stored in cents — a $-prefixed number that
 *  submits cents via a hidden input, so the database and every rule are unchanged. */
function DollarField({ name, label, def, hint }: { name: string; label: string; def: number | null; hint?: string }) {
  const [val, setVal] = useState<string>(def != null ? String(Number(def) / 100) : '');
  const cents = val.trim() === '' ? '' : String(Math.round(parseFloat(val) * 100));
  return (
    <div className="field">
      <label htmlFor={name}>{label}</label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ color: 'var(--text-faint)', fontWeight: 600 }}>$</span>
        <input id={name} type="number" min="0" step="0.01" value={val} onChange={(e) => setVal(e.target.value)} style={{ flex: 1 }} />
      </div>
      <input type="hidden" name={name} value={cents} />
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

/** A duration in minutes/hours instead of raw seconds — a number plus a unit,
 *  submitting the value in seconds via a hidden input so nothing else changes. */
function TimeField({ name, label, def, hint }: { name: string; label: string; def: number | null; hint?: string }) {
  const sec = Number(def ?? 0);
  const initUnit: 'min' | 'hour' = sec >= 3600 && sec % 3600 === 0 ? 'hour' : 'min';
  const [unit, setUnit] = useState<'min' | 'hour'>(initUnit);
  const [val, setVal] = useState<string>(sec ? String(initUnit === 'hour' ? sec / 3600 : sec / 60) : '');
  const seconds = val.trim() === '' ? '' : String(Math.round(parseFloat(val) * (unit === 'hour' ? 3600 : 60)));
  return (
    <div className="field">
      <label htmlFor={name}>{label}</label>
      <div style={{ display: 'flex', gap: 8 }}>
        <input id={name} type="number" min="0" value={val} onChange={(e) => setVal(e.target.value)} style={{ flex: 1 }} />
        <select value={unit} onChange={(e) => setUnit(e.target.value as 'min' | 'hour')} style={{ width: 120 }}>
          <option value="min">minutes</option>
          <option value="hour">hours</option>
        </select>
      </div>
      <input type="hidden" name={name} value={seconds} />
      {hint && <div className="field-hint">{hint}{seconds ? ` (= ${seconds}s)` : ''}</div>}
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

// Rake/fees and the ClubGG-balance card are intentionally NOT rendered (hidden per
// request). Their fields are also left out of these sets, so saving the form never
// touches them — they keep whatever value they already have in the database.
const NUMERIC = new Set([
  'match_timeout_seconds', 'reversible_hold_seconds', 'confirm_escalation_seconds',
  'min_amount', 'max_amount', 'daily_cap_per_player', 'max_open_deposits_per_player',
  'max_open_withdraws_per_player', 'handle_reveals_per_hour', 'owner_approval_threshold',
]);
const BOOL = new Set(['allow_reversible', 'auto_release_on_expiry', 'dev_notice_enabled']);
