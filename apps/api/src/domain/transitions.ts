/**
 * Pure domain logic — no Nest, no Prisma, no I/O. This is the testable heart of
 * the backend: the same rules the frontend enforces, applied server-side as the
 * source of truth.
 *
 * The Phase 1 Task 6 DERIVED-READINESS truth tables — `deriveDecisionReading`,
 * `deriveInspectionGate`, `deriveDrawingGate`, `deriveReadiness`, `readinessReady`,
 * `gateReady` and their input/output types — are now IMPORTED from the built
 * `@vitan/shared` runtime package (Phase 2 Task 2); the former pinned copy is
 * retired, so web and API run the SAME derivation object. Only the legacy
 * four-gate helpers and the API-specific checklist/reinspection utilities remain
 * local (no web equivalent).
 */
import { gateReady } from '@vitan/shared';

export {
  gateReady,
  deriveDecisionReading,
  deriveInspectionGate,
  deriveDrawingGate,
  deriveReadiness,
  readinessReady,
} from '@vitan/shared';
export type {
  Gate,
  GateSource,
  GateReading,
  ActivityReadiness,
  OverridableGate,
  ReadinessInspection,
  ReadinessDrawing,
  ReadinessOverride,
  ReadinessInput,
} from '@vitan/shared';

export type GateState = 'ok' | 'wait' | 'fail' | 'na';
export type DecisionStatus = 'pending' | 'approved' | 'change';

/** The Decision gate is derived live from the linked decision's status (legacy four-gate helper). */
export function deriveDecisionGate(decisionStatus: DecisionStatus | null): GateState {
  if (decisionStatus == null) return 'na';
  return decisionStatus === 'approved' ? 'ok' : 'wait';
}

/** An activity can Start only when all four gates align (ok or n/a) (legacy four-gate helper). */
export function isActivityReady(gates: { d: GateState; m: GateState; t: GateState; i: GateState }): boolean {
  return gateReady(gates.d) && gateReady(gates.m) && gateReady(gates.t) && gateReady(gates.i);
}

/** Returns a guard message if the engineer checklist may not be submitted yet, else null. */
export function checklistSubmitError(items: { state: string | null; photos: number }[]): string | null {
  const undone = items.filter((it) => !it.state).length;
  if (undone > 0) return `Please mark all ${items.length} items before submitting.`;
  const failNoPhoto = items.filter((it) => it.state === 'fail' && it.photos === 0).length;
  if (failNoPhoto > 0) return 'A failed item needs a photo before you can submit.';
  return null;
}

/** How many re-inspection tasks sending rejections would create (FAIL or explicitly rejected). */
export function reinspectionCount(items: { rejected: boolean; result: string | null }[]): number {
  return items.filter((it) => it.rejected || it.result === 'FAIL').length;
}
