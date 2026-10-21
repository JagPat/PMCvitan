import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { GoneException } from '@nestjs/common';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
import { MediaService } from '../../src/media/media.service';
import { StorageService } from '../../src/media/storage.service';
import type { AuthUser } from '../../src/common/auth';

/**
 * #482 site photos — a deleted photo stays deleted (#1011 review, r4322976235). A copy of a photo's send still queued
 * on another device used to find no row for its key once the photo was deleted, and stored the photo again. The delete
 * now writes the key's record (`MediaTombstone`, 20280117) in its own transaction, under the key's lock, and a later
 * send of that key is answered 410 "This photo was deleted" and stores nothing. Reproduce-first: on the base the
 * replays below create the photo again.
 */
describe('a deleted photo stays deleted (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let media: MediaService;
  let storage: StorageService;
  const contractorId = () => `${f.projectA.id}-tomb-contractor`;
  const px = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
  let seq = 0;
  const key = () => `tomb-${Date.now()}-${++seq}`;

  const contractor = (): AuthUser => ({ sub: contractorId(), role: 'contractor', projectId: f.projectA.id }) as AuthUser;
  const pmc = (projectId = f.projectA.id): AuthUser =>
    ({ sub: projectId === f.projectA.id ? f.memberUser.id : f.otherUser.id, role: 'pmc', projectId }) as AuthUser;
  const sitePhoto = (user: AuthUser, clientKey?: string) =>
    media.create(user.projectId, user, { kind: 'progress', mime: 'image/png', data: px, ...(clientKey ? { clientKey } : {}) } as never);
  const rowsFor = (clientKey: string, projectId = f.projectA.id) => t.prisma.media.count({ where: { projectId, clientKey } });
  const recorded = async (clientKey: string, projectId = f.projectA.id) =>
    (await t.prisma.mediaTombstone.count({ where: { projectId, clientKey } })) === 1;
  const uploadedEvents = () => t.prisma.domainEvent.count({ where: { projectId: f.projectA.id, eventType: 'media.uploaded' } });
  const lockSql = `SELECT pg_advisory_xact_lock(hashtextextended('media-send-key:' || $1 || ':' || $2, 0))`;
  const advisoryWaiters = async () => (await t.prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory' AND NOT l.granted AND a.datname = current_database()`))[0]!.n;
  const until = async (cond: () => Promise<boolean>) => {
    for (let i = 0; i < 200; i++) { if (await cond()) return; await new Promise((r) => setTimeout(r, 25)); }
    throw new Error('timed out waiting for the lock wait');
  };
  /** A transaction that holds the key's lock until `release()` is called. */
  const holdKey = (clientKey: string, then?: (tx: Parameters<Parameters<TestApp['prisma']['$transaction']>[0]>[0]) => Promise<unknown>) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held!: () => void;
    const holding = new Promise<void>((r) => { held = r; });
    const done = t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(lockSql, f.projectA.id, clientKey);
      held();
      await gate;
      if (then) await then(tx);
    }, { timeout: 30_000 });
    return { holding, release, done };
  };

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    media = t.app.get(MediaService);
    storage = t.app.get(StorageService);
    await t.prisma.user.create({ data: { id: contractorId(), projectId: f.projectA.id, role: 'contractor', name: 'Ravi Patel', email: `${contractorId()}@test.local` } });
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: contractorId(), role: 'contractor', status: 'active' } });
  });

  afterEach(() => vi.restoreAllMocks());

  afterAll(async () => {
    await t?.prisma.inspectionEvidence.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
    await t?.prisma.media.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
    await t?.prisma.inspectionItem.deleteMany({ where: { inspection: { projectId: f.projectA.id } } });
    await t?.prisma.inspection.deleteMany({ where: { projectId: f.projectA.id } });
    await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor', 'MembershipTransition'], { cascade: true });
    await t?.prisma.membership.deleteMany({ where: { userId: contractorId() } });
    await t?.prisma.user.deleteMany({ where: { id: contractorId() } });
    // the fixture's project delete takes the records with it
    await f?.cleanup();
    await t?.close();
  });

  it('a member\'s own photo, deleted within the hour, is not stored again by a later send of its key', async () => {
    const k = key();
    const sent = await sitePhoto(contractor(), k);
    expect(await media.removeFiled(sent.id, contractor())).not.toBeNull();
    expect(await recorded(k)).toBe(true);
    const put = vi.spyOn(storage, 'put');
    const events = await uploadedEvents();
    const late = sitePhoto(contractor(), k);
    await expect(late).rejects.toBeInstanceOf(GoneException);
    await expect(late).rejects.toThrow('This photo was deleted');
    expect(put).not.toHaveBeenCalled();
    expect(await rowsFor(k)).toBe(0);
    expect(await uploadedEvents()).toBe(events);
  });

  it('inspection evidence the PMC deleted is not stored, or linked, again by a later send of its key', async () => {
    const inspectionId = `${f.projectA.id}-tomb-insp`;
    await t.prisma.inspection.create({ data: { id: inspectionId, projectId: f.projectA.id, kind: 'review', title: 'Slab check', zone: 'Zone A', date: '20 Oct' } });
    const item = await t.prisma.inspectionItem.create({ data: { inspectionId, name: 'Cover' } });
    const k = key();
    const evidence = () => media.create(f.projectA.id, pmc(), { kind: 'inspection', mime: 'image/png', data: px, inspectionId, inspectionItemId: item.id, clientKey: k } as never);
    const sent = await evidence();
    expect(await t.prisma.inspectionEvidence.count({ where: { mediaId: sent.id } })).toBe(1);
    expect(await media.removeFiled(sent.id, pmc())).not.toBeNull();
    await expect(evidence()).rejects.toBeInstanceOf(GoneException);
    expect(await rowsFor(k)).toBe(0);
    expect(await t.prisma.inspectionEvidence.count({ where: { inspectionItemId: item.id } })).toBe(0);
  });

  it('a send whose bytes were stored while its photo was being deleted gets 410, and leaves no stored object', async () => {
    const k = key();
    const realPut = storage.put.bind(storage);
    let replayObject: string | undefined;
    // the late copy reads before the original lands, so it stores its bytes; meanwhile the original commits and is
    // deleted, and the late copy's transaction then finds the record under the key's lock
    vi.spyOn(storage, 'put').mockImplementationOnce(async (objectKey, bytes, mime) => {
      replayObject = objectKey;
      const original = await sitePhoto(contractor(), k);
      await media.removeFiled(original.id, contractor());
      return realPut(objectKey, bytes, mime);
    });
    const remove = vi.spyOn(storage, 'remove');
    await expect(sitePhoto(contractor(), k)).rejects.toBeInstanceOf(GoneException);
    expect(replayObject).toBeDefined();
    expect(remove).toHaveBeenCalledWith(replayObject);
    expect(await rowsFor(k)).toBe(0);
    expect(await t.prisma.media.count({ where: { storageKey: replayObject } })).toBe(0);
    expect(await recorded(k)).toBe(true);
  });

  it('a send waits on the key\'s lock, and then sees the record written under it', async () => {
    const k = key();
    const hold = holdKey(k, (tx) => tx.mediaTombstone.create({ data: { projectId: f.projectA.id, clientKey: k } }));
    await hold.holding;
    const waiting = await advisoryWaiters();
    const late = sitePhoto(contractor(), k);
    late.catch(() => undefined);
    await until(async () => (await advisoryWaiters()) > waiting);
    hold.release();
    await hold.done;
    await expect(late).rejects.toBeInstanceOf(GoneException);
    expect(await rowsFor(k)).toBe(0);
  });

  it('a delete waits on the key\'s lock, and writes the record once it has it', async () => {
    const k = key();
    const sent = await sitePhoto(contractor(), k);
    const hold = holdKey(k);
    await hold.holding;
    const waiting = await advisoryWaiters();
    const removing = media.removeFiled(sent.id, contractor());
    removing.catch(() => undefined);
    await until(async () => (await advisoryWaiters()) > waiting);
    expect(await recorded(k)).toBe(false);
    hold.release();
    await hold.done;
    expect(await removing).not.toBeNull();
    expect(await recorded(k)).toBe(true);
    await expect(sitePhoto(contractor(), k)).rejects.toBeInstanceOf(GoneException);
  });

  it('a photo sent without a key leaves no record, and a key is retired only in its own project', async () => {
    const before = await t.prisma.mediaTombstone.count({ where: { projectId: f.projectA.id } });
    const plain = await sitePhoto(contractor());
    await media.removeFiled(plain.id, contractor());
    expect(await t.prisma.mediaTombstone.count({ where: { projectId: f.projectA.id } })).toBe(before);

    const k = key();
    const sent = await sitePhoto(contractor(), k);
    await media.removeFiled(sent.id, contractor());
    const elsewhere = await sitePhoto(pmc(f.projectB.id), k);
    expect(elsewhere.id).toBeTruthy();
    expect(await rowsFor(k, f.projectB.id)).toBe(1);
  });

  it('a delete of a keyed photo succeeds and leaves exactly one record (the database\'s, not a second write)', async () => {
    const k = key();
    const sent = await sitePhoto(contractor(), k);
    expect(await media.removeFiled(sent.id, contractor())).not.toBeNull();
    expect(await t.prisma.mediaTombstone.count({ where: { projectId: f.projectA.id, clientKey: k } })).toBe(1);
  });

  it('a send that loses its key to a copy deleted before it can be read is answered 410 on the record, keeping nothing', async () => {
    const k = key();
    const realPut = storage.put.bind(storage);
    let ours: string | undefined;
    let winnerId: string | undefined;
    // after this send's quick read, another copy of the same send lands first (no key lock: a release before this one)
    vi.spyOn(storage, 'put').mockImplementationOnce(async (objectKey, bytes, mime) => {
      ours = objectKey;
      winnerId = (await t.prisma.media.create({ data: {
        projectId: f.projectA.id, kind: 'progress', mime: 'image/png', data: Buffer.from('abc'), sizeBytes: 3, uploadedBy: contractorId(), clientKey: k,
      } })).id;
      return realPut(objectKey, bytes, mime);
    });
    // the read of the winner after the conflict: the winner is deleted just before it, so it reads nothing
    const realFind = t.prisma.media.findUnique.bind(t.prisma.media);
    vi.spyOn(t.prisma.media, 'findUnique').mockImplementation((async (args: { where?: { projectId_clientKey?: { clientKey?: string } } }) => {
      if (winnerId && args?.where?.projectId_clientKey?.clientKey === k) {
        await t.prisma.$executeRawUnsafe(`DELETE FROM "Media" WHERE "id" = $1`, winnerId);
        winnerId = undefined;
      }
      return realFind(args as never);
    }) as never);
    const remove = vi.spyOn(storage, 'remove');
    await expect(sitePhoto(contractor(), k)).rejects.toBeInstanceOf(GoneException);
    expect(winnerId).toBeUndefined();
    expect(await rowsFor(k)).toBe(0);
    expect(remove).toHaveBeenCalledWith(ours);
  });

  it('a send whose insert waits behind a delete that takes no key lock is refused once that delete commits', async () => {
    const k = key();
    const realPut = storage.put.bind(storage);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let held!: () => void;
    const holding = new Promise<void>((r) => { held = r; });
    let deleting: Promise<unknown> = Promise.resolve();
    const txWaiters = async () => (await t.prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'transactionid' AND NOT l.granted AND a.datname = current_database()`))[0]!.n;
    // after this send's quick read: a copy of the same key commits on another connection, and a delete of it with no
    // key lock (a release before this one) is opened on a third and held
    vi.spyOn(storage, 'put').mockImplementationOnce(async (objectKey, bytes, mime) => {
      const first = await t.prisma.media.create({ data: {
        projectId: f.projectA.id, kind: 'progress', mime: 'image/png', data: Buffer.from('abc'), sizeBytes: 3, uploadedBy: contractorId(), clientKey: k,
      } });
      deleting = t.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`DELETE FROM "Media" WHERE "id" = $1`, first.id);
        held();
        await gate;
      }, { timeout: 30_000 });
      await holding;
      return realPut(objectKey, bytes, mime);
    });
    const before = await txWaiters();
    const sending = sitePhoto(contractor(), k);
    sending.catch(() => undefined);
    // the send holds the key's lock, finds no record yet, and its insert waits on the unique for the open delete
    await until(async () => (await txWaiters()) > before);
    release();
    await deleting;
    await expect(sending).rejects.toBeInstanceOf(GoneException);
    expect(await rowsFor(k)).toBe(0);
    expect(await recorded(k)).toBe(true);
  });
});
