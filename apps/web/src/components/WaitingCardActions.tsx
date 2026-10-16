import { useStore } from '@/store/store';
import { useMayWithdrawChange, useMySub } from '@/lib/mayWithdrawChange';
import { decisionLogLabels, withdrawChangeLabels, type Decision, type Lang } from '@vitan/shared';
import { ConsultationThread } from './ConsultationThread';
import { CountersignControls } from './CountersignControls';
import { EditState } from './EditState';

/** #482 follow-up — what the client may do on a decision waiting on them besides approving it, the same on its card
 *  in the list and on the one-decision screen: read the advice thread and answer a question put to them (the
 *  component offers asking only to the roles allowed to ask), forward it while the countersign chain is open, and
 *  withdraw a change they asked for themselves. `lang` is the caller's (English unless it says otherwise), for
 *  this card's own words and the thread and controls it holds. */
export function WaitingCardActions({ d, lang = 'en' }: { d: Decision; lang?: Lang }) {
  const withdrawChange = useStore((s) => s.withdrawChange);
  const mayWithdraw = useMayWithdrawChange();
  const mySub = useMySub();
  // the PMC may withdraw anyone's request — say so rather than claim they asked for it
  const mine = !!mySub && d.changeRequest?.requestedById === mySub;
  return (
    <>
      <ConsultationThread decision={d} lang={lang} />
      {/* the register row's Forward (while the countersign rollout is open), so hiding that row loses nothing */}
      <CountersignControls decision={d} lang={lang} />
      {mayWithdraw(d) && (
        <div style={{ marginTop: 10 }}>
          <EditState
            state="workflow"
            reason={(mine ? withdrawChangeLabels.mine : withdrawChangeLabels.others)[lang]}
            action={{ label: decisionLogLabels.withdrawRequest[lang], onClick: () => withdrawChange(d.id), testId: `withdraw-${d.id}` }}
            testId={`edit-state-${d.id}`}
          />
        </div>
      )}
    </>
  );
}
