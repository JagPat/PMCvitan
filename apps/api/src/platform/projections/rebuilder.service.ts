import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { getConsumer, outboxSenderMode, type EmittedEventMeta, type OutboxConsumer, type ProjectionTarget } from '../outbox/registry';
import { metaFromEvent } from '../outbox/relay.service';

/**
 * Phase 2 Task 9 — the projection REBUILDER: build a fresh read-model generation online and swap it
 * in behind a FINAL ACTIVATION BARRIER, with zero handoff gap.
 *
 * Protocol (per project):
 *   1. Allocate a new `building` generation (generation = max + 1) for `(consumer, projectId)`.
 *   2. SEED it from the module's consistent canonical snapshot (`rebuildSeed`, optional) — its rows
 *      reflect state as of some position S; set the generation's checkpoint to S. (No seed → S = ∅,
 *      replay from position 0.)
 *   3. CATCH-UP (no lock): replay events (S+1 .. current max) into the generation, one short
 *      transaction per event, so the lock is never held during the bulk of the work.
 *   4. BARRIER (lock held): acquire the `ProjectEventStream` lock — this BLOCKS every new `emitEvent`
 *      for the project (emit increments that same row) — read the final position **H** (= nextPosition
 *      − 1: while the lock is held, every position < nextPosition is committed and visible), apply the
 *      residual tail (checkpoint+1 .. H) into the generation, then ATOMICALLY set it `active` with
 *      `appliedPosition = H` and retire the previously-active generation, before releasing the lock.
 *   5. Every event allocated AFTER the barrier releases gets a position > H and — because the new
 *      generation is now the active one — is delivered by the relay INTO IT, never the retired one.
 *
 * Dedup is per generation on `(consumer, generation, streamPosition)`: a generation has a SINGLE
 * writer at any instant (this rebuilder while `building`, the relay once `active`; the barrier hands
 * off in one transaction), and `appliedPosition` is the contiguous high-water mark, so an event
 * applied by both a rebuild replay and a live relay delivery is idempotent (the later apply sees
 * position ≤ `appliedPosition` and skips). The activation is provably lossless: events ≤ H are in the
 * generation via the replay, events > H arrive via the relay, and the boundary event H is deduped.
 *
 * Cross-project rebuilds (e.g. a portfolio projection) call {@link rebuild} PER PROJECT, so each
 * project's barrier locks only its own stream row — no multi-row lock, no deadlock ordering to
 * reason about.
 */

const REPLAY_BATCH = 500;

export interface RebuildResult {
  generationId: string;
  generation: number;
  /** The activation-barrier position: the generation is complete through here and its checkpoint
   *  equals it. `null` when the project had no events at activation. */
  checkpoint: bigint | null;
}

@Injectable()
export class ProjectionRebuilder {
  /** TEST-ONLY seam: a callback invoked INSIDE the barrier transaction, after H is read and while the
   *  `ProjectEventStream` lock is held — used to prove that a write attempted at that instant blocks
   *  until the barrier commits and then lands in the new generation (> H). Never set in production. */
  barrierHook: ((h: bigint) => Promise<void>) | null = null;

  constructor(private readonly prisma: PrismaService) {}

  /** The currently-serving generation for a projection (no lock). `null` before first initialisation. */
  async activeGeneration(consumer: string, projectId: string) {
    return this.prisma.projectionGeneration.findFirst({ where: { consumer, projectId, status: 'active' } });
  }

  /**
   * Rebuild `consumer`'s projection for one project: build a fresh generation and activate it behind
   * the final barrier. Returns the new generation + its activation checkpoint (== H).
   */
  async rebuild(consumerName: string, projectId: string): Promise<RebuildResult> {
    const consumer = getConsumer(consumerName);
    if (!consumer?.projection) throw new Error(`${consumerName} is not a registered projection consumer`);
    const spec = consumer.projection;

    // 1. allocate a new BUILDING generation (generation = max + 1)
    const gNew = await this.prisma.$transaction(async (tx) => {
      const agg = await tx.projectionGeneration.aggregate({ where: { consumer: consumerName, projectId }, _max: { generation: true } });
      const generation = (agg._max.generation ?? 0) + 1;
      return tx.projectionGeneration.create({
        data: { consumer: consumerName, projectId, generation, status: 'building', appliedPosition: null },
        select: { id: true, generation: true },
      });
    });
    const target: ProjectionTarget = { generationId: gNew.id, generation: gNew.generation, projectId };

    // 2. SEED from the canonical snapshot (optional). Its rows reflect state as of `seededThrough`;
    //    set the generation checkpoint there so replay resumes at the next position.
    if (spec.rebuildSeed) {
      const seededThrough = await this.prisma.$transaction((tx) => spec.rebuildSeed!(tx, target));
      await this.prisma.projectionGeneration.update({ where: { id: gNew.id }, data: { appliedPosition: seededThrough } });
    }

    // 3. CATCH-UP (no lock): replay events into the generation until it reaches the current head.
    await this.catchUp(consumer, target);

    // 4. BARRIER (lock held): read H, apply the tail, activate + retire atomically.
    const checkpoint = await this.prisma.$transaction(async (tx) => {
      // Lock the stream row — every new emitEvent for this project blocks on this same row until we
      // commit, so H is the final position and no event ≤ H is still uncommitted.
      const streamRows = await tx.$queryRaw<{ nextPosition: bigint }[]>`
        SELECT "nextPosition" FROM "ProjectEventStream" WHERE "projectId" = ${projectId} FOR UPDATE`;
      const nextPosition = streamRows[0]?.nextPosition ?? 0n;
      const h = nextPosition - 1n; // last committed position; < 0 ⇒ the project has no events

      if (this.barrierHook) await this.barrierHook(h);

      // apply the residual tail (checkpoint+1 .. H) into the generation within THIS transaction
      if (h >= 0n) await this.replayInto(tx, consumer, target, h);

      // atomic swap: retire the previously-active generation, activate the new one at checkpoint H
      const prev = await tx.projectionGeneration.findFirst({ where: { consumer: consumerName, projectId, status: 'active' } });
      if (prev && prev.id !== gNew.id) {
        await tx.projectionGeneration.update({ where: { id: prev.id }, data: { status: 'retired' } });
      }
      await tx.projectionGeneration.update({
        where: { id: gNew.id },
        data: { status: 'active', appliedPosition: h < 0n ? null : h, cursorStatus: 'live', activatedAt: new Date() },
      });
      return h < 0n ? null : h;
    });

    return { generationId: gNew.id, generation: gNew.generation, checkpoint };
  }

  /**
   * Drop every RETIRED generation's rows + records for a projection/project (best-effort cleanup,
   * DECOUPLED from {@link rebuild} on purpose). A retired generation is already invisible to serving
   * — reads target the active generation's id — so dropping it is a background chore an operator or
   * scheduler runs after the new generation is confirmed healthy, never inside the activation path
   * where it could race a still-committing relay delivery to the just-retired generation. A failure
   * here never un-does an activation.
   */
  async dropRetiredGenerations(consumerName: string, projectId: string): Promise<number> {
    const consumer = getConsumer(consumerName);
    if (!consumer?.projection) throw new Error(`${consumerName} is not a registered projection consumer`);
    const stale = await this.prisma.projectionGeneration.findMany({ where: { consumer: consumerName, projectId, status: 'retired' } });
    for (const g of stale) {
      await this.prisma.$transaction(async (tx) => {
        if (consumer.projection?.dropGeneration) {
          await consumer.projection.dropGeneration(tx, { generationId: g.id, generation: g.generation, projectId });
        }
        await tx.projectionGeneration.delete({ where: { id: g.id } });
      });
    }
    return stale.length;
  }

  /** Replay events into a building generation until it reaches the current head — one short
   *  transaction per event (no long-held lock), stopping when no further event exists. */
  private async catchUp(consumer: OutboxConsumer, target: ProjectionTarget): Promise<void> {
    for (;;) {
      const gen = await this.prisma.projectionGeneration.findUniqueOrThrow({ where: { id: target.generationId } });
      const from = gen.appliedPosition === null ? 0n : gen.appliedPosition + 1n;
      const events = await this.prisma.domainEvent.findMany({
        where: { projectId: target.projectId, streamPosition: { gte: from } },
        orderBy: { streamPosition: 'asc' },
        take: REPLAY_BATCH,
      });
      if (!events.length) return;
      for (const ev of events) {
        await this.prisma.$transaction((tx) => this.applyEvent(tx, consumer, target, ev));
      }
    }
  }

  /** Apply every event in (checkpoint .. h] into the generation, in order, within the caller's
   *  transaction (the barrier's). Events are contiguous, so this closes the gap exactly to H. */
  private async replayInto(tx: Prisma.TransactionClient, consumer: OutboxConsumer, target: ProjectionTarget, h: bigint): Promise<void> {
    const gen = await tx.projectionGeneration.findUniqueOrThrow({ where: { id: target.generationId } });
    let from = gen.appliedPosition === null ? 0n : gen.appliedPosition + 1n;
    while (from <= h) {
      const events = await tx.domainEvent.findMany({
        where: { projectId: target.projectId, streamPosition: { gte: from, lte: h } },
        orderBy: { streamPosition: 'asc' },
        take: REPLAY_BATCH,
      });
      if (!events.length) break;
      for (const ev of events) await this.applyEvent(tx, consumer, target, ev);
      from = events[events.length - 1].streamPosition + 1n;
    }
  }

  /** Apply ONE event into the building generation (contiguous, idempotent): skip if the checkpoint is
   *  already past it, otherwise invoke the projection handler (for a `dispatch` plan) and advance the
   *  checkpoint. The generation row is locked `FOR UPDATE` so this is safe under any concurrency. */
  private async applyEvent(
    tx: Prisma.TransactionClient,
    consumer: OutboxConsumer,
    target: ProjectionTarget,
    event: DomainEventRow,
  ): Promise<void> {
    const rows = await tx.$queryRaw<{ appliedPosition: bigint | null }[]>`
      SELECT "appliedPosition" FROM "ProjectionGeneration" WHERE "id" = ${target.generationId} FOR UPDATE`;
    const applied = rows[0]?.appliedPosition ?? null;
    const nextExpected = applied === null ? 0n : applied + 1n;
    if (event.streamPosition < nextExpected) return; // already reflected — idempotent replay
    if (event.streamPosition > nextExpected) {
      // events are contiguous per project, so a gap here is a real invariant breach, not a wait state
      throw new Error(`replay gap for ${consumer.name}/${target.projectId}: expected ${nextExpected}, got ${event.streamPosition}`);
    }
    const meta: EmittedEventMeta = metaFromEvent(event);
    if (consumer.deliveryFor(meta).action === 'dispatch') {
      await consumer.handle({
        delivery: { id: `(rebuild:${target.generationId})`, consumer: consumer.name, projectId: target.projectId, streamPosition: event.streamPosition, payload: event.payload },
        meta,
        senderMode: outboxSenderMode(),
        tx,
        projection: target,
      });
    }
    await tx.projectionGeneration.update({ where: { id: target.generationId }, data: { appliedPosition: event.streamPosition } });
  }
}

interface DomainEventRow {
  eventId: string;
  eventType: string;
  projectId: string;
  organizationId: string;
  streamPosition: bigint;
  entityType: string;
  entityId: string;
  payload: Prisma.JsonValue | null;
  dispatchIntent: Prisma.JsonValue | null;
}
