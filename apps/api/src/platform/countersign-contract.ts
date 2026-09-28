import { ConflictException } from '@nestjs/common';
import { countersignReloadMessage, understandsCountersign, type DecisionsContract } from '../common/decisions-contract';
import { RoleStandingQuery, type KernelReadClient } from './role-standing.query';

/**
 * Phase 6 task 4d unit 4d-ii-a / A5e (§A.2) — the IN-COMMAND half of the `countersign-v1` boundary.
 *
 * A command whose outcome a pre-4d tab cannot represent under an ACTIVE chain (the approve that lands
 * `awaiting_countersign`; a create or draft edit naming the architect designation; 4d-iii's forward,
 * countersign and disagree) refuses a lesser client with a reload 409. It is judged INSIDE the command,
 * AFTER `lockProjectReadiness` and before any write, never at the transport: a boundary-time chain read
 * can race the activation it guards, and the readiness key is what serializes an activation (the
 * architect `Membership` write takes it) against this read. With no chain the command is untouched.
 *
 * The chain is ACTIVE when the kernel register counts an architect (`RoleStandingQuery`), the read the
 * `countersignRequired` overlay and the database seals share.
 */
export async function assertCountersignClient(
  client: KernelReadClient,
  projectId: string,
  contract: DecisionsContract | undefined,
  what: string,
): Promise<void> {
  if (understandsCountersign(contract)) return;
  if ((await RoleStandingQuery.activeCount(client, projectId, 'architect')) === 0) return;
  throw new ConflictException(countersignReloadMessage(what));
}
