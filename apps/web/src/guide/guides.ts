import type { Role, ScreenKey } from '@vitan/shared';
import type { GuideTip } from './words';
import { guidedPhotoPicksOf, type GuideOutcome } from './outcomes';
import { useGuideState } from './guideState';
import { useStore } from '@/store/store';

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
   * When the step is complete: `press` (default) when the control is pressed; `done` when the control
   * says so with `data-guide-done="true"` (a photo actually attached), so a cancelled picker does not
   * move the guide on; `outcome` when the store reports the action really succeeded (see `outcome`).
   */
  until?: 'press' | 'done' | 'outcome';
  /**
   * For `until: 'outcome'`: the store's report that the pressed action succeeded (`ok`) or did not
   * (`failed`). Between the press and the report the guide waits instead of stepping back, because the
   * control may leave the screen while the request is on its way; a failure ends that wait.
   */
  outcome?: { ok: GuideOutcome; failed: GuideOutcome };
  /**
   * For `until: 'outcome'`: true when the store already shows the pressed action done, however that
   * became known (a live refresh can show a checklist submitted before the request's own answer comes
   * back, and that answer is then dropped). Checked on every look at the step, also after the request reported a
   * failure (its answer can be lost after the server took it), so it only says true for this run's own action.
   */
  settled?: (key: string | null) => boolean;
  /** point at the control carrying the same `data-guide-key` as the one pressed in an earlier step
   *  (the photo button of the item just failed, not of another failed item), or the key of the record
   *  it belongs to (that checklist's Submit); an `outcome` for another record does not count */
  keyed?: boolean;
}

export interface Guide {
  id: string;
  roles: readonly Role[];
  screen: ScreenKey;
  steps: readonly GuideStep[];
}

export const GUIDES: readonly Guide[] = [
  {
    // the app's "open issue" is a failed checklist item: the engineer raises it on the checklist
    id: 'raise-issue-engineer',
    roles: ['engineer'],
    screen: 'engineer-check',
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
    roles: ['pmc', 'engineer'],
    screen: 'dashboard',
    steps: [
      { target: 'add-site-photo', tip: 'photoAdd', until: 'outcome', outcome: { ok: 'site-photo-added', failed: 'site-photo-add-failed' }, settled: guidedPhotoOnRecord },
    ],
  },
];

/** The run's key is `<checklist id>:<item>`: that checklist is submitted once it is no longer out on site. */
function checklistSubmitted(key: string | null): boolean {
  if (key === null) return false;
  const id = key.split(':')[0];
  const s = useStore.getState();
  const open = s.openChecklists.some((c) => c.id === id) || (s.checklist?.id === id && !s.checklist.submitted);
  return !open;
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

/** The guides this role can be shown on this screen, in order. */
export function guidesFor(role: Role, screen: ScreenKey): readonly Guide[] {
  return GUIDES.filter((g) => g.screen === screen && g.roles.includes(role));
}
