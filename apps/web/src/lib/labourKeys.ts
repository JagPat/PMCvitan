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

export const musterCoalesceKey = (workerId: string, civilDate: string, shift: string): string =>
  `lab:must:${workerId}:${civilDate}:${shift}`;

export const workCoalesceKey = (allocationId: string, workedMinutes: number): string =>
  `lab:work:${allocationId}:${workedMinutes}`;

export const labourRequisitionCoalesceKey = (
  lines: ReadonlyArray<{ requirementId: string; revision: number; civilDate: string; personShiftQty: number }>,
): string => {
  const sig = lines
    .map((l) => `${l.requirementId}@${l.revision}:${l.civilDate}x${l.personShiftQty}`)
    .sort()
    .join(',');
  return `lab:req:${sig}`;
};

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
