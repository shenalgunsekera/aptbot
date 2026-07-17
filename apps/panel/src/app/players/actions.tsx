'use client';

import { ActionButton, PromptAction } from '../../components/ui';
import { confirmPlayer, setPlayerStatus, adjustPlayer, approveSportsbook } from '../../lib/actions';

/** A Sportsbook account the club must CREATE. Shows the desired credentials; the
 *  button marks it created (on APT Sports) and auto-resumes the player. */
export function SportsbookCreateAction({
  playerId, username,
}: {
  playerId: string; username: string;
}) {
  return (
    <div className="btn-row">
      <ActionButton
        small variant="ok" label={`Created ${username}`}
        confirm={`Confirm you've created the APT Sports account "${username}" with the shown password. ` +
          `The player will be told and setup will continue.`}
        action={() => approveSportsbook(playerId, null)}
      />
      <PromptAction
        label="Different username"
        title="Created with a different username"
        variant="primary"
        fields={[{ name: 'uid', label: 'Actual Sportsbook username', placeholder: username, required: true }]}
        action={(v) => approveSportsbook(playerId, v.uid ?? null)}
      />
    </div>
  );
}

/** Approve a claimed platform account. Shown per pending claim. */
export function ConfirmAction({
  playerId, platformId, uid, platformName,
}: {
  playerId: string; platformId: string; uid: string; platformName: string;
}) {
  return (
    <div className="btn-row">
      <ActionButton
        small variant="ok" label={`Approve ${uid}`}
        confirm={`Link this player to ${platformName} ID:\n\n${uid}\n\n` +
          `Have you checked this exact ID against the roster? Money gets sent here.`}
        action={() => confirmPlayer(playerId, platformId)}
      />
      <PromptAction
        label="Fix it"
        title={`Approve with a different ${platformName} ID`}
        variant="primary"
        fields={[{ name: 'uid', label: `Correct ${platformName} ID`, placeholder: uid, required: true }]}
        action={(v) => confirmPlayer(playerId, platformId, v.uid)}
      />
    </div>
  );
}

export function PlayerActions({
  player, isOwner, platforms,
}: {
  player: { id: string; status: string; name: string; currency: string };
  isOwner: boolean;
  platforms: Array<{ id: string; name: string }>;
}) {
  return (
    <div className="btn-row">
      {player.status === 'active' ? (
        <PromptAction
          label="Put on hold"
          title={`Put ${player.name} on hold`}
          variant="danger"
          confirm="They keep their money but can't start anything new. Money already moving settles normally."
          fields={[{ name: 'reason', label: 'Reason', type: 'textarea', required: true }]}
          action={(v) => setPlayerStatus(player.id, 'frozen', v.reason ?? '')}
        />
      ) : player.status === 'frozen' ? (
        <PromptAction
          label="Un-hold"
          title={`Reactivate ${player.name}`}
          variant="ok"
          fields={[{ name: 'reason', label: 'Reason', type: 'textarea', required: true }]}
          action={(v) => setPlayerStatus(player.id, 'active', v.reason ?? '')}
        />
      ) : null}

      {isOwner && platforms.length > 0 && (
        <PromptAction
          label="Adjust"
          title={`Manually adjust ${player.name}`}
          variant="danger"
          confirm="This writes straight to the books against your P&L. Owner only, fully logged."
          fields={[
            { name: 'platform', label: `Platform (${platforms.map((p) => p.name).join(' / ')})`, placeholder: platforms[0]!.name, required: true },
            { name: 'amount', label: 'Amount, signed (e.g. -25.00 to claw back)', required: true },
            { name: 'reason', label: 'Reason', type: 'textarea', required: true },
          ]}
          action={async (v) => {
            const minor = Math.round(parseFloat(v.amount!) * 100);
            if (!Number.isFinite(minor) || minor === 0) return { ok: false as const, error: 'Enter a non-zero amount.' };
            const pf = platforms.find((p) => p.name.toLowerCase() === v.platform?.trim().toLowerCase());
            if (!pf) return { ok: false as const, error: `Unknown platform. Use: ${platforms.map((p) => p.name).join(', ')}` };
            return adjustPlayer(player.id, pf.id, minor, player.currency, v.reason ?? '');
          }}
        />
      )}
    </div>
  );
}
