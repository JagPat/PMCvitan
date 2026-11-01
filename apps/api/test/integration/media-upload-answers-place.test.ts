import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
import { treeLockKey } from '../../src/common/tree-lock';
import { SITE_PHOTO_DELETED_MESSAGE } from '@vitan/shared';

/**
 * #919 part 1 (Codex 4436483105) — a site photo's upload answer names the place it is filed on (null for none), on a
 * fresh upload and on a replay of its key alike. The web sends a photo whose place was removed once more without the
 * place; when the answer to that second send is lost, the phone sends the photo WITH its place again, and the key's
 * fast path answers with the stored, unplaced photo before any place check. That answer's `nodeId: null` is how the
 * phone learns the place was dropped. Reproduce-first: the answers carry no `nodeId` at the base.
 */
describe('a site photo upload answers with its place (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let token: string;
  const px = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
  const upload = (body: Record<string, unknown>) =>
    request(t.app.getHttpServer())
      .post(`/projects/${f.projectA.id}/media`)
      .set('Authorization', `Bearer ${token}`)
      .send({ mime: 'image/png', data: px, kind: 'progress', ...body });

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    token = t.issueProjectToken(f.memberUser.id, f.projectA.id, 'pmc');
  });

  afterAll(async () => {
    await t?.prisma.media.deleteMany({ where: { projectId: f.projectA.id } });
    await t?.prisma.projectNode.deleteMany({ where: { projectId: f.projectA.id, id: { startsWith: `${f.projectA.id}-answers-` } } });
    await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor'], { cascade: true });
    await f?.cleanup();
    await t?.close();
  });

  it('a placed photo is answered with its place, and its replay too', async () => {
    const room = await t.prisma.projectNode.create({
      data: { id: `${f.projectA.id}-answers-room`, projectId: f.projectA.id, name: 'room', kind: 'zone', publishedAt: new Date(), authorId: f.memberUser.id },
    });
    const first = await upload({ clientKey: 'answers-placed', nodeId: room.id });
    expect(first.status).toBe(201);
    expect(first.body.nodeId).toBe(room.id);
    const again = await upload({ clientKey: 'answers-placed', nodeId: room.id });
    expect(again.status).toBe(201);
    expect(again.body).toMatchObject({ id: first.body.id, nodeId: room.id });
  });

  it('the lost second send: a replay naming a removed place is answered by the key with the unplaced photo', async () => {
    const gone = `${f.projectA.id}-answers-gone`;
    // the first send names a place that is no longer there: refused, nothing stored for the key
    const refused = await upload({ clientKey: 'answers-dropped', nodeId: gone });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toBe('Unknown location for this project');
    // the second send, without the place: stored unplaced (its answer is the one the phone lost)
    const second = await upload({ clientKey: 'answers-dropped' });
    expect(second.status).toBe(201);
    expect(second.body.nodeId).toBeNull();
    // the phone's next send of the key still names the place: the key answers first, with the stored photo
    const replay = await upload({ clientKey: 'answers-dropped', nodeId: gone });
    expect(replay.status).toBe(201);
    expect(replay.body).toMatchObject({ id: second.body.id, nodeId: null });
    expect(await t.prisma.media.count({ where: { projectId: f.projectA.id, clientKey: 'answers-dropped' } })).toBe(1);
  });

  const waitingOn = async (lockTypes: string[], ms = 10_000): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const rows = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT COUNT(*)::bigint AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE NOT l.granted AND l.locktype = ANY($1::text[]) AND a.datname = current_database() AND l.pid <> pg_backend_pid()`, lockTypes,
      );
      if (Number(rows[0]?.n ?? 0) > 0) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return false;
  };
  /** Runs `during` under an advisory lock held until released: the project's tree lock (as a place's removal holds it)
   *  or a photo's send key (as its delete, `removeFiled`, holds it, with no tree lock). */
  const underLock = (lockKey: string, during: (q: Parameters<Parameters<TestApp['prisma']['$transaction']>[0]>[0]) => Promise<unknown>, rollback = false) => {
    let held!: () => void; const heldP = new Promise<void>((r) => { held = r; });
    let release!: () => void; const releaseP = new Promise<void>((r) => { release = r; });
    const rolledBack = new Error('rolled back');
    const done = t.prisma.$transaction(async (q) => {
      await q.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, lockKey);
      await during(q);
      held();
      await releaseP;
      if (rollback) throw rolledBack;
    }, { timeout: 30_000 }).catch((e: unknown) => { if (e !== rolledBack) throw e; });
    return { held: heldP, release, done };
  };

  // Codex 4436983883: the replay's answer reads the place under the tree lock's shared side, so a removal in flight
  // (which files the photo off the place) finishes first and the answer names no place, not the one it had.
  it('a replay while its place is being removed waits for the removal and is answered with no place', async () => {
    const room = await t.prisma.projectNode.create({
      data: { id: `${f.projectA.id}-answers-racing`, projectId: f.projectA.id, name: 'racing', kind: 'zone', publishedAt: new Date(), authorId: f.memberUser.id },
    });
    const first = await upload({ clientKey: 'answers-racing', nodeId: room.id });
    expect(first.body.nodeId).toBe(room.id);
    const removal = underLock(treeLockKey(f.projectA.id), async (q) => {
      await q.$executeRawUnsafe(`UPDATE "Media" SET "nodeId" = NULL WHERE "nodeId" = $1`, room.id);
      await q.$executeRawUnsafe(`DELETE FROM "ProjectNode" WHERE "id" = $1`, room.id);
    });
    await removal.held;
    const replaying = upload({ clientKey: 'answers-racing', nodeId: room.id }).then((r) => r);
    expect(await waitingOn(['advisory'])).toBe(true);
    removal.release();
    await removal.done;
    const replay = await replaying;
    expect(replay.status).toBe(201);
    expect(replay.body).toMatchObject({ id: first.body.id, nodeId: null });
  });

  // Stage 1 r1 fold, Codex 4437127224: the photo itself deleted while the replay waited is answered as deleted (410),
  // never as a photo saved (with or without its place). The delete holds the photo's send key, as `removeFiled` does,
  // and no tree lock; the replay takes that key first, so it waits for the delete and reads after it commits.
  it('a replay while its photo is being deleted waits and is answered as deleted, not as unplaced', async () => {
    const room = await t.prisma.projectNode.create({
      data: { id: `${f.projectA.id}-answers-deleting`, projectId: f.projectA.id, name: 'deleting', kind: 'zone', publishedAt: new Date(), authorId: f.memberUser.id },
    });
    const first = await upload({ clientKey: 'answers-deleting', nodeId: room.id });
    expect(first.body.nodeId).toBe(room.id);
    const deletion = underLock(`media-send-key:${f.projectA.id}:answers-deleting`, (q) => q.$executeRawUnsafe(`DELETE FROM "Media" WHERE "id" = $1`, first.body.id));
    await deletion.held;
    const replaying = upload({ clientKey: 'answers-deleting', nodeId: room.id }).then((r) => r);
    expect(await waitingOn(['advisory'])).toBe(true);
    deletion.release();
    await deletion.done;
    const replay = await replaying;
    expect(replay.status).toBe(410);
    expect(replay.body.message).toBe(SITE_PHOTO_DELETED_MESSAGE);
  });

  // Stage 1 r2: the other side — a delete that rolls back (refused after its DELETE, as a P2003 cited-photo refusal is)
  // leaves the photo: the replay waiting behind it is answered with the photo and its place
  it('a replay behind a photo delete that rolls back is answered with the photo, on its place', async () => {
    const room = await t.prisma.projectNode.create({
      data: { id: `${f.projectA.id}-answers-kept`, projectId: f.projectA.id, name: 'kept', kind: 'zone', publishedAt: new Date(), authorId: f.memberUser.id },
    });
    const first = await upload({ clientKey: 'answers-kept', nodeId: room.id });
    expect(first.body.nodeId).toBe(room.id);
    const deletion = underLock(`media-send-key:${f.projectA.id}:answers-kept`, (q) => q.$executeRawUnsafe(`DELETE FROM "Media" WHERE "id" = $1`, first.body.id), true);
    await deletion.held;
    const replaying = upload({ clientKey: 'answers-kept', nodeId: room.id }).then((r) => r);
    expect(await waitingOn(['advisory'])).toBe(true);
    deletion.release();
    await deletion.done;
    const replay = await replaying;
    expect(replay.status).toBe(201);
    expect(replay.body).toMatchObject({ id: first.body.id, nodeId: room.id });
    expect(await t.prisma.mediaTombstone.count({ where: { projectId: f.projectA.id, clientKey: 'answers-kept' } })).toBe(0);
  });
});
