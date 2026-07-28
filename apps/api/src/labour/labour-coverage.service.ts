import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { LabourSliceCoverageDto } from '@vitan/shared';
import { PrismaService } from '../prisma.service';
import { toIsoCivilDate } from '../common/civil-date';
import type { LabourCoverageRequirement, RequirementLabourCoverage, RequirementLabourForecast } from './coverage';

/**
 * Phase 4 Task 4 — the CANONICAL §A labour coverage authority (the labour sibling of
 * `InventoryService.coverageFor`).
 *
 * Both entry points are pure READS of Labour-owned §C facts (`WorkerAllocation`,
 * `LabourAttendance`, `LabourWorkFact`, `CapacityCommitment`+`CapacityPromise`) evaluated on the
 * CALLER's transaction client. `coverageFor` (execution truth) is called by `activities.start`
 * INSIDE its command transaction, AFTER it has taken `lockProjectReadiness` — so a concurrent
 * allocation/release/attendance/commitment write serializes: it lands strictly before (this
 * start observes it) or strictly after (it waits for this commit). `forecastFor` feeds the
 * labour-readiness projection and the `labour.readiness` read ONLY.
 *
 * The caller resolves the requirement snapshots from ITS OWN canonical truth and passes them in
 * (§G — Labour never reads Activities persistence). NOT a controller surface: the caller already
 * gated on the `labour` pilot capability.
 *
 * §B slice arithmetic: every count is per `(civilDate, shift)` slice — capacity for one slice
 * can NEVER satisfy another. Satisfaction admits an allocation whose `labourSpecFingerprint` is
 * in the requirement's `acceptableFingerprints` (head fingerprint or an active substitution
 * target), for the head's shift, regardless of the allocation's pinned `originRevision` — the
 * §C compatible-revision carry-forward: a responsible-only revision keeps the fingerprint and
 * the allocation keeps satisfying; a trade/skill/shift revision changes the head fingerprint and
 * strands it; a headcount increase preserves existing coverage and surfaces the shortfall.
 *
 * Work performed counts as satisfied capacity (§A guardrail): a slice's covered person-shifts
 * are `max(present-or-allocated, distinct workers with a work fact)` so deploying an allocated
 * crew never un-readies the activity, and a fully-worked past window stays satisfied even after
 * its allocations are released.
 */

interface SliceCounts {
  allocated: number;
  present: number;
  worked: number;
  /** Active allocation ids matching the slice (for commitment draw-down accounting). */
  allocatedFromCommitment: Map<string, number>;
}

const EMPTY_COUNTS: Omit<SliceCounts, 'allocatedFromCommitment'> = { allocated: 0, present: 0, worked: 0 };

function sliceKey(requirementId: string, civilDate: string, shift: string): string {
  return `${requirementId}|${civilDate}|${shift}`;
}

@Injectable()
export class LabourCoverageService {
  constructor(private readonly prisma: PrismaService) {}

  /** Count allocated / present / worked person-shifts per requirement slice, in one batched read. */
  private async countsFor(
    db: Prisma.TransactionClient,
    projectId: string,
    requirements: readonly LabourCoverageRequirement[],
  ): Promise<Map<string, SliceCounts>> {
    const out = new Map<string, SliceCounts>();
    const requirementIds = [...new Set(requirements.map((r) => r.requirementId))];
    const sliceDates = [...new Set(requirements.flatMap((r) => r.slices.map((s) => s.civilDate)))];
    if (requirementIds.length === 0 || sliceDates.length === 0) return out;
    const dates = sliceDates.map((d) => new Date(d));

    const allocations = await db.workerAllocation.findMany({
      where: { projectId, requirementId: { in: requirementIds }, civilDate: { in: dates } },
      select: {
        id: true, requirementId: true, workerId: true, civilDate: true, shift: true,
        labourSpecFingerprint: true, status: true, capacityCommitmentId: true,
      },
    });
    const attendance = await db.labourAttendance.findMany({
      where: { projectId, revokedAt: null, civilDate: { in: dates } },
      select: { workerId: true, civilDate: true, shift: true },
    });
    const workFacts = allocations.length
      ? await db.labourWorkFact.findMany({
          where: { projectId, allocationId: { in: allocations.map((a) => a.id) } },
          select: { allocationId: true, workerId: true, civilDate: true, shift: true },
        })
      : [];

    const present = new Set(attendance.map((a) => `${a.workerId}|${toIsoCivilDate(a.civilDate)}|${a.shift}`));
    const factsByAllocation = new Map<string, typeof workFacts>();
    for (const f of workFacts) {
      const bucket = factsByAllocation.get(f.allocationId);
      if (bucket) bucket.push(f);
      else factsByAllocation.set(f.allocationId, [f]);
    }

    for (const r of requirements) {
      const acceptable = new Set(r.acceptableFingerprints);
      for (const s of r.slices) {
        const key = sliceKey(r.requirementId, s.civilDate, r.shift);
        const allocatedWorkers = new Set<string>();
        const presentWorkers = new Set<string>();
        const workedWorkers = new Set<string>();
        const allocatedFromCommitment = new Map<string, number>();
        for (const a of allocations) {
          if (a.requirementId !== r.requirementId) continue;
          if (toIsoCivilDate(a.civilDate) !== s.civilDate || a.shift !== r.shift) continue;
          if (!acceptable.has(a.labourSpecFingerprint)) continue;
          if (a.status === 'active') {
            allocatedWorkers.add(a.workerId);
            if (present.has(`${a.workerId}|${s.civilDate}|${r.shift}`)) presentWorkers.add(a.workerId);
            if (a.capacityCommitmentId) {
              allocatedFromCommitment.set(a.capacityCommitmentId, (allocatedFromCommitment.get(a.capacityCommitmentId) ?? 0) + 1);
            }
          }
          // Work counts regardless of the allocation's later release (§A worked guardrail).
          for (const f of factsByAllocation.get(a.id) ?? []) {
            if (toIsoCivilDate(f.civilDate) === s.civilDate && f.shift === r.shift) workedWorkers.add(f.workerId);
          }
        }
        out.set(key, {
          allocated: allocatedWorkers.size,
          present: presentWorkers.size,
          worked: workedWorkers.size,
          allocatedFromCommitment,
        });
      }
    }
    return out;
  }

  /**
   * EXECUTION truth (§A execution table, first match, worst-wins across the requirement's
   * slices) at the project-timezone civil date `asOf`. See `coverage.ts` for the row semantics.
   */
  async coverageFor(
    tx: Prisma.TransactionClient,
    projectId: string,
    requirements: readonly LabourCoverageRequirement[],
    asOf: string,
  ): Promise<RequirementLabourCoverage[]> {
    if (requirements.length === 0) return [];
    const counts = await this.countsFor(tx, projectId, requirements);
    return requirements.map((r) => {
      const detail: LabourSliceCoverageDto[] = r.slices.map((s) => {
        const c = counts.get(sliceKey(r.requirementId, s.civilDate, r.shift)) ?? { ...EMPTY_COUNTS, allocatedFromCommitment: new Map() };
        return { civilDate: s.civilDate, shift: r.shift, personShiftQty: s.personShiftQty, allocated: c.allocated, present: c.present, worked: c.worked };
      });
      const base = { requirementId: r.requirementId, revision: r.revision, activityId: r.activityId, slices: detail };
      const first = detail[0]?.civilDate;
      // §A row 3 — before the window: the labour window has not begun, start is refused (wait).
      if (first !== undefined && asOf < first) {
        return { ...base, verdict: 'wait' as const, reason: `Labour window has not begun — first demand slice is ${first} (§A)` };
      }
      // §A row 4 — an overdue slice went unfulfilled (present-or-worked short of its quantity).
      const overdue = detail.find((d) => d.civilDate < asOf && Math.max(d.present, d.worked) < d.personShiftQty);
      if (overdue) {
        return {
          ...base,
          verdict: 'fail' as const,
          reason: `Overdue labour slice ${overdue.civilDate} unfulfilled — ${Math.max(overdue.present, overdue.worked)} of ${overdue.personShiftQty} person-shifts covered (§A)`,
        };
      }
      const dueToday = detail.filter((d) => d.civilDate === asOf);
      const unsatisfied = dueToday.filter((d) => Math.max(d.present, d.worked) < d.personShiftQty);
      // §A row 5 — every slice due today covered by present-or-worked person-shifts, and (row 4
      // already passed) every past slice fulfilled. An empty due-today set reaches this row only
      // after rows 3–4 declined to fire — a wholly-past fulfilled window, or a mid-window civil
      // date the demand does not name — never the vacuous-ready path.
      if (unsatisfied.length === 0) {
        return { ...base, verdict: 'ok' as const, reason: dueToday.length ? `Labour present for today's demand (§A)` : `Every demanded labour slice up to today is fulfilled (§A)` };
      }
      // §A row 6 — allocated in full but not yet mustered.
      if (unsatisfied.every((d) => d.allocated >= d.personShiftQty)) {
        const w = unsatisfied[0];
        return { ...base, verdict: 'wait' as const, reason: `Crew allocated for today — muster pending (${w.present} of ${w.personShiftQty} present, ${w.civilDate} ${r.shift}) (§A)` };
      }
      // §A row 7 — under-allocated today.
      const worst = unsatisfied.reduce((m, d) => (d.personShiftQty - d.allocated > m.personShiftQty - m.allocated ? d : m), unsatisfied[0]);
      return { ...base, verdict: 'fail' as const, reason: `Under-allocated for today's labour demand — ${worst.allocated} of ${worst.personShiftQty} person-shifts allocated (${worst.civilDate} ${r.shift}) (§A)` };
    });
  }

  /**
   * FORECAST truth (§A forecast table; presence never consulted). Per slice: allocated-or-worked
   * covers it → `ready`; else a live commitment for the SAME `(civilDate, shift)` slice of an
   * acceptable fingerprint, with remaining undrawn quantity and a latest arrival promise not
   * after the slice date, covers the shortfall → `at-risk` dated at the covering promise; else
   * `blocked`. Worst-wins across slices.
   */
  async forecastFor(
    tx: Prisma.TransactionClient,
    projectId: string,
    requirements: readonly LabourCoverageRequirement[],
  ): Promise<RequirementLabourForecast[]> {
    if (requirements.length === 0) return [];
    const counts = await this.countsFor(tx, projectId, requirements);
    const fingerprints = [...new Set(requirements.flatMap((r) => r.acceptableFingerprints))];
    const dates = [...new Set(requirements.flatMap((r) => r.slices.map((s) => s.civilDate)))].map((d) => new Date(d));
    const commitments = fingerprints.length && dates.length
      ? await tx.capacityCommitment.findMany({
          where: { projectId, status: { in: ['committed', 'revised'] }, labourSpecFingerprint: { in: fingerprints }, civilDate: { in: dates } },
          select: {
            id: true, labourSpecFingerprint: true, civilDate: true, shift: true, personShiftQty: true,
            promises: { select: { promisedDate: true }, orderBy: { seq: 'desc' }, take: 1 },
          },
        })
      : [];

    return requirements.map((r) => {
      const acceptable = new Set(r.acceptableFingerprints);
      let worst: RequirementLabourForecast['verdict'] = 'ready';
      let coveringDate: string | null = null;
      let reason = `Allocated labour covers every demand slice (§A forecast)`;
      for (const s of r.slices) {
        const c = counts.get(sliceKey(r.requirementId, s.civilDate, r.shift)) ?? { ...EMPTY_COUNTS, allocatedFromCommitment: new Map<string, number>() };
        const covered = Math.max(c.allocated, c.worked);
        if (covered >= s.personShiftQty) continue;
        let need = s.personShiftQty - covered;
        // Eligible: same slice, acceptable fingerprint, latest promise not after the slice date.
        const eligible = commitments
          .map((cm) => ({
            ...cm,
            civilDateIso: toIsoCivilDate(cm.civilDate) ?? '',
            latestPromise: cm.promises[0] ? (toIsoCivilDate(cm.promises[0].promisedDate) ?? '') : (toIsoCivilDate(cm.civilDate) ?? ''),
          }))
          .filter((cm) => cm.civilDateIso === s.civilDate && cm.shift === r.shift && acceptable.has(cm.labourSpecFingerprint) && cm.latestPromise <= s.civilDate)
          .sort((a, b) => (a.latestPromise < b.latestPromise ? -1 : a.latestPromise > b.latestPromise ? 1 : 0));
        let sliceCovering: string | null = null;
        for (const cm of eligible) {
          if (need <= 0) break;
          const drawn = c.allocatedFromCommitment.get(cm.id) ?? 0;
          const remaining = Math.max(0, cm.personShiftQty - drawn);
          if (remaining <= 0) continue;
          need -= remaining;
          sliceCovering = cm.latestPromise;
        }
        if (need <= 0 && sliceCovering !== null) {
          if (worst === 'ready') worst = 'at-risk';
          if (worst === 'at-risk') {
            if (coveringDate === null || sliceCovering > coveringDate) coveringDate = sliceCovering;
            reason = `Shortfall covered by committed capacity arriving by ${coveringDate} (§A forecast)`;
          }
        } else {
          worst = 'blocked';
          coveringDate = null;
          reason = `No allocated or committed labour for slice ${s.civilDate} ${r.shift} — ${covered} of ${s.personShiftQty} person-shifts (§A forecast)`;
          break;
        }
      }
      return { requirementId: r.requirementId, revision: r.revision, activityId: r.activityId, verdict: worst, coveringDate: worst === 'at-risk' ? coveringDate : null, reason };
    });
  }
}
