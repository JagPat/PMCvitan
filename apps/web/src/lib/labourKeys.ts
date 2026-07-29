/**
 * Phase 4 Task 6 (§J) — the labour twin of `materialsKeys.ts`, born ALREADY carrying the
 * PR-#208 two-key split:
 *
 *  - `idempotencyKey` — a fresh COMMAND-ATTEMPT identity (`newIdempotencyKey()`), minted once
 *    per deliberate user action, persisted on the outbox op, reused unchanged on retry so a
 *    lost response replays exactly once, and DIFFERENT for the next legitimate action.
 *  - `coalesceKey` — a deterministic EQUIVALENT-ACTION identity used only to dedupe an
 *    identical action WHILE one is pending (button disabled, second click ignored).
 *
 * There is no legacy labour queue, so unlike materials no hydration migration exists: a labour
 * op without BOTH keys is malformed and is dropped by `normalizeLabourOutbox`.
 */

export const allocateCoalesceKey = (
  activityId: string,
  requirementId: string,
  // Codex round 4 — the coalesce identity carries the SELECTED head revision: a stale rev-N op
  // still queued offline must not swallow a legitimate rev-N+1 action for the same worker/slice
  // (the stale op replays, 409s on head drift and is dropped; the new op must still be queued).
  originRevision: number,
  civilDate: string,
  subject: string, // workerId or crew:<crewId> — one live allocation per worker/slice either way
): string => `lab:alloc:${activityId}:${requirementId}@${originRevision}:${civilDate}:${subject}`;

/** Codex round 5 — whether a pending coalesce key is an ALLOCATE op for the given demand slice,
 *  ANY worker: the allocate stop must count every in-flight allocation against the slice, not
 *  only the currently-chosen worker's own key — otherwise picking a second worker while the
 *  first command is still in flight queues a 2/1 own-workforce over-allocation.
 *
 *  Codex round 6 — scoped to the SELECTED revision: a stale rev-N op still queued offline will
 *  replay, 409 on head drift and be dropped — it must NOT make the rev-N+1 slice read as full
 *  and suppress the legitimate current-head allocation (the very action the revision-keyed
 *  coalesce identity of round 4 exists to preserve). Prefix-matched so a `crew:<id>` subject
 *  (which itself contains ':') also matches. */
export const isAllocatePendingForSlice = (
  key: string,
  activityId: string,
  requirementId: string,
  originRevision: number,
  civilDate: string,
): boolean => key.startsWith(`lab:alloc:${activityId}:${requirementId}@${originRevision}:${civilDate}:`);

export const musterCoalesceKey = (workerId: string, civilDate: string, shift: string): string =>
  `lab:must:${workerId}:${civilDate}:${shift}`;

export const workCoalesceKey = (allocationId: string, workedMinutes: number): string =>
  `lab:work:${allocationId}:${workedMinutes}`;

/** Codex round 7 — whether a pending coalesce key is a WORK op for the given allocation at ANY
 *  minutes value: the key carries the minutes, so the per-key pending check alone re-enables the
 *  button the moment the user edits the input while the first record is still in flight. */
export const isWorkPendingForAllocation = (key: string, allocationId: string): boolean =>
  key.startsWith(`lab:work:${allocationId}:`);

export const labourRequisitionCoalesceKey = (
  lines: ReadonlyArray<{ requirementId: string; revision: number; civilDate: string; personShiftQty: number }>,
): string => {
  const sig = lines
    .map((l) => `${l.requirementId}@${l.revision}:${l.civilDate}x${l.personShiftQty}`)
    .sort()
    .join(',');
  return `lab:req:${sig}`;
};

/** The roster bind's held-key SIGNATURE — the store's `labourBindPending` map key. Shared so the
 *  device-level pending check below parses the same format the store writes. */
export const bindSig = (deviceId: string, workerId: string): string => JSON.stringify([deviceId, workerId]);

/** Codex round 10 — whether ANY bind for this DEVICE is still unresolved, regardless of which
 *  worker it names. The held-key map is keyed per `(device, worker)` pair, but a device is
 *  one-way evidence: two racing binds of one device to DIFFERENT workers let the server CAS
 *  permanently attribute it to whichever wins while the other is a terminal 409 — so the bind
 *  form must reserve the DEVICE while any bind naming it is pending. */
export function isDeviceBindPending(pending: Readonly<Record<string, string>>, deviceId: string): boolean {
  return Object.keys(pending).some((sig) => {
    try {
      const parsed = JSON.parse(sig) as unknown;
      return Array.isArray(parsed) && parsed[0] === deviceId;
    } catch {
      return false;
    }
  });
}

/** The labour outbox op types (the §J offline/idempotent field ops). */
export const LABOUR_OUTBOX_OP_TYPES = ['allocateLabour', 'recordAttendance', 'recordLabourWork', 'createLabourRequisition'] as const;

export const isLabourOpType = (t: unknown): boolean =>
  typeof t === 'string' && (LABOUR_OUTBOX_OP_TYPES as readonly string[]).includes(t);

type OutboxOpShape = { t?: unknown; idempotencyKey?: unknown; coalesceKey?: unknown };

/**
 * Hydration guard: labour ops were born with both keys, so there is nothing to migrate — but a
 * malformed row (missing either key) must never reach `labourPending` as `undefined` or replay
 * without exactly-once identity. Non-labour ops pass through untouched.
 */
export function normalizeLabourOutbox<T extends OutboxOpShape>(ops: readonly T[]): { ops: T[]; changed: boolean } {
  const out: T[] = [];
  let changed = false;
  for (const op of ops) {
    if (op === null || typeof op !== 'object') {
      changed = true;
      continue;
    }
    if (!isLabourOpType(op.t)) {
      out.push(op);
      continue;
    }
    const idem = op.idempotencyKey;
    const ck = op.coalesceKey;
    if (typeof idem === 'string' && idem.length > 0 && typeof ck === 'string' && ck.length > 0) {
      out.push(op);
      continue;
    }
    changed = true; // malformed labour op — dropped, never replayed with a broken identity
  }
  return { ops: out, changed };
}
