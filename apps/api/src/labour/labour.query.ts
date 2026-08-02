import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { LabourSpecRef } from '@vitan/shared';
import { PrismaService } from '../prisma.service';
import { toIsoCivilDate } from '../common/civil-date';

type SpecRow = Prisma.LabourRequirementSpecGetPayload<Record<string, never>>;
type SliceRow = Prisma.LabourDemandSliceGetPayload<Record<string, never>>;

/** Serialize one Labour-owned requirement detail (spec + slices) into the shared `LabourSpecRef`.
 *  The slices carry the spec's shift, so the slice triple is complete in the served shape. */
function serializeLabourSpec(s: SpecRow, slices: readonly SliceRow[]): LabourSpecRef {
  return {
    tradeCode: s.tradeCode,
    skillCode: s.skillCode,
    shift: s.shift,
    labourSpecFingerprint: s.labourSpecFingerprint,
    decisionId: s.decisionId,
    decisionVersion: s.decisionVersion,
    optionKey: s.optionKey,
    demandSlices: [...slices]
      .sort((a, b) => a.civilDate.getTime() - b.civilDate.getTime())
      .map((slice) => ({ civilDate: toIsoCivilDate(slice.civilDate) ?? '', shift: s.shift, personShiftQty: slice.personShiftQty })),
  };
}

/** The `(requirementId, revision)` key a detail is stored under. */
export function labourDetailKey(requirementId: string, revision: number): string {
  return `${requirementId}@${revision}`;
}

/**
 * Phase 4 Task 1 (correction F1) — the LABOUR read CONTRACT for requirement details.
 *
 * `LabourRequirementSpec`/`LabourDemandSlice` are Labour-module-owned and read-encapsulated.
 * Activities must NOT reach into them through a Prisma relation include on `ActivityRequirement`
 * (a foreign nested read — now caught by the boundary analyzer). Instead the Activities
 * requirement command/read calls THIS contract, which reads only Labour-owned tables (an
 * own-module read) and returns the canonical `LabourSpecRef`. It accepts the command transaction
 * so create/revise/cancel serialize the detail they just wrote in the same tx, and runs on the
 * module's own client for the standalone `list` read. This is the `activities → labour` read edge
 * (`activities.dependsOn` includes `labour`); Labour stays a LEAF (it reads nothing foreign).
 */
@Injectable()
export class LabourRequirementQuery {
  constructor(private readonly prisma: PrismaService) {}

  /** Hydrate the labour detail for a set of requirement revisions, keyed by
   *  {@link labourDetailKey}. Pass `tx` to read inside the requirement command transaction. */
  async detailsFor(
    projectId: string,
    refs: ReadonlyArray<{ requirementId: string; revision: number }>,
    tx?: Prisma.TransactionClient,
  ): Promise<Map<string, LabourSpecRef>> {
    const out = new Map<string, LabourSpecRef>();
    if (refs.length === 0) return out;
    const db = tx ?? this.prisma;
    const or = refs.map((r) => ({ requirementId: r.requirementId, revision: r.revision }));
    const specs = await db.labourRequirementSpec.findMany({ where: { projectId, OR: or } });
    if (specs.length === 0) return out;
    const slices = await db.labourDemandSlice.findMany({ where: { projectId, OR: or } });
    const slicesByKey = new Map<string, SliceRow[]>();
    for (const s of slices) {
      const k = labourDetailKey(s.requirementId, s.revision);
      const bucket = slicesByKey.get(k);
      if (bucket) bucket.push(s);
      else slicesByKey.set(k, [s]);
    }
    for (const spec of specs) {
      const k = labourDetailKey(spec.requirementId, spec.revision);
      out.set(k, serializeLabourSpec(spec, slicesByKey.get(k) ?? []));
    }
    return out;
  }

  /**
   * Phase 4 Task 3 — the trusted-worker existence/lifecycle read the ORGS-owned
   * `WorkerDevice` bind command needs (`Worker` is Labour-owned and read-encapsulated, so the
   * owner of the device row must not reach into it directly). Returns `null` when no such worker
   * exists in the project. This is the `orgs → labour` read edge; Labour is a LEAF, so it closes
   * no cycle. The same-project composite FK on `WorkerDevice` remains the database backstop —
   * this read only supplies a truthful message and the revocation check an FK cannot express.
   */
  async workerLifecycle(
    projectId: string,
    workerId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<{ id: string; revoked: boolean } | null> {
    const db = tx ?? this.prisma;
    const w = await db.worker.findFirst({ where: { id: workerId, projectId }, select: { id: true, revokedAt: true } });
    return w ? { id: w.id, revoked: w.revokedAt !== null } : null;
  }

  /**
   * Phase 4 Task 4 — the ACTIVE skill-substitution targets per requirement (§B satisfaction),
   * the labour sibling of `SubstitutionsService.activeTargets`. `ApprovedSkillSubstitution` is
   * Labour-owned and read-encapsulated, so the Activities coverage loader must not reach into it
   * directly — it calls THIS contract (the same `activities → labour` read edge as `detailsFor`).
   * The caller applies the F2 rule: an edge widens the acceptable set ONLY while its
   * `fromFingerprint` still equals the CURRENT head fingerprint.
   */
  async activeSkillTargets(
    projectId: string,
    requirementIds: readonly string[],
    tx?: Prisma.TransactionClient,
  ): Promise<Map<string, Array<{ fromFingerprint: string; toFingerprint: string }>>> {
    const out = new Map<string, Array<{ fromFingerprint: string; toFingerprint: string }>>();
    if (requirementIds.length === 0) return out;
    const db = tx ?? this.prisma;
    const rows = await db.approvedSkillSubstitution.findMany({
      where: { projectId, requirementId: { in: [...requirementIds] }, revokedAt: null },
      select: { requirementId: true, fromFingerprint: true, toFingerprint: true },
      orderBy: { at: 'asc' },
    });
    for (const r of rows) {
      const bucket = out.get(r.requirementId);
      const edge = { fromFingerprint: r.fromFingerprint, toFingerprint: r.toFingerprint };
      if (bucket) bucket.push(edge);
      else out.set(r.requirementId, [edge]);
    }
    return out;
  }
  /** Phase 4 Task 5 (§I) — Labour's EFFORT exposed to the composing Activities side (the
   *  `activities → labour` read edge). Worked-minutes summed per `(activityId, civilDate, shift)`;
   *  Labour never reads the Activities-owned `ActivityWorkOutput` it is joined with (§G). */
  async effortFor(
    projectId: string,
    scope: { activityIds?: readonly string[] },
    tx?: Prisma.TransactionClient,
  ): Promise<Array<{ activityId: string; civilDate: string; shift: string; workedMinutes: number }>> {
    const db = tx ?? this.prisma;
    if (scope.activityIds && scope.activityIds.length === 0) return [];
    const grouped = await db.labourWorkFact.groupBy({
      by: ['activityId', 'civilDate', 'shift'],
      where: { projectId, ...(scope.activityIds ? { activityId: { in: [...scope.activityIds] } } : {}) },
      _sum: { workedMinutes: true },
    });
    return grouped
      .map((g) => ({
        activityId: g.activityId,
        civilDate: toIsoCivilDate(g.civilDate) ?? '',
        shift: g.shift,
        workedMinutes: g._sum.workedMinutes ?? 0,
      }))
      .sort((a, b) => (a.activityId + a.civilDate + a.shift < b.activityId + b.civilDate + b.shift ? -1 : 1));
  }

  /** Phase 4 Task 5 (§E) — the activities whose Team gate an UNRESOLVED mismatch observation
   *  currently fails (§A first-match). Labour-owned truth, served to the deriving reader. */
  async unresolvedMismatchActivityIds(
    projectId: string,
    activityIds?: readonly string[],
    tx?: Prisma.TransactionClient,
  ): Promise<Set<string>> {
    const db = tx ?? this.prisma;
    if (activityIds && activityIds.length === 0) return new Set();
    const rows = await db.labourMismatch.findMany({
      where: {
        projectId,
        ...(activityIds ? { activityId: { in: [...activityIds] } } : {}),
        resolution: { is: null },
      },
      select: { activityId: true },
    });
    return new Set(rows.map((r) => r.activityId));
  }

  /**
   * Phase 5 Task 1 (§C/§L) — the LIVE labour PO lines of a project, for the commercial
   * activation backfill. `LabourPurchaseOrderLine` is labour-owned and read-encapsulated, so
   * commercial asks the OWNER rather than reaching into the table (§C: one fold, two owners).
   *
   * LIVE is the version-status set the attribution lifecycle maintains: `draft` is not live yet
   * (issue attributes it), `amended` has been superseded by the next version (amend replaces the
   * attribution), and `cancelled` released it. A `closed_short` version stays live because it
   * keeps its committed portion — a real obligation someone still owes.
   */
  async liveOrderedLineIds(projectId: string, tx?: Prisma.TransactionClient): Promise<string[]> {
    const db = tx ?? this.prisma;
    const rows = await db.labourPurchaseOrderLine.findMany({
      where: {
        projectId,
        poVersion: { is: { status: { in: ['issued', 'partially_committed', 'completed', 'closed_short'] } } },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((r) => r.id);
  }
}
