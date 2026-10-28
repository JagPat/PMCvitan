import { can, viewerIsConsultee, type Decision, type Role, type ScreenKey } from '@vitan/shared';
import type { GuideTip, GuideTitle } from './words';
import { guidedPhotoPicksOf, type GuideOutcome } from './outcomes';
import { useGuideState } from './guideState';
import { inspectionFrozen, useStore } from '@/store/store';
import { dailyLogSendPending } from '@/store/dailyLogPending';
import { selectDecisionsNeedingViewer } from '@/store/selectors';
import { API_BASE } from '@/data/apiGateway';

/**
 * #482 (board decision 14 Oct) — the in-app guide: coach marks on the live screen.
 *
 * A guide is a short list of steps. Each step points at ONE real control, found by its stable
 * `data-guide` attribute (never a CSS class), and says one short line about it. The guide moves on
 * when the person presses that control (or, for an action that can fail, when it succeeds), so it follows the work instead of describing it.
 *
 * `screen` is where the guide shows itself the first time and where "Guide me" offers it again.
 * `roles` keeps each guide to the people who can actually do the task (the policy decides that;
 * a guide never points at a control the role is not shown).
 */
export interface GuideStep {
  /** the `data-guide` value of the control this step points at */
  target: string;
  tip: GuideTip;
  /**
   * When the step is complete: `press` (default) when the control is pressed; `focus` when a text box is pressed or
   * reached from the keyboard; `done` when the control
   * says so with `data-guide-done="true"` (a photo actually attached), so a cancelled picker does not
   * move the guide on; `outcome` when the store reports the action really succeeded (see `outcome`).
   */
  until?: 'press' | 'focus' | 'done' | 'outcome';
  /**
   * For `until: 'outcome'`: the store's report that the pressed action succeeded (`ok`) or did not
   * (`failed`). Between the press and the report the guide waits instead of stepping back, because the
   * control may leave the screen while the request is on its way; a failure ends that wait. `held` is the
   * report that the action went through but may not last (an offline photo the phone could not keep, still
   * sent from memory while Vitan stays open): the run ends unfinished, so it is offered again later and does
   * not invite a second try that would send the same thing twice.
   */
  outcome?: { ok: GuideOutcome; failed: GuideOutcome; held?: GuideOutcome };
  /**
   * For `until: 'outcome'`: true when the store already shows the pressed action done, however that
   * became known (a live refresh can show a checklist submitted before the request's own answer comes
   * back, and that answer is then dropped). Checked on every look at the step, also after the request reported a
   * failure (its answer can be lost after the server took it), so it only says true for this run's own action.
   */
  settled?: (key: string | null) => boolean;
  /** For `until: 'outcome'`: the step a failed report goes back to (the box the attempt emptied), instead of staying here */
  retryFrom?: number;
  /** point at the control carrying the same `data-guide-key` as the one pressed in an earlier step
   *  (the photo button of the item just failed, not of another failed item), or the key of the record
   *  it belongs to (that checklist's Submit); an `outcome` for another record does not count */
  keyed?: boolean;
}

export interface Guide {
  id: string;
  /** its name in the Help sheet's "Show me how" list */
  title: GuideTitle;
  roles: readonly Role[];
  screen: ScreenKey;
  /** other screens showing the same controls (the client's register renders their Decisions screen too) */
  alsoOn?: readonly ScreenKey[];
  steps: readonly GuideStep[];
  /** false while the project has nothing yet to show this guide on (no checklist out on site), so the welcome's
   *  "Show me around" picks another one; leave it out for a guide that can always start */
  available?: () => boolean;
}

export const GUIDES: readonly Guide[] = [
  {
    // the app's "open issue" is a failed checklist item: the engineer raises it on the checklist
    id: 'raise-issue-engineer',
    title: 'raiseIssueEngineer',
    roles: ['engineer'],
    screen: 'engineer-check',
    available: checklistOutOnSite,
    steps: [
      { target: 'mark-fail', tip: 'issueMarkFail' },
      { target: 'fail-photo', tip: 'issueFailPhoto', keyed: true, until: 'done' },
      {
        target: 'submit-inspection',
        tip: 'issueSubmit',
        keyed: true,
        until: 'outcome',
        outcome: { ok: 'inspection-submitted', failed: 'inspection-submit-failed' },
        settled: checklistSubmitted,
      },
    ],
  },
  {
    // the PMC raises one by asking the engineer to check it: + → "Check something here" → issue
    id: 'raise-issue-pmc',
    title: 'raiseIssuePmc',
    roles: ['pmc'],
    screen: 'dashboard',
    steps: [
      { target: 'add', tip: 'issueAdd' },
      { target: 'create-inspection', tip: 'issueAskCheck' },
      { target: 'issue-checklist', tip: 'issueSend', until: 'outcome', outcome: { ok: 'checklist-issued', failed: 'checklist-issue-failed' } },
    ],
  },
  {
    // the PMC puts a decision to its decider (the client, by default): + → "Something to decide here" → Publish. It shares
    // the Dashboard with the guide above, so it starts by itself on the next visit, not on top of it.
    id: 'record-decision-pmc',
    title: 'recordDecision',
    roles: ['pmc'],
    screen: 'dashboard',
    steps: [
      { target: 'add', tip: 'decisionAdd' },
      { target: 'create-decision', tip: 'decisionPick' },
      { target: 'publish-decision', tip: 'decisionPublish', until: 'outcome', outcome: { ok: 'decision-published', failed: 'decision-publish-failed' } },
    ],
  },
  {
    // a site photo: the Dashboard's "Add site photo" opens the phone's camera or gallery. The step ends only when the
    // store has the photo (sent, kept on this phone to send, or on record from a live refresh before the upload's own
    // answer), so a cancelled picker leaves the tip where it is.
    id: 'add-site-photo',
    title: 'addSitePhoto',
    roles: ['pmc', 'engineer'],
    screen: 'dashboard',
    available: sitePhotoButtonUsable,
    steps: [
      { target: 'add-site-photo', tip: 'photoAdd', until: 'outcome', outcome: { ok: 'site-photo-added', failed: 'site-photo-add-failed', held: 'site-photo-not-kept' }, settled: guidedPhotoOnRecord },
    ],
  },
  {
    // the client answers a choice put to them: Approve on the option they want, then confirm. Each Approve carries its
    // decision's id, so the confirm step and its outcome follow that one decision, not another approved meanwhile.
    id: 'approve-decision-client',
    title: 'approveDecision',
    roles: ['client'],
    screen: 'client-decisions',
    available: decisionWaitingOnViewer,
    steps: [
      { target: 'approve-option', tip: 'approvePick' },
      {
        target: 'approve-confirm',
        tip: 'approveConfirm',
        keyed: true,
        until: 'outcome',
        outcome: { ok: 'decision-approved', failed: 'decision-approve-failed', held: 'decision-approve-not-kept' },
        settled: decisionApproved,
      },
    ],
  },
  {
    // a member asked for advice on a decision answers it: write it, then send it. The box and its Send carry
    // `<decision>:<consultation>`, so the Send step and its outcome follow that one request.
    id: 'answer-advice',
    title: 'answerAdvice',
    roles: ['consultant', 'architect', 'pmc', 'engineer', 'contractor'],
    screen: 'decision-log',
    available: adviceWaitingOnViewer,
    steps: answerAdviceSteps(),
  },
  {
    // a client asked for advice answers it on their own Decisions screen, in the same box on the decision's card
    id: 'answer-advice-client',
    title: 'answerAdvice',
    roles: ['client'],
    screen: 'client-decisions',
    // a request's link opens the client's register (`decision-log`), which shows the same Decisions screen
    alsoOn: ['decision-log'],
    available: adviceWaitingOnViewer,
    steps: answerAdviceSteps(),
  },
];

/** Write the advice, then send it: the same two steps wherever the advice box shows. */
function answerAdviceSteps(): GuideStep[] {
  return [
    // keyed: any box starts it; after a refused send it points back at the same request's box
    { target: 'advice-write', tip: 'adviceWrite', until: 'focus', keyed: true },
    {
      target: 'advice-send',
      tip: 'adviceSend',
      keyed: true,
      until: 'outcome',
      outcome: { ok: 'advice-sent', failed: 'advice-send-failed', held: 'advice-not-kept' },
      settled: adviceAnswered,
      // Send empties the box, so a refused send goes back to writing it again
      retryFrom: 0,
    },
  ];
}

/** A decision still open to advice: the same open set the advice box itself reads (`ConsultationThread`). */
function openToAdvice(d: Decision): boolean {
  return !d.draft && (d.status === 'pending' || d.status === 'change' || d.status === 'awaiting_countersign');
}

/** This viewer was asked for advice on the decision, in its current cycle, and has not answered yet: its advice box shows. */
function adviceAskedOf(d: Decision, userId: string | null): boolean {
  const thread = d.consultations ?? [];
  const cycle = d.approvalCycle ?? 0;
  return openToAdvice(d) && viewerIsConsultee(thread, cycle, userId) && thread.some((c) => c.consulteeUserId === userId && c.openCycle === cycle && !c.response);
}

/** Someone asked this viewer for advice that is still open and unanswered. */
function adviceWaitingOnViewer(): boolean {
  const s = useStore.getState();
  return s.decisions.some((d) => adviceAskedOf(d, s.sessionUserId));
}

/** The run's key is `<decision id>:<consultation id>`: answered once that consultation carries a response (an earlier one
 *  answered on the same decision is not this one). */
function adviceAnswered(key: string | null): boolean {
  if (key === null) return false;
  const at = key.indexOf(':');
  if (at < 0) return false;
  const decisionId = key.slice(0, at);
  const consultationId = key.slice(at + 1);
  const d = useStore.getState().decisions.find((x) => x.id === decisionId);
  return (d?.consultations ?? []).some((c) => c.id === consultationId && !!c.response);
}

/** A decision waits on this viewer (the client's Decisions screen shows its Approve buttons only then). */
function decisionWaitingOnViewer(): boolean {
  return selectDecisionsNeedingViewer(useStore.getState()).length > 0;
}

/** The run's key is the decision's id: it is answered once the store shows it approved (or sent on for the architect's
 *  countersign). A decision that only left the list (withdrawn, or its decider changed) was not approved. */
function decisionApproved(key: string | null): boolean {
  if (key === null) return false;
  const d = useStore.getState().decisions.find((x) => x.id === key);
  return d?.status === 'approved' || d?.status === 'awaiting_countersign';
}

/** The run's key is `<checklist id>:<item>`: that checklist is submitted once it is no longer out on site. */
function checklistSubmitted(key: string | null): boolean {
  if (key === null) return false;
  const id = key.split(':')[0];
  const s = useStore.getState();
  const open = s.openChecklists.some((c) => c.id === id) || (s.checklist?.id === id && !s.checklist.submitted);
  return !open;
}

/** The engineer has a checklist out on site with an item still to mark failed: one not frozen by a submit, with an
 *  item not already failed (the checklist screen offers Fail as a guide target only there). */
function checklistOutOnSite(): boolean {
  const s = useStore.getState();
  const lists = s.checklist && !s.openChecklists.some((c) => c.id === s.checklist!.id) ? [...s.openChecklists, s.checklist] : s.openChecklists;
  return lists.some((c) => !inspectionFrozen(s, c) && c.items.some((it) => it.state !== 'fail'));
}

/** The Dashboard shows a pressable "Add site photo": only against the server (never in demo mode), to a role that may
 *  upload, and not while the day's log is being sent (see `AddSitePhoto`). */
function sitePhotoButtonUsable(): boolean {
  const s = useStore.getState();
  return !!API_BASE && can('media.upload', s.role) && !dailyLogSendPending(s);
}

/** A photo picked under this run of the guide is in the project's photos (the viewer's own photos carry their upload key). */
function guidedPhotoOnRecord(): boolean {
  const run = useGuideState.getState().run;
  if (!run) return false;
  const picks = guidedPhotoPicksOf(run.id);
  if (picks.size === 0) return false;
  const s = useStore.getState();
  return [...s.photos, ...s.myDeletablePhotos].some((p) => p.clientKey !== undefined && picks.has(p.clientKey));
}

/** Every guide this role can be shown, on any screen, in order (the Help sheet's list). */
export function guidesForRole(role: Role): readonly Guide[] {
  return GUIDES.filter((g) => g.roles.includes(role));
}

/** The guide's controls are on this screen: its own, or one showing the same controls. */
export function guideOnScreen(guide: Guide, screen: string): boolean {
  return guide.screen === screen || (guide.alsoOn ?? []).some((s) => s === screen);
}

/** The guides this role can be shown on this screen, in order. */
export function guidesFor(role: Role, screen: ScreenKey): readonly Guide[] {
  return GUIDES.filter((g) => guideOnScreen(g, screen) && g.roles.includes(role));
}
