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
 * in the requirement's `acceptableFingerprints`, for the head's shift AND the head's OWNING
 * ACTIVITY (round-1 F4: a revision that moves the requirement onto a different activity strands
 * the old activity's allocations — nothing pinned to the previous activity may cover the new
 * one), regardless of the allocation's pinned `originRevision` — the §C compatible-revision
 * carry-forward: a responsible-only revision keeps fingerprint and activity and the allocation
 * keeps satisfying; a trade/skill/shift revision changes the head fingerprint and strands it; a
 * headcount increase preserves existing coverage and surfaces the shortfall.
 *
 * Work performed counts as satisfied capacity (§A guardrail), counted as DISTINCT PEOPLE, never
 * as a max of two counts (round-1 F3): a slice's execution-covered person-shifts are
 * `|present ∪ worked|` and its sourced person-shifts are `|allocated ∪ worked|` — one mustered
 * worker plus a DIFFERENT worker who already delivered their shift are two covered person-shifts,
 * while a worker who both mustered and worked is one. Deploying an allocated crew never
 * un-readies the activity, and a fully-worked past window stays satisfied even after its
 * allocations are released.
 */

interface SliceCounts {
  allocated: number;
  present: number;
  worked: number;
  /** §A execution satisfaction: distinct workers present OR with a work fact (round-1 F3). */
  coveredExecution: number;
  /** §A sourced capacity: distinct workers allocated OR with a work fact (rows 6–7 + forecast). */
  coveredSourced: number;
}

const EMPTY_COUNTS: SliceCounts = { allocated: 0, present: 0, worked: 0, coveredExecution: 0, coveredSourced: 0 };

function sliceKey(requirementId: string, civilDate: string, shift: string): string {
  return `${requirementId}|${civilDate}|${shift}`;
}

/** Canonical processing order for the forecast assignment — verdicts must be a function of the
 *  FACTS, never of the caller's array order (§G: live == projection == rebuild). */
function canonicalOrder(a: LabourCoverageRequirement, b: LabourCoverageRequirement): number {
  if (a.activityId !== b.activityId) return a.activityId < b.activityId ? -1 : 1;
  return a.requirementId < b.requirementId ? -1 : a.requirementId > b.requirementId ? 1 : 0;
}

/** One expanded committed person-shift the forecast may assign (round-1 F2 conservation). */
interface SupplySlot {
  commitmentId: string;
  fingerprint: string;
  civilDate: string;
  shift: string;
  latestPromise: string;
}

/** One requirement-slice shortfall unit seeking a committed person-shift. */
interface DemandUnit {
  sliceRef: SliceShortfall;
  eligibleSlots: number[];
}

interface SliceShortfall {
  requirementId: string;
  civilDate: string;
  need: number;
  units: DemandUnit[];
  matched: boolean;
  coveringDate: string | null;
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
        id: true, requirementId: true, activityId: true, workerId: true, civilDate: true, shift: true,
        labourSpecFingerprint: true, status: true,
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
        for (const a of allocations) {
          if (a.requirementId !== r.requirementId) continue;
          // round-1 F4 — the allocation must target the activity that OWNS the head. A revision
          // that moved the requirement onto a different activity strands the old allocations
          // (and their work facts): a crew pinned to activity A never covers activity B.
          if (a.activityId !== r.activityId) continue;
          if (toIsoCivilDate(a.civilDate) !== s.civilDate || a.shift !== r.shift) continue;
          if (!acceptable.has(a.labourSpecFingerprint)) continue;
          if (a.status === 'active') {
            allocatedWorkers.add(a.workerId);
            if (present.has(`${a.workerId}|${s.civilDate}|${r.shift}`)) presentWorkers.add(a.workerId);
          }
          // Work counts regardless of the allocation's later release (§A worked guardrail).
          for (const f of factsByAllocation.get(a.id) ?? []) {
            if (toIsoCivilDate(f.civilDate) === s.civilDate && f.shift === r.shift) workedWorkers.add(f.workerId);
          }
        }
        // round-1 F3 — satisfaction counts DISTINCT PEOPLE across the two evidence kinds.
        const coveredExecution = new Set([...presentWorkers, ...workedWorkers]).size;
        const coveredSourced = new Set([...allocatedWorkers, ...workedWorkers]).size;
        out.set(key, {
          allocated: allocatedWorkers.size,
          present: presentWorkers.size,
          worked: workedWorkers.size,
          coveredExecution,
          coveredSourced,
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
      const rows = r.slices.map((s) => {
        const c = counts.get(sliceKey(r.requirementId, s.civilDate, r.shift)) ?? EMPTY_COUNTS;
        const dto: LabourSliceCoverageDto = {
          civilDate: s.civilDate, shift: r.shift, personShiftQty: s.personShiftQty,
          allocated: c.allocated, present: c.present, worked: c.worked, covered: c.coveredExecution,
        };
        return { dto, sourced: c.coveredSourced };
      });
      const detail = rows.map((x) => x.dto);
      const base = { requirementId: r.requirementId, revision: r.revision, activityId: r.activityId, slices: detail };
      const first = detail[0]?.civilDate;
      // §A row 3 — before the window: the labour window has not begun, start is refused (wait).
      if (first !== undefined && asOf < first) {
        return { ...base, verdict: 'wait' as const, reason: `Labour window has not begun — first demand slice is ${first} (§A)` };
      }
      // §A row 4 — an overdue slice went unfulfilled (present-or-worked people short of its qty).
      const overdue = detail.find((d) => d.civilDate < asOf && d.covered < d.personShiftQty);
      if (overdue) {
        return {
          ...base,
          verdict: 'fail' as const,
          reason: `Overdue labour slice ${overdue.civilDate} unfulfilled — ${overdue.covered} of ${overdue.personShiftQty} person-shifts covered (§A)`,
        };
      }
      const dueToday = rows.filter((x) => x.dto.civilDate === asOf);
      const unsatisfied = dueToday.filter((x) => x.dto.covered < x.dto.personShiftQty);
      // §A row 5 — every slice due today covered by present-or-worked person-shifts, and (row 4
      // already passed) every past slice fulfilled. An empty due-today set reaches this row only
      // after rows 3–4 declined to fire — a wholly-past fulfilled window, or a mid-window civil
      // date the demand does not name — never the vacuous-ready path.
      if (unsatisfied.length === 0) {
        return { ...base, verdict: 'ok' as const, reason: dueToday.length ? `Labour present for today's demand (§A)` : `Every demanded labour slice up to today is fulfilled (§A)` };
      }
      // §A row 6 — sourced in full (allocated or already delivered) but not yet mustered.
      if (unsatisfied.every((x) => x.sourced >= x.dto.personShiftQty)) {
        const w = unsatisfied[0].dto;
        return { ...base, verdict: 'wait' as const, reason: `Crew allocated for today — muster pending (${w.present} of ${w.personShiftQty} present, ${w.civilDate} ${r.shift}) (§A)` };
      }
      // §A row 7 — under-allocated today (short of sourced people even counting delivered work).
      const worst = unsatisfied.reduce((m, x) => (x.dto.personShiftQty - x.sourced > m.dto.personShiftQty - m.sourced ? x : m), unsatisfied[0]);
      return {
        ...base,
        verdict: 'fail' as const,
        reason: `Under-allocated for today's labour demand — ${worst.sourced} of ${worst.dto.personShiftQty} person-shifts allocated (${worst.dto.civilDate} ${r.shift}) (§A)`,
      };
    });
  }

  /**
   * FORECAST truth (§A forecast table; presence never consulted). Per slice: allocated-or-worked
   * people cover it → `ready`; else COMMITTED capacity for the SAME `(civilDate, shift)` slice of
   * an acceptable fingerprint, still undrawn, with a latest arrival promise not after the slice
   * date, covers the WHOLE shortfall → `at-risk` dated at the covering promise; else `blocked`.
   * Worst-wins across slices.
   *
   * Round-1 F5 — only `status = 'committed'` rows participate: that is the ONLY status the
   * allocation command (and its `WorkerAllocation_within_commitment` DB trigger) will draw down,
   * so any other status would be §A cover that cannot convert into execution capacity.
   *
   * Round-1 F2 — committed person-shifts are CONSERVED: a person-shift already drawn by ANY
   * active allocation in the project is spent (project-wide `groupBy`, not per-requirement
   * counts), and the undrawn remainder is assigned to shortfalls by a deterministic matching —
   * requirement-slices in canonical `(activityId, requirementId, civilDate)` order, earliest
   * promise first, augmenting reroutes so an assignable shortfall is never refused while a
   * compatible rearrangement exists, all-or-nothing per slice (a slice the pool cannot fully
   * cover consumes nothing). One committed person-shift therefore covers AT MOST ONE forecast
   * shortfall, and the verdicts are a pure, order-invariant function of the facts.
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
          where: { projectId, status: 'committed', labourSpecFingerprint: { in: fingerprints }, civilDate: { in: dates } },
          select: {
            id: true, labourSpecFingerprint: true, civilDate: true, shift: true, personShiftQty: true,
            promises: { select: { promisedDate: true }, orderBy: { seq: 'desc' }, take: 1 },
          },
        })
      : [];
    // F2 — a person-shift drawn by ANY active allocation anywhere in the project is spent.
    // Round-2: an allocation that produced a WORK FACT stays consumed even after release — the
    // supplier person-shift was DELIVERED (the work fact keeps its requirement sourced via the
    // §A worked guardrail), so releasing the row must not free the commitment to cover a second
    // shortfall. Only a release with NO recorded work returns the capacity (the worker never
    // served; the allocation command may re-draw it, and the forecast may re-advertise it).
    const drawnRows = commitments.length
      ? await tx.workerAllocation.findMany({
          where: {
            projectId,
            capacityCommitmentId: { in: commitments.map((c) => c.id) },
            OR: [{ status: 'active' }, { work: { some: {} } }],
          },
          select: { capacityCommitmentId: true },
        })
      : [];
    const drawn = new Map<string, number>();
    for (const row of drawnRows) {
      const id = row.capacityCommitmentId as string;
      drawn.set(id, (drawn.get(id) ?? 0) + 1);
    }

    // Expand the undrawn remainder into unit supply slots, earliest promise first (deterministic).
    const slots: SupplySlot[] = [];
    const eligibleSupplies = commitments
      .map((cm) => ({
        id: cm.id,
        fingerprint: cm.labourSpecFingerprint,
        civilDate: toIsoCivilDate(cm.civilDate) ?? '',
        shift: cm.shift,
        latestPromise: cm.promises[0] ? (toIsoCivilDate(cm.promises[0].promisedDate) ?? '') : (toIsoCivilDate(cm.civilDate) ?? ''),
        remaining: Math.max(0, cm.personShiftQty - (drawn.get(cm.id) ?? 0)),
      }))
      .filter((s) => s.remaining > 0 && s.latestPromise <= s.civilDate)
      .sort((a, b) => (a.latestPromise < b.latestPromise ? -1 : a.latestPromise > b.latestPromise ? 1 : a.id < b.id ? -1 : 1));
    for (const s of eligibleSupplies) {
      for (let i = 0; i < s.remaining; i++) {
        slots.push({ commitmentId: s.id, fingerprint: s.fingerprint, civilDate: s.civilDate, shift: s.shift, latestPromise: s.latestPromise });
      }
    }

    // Collect every shortfall slice in canonical order and run the all-or-nothing assignment.
    const shortfalls = new Map<string, SliceShortfall>();
    const slotHolder: Array<DemandUnit | null> = slots.map(() => null);
    const tryPlace = (unit: DemandUnit, visited: Set<number>): boolean => {
      for (const si of unit.eligibleSlots) {
        if (visited.has(si)) continue;
        visited.add(si);
        const holder = slotHolder[si];
        if (holder === null || tryPlace(holder, visited)) {
          slotHolder[si] = unit;
          return true;
        }
      }
      return false;
    };
    for (const r of [...requirements].sort(canonicalOrder)) {
      for (const s of r.slices) {
        const c = counts.get(sliceKey(r.requirementId, s.civilDate, r.shift)) ?? EMPTY_COUNTS;
        const need = s.personShiftQty - c.coveredSourced;
        if (need <= 0) continue;
        // Round-2: committed capacity matches the HEAD fingerprint ONLY. The allocation command
        // (and its DB trigger) refuse to draw a commitment whose fingerprint differs from the
        // current head — a substitution widens what an existing ALLOCATION may satisfy (§B), but
        // it never makes a foreign-fingerprint commitment drawable, so advertising one would be
        // §A cover that cannot convert into execution capacity.
        const eligibleSlots = slots
          .map((slot, i) => ({ slot, i }))
          .filter(({ slot }) => slot.civilDate === s.civilDate && slot.shift === r.shift && slot.fingerprint === r.headFingerprint)
          .map(({ i }) => i);
        const shortfall: SliceShortfall = { requirementId: r.requirementId, civilDate: s.civilDate, need, units: [], matched: false, coveringDate: null };
        shortfalls.set(sliceKey(r.requirementId, s.civilDate, r.shift), shortfall);
        // all-or-nothing: attempt every unit; on any failure restore the pre-slice assignment so
        // a slice the pool cannot fully cover consumes nothing another slice could use
        const snapshot = [...slotHolder];
        let placedAll = true;
        for (let u = 0; u < need; u++) {
          const unit: DemandUnit = { sliceRef: shortfall, eligibleSlots };
          shortfall.units.push(unit);
          if (!tryPlace(unit, new Set())) {
            placedAll = false;
            break;
          }
        }
        if (!placedAll) {
          for (let i = 0; i < slotHolder.length; i++) slotHolder[i] = snapshot[i];
          shortfall.units = [];
          continue;
        }
        shortfall.matched = true;
      }
    }
    // The covering date per matched slice: the LATEST promise among the slots its units hold.
    for (let i = 0; i < slotHolder.length; i++) {
      const unit = slotHolder[i];
      if (!unit) continue;
      const promise = slots[i].latestPromise;
      const ref = unit.sliceRef;
      if (ref.coveringDate === null || promise > ref.coveringDate) ref.coveringDate = promise;
    }

    return requirements.map((r) => {
      let worst: RequirementLabourForecast['verdict'] = 'ready';
      let coveringDate: string | null = null;
      let reason = `Allocated labour covers every demand slice (§A forecast)`;
      for (const s of r.slices) {
        const c = counts.get(sliceKey(r.requirementId, s.civilDate, r.shift)) ?? EMPTY_COUNTS;
        if (c.coveredSourced >= s.personShiftQty) continue;
        const shortfall = shortfalls.get(sliceKey(r.requirementId, s.civilDate, r.shift));
        if (shortfall?.matched && shortfall.coveringDate !== null) {
          if (worst === 'ready') worst = 'at-risk';
          if (worst === 'at-risk') {
            if (coveringDate === null || shortfall.coveringDate > coveringDate) coveringDate = shortfall.coveringDate;
            reason = `Shortfall covered by committed capacity arriving by ${coveringDate} (§A forecast)`;
          }
        } else {
          worst = 'blocked';
          coveringDate = null;
          reason = `No allocated or committed labour for slice ${s.civilDate} ${r.shift} — ${c.coveredSourced} of ${s.personShiftQty} person-shifts (§A forecast)`;
          break;
        }
      }
      return { requirementId: r.requirementId, revision: r.revision, activityId: r.activityId, verdict: worst, coveringDate: worst === 'at-risk' ? coveringDate : null, reason };
    });
  }
}
