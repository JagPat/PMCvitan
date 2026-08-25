import { can, type PolicyAction, type TokenRole } from '@vitan/shared';
import { ClipboardCheck, Package, ClipboardList, type LucideIcon } from 'lucide-react';

/** What a user can start creating, named the way a person would say it. */
export type CreateKind = 'inspection' | 'material' | 'decision';

export interface CreateOption {
  kind: CreateKind;
  /** what the user is DOING, never which module owns the result */
  label: string;
  detail: string;
  action: PolicyAction;
  icon: LucideIcon;
}

/**
 * The Add menu's options.
 *
 * Worded as things that happen on a building site, because a user should not have to know
 * which backend module owns a record before they can enter one. "Check something here" is
 * the question they are answering; that it becomes an inspection the PMC reviews is the
 * system's business, not theirs.
 *
 * Each option names the permission that already governs it, so the menu can never offer an
 * action the server would refuse — the existing policy stays the single authority.
 */
const OPTIONS: readonly CreateOption[] = [
  { kind: 'inspection', label: 'Check something here', detail: 'Issue a checklist for the site engineer to fill in', action: 'inspection.create', icon: ClipboardCheck },
  { kind: 'material', label: 'Material delivered here', detail: 'Record what arrived and how much', action: 'dailyLog.addMaterial', icon: Package },
  { kind: 'decision', label: 'Something to decide here', detail: 'Put options to the client to choose between', action: 'decision.create', icon: ClipboardList },
];

/** The options this role may actually author — the existing policy decides, nothing else. */
export function createOptionsFor(role: TokenRole): readonly CreateOption[] {
  return OPTIONS.filter((o) => can(o.action, role));
}

/**
 * Why a delivery cannot be recorded right now, or `null` when it can.
 *
 * A delivery is recorded ONTO a daily log: `DailyLogService.addMaterial` 404s with no log
 * and 409s once the log is submitted. Permission alone therefore does not mean the command
 * will be accepted, and offering the form regardless would take a name and a quantity and
 * then fail — the dead-end this whole unit exists to remove.
 *
 * Permission and readiness are answered differently on purpose. A role that may never do
 * something is not shown the option at all; a role whose turn simply has not come is shown
 * it with the reason, because that is a state they can act on.
 *
 * A FAILED log read fails CLOSED. An earlier version enabled capture there, reasoning that
 * we cannot know whether a log is open so the server's error is the honest fallback. That
 * was wrong on the evidence: `DailyLogScreen` treats the same `dailyLogLoad === 'error'` as
 * unavailable and locks every mutation until Retry succeeds, and a second entry point that
 * accepts the delivery instead would take the entry, close the form, and leave the write to
 * be rejected. Not knowing is itself a reason, and it is stated rather than gambled on.
 */
export function materialBlockedReason(
  dailyLog: { submitted: boolean } | null,
  logReadFailed: boolean,
): string | null {
  if (logReadFailed) return 'Today\u2019s log could not be loaded, so a delivery cannot be recorded yet — open the Daily Log and retry.';
  if (!dailyLog) return 'Start today\u2019s site log first — a delivery is recorded onto it.';
  if (dailyLog.submitted) return 'Today\u2019s log is already submitted — start a new day to record a delivery.';
  return null;
}
