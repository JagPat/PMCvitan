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
  include: { options: true; changeRequests: true };
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
    photoSwatch: d.photoSwatch,
    approvedOption: d.approvedOption ?? undefined,
    material: d.material ?? undefined,
    approver: d.approver ?? undefined,
    onBehalfOf: d.onBehalfOf ?? undefined,
    // Phase 6 unit 4b — the holder, present ONLY when it is not the historical default. A
    // client-held decision therefore serializes exactly the keys it always did (P15's
    // byte-identity reaches the wire, not just the columns), and the register/Drafts surfaces can
    // show and correct a named holder without a second read.
    ...(d.deciderKind !== 'client'
      ? { deciderKind: d.deciderKind, ...(d.deciderMembershipId ? { deciderMembershipId: d.deciderMembershipId } : {}) }
      : {}),
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

/**
 * The per-viewer visibility rule, applied identically by the live snapshot slice and the projection
 * query so a projection is NEVER an RBAC bypass:
 *   - a DRAFT (publishedAt null) is author-private — visible only to its creator;
 *   - a published-but-`pending` decision is visible only to pmc/client (AUTH-02);
 *   - a WITHDRAWN decision is pmc-only (Phase 6 task 4a — withdrawal never widens an audience);
 *   - everything else is visible to the project.
 */
export function decisionVisibleToViewer(
  d: {
    publishedAt: Date | null;
    authorId: string | null;
    status: string;
    /** Phase 6 unit 4b — the holder designation, and the USER a named membership resolves to. */
    deciderKind?: string | null;
    deciderUserId?: string | null;
  },
  role: string,
  userId?: string,
): boolean {
  if (d.publishedAt === null) return !!userId && d.authorId === userId;
  // Phase 6 task 4a — a WITHDRAWN decision is pmc-only: it was pmc/client-visible while
  // pending, contractor/engineer/consultant NEVER saw it, and withdrawal must not widen an
  // audience — including to the client, for whom nothing is awaited any more.
  if (d.status === 'withdrawn') return role === 'pmc';
  const hidePending = role !== 'pmc' && role !== 'client';
  // Phase 6 unit 4b (plan §A.3) — AUTH-02's pending narrowing was written when "pending" meant
  // "awaiting the client", so it hides every pending decision from every other role. A decision
  // now names WHO decides it, and a named member may be the contractor or the site engineer: the
  // audience follows the DECIDER. Without this the register would authorise them to approve
  // (the service's decider check) while never showing them the question — an action item pointing
  // at a row they cannot see. The widening is exactly one person: the decider's own user id, so a
  // SAME-ROLE non-decider is still refused. `deciderUserId` is resolved by the READ (through the
  // orgs participant on the live path, from the stored column on the projection path), so both
  // paths apply the identical rule and a projection read is never an RBAC bypass.
  if (hidePending && d.status === 'pending') {
    return !!userId && !!d.deciderUserId && d.deciderUserId === userId;
  }
  return true;
}
