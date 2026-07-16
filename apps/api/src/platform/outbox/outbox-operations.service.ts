import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { outboxSenderMode } from './registry';
import { effectCoverageVersion } from '../external-effects';

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

/** The seal holds a SHARE ROW EXCLUSIVE lock on DomainEvent across its gap scan; give the interactive
 *  transaction a generous ceiling (well over Prisma's 5s default) so a large event history can be
 *  scanned without the whole seal timing out and rolling back mid-cutover. */
const SEAL_TX_TIMEOUT_MS = 120_000;

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

  /**
   * PR C Task 3 — the audited external-effect cutover SEAL. Run in `legacy`/`shadow` mode; it pins the
   * compiled coverage version that `OUTBOX_SENDER_MODE=outbox` startup then requires, and neutralizes
   * the pre-cutover external deliveries so switching to outbox mode never re-sends historical
   * socket/push. It NEVER deletes an event, a delivery, or a payload — a `noop`/`succeeded` mark
   * preserves the historical push body for audit.
   *
   * Protocol (ONE transaction):
   *   1. `LOCK TABLE "DomainEvent" IN SHARE ROW EXCLUSIVE MODE` — conflicts with the ROW EXCLUSIVE an
   *      INSERT takes, so an in-flight event insert commits BEFORE the seal proceeds and no new event
   *      can be inserted while the seal runs (the seal sees a stable set).
   *   2. Refuse if the outbox has unresolved trouble: a `dead` delivery, a `blocked` cursor, or a
   *      delivery GAP (an active external consumer missing a delivery for some event) — the operator
   *      must let the relay expand / resolve first, or the seal would strand it.
   *   3. Row-lock the pre-cutover external deliveries (null-intent legacy events + non-current-coverage
   *      compat intents). Abort if any is currently `leased` (a sender owns it). Mark the rest
   *      `noop`/`succeeded` WITHOUT clearing payload. Current-coverage deliveries are left alone.
   *   4. Upsert the singleton coverage version and write the operator audit. Once the singleton exists,
   *      the BEFORE INSERT trigger rejects any future null-intent event.
   */
  async sealExternal(input: { operatorIdentity: string; reason: string }): Promise<{ coverageVersion: string; auditId: string; neutralized: number }> {
    const operatorIdentity = input.operatorIdentity?.trim();
    const reason = input.reason?.trim();
    if (!operatorIdentity) throw new Error('operator identity is required');
    if (!reason) throw new Error('reason is required');
    if (outboxSenderMode() === 'outbox') {
      throw new Error('the seal must be run in legacy or shadow mode — outbox mode requires an EXISTING seal to start, so it cannot create the first one');
    }
    const coverageVersion = effectCoverageVersion();

    const result = await this.prisma.$transaction(async (tx) => {
      // (1) Serialize against concurrent event inserts.
      await tx.$executeRawUnsafe('LOCK TABLE "DomainEvent" IN SHARE ROW EXCLUSIVE MODE');

      // (2) Refuse on unresolved trouble.
      const dead = await tx.outboxDelivery.count({ where: { status: 'dead' } });
      if (dead > 0) throw new Error(`refusing to seal: ${dead} dead outbox delivery(ies) — resolve (retry) them before cutting over`);
      const blocked = await tx.projectionCursor.count({ where: { status: 'blocked' } });
      if (blocked > 0) throw new Error(`refusing to seal: ${blocked} blocked projection cursor(s) — resolve them before cutting over`);
      // A delivery GAP: an active external consumer with a DomainEvent that has no delivery for it.
      // The relay's expander closes these continuously; the operator must let it catch up first.
      const gaps = await tx.$queryRaw<Array<{ missing: bigint }>>`
        SELECT count(*) AS missing
        FROM "OutboxConsumerCatalog" c
        JOIN "DomainEvent" e ON true
        WHERE c."active" = true AND c."consumerEffect" = 'external'
          AND NOT EXISTS (SELECT 1 FROM "OutboxDelivery" d WHERE d."eventId" = e."eventId" AND d."consumer" = c."consumer")`;
      const gapCount = Number(gaps[0]?.missing ?? 0n);
      if (gapCount > 0) throw new Error(`refusing to seal: ${gapCount} external delivery gap(s) — let the relay expand missing deliveries before cutting over`);

      // (3) The pre-cutover external deliveries: null-intent legacy events, or a non-current coverage
      // (a PR B 'compat.task6' intent). Current-coverage deliveries are NOT touched — the relay will
      // still send any the immediate dispatcher hasn't (at-least-once), which is correct.
      const targets = await tx.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT d."id", d."status"
        FROM "OutboxDelivery" d
        JOIN "DomainEvent" e ON e."eventId" = d."eventId"
        WHERE d."consumerKind" = 'unordered'
          AND d."status" IN ('pending', 'leased')
          AND (
            e."dispatchIntent" IS NULL
            OR (e."dispatchIntent" ->> 'coverageVersion') IS DISTINCT FROM ${coverageVersion}
          )
        FOR UPDATE`;
      const leased = targets.filter((t) => t.status === 'leased');
      if (leased.length > 0) {
        throw new Error(`refusing to seal: ${leased.length} legacy external delivery(ies) are leased by a sender — retry after the lease expires`);
      }
      const ids = targets.map((t) => t.id);
      if (ids.length) {
        await tx.outboxDelivery.updateMany({
          where: { id: { in: ids } },
          // neutralize but PRESERVE the payload (the historical push body stays for audit)
          data: { status: 'succeeded', deliveryAction: 'noop', leaseOwner: null, leaseExpiresAt: null, lastError: null },
        });
      }

      // (4) Pin the coverage version + audit. The singleton's existence is what the trigger keys on.
      await tx.outboxCutoverState.upsert({
        where: { key: 'singleton' },
        create: { key: 'singleton', coverageVersion, sealedBy: operatorIdentity, reason },
        update: { coverageVersion, sealedBy: operatorIdentity, reason },
      });
      const action = await tx.outboxOperatorAction.create({
        data: { action: 'seal-external', operatorIdentity, reason },
      });
      return { coverageVersion, auditId: action.id, neutralized: ids.length };
    }, { timeout: SEAL_TX_TIMEOUT_MS, maxWait: SEAL_TX_TIMEOUT_MS });
    this.log.warn(`external-effect cutover sealed at coverage ${result.coverageVersion} by '${operatorIdentity}' — ${result.neutralized} legacy delivery(ies) neutralized (audit ${result.auditId})`);
    return result;
  }
}
