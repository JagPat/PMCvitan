import type { Prisma } from '@prisma/client';
import { viewerIsDecider, type DeciderSlice } from '@vitan/shared';
import type { DecisionDto } from '../snapshot/types';

/**
 * Phase 2 Task 9 — the ONE canonical decision serializer.
 *
 * The projection (Task 9) and the live snapshot slice (Task 8) both turn a canonical `Decision` row
 * into the exact same `DecisionDto`. Extracting the mapping HERE — used verbatim by
 * `DecisionsQueryService.snapshotSlice` (the live path) and the decisions projection handler (which
 * stores this DTO on the projection row) — guarantees the projection-served decision is
 * BYTE-IDENTICAL to the snapshot's, so a live-vs-projection comparison can never drift by
 * construction. The role/author filtering stays with each caller (it is a per-viewer concern, not a
 * property of the decision itself).
 */

/** The canonical row shape the serializer needs: a `Decision` with its ordered options and, when
 *  reopened, its single OPEN change request (Phase 1 Task 2). */
export type DecisionRow = Prisma.DecisionGetPayload<{
  include: {
    options: true;
    changeRequests: true;
    deciderMembership: { select: { userId: true } };
    // Phase 6 unit 4c-ii (§A/P25c) — the consultation thread travels with the decision through the
    // ONE serializer, so the live slice, the stored projection row and a rebuild carry the same
    // thread by construction. The recommended OPTION is joined to its key: the stored DTO must
    // survive a reorder, and an option id means nothing to a client.
    consultations: {
      include: { response: { include: { recommendedOption: { select: { optionKey: true } } } } };
    };
  };
}>;

/** Serialize one canonical decision row into its snapshot `DecisionDto` (unfiltered). */
export function serializeDecision(d: DecisionRow): DecisionDto {
  return {
    id: d.id,
    title: d.title,
    room: d.room,
    nodeId: d.nodeId ?? undefined,
    status: d.status,
    draft: d.publishedAt === null,
    ageDays: d.ageDays ?? undefined,
    photoSwatch: d.photoSwatch ?? undefined,
    // Phase 6 task 4b — the holder designation, with the named member's USER resolved here so
    // every viewer/decider predicate (server slice, store selectors, projection filter) asks the
    // same question of the same value.
    deciderKind: d.deciderKind,
    deciderMembershipId: d.deciderMembershipId ?? undefined,
    deciderUserId: d.deciderMembership?.userId ?? undefined,
    approvedOption: d.approvedOption ?? undefined,
    material: d.material ?? undefined,
    approver: d.approver ?? undefined,
    onBehalfOf: d.onBehalfOf ?? undefined,
    date: d.date ?? undefined,
    cost: d.cost ?? undefined,
    // a reopened decision carries its open request so every surface can show WHY it awaits
    // re-approval (reason + impacts) without a second query
    changeRequest:
      d.status === 'change' && d.changeRequests[0]
        ? {
            reason: d.changeRequests[0].reason,
            costImpact: d.changeRequests[0].costImpact,
            timeImpactDays: d.changeRequests[0].timeImpactDays,
            requestedById: d.changeRequests[0].requestedById ?? undefined,
          }
        : undefined,
    // Phase 6 task 4a — the withdrawal evidence travels through the CONTRACT (not just the
    // screen): frozen at withdraw time (the `approver` precedent, so the stored projection DTO
    // never drifts from a later user rename). Only ever delivered to pmc — the visibility rule
    // below removes the whole row for every other viewer.
    ...(d.status === 'withdrawn'
      ? {
          withdrawnAt: d.withdrawnAt?.toISOString(),
          withdrawnBy: d.withdrawnByName ?? undefined,
          withdrawReason: d.withdrawReason ?? undefined,
        }
      : {}),
    // Phase 6 unit 4c-ii — the thread, oldest first (the order it was asked in). ABSENT rather
    // than empty when there is none, so a decision that was never consulted serializes exactly as
    // it does today and the §D gate-off byte-identity proof holds.
    ...(d.consultations.length > 0
      ? {
          consultations: [...d.consultations]
            .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime())
            .map((c) => ({
              id: c.id,
              consulteeMembershipId: c.consulteeMembershipId,
              consulteeUserId: c.consulteeUserId,
              requestedById: c.requestedById,
              question: c.question,
              requestedAt: c.requestedAt.toISOString(),
              openCycle: c.openCycle,
              ...(c.response
                ? {
                    response: {
                      respondedById: c.response.respondedById,
                      response: c.response.response,
                      respondedAt: c.response.respondedAt.toISOString(),
                      ...(c.response.recommendedOption
                        ? { recommendedOptionKey: c.response.recommendedOption.optionKey }
                        : {}),
                    },
                  }
                : {}),
            })),
        }
      : {}),
    options: d.options.map((o) => ({
      label: o.label,
      key: o.optionKey,
      material: o.material,
      delta: o.delta,
      swatch: o.swatch,
      photoUrl: o.photoUrl ?? undefined,
      recommended: o.recommended,
    })),
  };
}

/**
 * The per-viewer visibility rule, applied identically by the live snapshot slice and the projection
 * query so a projection is NEVER an RBAC bypass:
 *   - a DRAFT (publishedAt null) is author-private — visible only to its creator;
 *   - a published-but-`pending` decision is visible only to pmc and THE DECIDER (Phase 6 task 4b
 *     §A.3 — the pending audience FOLLOWS the decider: a named engineer-decider sees their
 *     obligation, a same-role non-decider does not, and the client no longer sees a demand for a
 *     decision they do not decide; a `client`-held decision keeps the pre-4b pmc/client audience
 *     byte-identically);
 *   - a WITHDRAWN decision is pmc-only (Phase 6 task 4a — withdrawal never widens an audience);
 *   - everything else — `recorded` rows included (a record is a team-visible fact, §A.2) — is
 *     visible to the project.
 */
export function decisionVisibleToViewer(
  d: {
    publishedAt: Date | null;
    authorId: string | null;
    status: string;
    /** Phase 6 unit 4c-ii — the canonical audience column of every consultation on this decision.
     *  Optional so every pre-4c caller compiles unchanged and behaves identically. */
    consultations?: readonly { consulteeUserId: string }[];
  } & DeciderSlice,
  role: string,
  userId?: string,
): boolean {
  if (d.publishedAt === null) return !!userId && d.authorId === userId;
  // Phase 6 task 4a — a WITHDRAWN decision is pmc-only: it was pmc/client-visible while
  // pending, contractor/engineer/consultant NEVER saw it, and withdrawal must not widen an
  // audience — including to the client, for whom nothing is awaited any more.
  if (d.status === 'withdrawn') return role === 'pmc';
  // Phase 6 unit 4c-ii (§A) — the CONSULTEE joins the pending audience. This is the whole point
  // of a consultation: someone who does not decide is asked to advise, and they cannot advise on
  // a decision they cannot see. The audience is read from the decisions-owned canonical column,
  // never resolved from `Membership` — a projection fold that reached into orgs persistence would
  // be a cross-module read, and a rebuild (which replays no payloads) would lose it entirely.
  //
  // It widens the PENDING arm only. A withdrawn decision stays pmc-only above: withdrawal never
  // widens an audience, and a consultation on a question the practice has taken back is history
  // its consultee has no live interest in.
  if (d.status === 'pending') {
    if (role === 'pmc' || viewerIsDecider(d, role, userId)) return true;
    return !!userId && (d.consultations ?? []).some((c) => c.consulteeUserId === userId);
  }
  return true;
}
