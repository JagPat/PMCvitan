import { computeLabourSpecFingerprint, LABOUR_SHIFTS } from '@vitan/shared';
import type { WorkerDto, WorkerAllocationDto, CapacityCommitmentDto, ApprovedSkillSubstitutionDto, LabourSpecRef } from '@vitan/shared';

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

/** F2 — the live same-slice commitment (exact fingerprint + civil date + shift) with undrawn
 *  quantity, or null for own-workforce allocation. Draws are counted over ALL allocations naming
 *  the commitment regardless of status — a delivered-then-released draw stays consumed (the
 *  Task-4 round-2 rule). The server re-derives the bound under `FOR UPDATE`; a stale pick is a
 *  deterministic 409 that the flush reconciles. */
export function pickCommitmentFor(
  commitments: readonly CapacityCommitmentDto[],
  allocations: readonly WorkerAllocationDto[],
  spec: Pick<LabourSpecRef, 'labourSpecFingerprint' | 'shift'>,
  civilDate: string,
): string | null {
  const draws = new Map<string, number>();
  for (const a of allocations) {
    if (a.capacityCommitmentId) draws.set(a.capacityCommitmentId, (draws.get(a.capacityCommitmentId) ?? 0) + 1);
  }
  const live = commitments
    .filter(
      (c) =>
        c.labourSpecFingerprint === spec.labourSpecFingerprint &&
        c.civilDate === civilDate &&
        c.shift === spec.shift &&
        (c.status === 'committed' || c.status === 'revised') &&
        c.personShiftQty - (draws.get(c.id) ?? 0) > 0,
    )
    .sort((a, b) => (a.id < b.id ? -1 : 1)); // deterministic pick
  return live[0]?.id ?? null;
}
