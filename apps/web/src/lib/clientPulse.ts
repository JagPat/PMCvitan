import { diffCivilDays, type Activity, type Decision } from '@vitan/shared';

/** How many upcoming activities "What happens next" names. */
export const NEXT_COUNT = 3;

export interface ClientPulse {
  /** the project's overall progress, as the project records it (the Health screen's figure) */
  progressPct: number;
  /** "Week N of M" — only inside the schedule's own dates, and only when both are known */
  week: { at: number; of: number } | null;
  /** what is being built now: the names of the activities in progress */
  underWay: string[];
  /** the first decision waiting on this client (a reopened one before a new one), and how many */
  needs: { first: Decision; count: number; reapproval: boolean } | null;
  /** the next activities due to start, soonest first, each with the decision it waits on, if any */
  next: { id: string; name: string; from: string; waitsOn?: string }[];
}

/**
 * U2a — the client's Pulse, derived from what the client already holds; nothing is stored, and
 * nothing is claimed that the data does not show. There is NO schedule verdict ("On track",
 * "Watch"): no field or rule decides one yet (#482). Decisions carry no reliable waiting-since date,
 * so "One thing needs you" is the first in the client's own list (a reopened one first), never
 * called the oldest. Civil dates are ISO `YYYY-MM-DD`; `today` is the site's.
 */
export function clientPulse(input: {
  milestonePct: number;
  scheduleStartDate: string | null;
  scheduleEndDate: string | null;
  today: string;
  activities: readonly Activity[];
  /** the decisions waiting on this viewer: re-approvals, then new ones */
  reapprovals: readonly Decision[];
  pending: readonly Decision[];
}): ClientPulse {
  const { scheduleStartDate: start, scheduleEndDate: end, today } = input;
  let week: ClientPulse['week'] = null;
  if (start && end && start <= today && today <= end) {
    week = { at: Math.floor(diffCivilDays(start, today) / 7) + 1, of: Math.ceil((diffCivilDays(start, end) + 1) / 7) };
  }

  const waiting = [...input.reapprovals, ...input.pending];
  const needs = waiting.length ? { first: waiting[0]!, count: waiting.length, reapproval: input.reapprovals.length > 0 } : null;
  const waitingTitle = new Map(waiting.map((d) => [d.id, d.title]));

  const next = input.activities
    .filter((a) => a.status === 'not-started' && !!a.plannedStartDate && a.plannedStartDate >= today)
    .sort((a, b) => a.plannedStartDate!.localeCompare(b.plannedStartDate!) || a.name.localeCompare(b.name))
    .slice(0, NEXT_COUNT)
    .map((a) => {
      const waitsOn = a.decisionId ? waitingTitle.get(a.decisionId) : undefined;
      return { id: a.id, name: a.name, from: a.plannedStartDate!, ...(waitsOn ? { waitsOn } : {}) };
    });

  return {
    progressPct: Math.max(0, Math.min(100, Math.round(input.milestonePct))),
    week,
    underWay: input.activities.filter((a) => a.status === 'in-progress').map((a) => a.name),
    needs,
    next,
  };
}
