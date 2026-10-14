import type { Role, ScreenKey } from '@vitan/shared';
import type { GuideTip } from './words';

/**
 * #482 (board decision 14 Oct) — the in-app guide: coach marks on the live screen.
 *
 * A guide is a short list of steps. Each step points at ONE real control, found by its stable
 * `data-guide` attribute (never a CSS class), and says one short line about it. The guide moves on
 * when the person presses that control, so it follows the work instead of describing it.
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
   * says so with `data-guide-done="true"` (a photo actually attached, a submit actually accepted or
   * queued), so a cancelled picker or a refused submit does not move the guide on.
   */
  until?: 'press' | 'done';
  /** point at the control carrying the same `data-guide-key` as the one pressed in an earlier step
   *  (the photo button of the item just failed, not of another failed item) */
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
      { target: 'submit-inspection', tip: 'issueSubmit', until: 'done' },
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
      { target: 'issue-checklist', tip: 'issueSend' },
    ],
  },
];

/** The guides this role can be shown on this screen, in order. */
export function guidesFor(role: Role, screen: ScreenKey): readonly Guide[] {
  return GUIDES.filter((g) => g.screen === screen && g.roles.includes(role));
}
