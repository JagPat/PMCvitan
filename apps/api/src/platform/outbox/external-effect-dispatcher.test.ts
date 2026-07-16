import { describe, it, expect, vi, afterEach } from 'vitest';
import { ExternalEffectDispatcher } from './external-effect-dispatcher';
import { SOCKET_CONSUMER, PUSH_CONSUMER } from './consumers';
import type { OutboxRelay } from './relay.service';
import type { PrismaService } from '../../prisma.service';
import type { EmittedEventMeta } from './registry';

/**
 * PR C Task 2 — the single external-effect sender, in isolation.
 *
 * A command hands its committed events to `dispatchCommitted` AFTER the transaction commits. The
 * sender-mode decides WHO sends BEFORE any consumer runs, so there are never two active senders:
 *   - `outbox` → the background relay owns external dispatch; this returns immediately (no query, no send).
 *   - `legacy`/`shadow` → this dispatcher is the SOLE sender. It invalidates the socket ONCE per project
 *     across the whole committed batch (a multi-event command still invalidates once), sends one push per
 *     push-bearing delivery, and NEVER throws out of the post-commit path (durable delivery state carries
 *     the retry/dead outcome; the API result already committed).
 */

/** A committed-event meta with a bigint streamPosition (the gate: bigint never gets JSON-serialized). */
const meta = (eventId: string, over: Partial<EmittedEventMeta> = {}): EmittedEventMeta => ({
  eventId,
  eventType: 'decision.approved',
  projectId: 'p',
  organizationId: 'o',
  streamPosition: 7n,
  entityType: 'Decision',
  entityId: 'D',
  payload: null,
  dispatchIntent: { effectKey: 'decision.approved', coverageVersion: 'v', invalidate: true, push: { body: 'b', roles: ['pmc'] } },
  ...over,
});

type Delivery = { id: string; projectId: string; consumer: string };

function make(deliveries: Delivery[]) {
  const findMany = vi.fn(async () => deliveries);
  const updateMany = vi.fn(async () => ({ count: 0 }));
  const prisma = { outboxDelivery: { findMany, updateMany } } as unknown as PrismaService;
  const dispatchOne = vi.fn(async () => 'succeeded' as const);
  const claimOne = vi.fn(async () => true); // by default the immediate path wins the delivery lease
  const relay = { dispatchOne, claimOne } as unknown as OutboxRelay;
  const dispatcher = new ExternalEffectDispatcher(prisma, relay);
  return { dispatcher, findMany, updateMany, dispatchOne, claimOne };
}

afterEach(() => {
  delete process.env.OUTBOX_SENDER_MODE;
});

describe('ExternalEffectDispatcher — the single post-commit external sender', () => {
  it('outbox mode: returns immediately — never queries deliveries, never invokes the relay (the relay owns it)', async () => {
    process.env.OUTBOX_SENDER_MODE = 'outbox';
    const { dispatcher, findMany, dispatchOne } = make([{ id: 's1', projectId: 'p', consumer: SOCKET_CONSUMER }]);
    await dispatcher.dispatchCommitted([meta('e1')]);
    expect(findMany).not.toHaveBeenCalled();
    expect(dispatchOne).not.toHaveBeenCalled();
  });

  it('empty events: a no-op — no query, no send', async () => {
    const { dispatcher, findMany, dispatchOne } = make([]);
    await dispatcher.dispatchCommitted([]);
    expect(findMany).not.toHaveBeenCalled();
    expect(dispatchOne).not.toHaveBeenCalled();
  });

  it('legacy mode: a MULTI-EVENT command invalidates the socket ONCE per project and marks the rest succeeded', async () => {
    // two committed events → two socket dispatch deliveries for the SAME project
    const { dispatcher, dispatchOne, updateMany } = make([
      { id: 's1', projectId: 'p', consumer: SOCKET_CONSUMER },
      { id: 's2', projectId: 'p', consumer: SOCKET_CONSUMER },
    ]);
    await dispatcher.dispatchCommitted([meta('e1'), meta('e2')]);
    // exactly ONE socket send (the head); the rest are neutralized to succeeded (no second emit)
    expect(dispatchOne).toHaveBeenCalledTimes(1);
    expect(dispatchOne).toHaveBeenCalledWith('s1');
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ['s2'] }, status: 'pending' }, data: expect.objectContaining({ status: 'succeeded' }) }));
  });

  it('legacy mode: TWO projects each get their own single socket invalidation', async () => {
    const { dispatcher, dispatchOne, updateMany } = make([
      { id: 'a1', projectId: 'pa', consumer: SOCKET_CONSUMER },
      { id: 'b1', projectId: 'pb', consumer: SOCKET_CONSUMER },
    ]);
    await dispatcher.dispatchCommitted([meta('e1', { projectId: 'pa' }), meta('e2', { projectId: 'pb' })]);
    expect(dispatchOne).toHaveBeenCalledTimes(2);
    expect(dispatchOne).toHaveBeenCalledWith('a1');
    expect(dispatchOne).toHaveBeenCalledWith('b1');
    // neither project had extra socket rows to neutralize
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('legacy mode: each push-bearing delivery dispatches once (a command carries at most one push by catalog design)', async () => {
    const { dispatcher, dispatchOne } = make([
      { id: 's1', projectId: 'p', consumer: SOCKET_CONSUMER },
      { id: 'w1', projectId: 'p', consumer: PUSH_CONSUMER },
    ]);
    await dispatcher.dispatchCommitted([meta('e1')]);
    expect(dispatchOne).toHaveBeenCalledWith('s1'); // socket
    expect(dispatchOne).toHaveBeenCalledWith('w1'); // push
    expect(dispatchOne).toHaveBeenCalledTimes(2);
  });

  it('legacy mode: the lease is claimed BEFORE the send (immediate path is lease-coordinated)', async () => {
    const { dispatcher, dispatchOne, claimOne } = make([{ id: 's1', projectId: 'p', consumer: SOCKET_CONSUMER }]);
    await dispatcher.dispatchCommitted([meta('e1')]);
    expect(claimOne).toHaveBeenCalledWith('s1');
    expect(dispatchOne).toHaveBeenCalledWith('s1');
  });

  it('mixed-mode: when the relay already owns the lease (claimOne loses), the dispatcher does NOT send — exactly one sender', async () => {
    const { dispatcher, dispatchOne, claimOne } = make([{ id: 's1', projectId: 'p', consumer: SOCKET_CONSUMER }]);
    (claimOne as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(false); // an outbox-mode relay claimed it first
    await dispatcher.dispatchCommitted([meta('e1')]);
    expect(claimOne).toHaveBeenCalledWith('s1');
    expect(dispatchOne).not.toHaveBeenCalled(); // the relay will send it — no double-send across a rolling cutover
  });

  it('a provider failure NEVER throws out of the post-commit path (durable state carries the outcome)', async () => {
    const { dispatcher, dispatchOne } = make([{ id: 's1', projectId: 'p', consumer: SOCKET_CONSUMER }]);
    (dispatchOne as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('web push endpoint gone'));
    await expect(dispatcher.dispatchCommitted([meta('e1')])).resolves.toBeUndefined();
  });

  it('a transient DB error in the post-commit query NEVER throws out (the already-committed command stays successful)', async () => {
    const { dispatcher, findMany } = make([{ id: 's1', projectId: 'p', consumer: SOCKET_CONSUMER }]);
    (findMany as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('connection reset'));
    await expect(dispatcher.dispatchCommitted([meta('e1')])).resolves.toBeUndefined();
  });

  it('shadow mode still sends exactly once (the plan-vs-catalog comparison is diagnostics only, never a second send)', async () => {
    process.env.OUTBOX_SENDER_MODE = 'shadow';
    const { dispatcher, dispatchOne } = make([{ id: 's1', projectId: 'p', consumer: SOCKET_CONSUMER }]);
    await dispatcher.dispatchCommitted([meta('e1')]);
    expect(dispatchOne).toHaveBeenCalledTimes(1);
  });

  it('bigint stream positions pass through untouched — the query keys on the event ids, never a serialized position', async () => {
    const { dispatcher, findMany } = make([]);
    await dispatcher.dispatchCommitted([meta('e1', { streamPosition: 9007199254740993n }), meta('e2', { streamPosition: 9007199254740994n })]);
    // the deliveries are looked up by eventId (in-process); the bigint positions are never serialized
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ eventId: { in: ['e1', 'e2'] } }) }));
  });
});
