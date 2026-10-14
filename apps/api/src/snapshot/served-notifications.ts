import { Prisma } from '@prisma/client';
import { viewerIsDecider } from '@vitan/shared';
import type { PrismaService } from '../prisma.service';
import type { DecisionsQueryService } from '../decisions/decisions.query';
import { isPendingDecisionNotice, isWithdrawnDecisionNotice } from '../domain/notifications';
import { readFeedEvents, readNotificationFeed } from '../platform/notification-feed';
import type { Role } from '../common/auth';
import type { SnapshotDto } from './types';
import { SITE_VISIT_NOTICE_KINDS, renderSiteVisitNotice } from '../site-visits/site-visit-notice';

/**
 * Top 10 #4b unit B (#778) — THE one definition of which notices the authenticated viewer is served.
 *
 * The snapshot's bell feed is built from it, and the read-state endpoint (unit C) will judge the ids
 * it confirms against the same definition, so "served to this viewer" can never mean two things.
 * Moved here verbatim from `SnapshotService.build`; `top10-4b-served-notifications.test.ts` pins
 * what every role is served, captured before the move.
 */

/** One notice as the viewer is served it (the snapshot's `notifications` element). */
export type ServedNotice = SnapshotDto['notifications'][number];

/**
 * Phase 6 task 4d-ii-a / A4c — the viewer's decision slice and the notification feed, read in ONE
 * REPEATABLE READ transaction, each through its owner's query (the decisions module's slice, the
 * platform's feed and the events kinded notices are bound to) and with no cross-module join. A kinded
 * notice is served only if its decision is in the viewer's slice, so the two must be one snapshot:
 * read separately, a withdrawal committing between them would let the notice be authorized against
 * the decision as it stood before.
 */
export function readViewerFeed(
  prisma: PrismaService,
  decisionsQuery: DecisionsQueryService,
  projectId: string,
  role: Role,
  userId?: string,
) {
  return prisma.$transaction(async (tx) => {
    const slice = await decisionsQuery.snapshotSlice(projectId, role, userId, tx);
    const feed = await readNotificationFeed(tx, projectId);
    const events = await readFeedEvents(tx, projectId, feed.flatMap((n) => (n.eventId ? [n.eventId] : [])));
    // 4d-ii-a / A7a — and the revisions the kinded green notices' events name, through the
    // decisions module (its register), in this same snapshot
    const revisions = await decisionsQuery.kindedNoticeRevisions(tx, projectId, events);
    // Top 10 #4b unit C — the viewer's receipts, in this same snapshot: a served notice is unread
    // exactly when this viewer holds no receipt for it (no backfill: every older notice starts unread)
    const seen = userId
      ? new Set((await tx.notificationReceipt.findMany({ where: { projectId, userId }, select: { notificationId: true } })).map((r) => r.notificationId))
      : new Set<string>();
    return { slice, feed, events, revisions, seen };
    // read-only, so REPEATABLE READ never fails it with a serialization error; the limits are
    // generous because these reads used to need no interactive transaction at all
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, maxWait: 10_000, timeout: 30_000 });
}

/** What {@link readViewerFeed} read: the viewer's slice, the feed, its events and their revisions, and
 *  the ids of the notices this viewer holds a receipt for. */
export type ViewerFeed = Awaited<ReturnType<typeof readViewerFeed>>;

/** The notices this viewer is served from one {@link readViewerFeed} read, newest first. */
export function servedNotifications(
  read: ViewerFeed,
  role: Role,
  userId: string | undefined,
  decisionsQuery: Pick<DecisionsQueryService, 'renderKindedNotice'>,
): ServedNotice[] {
  const { slice, feed, events, revisions, seen } = read;
  // Phase 6 task 4b (§A.3) — the pending-notice audience FOLLOWS the decider: a notice linked
  // to a decision (4a stamps `decisionId`) reaches pmc + THE DECIDER of that decision (the
  // shared `viewerIsDecider` predicate over the viewer's OWN visible slice) and is stripped
  // for everyone else — an engineer-decider sees their notice, the client no longer receives a
  // demand for a decision they do not decide, and a stale notice on a since-approved (and so
  // team-visible) decision still never widens past its decider. A LEGACY unlinked notice
  // (decisionId null, pre-4a) keeps the pre-4b pmc/client audience — every pre-4b decision is
  // a `client`-held one.
  const visibleById = new Map(slice.decisions.map((d) => [d.id, d]));
  // Live bug 1 (deep-link target fidelity) — a notice names the decision it is about, so a tap opens
  // that decision rather than the register. Only a decision in THIS viewer's slice is named: an id
  // the viewer cannot open is never handed out, and a notice about no decision carries no key at all
  // (the delivered three-key shape).
  const noticeSubject = (decisionId: string | null): { decisionId?: string } =>
    decisionId !== null && visibleById.has(decisionId) ? { decisionId } : {};
  const hidePending = role !== 'pmc' && role !== 'client';
  const stripPendingNotice = (n: { text: string; decisionId: string | null }): boolean => {
    if (!isPendingDecisionNotice(n.text)) return false;
    if (role === 'pmc') return false;
    if (n.decisionId) {
      const d = visibleById.get(n.decisionId);
      return !d || !viewerIsDecider({ deciderKind: d.deciderKind, deciderUserId: d.deciderUserId ?? null }, role, userId);
    }
    return hidePending;
  };

  // AUTH-02: a pending-decision notice ("Decision awaiting approval: …") is
  // pmc/client-only — drop it from the feed for roles that have pending decisions
  // hidden, so a decision's title can't leak through the bell.
  return feed.flatMap((n) => {
    // Phase 6 task 4d-ii-a / A4c — a KINDED notice is never served from its stored text: the
    // decisions module renders it from its kind and bound event, and decides whether this
    // viewer may see it (its decision in the viewer's slice, read in the same snapshot above;
    // an actionable kind of a withdrawn decision suppressed). A kind with no renderer arm in
    // this release, or a notice about no decision, is omitted.
    if (n.kind !== null) {
      const event = n.eventId ? events.get(n.eventId) : undefined;
      // Site Visits SV1-b (#792, F50) — a visit notice is the site-visits module's to render, from its event alone;
      // every member of the project sees a visit (D1)
      if (event && SITE_VISIT_NOTICE_KINDS.has(n.kind)) {
        const visit = renderSiteVisitNotice(n.kind, event);
        return visit ? [{ id: n.id, at: n.at.toISOString(), text: visit.text, time: n.time, color: visit.color, unread: !seen.has(n.id) }] : [];
      }
      if (!event || !n.decisionId) return [];
      const rendered = decisionsQuery.renderKindedNotice(n.kind, event, visibleById.get(n.decisionId), role, userId, revisions);
      return rendered ? [{ id: n.id, at: n.at.toISOString(), text: rendered.text, time: n.time, color: rendered.color, ...noticeSubject(n.decisionId), unread: !seen.has(n.id) }] : [];
    }
    // KIND-LESS rows (every notice written today): the delivered text-prefix filters, unchanged.
    if (stripPendingNotice(n)) return [];
    // Phase 6 task 4a — a withdrawal notice (title + reason) is PMC-ONLY: a withdrawn
    // decision is invisible to every other role INCLUDING the client (§A.3), so its
    // explanation must not leak through the bell either.
    if (role !== 'pmc' && isWithdrawnDecisionNotice(n.text)) return [];
    // live bug 1b-3 — a kindless inspection notice carries the inspection its writer stamped; the
    // inspection screen judges it against the viewer's own slice
    return [{ id: n.id, at: n.at.toISOString(), text: n.text, time: n.time, color: n.color, ...noticeSubject(n.decisionId), ...(n.inspectionId ? { inspectionId: n.inspectionId } : {}), unread: !seen.has(n.id) }];
  });
}
