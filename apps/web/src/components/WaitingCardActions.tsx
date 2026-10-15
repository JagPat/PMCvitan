import { useStore } from '@/store/store';
import { useMayWithdrawChange, useMySub } from '@/lib/mayWithdrawChange';
import type { Decision } from '@vitan/shared';
import { ConsultationThread } from './ConsultationThread';
import { CountersignControls } from './CountersignControls';
import { EditState } from './EditState';

/** #482 follow-up — what the client may do on a decision waiting on them besides approving it, the same on its card
 *  in the list and on the one-decision screen: read the advice thread and answer a question put to them (the
 *  component offers asking only to the roles allowed to ask), forward it while the countersign chain is open, and
 *  withdraw a change they asked for themselves. */
export function WaitingCardActions({ d }: { d: Decision }) {
  const withdrawChange = useStore((s) => s.withdrawChange);
  const mayWithdraw = useMayWithdrawChange();
  const mySub = useMySub();
  // the PMC may withdraw anyone's request — say so rather than claim they asked for it
  const mine = !!mySub && d.changeRequest?.requestedById === mySub;
  return (
    <>
      <ConsultationThread decision={d} />
      {/* the register row's Forward (while the countersign rollout is open), so hiding that row loses nothing */}
      <CountersignControls decision={d} />
      {mayWithdraw(d) && (
        <div style={{ marginTop: 10 }}>
          <EditState
            state="workflow"
            reason={mine
              ? 'You asked for this change. Withdraw it to keep the approved choice.'
              : 'Another member asked for this change. As PMC you can withdraw it to keep the approved choice.'}
            action={{ label: 'Withdraw request', onClick: () => withdrawChange(d.id), testId: `withdraw-${d.id}` }}
            testId={`edit-state-${d.id}`}
          />
        </div>
      )}
    </>
  );
}
