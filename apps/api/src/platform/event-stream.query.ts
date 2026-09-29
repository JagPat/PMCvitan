import type { KernelReadClient } from './role-standing.query';

/**
 * Phase 6 task 4d unit 4d-ii-a / A7d — `EventStreamQuery`, a KERNEL read over the kernel's own event
 * store (§A.2, the `decisions.effects` handler; §D "deferred dependencies, named").
 *
 * `latestPosition` answers "when was this entity last announced as X?" from stream positions the
 * kernel already holds — the highest `streamPosition` of an event of `eventType` about
 * `(entityType, entityId)` in the project, `null` when none was ever emitted. No module table is
 * read: the handler that asks it decides, per awaiting decision, whether the decision's countersign
 * DEMAND was raised before or after the standing crossing it is handling, and the answer is a
 * comparison of two positions on one project's stream.
 *
 * Every read runs on the caller's client, so it joins the caller's transaction (and its locks).
 */
export const EventStreamQuery = {
  async latestPosition(
    client: KernelReadClient, projectId: string, eventType: string, entityType: string, entityId: string,
  ): Promise<bigint | null> {
    const rows = await client.$queryRawUnsafe<Array<{ p: bigint | null }>>(
      `SELECT max("streamPosition") AS p FROM "DomainEvent"
        WHERE "projectId" = $1 AND "eventType" = $2 AND "entityType" = $3 AND "entityId" = $4`,
      projectId, eventType, entityType, entityId,
    );
    const p = rows[0]?.p;
    return p === null || p === undefined ? null : BigInt(p);
  },
};
