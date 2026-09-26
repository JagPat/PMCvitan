import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { emitEvent, type EmitInput } from '../../src/platform/events';
import type { EventActor } from '../../src/common/actor';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * Phase 6 task 4d unit 4d-ii-a / A1 — the actor ENVELOPE `emitEvent` writes, proven against live
 * PostgreSQL and 4d-i's `DomainEvent_t4d_envelope` seal.
 *
 * `emitEvent` resolves the frozen `actorRole`/`actorName` pair inside the emitting transaction
 * (`platform/actor-envelope.ts`, §A.3 obligation 3):
 * - the role is the token role, written only when the seal's own `platform_user_holds_role_windowed`
 *   admits it;
 * - the name is read from `UserIdentity` under `FOR UPDATE`, never taken from the `Actor`.
 * Anything the seal would not admit leaves the pair NULL, which the seal admits, so writing the
 * envelope introduces no refusal on a delivered path.
 */
describe('4d-ii-a / A1 — the actor envelope (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
  });
  afterAll(async () => {
    await sanctionedReset(t?.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor'], { cascade: true });
    await f?.cleanup();
    await t?.close();
  });

  const human = (actorId: string, actorRole: string): EventActor => ({ actorId, actorRole, actorKind: 'human' });

  /** One broadcast event with no fact behind it (the same neutral key the envelope suite uses). */
  const input = (actor: EventActor, over: Partial<EmitInput> = {}): EmitInput => ({
    projectId: f.projectA.id, actor, eventType: 'activity.completion_requested', entityType: 'Activity',
    entityId: `A1-${randomUUID()}`, effectKey: 'activity.completion_requested',
    dispatch: { push: { body: 'completion requested' } }, ...over,
  });

  const emit = (actor: EventActor, over: Partial<EmitInput> = {}) =>
    t.prisma.$transaction((tx) => emitEvent(tx, input(actor, over)));

  const envelopeOf = async (eventId: string) => {
    const ev = await t.prisma.domainEvent.findUniqueOrThrow({
      where: { eventId }, select: { actorRole: true, actorName: true, actorId: true, actorKind: true },
    });
    return ev;
  };

  const identityName = async (userId: string) =>
    (await t.prisma.$queryRawUnsafe<Array<{ displayName: string }>>(
      `SELECT "displayName" FROM "UserIdentity" WHERE "userId" = $1`, userId,
    ))[0]?.displayName;

  it('writes the pair for an active member acting in the role they hold, the name from UserIdentity', async () => {
    const { eventId } = await emit(human(f.memberUser.id, 'pmc'));
    const ev = await envelopeOf(eventId);
    expect(ev.actorRole).toBe('pmc');
    expect(ev.actorName).toBe(await identityName(f.memberUser.id));
    expect(ev.actorName, 'the fixture user has an identity row, so the pair is non-null').toBeTruthy();
  });

  it('writes the pair for a client member acting as client', async () => {
    const { eventId } = await emit(human(f.clientUser.id, 'client'));
    const ev = await envelopeOf(eventId);
    expect(ev).toMatchObject({ actorRole: 'client', actorName: await identityName(f.clientUser.id) });
  });

  it('admits a membership-less org owner acting as pmc (the owner/admin arm)', async () => {
    const { eventId } = await emit(human(f.ownerUser.id, 'pmc'));
    const ev = await envelopeOf(eventId);
    expect(ev).toMatchObject({ actorRole: 'pmc', actorName: await identityName(f.ownerUser.id) });
  });

  it('writes NO pair for a token role the actor does not hold, and never substitutes the role they do hold', async () => {
    // The client member claims `pmc` (a stale or wrong token role): the seal would refuse `pmc`,
    // and writing `client` instead would attribute the act to a standing it was not performed in.
    const { eventId } = await emit(human(f.clientUser.id, 'pmc'));
    const ev = await envelopeOf(eventId);
    expect(ev.actorId).toBe(f.clientUser.id);
    expect(ev.actorRole).toBeNull();
    expect(ev.actorName).toBeNull();
  });

  it('writes NO pair for an actor with no standing on the project (another tenant, a stranger)', async () => {
    for (const actorId of [f.otherUser.id, f.strangerUser.id]) {
      const { eventId } = await emit(human(actorId, 'pmc'));
      const ev = await envelopeOf(eventId);
      expect(ev.actorId).toBe(actorId);
      expect([ev.actorRole, ev.actorName]).toEqual([null, null]);
    }
  });

  it('writes NO pair for a system actor or a blank role', async () => {
    const system = await emit({ actorId: 'system:a1-probe', actorRole: 'system', actorKind: 'system' });
    expect(await envelopeOf(system.eventId)).toMatchObject({ actorKind: 'system', actorRole: null, actorName: null });
    const blank = await emit(human(f.memberUser.id, '  '));
    expect(await envelopeOf(blank.eventId)).toMatchObject({ actorRole: null, actorName: null });
  });

  it('takes the name from UserIdentity inside the transaction, not from a pre-transaction read', async () => {
    // A rename that commits between `resolveActor` and the emitting transaction: the actor object
    // carries no name at all now, and the event must freeze the name true at the act.
    const renamed = `Renamed ${randomUUID().slice(0, 8)}`;
    await t.prisma.user.update({ where: { id: f.memberUser.id }, data: { name: renamed } });
    const { eventId } = await emit(human(f.memberUser.id, 'pmc'));
    expect((await envelopeOf(eventId)).actorName).toBe(renamed);
  });

  /** A promise that can be resolved from outside, to hold a transaction open at a known point. */
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    return { promise, resolve };
  };

  it('the held-rename barrier: a rename that commits FIRST is the name the event freezes', async () => {
    const before = await identityName(f.memberUser.id);
    const renamed = `First ${randomUUID().slice(0, 8)}`;
    const renameHeld = deferred();
    const releaseRename = deferred();
    // The rename holds its UserIdentity row (written by the orgs identity trigger) until released.
    const rename = t.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: f.memberUser.id }, data: { name: renamed } });
      renameHeld.resolve();
      await releaseRename.promise;
    }, { timeout: 20_000 });
    await renameHeld.promise;
    // The emit blocks on the locked identity row; release the rename, and the emit then reads it.
    let emitDone = false;
    const emitting = emit(human(f.memberUser.id, 'pmc')).finally(() => { emitDone = true; });
    await new Promise((r) => setTimeout(r, 300));
    expect(emitDone, 'the emit is still waiting on the identity row the uncommitted rename holds').toBe(false);
    releaseRename.resolve();
    await rename;
    const { eventId } = await emitting;
    expect(before).not.toBe(renamed);
    expect((await envelopeOf(eventId)).actorName).toBe(renamed);
  });

  it('the held-rename barrier: an emit that locks FIRST freezes the name true at its act, and the rename waits', async () => {
    const before = await identityName(f.memberUser.id);
    const renamed = `Second ${randomUUID().slice(0, 8)}`;
    const emitted = deferred();
    const releaseEmit = deferred();
    let eventId = '';
    const emitting = t.prisma.$transaction(async (tx) => {
      ({ eventId } = await emitEvent(tx, input(human(f.memberUser.id, 'pmc'))));
      emitted.resolve();
      await releaseEmit.promise;
    }, { timeout: 20_000 });
    await emitted.promise;
    let renameDone = false;
    const rename = t.prisma.user.update({ where: { id: f.memberUser.id }, data: { name: renamed } })
      .finally(() => { renameDone = true; });
    await new Promise((r) => setTimeout(r, 300));
    // The completion barrier (#641 Codex finding 4111320926): the rename cannot finish while the
    // event's transaction holds the identity row, so a regression of that lock fails here.
    expect(renameDone, 'the rename is still waiting on the identity row the emitting transaction holds').toBe(false);
    releaseEmit.resolve();
    await emitting;
    await rename;
    expect((await envelopeOf(eventId)).actorName).toBe(before);
    expect(await identityName(f.memberUser.id)).toBe(renamed);
  });

  it('a supplied eventId is the id the event is written under; a non-UUID one is refused before any write', async () => {
    const eventId = randomUUID();
    const meta = await emit(human(f.memberUser.id, 'pmc'), { eventId });
    expect(meta.eventId).toBe(eventId);
    expect(await t.prisma.domainEvent.count({ where: { eventId } })).toBe(1);

    const positionBefore = (await t.prisma.projectEventStream.findUniqueOrThrow({ where: { projectId: f.projectA.id } })).nextPosition;
    await expect(emit(human(f.memberUser.id, 'pmc'), { eventId: 'not-a-uuid' })).rejects.toThrow(/not a UUID/);
    const positionAfter = (await t.prisma.projectEventStream.findUniqueOrThrow({ where: { projectId: f.projectA.id } })).nextPosition;
    expect(positionAfter, 'the refusal allocated no stream position').toBe(positionBefore);
  });
});
