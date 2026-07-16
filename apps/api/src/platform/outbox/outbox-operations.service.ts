import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';

/**
 * Phase 2 fix-forward PR B Task 4 — audited dead-letter operations.
 *
 * `status`/`metrics` expose the outbox's operational health WITHOUT event payloads or push secrets
 * (only counts, coordinates, attempts and a TRUNCATED error). `retry` is the only recovery path: it
 * accepts ONLY a `dead` delivery, re-validates its event coordinates + active catalog contract +
 * registered consumer, then — in ONE locked transaction — resets it to `pending` and writes an
 * `OutboxOperatorAction`. It NEVER advances a projection cursor: for an ordered consumer it only
 * un-blocks the cursor, and only when the dead delivery is the cursor's EXACT-NEXT position.
 */

export interface OutboxDeadRow {
  id: string; consumer: string; projectId: string; streamPosition: string; attempts: number; lastError: string | null;
}
export interface OutboxBlockedRow { consumer: string; projectId: string; appliedPosition: string | null; }
export interface OutboxMetrics {
  pending: number; leased: number; dead: number; blocked: number; oldestPendingSeconds: number | null;
}
export interface OutboxStatus extends OutboxMetrics {
  succeeded: number; deadRows: OutboxDeadRow[]; blockedRows: OutboxBlockedRow[];
}

const truncate = (s: string | null, max = 200): string | null => (s == null ? null : s.length > max ? `${s.slice(0, max)}…` : s);

@Injectable()
export class OutboxOperationsService {
  private readonly log = new Logger('OutboxOps');
  constructor(private readonly prisma: PrismaService) {}

  /** Aggregate-only health for /health — no lists, no payloads, no secrets. */
  async metrics(): Promise<OutboxMetrics> {
    const grouped = await this.prisma.outboxDelivery.groupBy({ by: ['status'], _count: { _all: true } });
    const by: Record<string, number> = {};
    for (const g of grouped) by[g.status] = g._count._all;
    const blocked = await this.prisma.projectionCursor.count({ where: { status: 'blocked' } });
    const oldest = await this.prisma.outboxDelivery.findFirst({ where: { status: 'pending' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } });
    const oldestPendingSeconds = oldest ? Math.max(0, Math.floor((Date.now() - oldest.createdAt.getTime()) / 1000)) : null;
    return { pending: by['pending'] ?? 0, leased: by['leased'] ?? 0, dead: by['dead'] ?? 0, blocked, oldestPendingSeconds };
  }

  /** Full operator status: aggregates + the dead deliveries and blocked cursors, errors truncated,
   *  never event payloads or push subscription secrets. */
  async status(deadLimit = 50): Promise<OutboxStatus> {
    const m = await this.metrics();
    const succeeded = await this.prisma.outboxDelivery.count({ where: { status: 'succeeded' } });
    const dead = await this.prisma.outboxDelivery.findMany({
      where: { status: 'dead' }, take: deadLimit, orderBy: { updatedAt: 'desc' },
      select: { id: true, consumer: true, projectId: true, streamPosition: true, attempts: true, lastError: true },
    });
    const blocked = await this.prisma.projectionCursor.findMany({
      where: { status: 'blocked' }, select: { consumer: true, projectId: true, appliedPosition: true },
    });
    return {
      ...m, succeeded,
      deadRows: dead.map((d) => ({ id: d.id, consumer: d.consumer, projectId: d.projectId, streamPosition: d.streamPosition.toString(), attempts: d.attempts, lastError: truncate(d.lastError) })),
      blockedRows: blocked.map((b) => ({ consumer: b.consumer, projectId: b.projectId, appliedPosition: b.appliedPosition?.toString() ?? null })),
    };
  }

  /** Retry ONE dead delivery. Returns the durable audit id. Throws (no side effect) on any guard. */
  async retry(input: { deliveryId: string; operatorIdentity: string; reason: string }): Promise<{ auditId: string }> {
    const operatorIdentity = input.operatorIdentity?.trim();
    const reason = input.reason?.trim();
    if (!operatorIdentity) throw new Error('operator identity is required');
    if (!reason) throw new Error('reason is required');

    const result = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string; eventId: string; projectId: string; streamPosition: bigint; consumer: string; consumerKind: string; status: string; lastError: string | null }>>`
        SELECT "id", "eventId", "projectId", "streamPosition", "consumer", "consumerKind", "status", "lastError"
        FROM "OutboxDelivery" WHERE "id" = ${input.deliveryId} FOR UPDATE`;
      const d = locked[0];
      if (!d) throw new Error(`delivery ${input.deliveryId} not found`);
      if (d.status !== 'dead') throw new Error(`delivery ${input.deliveryId} is '${d.status}'; only a 'dead' delivery can be retried`);

      const ev = await tx.domainEvent.findUnique({ where: { eventId: d.eventId }, select: { projectId: true, streamPosition: true } });
      if (!ev || ev.projectId !== d.projectId || ev.streamPosition !== d.streamPosition) throw new Error('delivery coordinates disagree with its event — investigate, do not retry');
      // Validate against the DURABLE active catalog contract — the cross-process source of truth
      // (an operator CLI need not have registered the in-process consumer). A deactivated contract
      // is rejected; a delivery whose code is absent in the dispatching process self-corrects (the
      // relay dead-letters it again), so the durable check is the authoritative guard here.
      const cat = await tx.outboxConsumerCatalog.findUnique({ where: { consumer: d.consumer } });
      if (!cat || !cat.active) throw new Error(`consumer '${d.consumer}' is not an active catalog contract`);

      // An ordered consumer's cursor may be un-blocked ONLY when this delivery is its exact-next
      // expected position. The cursor's appliedPosition is NEVER advanced by a retry.
      if (cat.consumerKind === 'ordered') {
        const cursor = await tx.projectionCursor.findUnique({ where: { consumer_projectId: { consumer: d.consumer, projectId: d.projectId } } });
        const nextExpected = cursor?.appliedPosition == null ? 0n : cursor.appliedPosition + 1n;
        if (d.streamPosition !== nextExpected) throw new Error(`delivery is at position ${d.streamPosition} but the ordered cursor's next expected position is ${nextExpected}; resolve positions in order`);
        if (cursor?.status === 'blocked') {
          await tx.projectionCursor.update({ where: { consumer_projectId: { consumer: d.consumer, projectId: d.projectId } }, data: { status: 'live' } });
        }
      }

      await tx.outboxDelivery.update({ where: { id: d.id }, data: { status: 'pending', attempts: 0, nextAttemptAt: new Date(), leaseOwner: null, leaseExpiresAt: null, lastError: null } });
      const action = await tx.outboxOperatorAction.create({
        data: { action: 'retry', deliveryId: d.id, consumer: d.consumer, projectId: d.projectId, eventId: d.eventId, operatorIdentity, reason, priorError: truncate(d.lastError) },
      });
      return { auditId: action.id };
    });
    this.log.warn(`outbox delivery ${input.deliveryId} retried by '${operatorIdentity}' (audit ${result.auditId})`);
    return result;
  }
}
