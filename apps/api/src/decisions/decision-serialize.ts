import type { Prisma } from '@prisma/client';
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
  include: { options: true; changeRequests: true; deciderMembership: { select: { userId: true } } };
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

/** The decider-designation slice of a decision every audience predicate consumes. */
export interface DeciderSlice {
  deciderKind: string;
  /** the NAMED member's resolved user — the value the targeted dispatch and every filter compare */
  deciderUserId?: string | null;
}

/**
 * Phase 6 task 4b (§A.3) — is this viewer THE DECIDER of the decision? `client`/`pmc` designate
 * the ROLE (any member of it decides); `member` designates ONE user, so a same-role non-decider
 * is NOT the decider; `none` is a record — nobody decides it. The ONE predicate shared by the
 * server visibility rule, the store selectors, and the projection read-path filter.
 */
export function viewerIsDecider(d: DeciderSlice, role: string, userId?: string): boolean {
  if (d.deciderKind === 'client') return role === 'client';
  if (d.deciderKind === 'pmc') return role === 'pmc';
  if (d.deciderKind === 'member') return !!userId && d.deciderUserId === userId;
  return false;
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
  d: { publishedAt: Date | null; authorId: string | null; status: string } & DeciderSlice,
  role: string,
  userId?: string,
): boolean {
  if (d.publishedAt === null) return !!userId && d.authorId === userId;
  // Phase 6 task 4a — a WITHDRAWN decision is pmc-only: it was pmc/client-visible while
  // pending, contractor/engineer/consultant NEVER saw it, and withdrawal must not widen an
  // audience — including to the client, for whom nothing is awaited any more.
  if (d.status === 'withdrawn') return role === 'pmc';
  if (d.status === 'pending') return role === 'pmc' || viewerIsDecider(d, role, userId);
  return true;
}
