import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

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
});
