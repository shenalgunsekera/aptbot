'use client';

import { ActionButton, PromptAction } from '../../components/ui';
import { claimJob, completeJob, failJob, releaseJob } from '../../lib/actions';

export function JobRow({
  job,
}: {
  job: { id: string; delta: number; status: string; name: string; uid: string };
}) {
  if (job.status === 'pending') {
    return <ActionButton small variant="primary" label="Claim" action={() => claimJob(job.id)} />;
  }

  const isAdd = job.delta > 0;
  const amount = Math.abs(job.delta);

  return (
    <div className="btn-row">
      <ActionButton
        small variant="ok" label="Done"
        confirm={`Confirm you ${isAdd ? 'added' : 'took off'} $${(amount / 100).toFixed(2)} ` +
          `${isAdd ? 'to' : 'from'} ${job.uid} (${job.name}). Only tap this if you actually did it.`}
        action={() => completeJob(job.id, null, 'done via panel')}
      />

      {/* Taking off can come up short — the player may have gambled some away. */}
      {!isAdd && (
        <PromptAction
          label="Different amount"
          title={`How much did you actually take off ${job.name}?`}
          variant="primary"
          fields={[
            { name: 'actual', label: 'Amount (e.g. 30.00)', placeholder: (amount / 100).toFixed(2), required: true },
            { name: 'note', label: 'What happened?', type: 'textarea', required: true },
          ]}
          action={async (v) => {
            const minor = Math.round(parseFloat(v.actual!) * 100);
            if (!Number.isFinite(minor) || minor < 0) return { ok: false as const, error: 'Enter a valid amount.' };
            return completeJob(job.id, -minor, v.note ?? '');
          }}
        />
      )}

      <PromptAction
        label="Couldn't do it"
        title="Mark as failed"
        variant="danger"
        fields={[{ name: 'reason', label: 'Why?', type: 'textarea', required: true }]}
        action={(v) => failJob(job.id, v.reason ?? '')}
      />

      <ActionButton
        small variant="ghost" label="Put back"
        confirm="Only put this back if you're certain nothing moved."
        action={() => releaseJob(job.id)}
      />
    </div>
  );
}
