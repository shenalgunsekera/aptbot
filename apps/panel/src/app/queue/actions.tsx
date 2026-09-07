'use client';

import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ActionButton, PromptAction } from '../../components/ui';
import { payFromClub, cancelCashout, setWithdrawMin, moveWithdraw, addQueuePayout, pausePayout, resumePayout, unpauseWithPayment } from '../../lib/actions';

/** Unpause a paused cash-out: either just put it back, or record a payment you
 *  made (amount + up to 2 receipts) which notifies the payee, then unpause. */
export function UnpauseDialog({ id, name, remaining }: { id: string; name: string; remaining: number }) {
  const dlg = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [mode, setMode] = useState<'choose' | 'adjust'>('choose');
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const amt = (remaining / 100).toFixed(2);

  const open = () => { setMode('choose'); setErr(null); dlg.current?.showModal(); };
  const close = () => dlg.current?.close();
  const justUnpause = () => start(async () => {
    setErr(null);
    const r = await resumePayout(id);
    if (r.ok) { close(); router.refresh(); } else setErr(r.error);
  });
  const submitAdjust = () => {
    setErr(null);
    const fd = new FormData(formRef.current!);
    fd.set('id', id);
    const a = String(fd.get('amount') ?? '').trim();
    if (!a || !(parseFloat(a) > 0)) { setErr('Enter the amount you paid.'); return; }
    start(async () => {
      const r = await unpauseWithPayment(fd);
      if (r.ok) { close(); router.refresh(); } else setErr(r.error);
    });
  };

  return (
    <>
      <button className="sm primary" onClick={open}>▶️ Unpause</button>
      <dialog ref={dlg} onClick={(e) => { if (e.target === dlg.current) close(); }}
              style={{ border: 'none', borderRadius: 14, padding: 0, width: 'min(380px, 92vw)', background: 'transparent' }}>
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12, textAlign: 'left' }}>
          <strong>Unpause {name}</strong>
          {mode === 'choose' ? (
            <>
              <p className="sub" style={{ margin: 0 }}>Put it back in the queue — record a payment you made, or just unpause.</p>
              <button className="primary" onClick={() => { setErr(null); setMode('adjust'); }}>💵 Adjust & unpause (a payment was made)</button>
              <button onClick={justUnpause} disabled={pending}>{pending ? '…' : '▶️ No adjust — just unpause'}</button>
            </>
          ) : (
            <form ref={formRef} style={{ display: 'flex', flexDirection: 'column', gap: 10 }} onSubmit={(e) => e.preventDefault()}>
              <label style={{ fontSize: 13, fontWeight: 600 }}>Amount paid ($)
                <input name="amount" inputMode="decimal" placeholder={amt} required style={{ width: '100%', marginTop: 4 }} />
              </label>
              <label style={{ fontSize: 13, fontWeight: 600 }}>Reference / txn ID (optional)
                <input name="ref" style={{ width: '100%', marginTop: 4 }} />
              </label>
              <label style={{ fontSize: 13, fontWeight: 600 }}>Receipt 1 (optional)
                <input type="file" name="r1" accept="image/*" style={{ width: '100%', marginTop: 4 }} />
              </label>
              <label style={{ fontSize: 13, fontWeight: 600 }}>Receipt 2 (optional)
                <input type="file" name="r2" accept="image/*" style={{ width: '100%', marginTop: 4 }} />
              </label>
              <p className="sub" style={{ margin: 0 }}>The payee gets the normal “you’ve been paid” message with these receipts.</p>
              <button type="button" className="primary" onClick={submitAdjust} disabled={pending}>{pending ? 'Saving…' : 'Record payment & unpause'}</button>
            </form>
          )}
          {err && <div className="alert err">{err}</div>}
          <button type="button" className="sm" onClick={close}>Cancel</button>
        </div>
      </dialog>
    </>
  );
}

/** Admin: drop a Venmo/Zelle tag into the cash-out queue, funded by the club's
 *  float. Any P2P deposit of that method fills it — fillable from any platform. */
export function AddQueuePayout({ methods }: { methods: { id: string; name: string }[] }) {
  const [open, setOpen] = useState(false);
  const [methodId, setMethodId] = useState(methods[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const [handle, setHandle] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  if (methods.length === 0) return null;

  const submit = () => {
    setErr(null);
    const cents = Math.round(parseFloat(amount) * 100);
    if (!Number.isFinite(cents) || cents <= 0) { setErr('Enter an amount.'); return; }
    if (!handle.trim()) { setErr('Enter the Venmo/Zelle tag to pay.'); return; }
    start(async () => {
      const r = await addQueuePayout(methodId, cents, handle.trim());
      if (r.ok) { setAmount(''); setHandle(''); setOpen(false); router.refresh(); }
      else setErr(r.error);
    });
  };

  return (
    <div style={{ position: 'relative' }}>
      <button className="btn" onClick={() => setOpen((o) => !o)}>{open ? 'Close' : '➕ Add payout to queue'}</button>
      {open && (
        <div className="card" style={{ position: 'absolute', right: 0, zIndex: 20, marginTop: 8, width: 300, display: 'flex', flexDirection: 'column', gap: 8, textAlign: 'left' }}>
          <div className="sub" style={{ margin: 0 }}>Funded by the club float. Any deposit of this method can fill it.</div>
          <select value={methodId} onChange={(e) => setMethodId(e.target.value)}>
            {methods.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <input placeholder="Amount ($)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <input placeholder="Venmo/Zelle tag to pay" value={handle} onChange={(e) => setHandle(e.target.value)} />
          <button className="primary" disabled={pending} onClick={submit}>{pending ? '…' : 'Add to queue'}</button>
          {err && <div className="alert err">{err}</div>}
        </div>
      )}
    </div>
  );
}

export function QueueActions({
  w,
}: {
  w: { id: string; remaining: number; currency: string; handle: string; name: string; minOverride: number | null; isClub?: boolean };
}) {
  const amt = (w.remaining / 100).toFixed(2);

  return (
    <div className="queue-actions">
      {/* A club-funded payout is already covered by the float — paying it "from
          float" again would double-count, and a per-player min is meaningless. So
          for those only Cancel (reclaim the float) and reorder are shown. */}
      {!w.isClub && (
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
      )}

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

      {!w.isClub && (
      <PromptAction
        label={w.minOverride ? `Min $${(w.minOverride / 100).toFixed(2)}` : 'Set min'}
        title={`Minimum for ${w.name}'s cash-out`}
        fields={[{
          name: 'min',
          label: 'Minimum ($) — must be above the default. Blank = reset.',
          placeholder: '50',
          defaultValue: w.minOverride ? String(w.minOverride / 100) : '',
        }]}
        action={async (v) => {
          const raw = v.min?.trim();
          const cents = raw ? Math.round(parseFloat(raw) * 100) : null;
          if (raw && (!Number.isFinite(cents!) || cents! <= 0)) {
            return { ok: false as const, error: 'Enter a dollar amount, or leave blank to reset.' };
          }
          return setWithdrawMin(w.id, cents);
        }}
      />
      )}

      {/* Take it out of the queue to handle it manually; unpause from the Paused list. */}
      <ActionButton small label="⏸ Pause" action={() => pausePayout(w.id)} />

      {/* One-click reorder — no more typing "confirm" every move. */}
      <ActionButton small label="↑ Up" action={() => moveWithdraw(w.id, 'up')} />
      <ActionButton small label="↓ Down" action={() => moveWithdraw(w.id, 'down')} />
    </div>
  );
}
