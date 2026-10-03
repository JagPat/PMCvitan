import type { PmcBriefProject, ScreenKey } from '@vitan/shared';

/** How many tasks "Do these first" names. */
export const FIRST_COUNT = 3;

const DAY_MS = 86_400_000;

/** One thing for the PMC to do, in one project, and the screen where it is done. */
export type BriefTask =
  | { kind: 'client'; projectId: string; short: string; count: number; days: number; target: ScreenKey }
  | { kind: 'reviews'; projectId: string; short: string; count: number; target: ScreenKey }
  | { kind: 'log'; projectId: string; short: string; log: 'open' | 'missing'; target: ScreenKey };

export interface PmcBrief {
  /** the first tasks, most pressing first (at most `FIRST_COUNT`) */
  first: BriefTask[];
  /** how many tasks there are in all, the ones not named included */
  total: number;
  /** across every project in the brief */
  digest: { projects: number; logsSent: number; approvals: number; photos: number; rejectedInspections: number };
}

/**
 * U3b — the PMC's brief, ranked from `GET /me/brief` (U3a); nothing is stored. The order is a fixed,
 * stated rule, not a verdict on any project:
 *  1. decisions waiting on a client, longest-waiting first — the client is the one held up;
 *  2. inspections waiting for review, most first — a contractor is held up;
 *  3. today's site log not sent, not started before started, then by project.
 * "Days" counts whole days since the oldest waiting decision was published, against `now`.
 */
export function pmcBrief(projects: readonly PmcBriefProject[], now: number): PmcBrief {
  const client = projects
    .filter((p) => p.waitingOnClient > 0)
    .map((p) => ({ p, since: p.oldestWaitingSince ? Date.parse(p.oldestWaitingSince) : NaN }))
    .sort((a, b) => (Number.isNaN(a.since) ? 1 : 0) - (Number.isNaN(b.since) ? 1 : 0) || a.since - b.since || byShort(a.p, b.p))
    .map(({ p, since }): BriefTask => ({
      kind: 'client',
      projectId: p.projectId,
      short: p.short,
      count: p.waitingOnClient,
      days: Number.isNaN(since) ? 0 : Math.max(0, Math.floor((now - since) / DAY_MS)),
      target: 'decision-log',
    }));
  const reviews = projects
    .filter((p) => p.reviewsWaiting > 0)
    .sort((a, b) => b.reviewsWaiting - a.reviewsWaiting || byShort(a, b))
    .map((p): BriefTask => ({ kind: 'reviews', projectId: p.projectId, short: p.short, count: p.reviewsWaiting, target: 'inspect-review' }));
  const logs = projects
    .filter((p) => p.logToday !== 'sent')
    .sort((a, b) => (a.logToday === 'missing' ? 0 : 1) - (b.logToday === 'missing' ? 0 : 1) || byShort(a, b))
    .map((p): BriefTask => ({ kind: 'log', projectId: p.projectId, short: p.short, log: p.logToday as 'open' | 'missing', target: 'dashboard' }));

  const all = [...client, ...reviews, ...logs];
  return {
    first: all.slice(0, FIRST_COUNT),
    total: all.length,
    digest: {
      projects: projects.length,
      logsSent: projects.filter((p) => p.logToday === 'sent').length,
      approvals: sum(projects, (p) => p.sinceYesterday.approvals),
      photos: sum(projects, (p) => p.sinceYesterday.photos),
      rejectedInspections: sum(projects, (p) => p.sinceYesterday.rejectedInspections),
    },
  };
}

function byShort(a: PmcBriefProject, b: PmcBriefProject): number {
  return a.short.localeCompare(b.short) || a.projectId.localeCompare(b.projectId);
}

function sum(projects: readonly PmcBriefProject[], f: (p: PmcBriefProject) => number): number {
  return projects.reduce((n, p) => n + f(p), 0);
}
