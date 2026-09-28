import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Phase 6 task 4d unit 4d-ii-a / A5b — the ONE read of the architect chain's rollout state (§A.1,
 * "The role is DELIVERED DARK and armed only after the drain").
 *
 * 4d-i installed the reservation DOORS (one shared refusal function, `phase6_t4d_reserved()`), and
 * 4d-iii drops them all in one statement once the previous release is attested drained. Until then the
 * database refuses every architect shape: a `Membership` or `User` row in the role, a `Decision`
 * designated to it or awaiting its countersign, a `DecisionForward`, a kinded `DecisionEvent`. The
 * service path judges the state the way the database does, by the doors' presence in `pg_trigger`, so
 * a command naming the role is refused 409 with the drain directive before it writes, rather than
 * meeting a trigger's exception mid-transaction; and the shell's `rollout.phase6_4d` is baked from the
 * same read, so no client offers what the server refuses.
 *
 * FAIL CLOSED: the state reads `reserved` while ANY door stands. The doors fall together, so a partial
 * set is not a state 4d-iii leaves; it can only be a damaged database, which must not read as open.
 */
export type Phase6_4dRollout = 'reserved' | 'open';

/** The drain directive every refusal names (docs/POLICY.md): the human operator attestation that the
 *  previous release is drained, which 4d-iii requires before it drops the doors. */
export const PHASE6_4D_DRAIN_DIRECTIVE = 'phase-6-4d-previous-release-drained';

/** The reservation doors 4d-i installs and 4d-iii drops, by trigger name. */
export const PHASE6_4D_RESERVATION_DOORS = [
  'Membership_t4d_architect_reserved',
  'User_t4d_architect_reserved',
  'Decision_t4d_architect_reserved',
  'Decision_t4d_awaiting_reserved',
  'DecisionForward_t4d_reserved',
  'DecisionEvent_t4d_kind_reserved',
] as const;

type CatalogReader = Pick<Prisma.TransactionClient, '$queryRaw'>;

/** The rollout state, read from the catalog on `client` (the caller's transaction, when it holds one). */
export async function readPhase6_4dRollout(client: CatalogReader): Promise<Phase6_4dRollout> {
  const rows = await client.$queryRaw<Array<{ doors: number }>>(Prisma.sql`
    SELECT count(*)::int AS doors FROM pg_trigger t
     WHERE NOT t.tgisinternal AND t.tgname IN (${Prisma.join([...PHASE6_4D_RESERVATION_DOORS])})`);
  return (rows[0]?.doors ?? 0) > 0 ? 'reserved' : 'open';
}

/**
 * Refuse `what` with a 409 naming the drain directive while the reservation stands. Called by each
 * command that would write an architect shape, BEFORE its first write, in its own transaction (under
 * the readiness lock where the command takes it), so the refusal leaves nothing behind.
 */
export async function assertPhase6_4dOpen(client: CatalogReader, what: string): Promise<void> {
  if ((await readPhase6_4dRollout(client)) === 'reserved') {
    throw new ConflictException(
      `${what} is reserved until the previous release is drained (${PHASE6_4D_DRAIN_DIRECTIVE}); the architect chain opens with Phase 6 unit 4d-iii`,
    );
  }
}
