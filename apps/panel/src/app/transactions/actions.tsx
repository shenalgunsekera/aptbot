'use client';

import { PromptAction } from '../../components/ui';
import { verifyPayment, reversePayment } from '../../lib/actions';

export function FillActions({
  fill,
}: {
  fill: {
    id: string;
    status: string;
    amount: number;
    currency: string;
    paymentRef: string | null;
    isClub: boolean;
  };
}) {
  const amt = (fill.amount / 100).toFixed(2);

  if (fill.status === 'awaiting_confirmation') {
    return (
      <PromptAction
        label="Verify & release"
        title="Fast-path confirm"
        variant="ok"
        confirm={
          `Release ${amt} ${fill.currency} now.\n\n` +
          `You are confirming that you personally checked payment reference "${fill.paymentRef}" ` +
          `against the provider and the money is there.\n\n` +
          `This issues chips immediately and overrides any hold. It cannot be undone.`
        }
        fields={[{
          name: 'note',
          label: 'How did you verify it?',
          type: 'textarea',
          placeholder: 'e.g. Confirmed on-chain, 6 confirmations, correct address and amount.',
          required: true,
        }]}
        action={(v) => verifyPayment(fill.id, v.note ?? '')}
      />
    );
  }

  if (fill.status === 'released') {
    return (
      <PromptAction
        label="Reversed"
        title="Payment was reversed after release"
        variant="danger"
        confirm={
          `Book ${amt} ${fill.currency} as a HOUSE LOSS.\n\n` +
          `The chips are already out and may be spent. The recipient will be made whole ` +
          `and the union eats the difference.\n\nOwner only. Continue?`
        }
        fields={[{
          name: 'reason',
          label: 'What happened?',
          type: 'textarea',
          placeholder: 'e.g. PayPal chargeback #12345 received, funds pulled back.',
          required: true,
        }]}
        action={(v) => reversePayment(fill.id, v.reason ?? '', true)}
      />
    );
  }

  return null;
}
