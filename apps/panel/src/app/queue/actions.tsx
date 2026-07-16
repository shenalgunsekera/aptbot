'use client';

import { PromptAction } from '../../components/ui';
import { payFromClub, cancelCashout } from '../../lib/actions';

export function QueueActions({
  w,
}: {
  w: { id: string; remaining: number; currency: string; handle: string; name: string };
}) {
  const amt = (w.remaining / 100).toFixed(2);

  return (
    <div className="btn-row">
      <PromptAction
        label="Pay from float"
        title="Clear this withdrawal yourself"
        variant="primary"
        confirm={
          `Confirm you have ALREADY SENT ${amt} ${w.currency} to:\n\n${w.handle}\n\n` +
          `This does not send anything — it records that you did, and books it against the float.\n\n` +
          `Only continue if the money has actually left your account.`
        }
        fields={[
          {
            name: 'amount',
            label: `Amount paid (blank = all ${amt})`,
            placeholder: amt,
          },
          {
            name: 'ref',
            label: 'Payment reference / transaction ID',
            placeholder: 'the ref from your own payment',
            required: true,
          },
          { name: 'note', label: 'Note', placeholder: 'why you cleared it manually' },
        ]}
        action={async (v) => {
          const minor = v.amount?.trim() ? Math.round(parseFloat(v.amount) * 100) : null;
          if (v.amount?.trim() && (!Number.isFinite(minor!) || minor! <= 0)) {
            return { ok: false as const, error: 'Enter a valid amount, or leave it blank for all.' };
          }
          return payFromClub(w.id, minor, v.ref ?? '', v.note ?? '');
        }}
      />

      <PromptAction
        label="Cancel"
        title={`Cancel ${w.name}'s withdrawal`}
        variant="danger"
        confirm={
          `Cancel this withdrawal. Unmatched escrow (${amt}) goes back to their wallet.\n\n` +
          `Any slice a depositor is already paying against will play out normally — it is not pulled back.`
        }
        fields={[{ name: 'reason', label: 'Reason', type: 'textarea', required: true }]}
        action={(v) => cancelCashout(w.id, v.reason ?? '')}
      />
    </div>
  );
}
