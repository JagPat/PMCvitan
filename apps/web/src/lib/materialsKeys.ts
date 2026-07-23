/**
 * Phase 3 Task 7 (correction 3) — the DETERMINISTIC COALESCE keys for the pilot MATERIALS commands.
 *
 * These are NOT idempotency keys. Correction 2 conflated the two; the re-review (finding 1) showed why
 * that is wrong: a permanently-derived key identifies a RESOURCE, not a command ATTEMPT, so it blocks
 * legitimate future repetitions (reserve → release → reserve again; issuing the same quantity twice) and
 * collides when the planner offers two candidates from the same lot.
 *
 * The split (correction 3):
 *  • the IDEMPOTENCY key — a FRESH `newIdempotencyKey()` minted ONCE per deliberate user action, persisted
 *    on the outbox op and reused unchanged for every retry/reload (so a lost response replays exactly once),
 *    and DIFFERENT for the next legitimate action after this one resolves; and
 *  • the COALESCE key (here) — a deterministic identity used ONLY to dedupe an EQUIVALENT action while it
 *    is still PENDING (a double-click, or a reload that finds the op still queued). Once the action
 *    resolves it leaves `materialsPending`, so a later identical legitimate action dispatches afresh.
 *
 * A reserve coalesces by `(activityId, lotId, storeLocation)` — the planner now aggregates candidates per
 * `(lotId, storeLocation)` (finding 1), so this uniquely identifies one pending reserve. Issue/consume/
 * requisition include the quantity / residual content so distinct amounts are distinct pending actions.
 */
export const reserveCoalesceKey = (activityId: string, lotId: string, storeLocation: string): string =>
  `mat:res:${activityId}:${lotId}:${storeLocation}`;

export const issueCoalesceKey = (activityId: string, lotId: string, storeLocation: string, qty: string): string =>
  `mat:iss:${activityId}:${lotId}:${storeLocation}:${qty}`;

export const consumeCoalesceKey = (issueId: string, qty: string): string =>
  `mat:con:${issueId}:${qty}`;

export const requisitionCoalesceKey = (
  activityId: string,
  lines: ReadonlyArray<{ requirementId: string; revision: number; qty: string }>,
): string => {
  const sig = lines.map((l) => `${l.requirementId}@${l.revision}x${l.qty}`).sort().join(',');
  return `mat:req:${activityId}:${sig}`;
};

/** The materials operation `t` discriminants persisted to the durable outbox. */
export const MATERIALS_OUTBOX_OP_TYPES = ['reserveStock', 'issueStock', 'consumeStock', 'createRequisition'] as const;
const MATERIALS_OP_TYPE_SET: ReadonlySet<string> = new Set(MATERIALS_OUTBOX_OP_TYPES);
/** True iff `t` is a materials outbox-op discriminant. Accepts `unknown` so it can screen parsed storage. */
export const isMaterialsOpType = (t: unknown): boolean => typeof t === 'string' && MATERIALS_OP_TYPE_SET.has(t);

/** The minimal shape the outbox normalizer inspects on each persisted op. */
type OutboxOpShape = { t?: unknown; idempotencyKey?: unknown; coalesceKey?: unknown };

/**
 * Phase 3 Task 7 (correction 4) — backward-compatible normalization of the persisted materials outbox.
 *
 * A materials op persisted by PR #207 carries only `idempotencyKey` (no `coalesceKey`); PR #208 keys
 * coalescing/disable-while-pending on `coalesceKey`, so on a legacy queue an equivalent action would NOT
 * coalesce and could execute a SECOND time (double reserve). The old PR #207 idempotency key used the
 * SAME deterministic business-coordinate format as the new coalesce key — `reserveKey`→`reserveCoalesceKey`
 * (etc.) were renamed with identical bodies — so we DERIVE `coalesceKey` from the legacy `idempotencyKey`
 * and PRESERVE the `idempotencyKey` byte-for-byte (replay stays exactly-once). A malformed materials op
 * (not an object, or neither key present) is DROPPED so a `undefined` can never reach `materialsPending`.
 * Non-materials ops pass through untouched. `changed` lets the caller persist the migrated queue back.
 */
export function normalizeMaterialsOutbox<T extends OutboxOpShape>(ops: readonly T[]): { ops: T[]; changed: boolean } {
  let changed = false;
  const out: T[] = [];
  for (const op of ops) {
    if (op === null || typeof op !== 'object') { changed = true; continue; } // drop non-object junk
    if (!isMaterialsOpType(op.t)) { out.push(op); continue; } // non-materials op — untouched
    if (typeof op.coalesceKey === 'string') { out.push(op); continue; } // already PR #208 shape
    if (typeof op.idempotencyKey === 'string' && op.idempotencyKey.length > 0) {
      // legacy PR #207 materials op: derive the coalesce key from the (same-format) idempotency key,
      // keep the idempotency key untouched.
      out.push({ ...op, coalesceKey: op.idempotencyKey } as T);
      changed = true;
      continue;
    }
    changed = true; // malformed materials op (no usable key) — drop rather than admit `undefined`
  }
  return { ops: out, changed };
}
