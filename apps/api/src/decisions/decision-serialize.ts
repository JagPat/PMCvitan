import type { Prisma } from '@prisma/client';
import { viewerIsConsultee, viewerIsDecider, type ConsultationAudienceEntry, type DeciderSlice } from '@vitan/shared';
import type { ConsultationDto, DecisionDto } from '../snapshot/types';

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
    // Phase 6 unit 4c-ii — the consultation thread and its answers, plus the approval register
    // COUNT the cycle test compares against. Both are decisions-owned (`decisionConsultation`,
    // `decisionConsultationResponse`, `decisionApprovalRevision` are in this module's
    // `ownsModels`), so this is a same-module read, not a boundary crossing.
    consultations: { include: { response: true } };
    approvalRevisions: { select: { version: true } };
  };
}>;

/** Serialize one canonical decision row into its snapshot `DecisionDto` (unfiltered). */
export function serializeDecision(d: DecisionRow): DecisionDto {
  const consultations = serializeConsultations(d);
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
    // Phase 6 unit 4c-ii — the thread, oldest first, with each option recommendation resolved to
    // its stable KEY. The option id is a database identifier; the key is what every other surface
    // already names an option by, and it survives a reordering an index would not.
    //
    // ALWAYS EMITTED, including as an empty array. There is an open DISPUTE about this, recorded
    // for the reviewer rather than settled here (JagPat, 2026-08-31 on #497: "do not reshape that
    // product surface on your own"). The closed parallel #496 serialized absent-when-empty and
    // argued that an always-emitted array breaks §D's byte-identity requirement for gate-OFF
    // projects, since it adds `consultations: []` and `approvalCycle: 0` to every decision of every
    // project — including ones the feature does not exist for. The case FOR always-emitting is that
    // an optional collection makes every consumer handle two shapes for one meaning, and that §D's
    // inertness claim is about the FEATURE being inert (no affordance, no write, commands 404)
    // rather than about the DTO's key set. Both readings are defensible; the reviewer decides.
    consultations,
    approvalCycle: d.approvalRevisions.length,
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

/** The consultation thread of one decision, oldest first. */
function serializeConsultations(d: DecisionRow): ConsultationDto[] {
  const optionKeyById = new Map(d.options.map((o) => [o.id, o.optionKey]));
  return [...d.consultations]
    .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime() || a.id.localeCompare(b.id))
    .map((c) => ({
      id: c.id,
      consulteeMembershipId: c.consulteeMembershipId,
      consulteeUserId: c.consulteeUserId,
      requestedById: c.requestedById,
      question: c.question,
      openCycle: c.openCycle,
      requestedAt: c.requestedAt.toISOString(),
      ...(c.response
        ? {
            response: {
              id: c.response.id,
              respondedById: c.response.respondedById,
              response: c.response.response,
              ...(c.response.recommendedOptionId && optionKeyById.has(c.response.recommendedOptionId)
                ? { recommendedOptionKey: optionKeyById.get(c.response.recommendedOptionId)! }
                : {}),
              respondedAt: c.response.respondedAt.toISOString(),
            },
          }
        : {}),
    }));
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
    /** Phase 6 unit 4c-ii — the standing consultees and the cycle their standing is judged in.
     *  Optional so a caller holding a pre-4c stored DTO passes the same predicate. */
    consultations?: readonly ConsultationAudienceEntry[];
    approvalCycle?: number;
  } & DeciderSlice,
  role: string,
  userId?: string,
): boolean {
  if (d.publishedAt === null) return !!userId && d.authorId === userId;
  // Phase 6 task 4a — a WITHDRAWN decision is pmc-only: it was pmc/client-visible while
  // pending, contractor/engineer/consultant NEVER saw it, and withdrawal must not widen an
  // audience — including to the client, for whom nothing is awaited any more.
  if (d.status === 'withdrawn') return role === 'pmc';
  // Phase 6 unit 4c-ii (§A) — the widening, and it is EXACTLY one way: a STANDING consultee sees
  // the decision they were asked about, and its thread, while their consultation stands. It is an
  // exception added BESIDE the decider arm, not a rewrite of it — a consultee gains no authority,
  // only sight of the question they are being asked to inform. `withdrawn` is deliberately above
  // this line: withdrawal never widens an audience, and a consultation there would leak the
  // pmc-only title and reason 4a hides.
  if (d.status === 'pending') {
    return role === 'pmc' || viewerIsDecider(d, role, userId) || viewerIsConsultee(d.consultations, d.approvalCycle, userId);
  }
  return true;
}

/**
 * Phase 6 unit 4c-ii (§B P25c, review round 18) — HYDRATE a STORED projection DTO at READ time.
 *
 * Widening `DECISION_INCLUDE` and the serializer does not rewrite JSON already stored in an
 * ACTIVE, caught-up generation, and a `catalogVersion` bump does not itself trigger a rebuild. So
 * a quiet project would keep answering `source: 'projection'` with pre-4c DTOs that lack the
 * consultation collection entirely, breaking live/projection equality — and the new UI with it —
 * until some unrelated decision event happened to refresh the row. The first consultation REQUEST
 * emits an event that refreshes every row, which is exactly why the P25c probe alone does not
 * catch this: the gap only exists for a project where nothing has happened yet.
 *
 * The rule is the delivered decider one, extended: a missing field means the pre-change default,
 * never an absent field. `deciderKind` hydrates to `client` (the column backfill's own semantic);
 * the consultation collection hydrates to EMPTY and the cycle to `0`, which is what a decision
 * nobody was consulted on and nobody has approved actually is.
 */
export function hydrateStoredDecisionDto(raw: DecisionDto): DecisionDto {
  const needsDecider = raw.deciderKind === undefined;
  const needsConsultations = !Array.isArray(raw.consultations);
  const needsCycle = typeof raw.approvalCycle !== 'number';
  if (!needsDecider && !needsConsultations && !needsCycle) return raw;
  return {
    ...raw,
    ...(needsDecider ? { deciderKind: 'client' as const } : {}),
    ...(needsConsultations ? { consultations: [] } : {}),
    ...(needsCycle ? { approvalCycle: 0 } : {}),
  };
}
