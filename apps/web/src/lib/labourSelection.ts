import { computeLabourSpecFingerprint, LABOUR_SHIFTS } from '@vitan/shared';
import type { WorkerDto, WorkerAllocationDto, CapacityCommitmentDto, ApprovedSkillSubstitutionDto, LabourSpecRef, LabourWorkFactDto, LabourRequisitionDto } from '@vitan/shared';

/**
 * Phase 4 Task 6 correction — the PURE selection rules behind the Labour hub's allocate action,
 * extracted so the Codex findings are unit-provable:
 *
 *  F1 (P1)  only COMPATIBLE workers may satisfy a demand slice — the worker's own
 *           (trade, skill, shift) identity must hash to the requirement's head fingerprint, or
 *           to the target of an ACTIVE approved skill substitution on that requirement (§B
 *           widening). An electrician can no longer be offered for a mason slice.
 *  F2 (P1)  an allocation that covers a commitment-covered slice must DRAW DOWN the commitment:
 *           pick the live same-slice `CapacityCommitment` with undrawn quantity so the store
 *           passes its id and the server's §F bound-3 drawdown actually runs.
 *  F6 (P2)  the allocated count must match the server's coverage rule — only ACTIVE allocations
 *           bound to the requirement's CURRENT activity AND current head fingerprint count; a
 *           row stranded by a revision (old activity or old trade/skill/shift) does not.
 */

/** Every fingerprint a worker's own identity can satisfy: for each shift, the bare-trade
 *  identity plus one per declared skill. Async because the shared fingerprint is WebCrypto
 *  SHA-256 (identical on web and Node) — compute once per workforce load and cache. */
export async function buildWorkerFingerprints(workers: readonly WorkerDto[]): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  for (const w of workers) {
    const fps: string[] = [];
    for (const shift of LABOUR_SHIFTS) {
      fps.push(await computeLabourSpecFingerprint({ tradeCode: w.tradeCode, skillCode: null, shift }));
      for (const skillCode of w.skillCodes) {
        fps.push(await computeLabourSpecFingerprint({ tradeCode: w.tradeCode, skillCode, shift }));
      }
    }
    out[w.id] = fps;
  }
  return out;
}

/** The fingerprints that satisfy a requirement's head spec: the head fingerprint itself plus the
 *  targets of ACTIVE substitutions on that requirement whose source IS the current head (the
 *  Phase-3 T6-F2 rule — a substitution stops applying when the head moves). */
export function satisfyingFingerprints(
  spec: Pick<LabourSpecRef, 'labourSpecFingerprint'>,
  requirementId: string,
  substitutions: readonly ApprovedSkillSubstitutionDto[],
): string[] {
  const targets = substitutions
    .filter((s) => s.requirementId === requirementId && s.revokedAt === null && s.fromFingerprint === spec.labourSpecFingerprint)
    .map((s) => s.toFingerprint);
  return [spec.labourSpecFingerprint, ...targets];
}

/** F1 — the workers the picker may offer for a slice of this requirement. */
export function compatibleWorkerIds(
  workers: readonly WorkerDto[],
  workerFingerprints: Readonly<Record<string, readonly string[]>>,
  spec: Pick<LabourSpecRef, 'labourSpecFingerprint'>,
  requirementId: string,
  substitutions: readonly ApprovedSkillSubstitutionDto[],
): Set<string> {
  const ok = new Set(satisfyingFingerprints(spec, requirementId, substitutions));
  const ids = new Set<string>();
  for (const w of workers) {
    if (w.revokedAt !== null) continue;
    const fps = workerFingerprints[w.id];
    if (fps && fps.some((fp) => ok.has(fp))) ids.add(w.id);
  }
  return ids;
}

/** F6 — active allocations that the server's coverage would actually count for this slice:
 *  bound to the requirement's CURRENT activity and a currently-satisfying fingerprint. */
export function allocatedCountFor(
  allocations: readonly WorkerAllocationDto[],
  requirementId: string,
  activityId: string,
  civilDate: string,
  spec: Pick<LabourSpecRef, 'labourSpecFingerprint'>,
  substitutions: readonly ApprovedSkillSubstitutionDto[],
): number {
  const ok = new Set(satisfyingFingerprints(spec, requirementId, substitutions));
  return allocations.filter(
    (a) =>
      a.requirementId === requirementId &&
      a.activityId === activityId &&
      a.civilDate === civilDate &&
      a.status === 'active' &&
      ok.has(a.labourSpecFingerprint),
  ).length;
}

/** F2 — the drawable same-slice commitment (exact fingerprint + civil date + shift) with undrawn
 *  quantity, or null for own-workforce allocation. Mirrors the SERVER's rules (Codex rounds 2–3,
 *  verified against `labour-capacity.service.ts` + the FORECAST's residual matching): only a
 *  `committed` commitment is drawable (a `revised` one is refused with a deterministic 409), and a
 *  draw stays CONSUMED while its allocation is ACTIVE — or, round 3, once ANY work fact was
 *  recorded under it (delivered capacity is spent; the forecast keeps it consumed, so re-offering
 *  the id would overdraw the supplier). Only a NO-WORK release frees the commitment for a
 *  replacement. The server re-derives the allocation bound under `FOR UPDATE`; a stale pick is a
 *  409 the flush reconciles. */
export function pickCommitmentFor(
  commitments: readonly CapacityCommitmentDto[],
  allocations: readonly WorkerAllocationDto[],
  workFacts: readonly LabourWorkFactDto[],
  spec: Pick<LabourSpecRef, 'labourSpecFingerprint' | 'shift'>,
  civilDate: string,
): string | null {
  const worked = new Set(workFacts.map((f) => f.allocationId));
  const draws = new Map<string, number>();
  for (const a of allocations) {
    if (a.capacityCommitmentId && (a.status === 'active' || worked.has(a.id))) {
      draws.set(a.capacityCommitmentId, (draws.get(a.capacityCommitmentId) ?? 0) + 1);
    }
  }
  const live = commitments
    .filter(
      (c) =>
        c.labourSpecFingerprint === spec.labourSpecFingerprint &&
        c.civilDate === civilDate &&
        c.shift === spec.shift &&
        c.status === 'committed' &&
        // Codex round 4 — a LATE promise never covers (`labour-coverage.service.ts` eligibility:
        // `latestPromise <= civilDate`, own civil date when no promise exists): drawing capacity
        // whose supplier arrives AFTER the slice would let a blocked activity read as sourced.
        (c.latestPromise?.promisedDate ?? c.civilDate) <= civilDate &&
        c.personShiftQty - (draws.get(c.id) ?? 0) > 0,
    )
    .sort((a, b) => (a.id < b.id ? -1 : 1)); // deterministic pick
  return live[0]?.id ?? null;
}

/** Codex round 2 — whether a (non-revoked) worker's active window admits a civil date. The
 *  server refuses allocation AND attendance outside `[activeFrom, activeTo]` with a terminal
 *  400 the outbox drops, so the pickers must never offer the action (ISO civil dates compare
 *  lexicographically). */
export function workerActiveOn(
  w: Pick<WorkerDto, 'revokedAt' | 'activeFrom' | 'activeTo'>,
  civilDate: string,
): boolean {
  return w.revokedAt === null && w.activeFrom <= civilDate && (w.activeTo === null || civilDate <= w.activeTo);
}

/** Codex round 2 — workers already holding an ACTIVE allocation on a `(civilDate, shift)`.
 *  Worker-level conservation (§C) admits ONE live allocation per worker/date/shift project-wide;
 *  offering a booked worker for a second slice is a guaranteed terminal 409. */
export function bookedWorkerIds(
  allocations: readonly WorkerAllocationDto[],
  civilDate: string,
  shift: string,
): Set<string> {
  const ids = new Set<string>();
  for (const a of allocations) {
    if (a.civilDate === civilDate && a.shift === shift && a.status === 'active') ids.add(a.workerId);
  }
  return ids;
}

/** Codex round 3 — the slice's SOURCED person-shifts, mirroring the server's canonical
 *  `coveredSourced = |allocated ∪ worked|` (labour-coverage: DISTINCT workers with an ACTIVE
 *  compatible allocation, UNION workers whose work fact was recorded under a compatible
 *  allocation of this slice — work counts even after the allocation's release, the §A worked
 *  guardrail). The allocate action must stop at THIS count, not the active-only one: a
 *  worked-then-released one-person slice is fulfilled, and another allocation would waste a
 *  worker on demand readiness already considers delivered. */
export function sourcedCountFor(
  allocations: readonly WorkerAllocationDto[],
  workFacts: readonly LabourWorkFactDto[],
  requirementId: string,
  activityId: string,
  civilDate: string,
  spec: Pick<LabourSpecRef, 'labourSpecFingerprint' | 'shift'>,
  substitutions: readonly ApprovedSkillSubstitutionDto[],
): number {
  const ok = new Set(satisfyingFingerprints(spec, requirementId, substitutions));
  const sourced = new Set<string>();
  for (const a of allocations) {
    if (a.requirementId !== requirementId || a.activityId !== activityId) continue;
    if (a.civilDate !== civilDate || a.shift !== spec.shift) continue;
    if (!ok.has(a.labourSpecFingerprint)) continue;
    if (a.status === 'active') sourced.add(a.workerId);
    for (const f of workFacts) {
      if (f.allocationId === a.id && f.civilDate === civilDate && f.shift === spec.shift) sourced.add(f.workerId);
    }
  }
  return sourced.size;
}

/** Codex round 3 — the UNREQUISITIONED residual of a requirement's demand slices. The server's
 *  §F bound-1 check counts every existing `open`/`ordered` requisition line on the SAME
 *  `(requirementId, revision, civilDate)` slice against its `personShiftQty` ceiling, so re-sending
 *  a slice that is already (partly) in the commercial chain is a guaranteed terminal 409. Send
 *  only the residual per slice, and drop fully-requisitioned slices entirely (an empty result
 *  means the raise action has nothing left to do and the button disappears). */
export function unrequisitionedLines(
  requirementId: string,
  revision: number,
  demandSlices: ReadonlyArray<{ civilDate: string; personShiftQty: number }>,
  requisitions: readonly LabourRequisitionDto[],
): Array<{ requirementId: string; revision: number; civilDate: string; personShiftQty: number }> {
  const already = new Map<string, number>();
  for (const rq of requisitions) {
    // Codex round 4 — the server's bound-1 count EXCLUDES lines whose parent requisition is
    // rejected or closed (`requisition.status NOT IN ('rejected','closed')`): a rejected
    // requisition's lines can stay `open` in the DTO, but its demand is re-sourceable and the
    // raise button must come back for it.
    if (rq.status === 'rejected' || rq.status === 'closed') continue;
    for (const l of rq.lines) {
      if (l.requirementId !== requirementId || l.revision !== revision) continue;
      if (l.status !== 'open' && l.status !== 'ordered') continue;
      already.set(l.civilDate, (already.get(l.civilDate) ?? 0) + l.personShiftQty);
    }
  }
  return demandSlices
    .map((sl) => ({ requirementId, revision, civilDate: sl.civilDate, personShiftQty: sl.personShiftQty - (already.get(sl.civilDate) ?? 0) }))
    .filter((l) => l.personShiftQty > 0);
}
