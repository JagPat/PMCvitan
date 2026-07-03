/**
 * Pure domain logic — no Nest, no Prisma, no I/O. This is the testable heart of
 * the backend: the same rules the frontend enforces, applied server-side as the
 * source of truth. Unit-tested in transitions.test.ts (no database needed).
 */

export type GateState = 'ok' | 'wait' | 'fail' | 'na';
export type DecisionStatus = 'pending' | 'approved' | 'change';

/** The Decision gate is derived live from the linked decision's status. */
export function deriveDecisionGate(decisionStatus: DecisionStatus | null): GateState {
  if (decisionStatus == null) return 'na';
  return decisionStatus === 'approved' ? 'ok' : 'wait';
}

export function gateReady(g: GateState): boolean {
  return g === 'ok' || g === 'na';
}

/** An activity can Start only when all four gates align (ok or n/a). */
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
