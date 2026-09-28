import { DECISIONS_CONTRACT_HEADER, DECISIONS_CONTRACT_RECORDED } from './recorded-compat.interceptor';

/**
 * Phase 6 task 4d unit 4d-ii-a / A5e (§A.2, "Browser tabs cannot be drained") — the decisions CLIENT
 * CONTRACT a request declares, in order of what it understands:
 *
 * - `none`: no `x-vitan-decisions-contract` header — a pre-4b bundle;
 * - `recorded-v1`: the 4b boundary, which every current web bundle declares;
 * - `countersign-v1`: the 4d boundary — the client maps `awaiting_countersign`, the `architect`
 *   role and designation, and a change request's non-standard origin. Declared by 4d-ii-b's gateway.
 *
 * Only the exact `countersign-v1` value is the 4d contract. Any other non-empty value is read as
 * `recorded-v1`, the rank the 4b interceptor already gives it, so a malformed or unknown declaration
 * is protected rather than trusted.
 */
export const DECISIONS_CONTRACT_COUNTERSIGN = 'countersign-v1';

export type DecisionsContract = 'none' | typeof DECISIONS_CONTRACT_RECORDED | typeof DECISIONS_CONTRACT_COUNTERSIGN;

/** The contract a request's headers declare. */
export function declaredDecisionsContract(headers: Record<string, string | string[] | undefined> | undefined): DecisionsContract {
  const declared = headers?.[DECISIONS_CONTRACT_HEADER];
  if (typeof declared !== 'string' || declared.length === 0) return 'none';
  return declared === DECISIONS_CONTRACT_COUNTERSIGN ? DECISIONS_CONTRACT_COUNTERSIGN : DECISIONS_CONTRACT_RECORDED;
}

/** True only for a client that declared `countersign-v1`. An absent contract (a caller that did not
 *  come through `JwtGuard`) is a LESSER client: the check fails closed. */
export function understandsCountersign(contract: DecisionsContract | undefined): boolean {
  return contract === DECISIONS_CONTRACT_COUNTERSIGN;
}

/** The reload refusal a lesser client receives, naming the contract it lacks. */
export function countersignReloadMessage(what: string): string {
  return `${what} needs the current app: this page predates the architect countersign — reload the page to continue (decisions contract ${DECISIONS_CONTRACT_COUNTERSIGN})`;
}
