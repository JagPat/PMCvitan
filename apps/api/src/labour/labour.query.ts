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
}
