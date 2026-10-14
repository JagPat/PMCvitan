import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
import { lockProjectTree, treeLockKey } from '../../src/common/tree-lock';

/**
 * #482 — a site photo is a team record, so it is filed only on a PUBLISHED place. Any draft, its author's
 * own included, is refused exactly like an unknown place, on upload and on re-filing, and nothing is
 * stored. Proven through the real routes against PostgreSQL. Photos already on a draft (filed before
 * this rule) are left as they are; their visibility is a separate unit.
 *
 * Reproduce-first: the "another author's draft" probes are 201/200 at the base, the own-draft probes are
 * 201/200 on da4273c (#869), the race probe fails on 9be3d72 (#869); all pass here.
 */
describe('a photo goes only on a published place (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let pmc: string;
  let engineer: string;
  const engineerId = () => `${f.projectA.id}-vp-engineer`;
  const nodeId = (name: string) => `${f.projectA.id}-vp-${name}`;
  const px = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');

  const upload = (token: string, body: Record<string, unknown>) =>
    request(t.app.getHttpServer())
      .post(`/projects/${f.projectA.id}/media`)
      .set('Authorization', `Bearer ${token}`)
      .send({ kind: 'progress', mime: 'image/png', data: px, ...body });
  const refile = (token: string, mediaId: string, to: string | null) =>
    request(t.app.getHttpServer())
      .patch(`/projects/${f.projectA.id}/media/${mediaId}/node`)
      .set('Authorization', `Bearer ${token}`)
      .send({ nodeId: to });

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    pmc = t.issueProjectToken(f.memberUser.id, f.projectA.id, 'pmc');
    await t.prisma.user.create({ data: { id: engineerId(), projectId: f.projectA.id, role: 'engineer', name: 'A engineer', email: `${engineerId()}@test.local` } });
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: engineerId(), role: 'engineer', status: 'active' } });
    engineer = t.issueProjectToken(engineerId(), f.projectA.id, 'engineer');
    const node = (name: string, publishedAt: Date | null) =>
      t.prisma.projectNode.create({ data: { id: nodeId(name), projectId: f.projectA.id, name, kind: 'zone', publishedAt, authorId: f.memberUser.id } });
    await node('published', new Date());
    await node('pmc-draft', null);
  });

  afterAll(async () => {
    await t?.prisma.media.deleteMany({ where: { projectId: f.projectA.id } });
    await t?.prisma.projectNode.deleteMany({ where: { id: { startsWith: `${f.projectA.id}-vp-` } } });
    await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor', 'MembershipTransition'], { cascade: true });
    await t?.prisma.membership.deleteMany({ where: { userId: engineerId() } });
    await t?.prisma.user.deleteMany({ where: { id: engineerId() } });
    await f?.cleanup();
    await t?.close();
  });

  it('files a photo on a published place', async () => {
    const res = await upload(engineer, { nodeId: nodeId('published'), clientKey: 'vp-published' });
    expect(res.status).toBe(201);
    expect((await t.prisma.media.findUniqueOrThrow({ where: { id: res.body.id } })).nodeId).toBe(nodeId('published'));
  });

  it('refuses another author\'s private draft exactly like an unknown place, and stores nothing', async () => {
    const hidden = await upload(engineer, { nodeId: nodeId('pmc-draft'), clientKey: 'vp-hidden' });
    const unknown = await upload(engineer, { nodeId: nodeId('nowhere'), clientKey: 'vp-unknown' });
    expect(hidden.status).toBe(400);
    expect(hidden.body.message).toBe(unknown.body.message);
    expect(await t.prisma.media.count({ where: { clientKey: { in: ['vp-hidden', 'vp-unknown'] } } })).toBe(0);
  });

  it('refuses the uploader\'s own private draft too: a team photo never goes on a draft', async () => {
    const own = await upload(pmc, { nodeId: nodeId('pmc-draft'), clientKey: 'vp-own-draft' });
    const unknown = await upload(pmc, { nodeId: nodeId('nowhere'), clientKey: 'vp-own-unknown' });
    expect(own.status).toBe(400);
    expect(own.body.message).toBe(unknown.body.message);
    expect(await t.prisma.media.count({ where: { clientKey: { in: ['vp-own-draft', 'vp-own-unknown'] } } })).toBe(0);
  });

  it('re-filing onto any draft is refused and the photo stays where it was', async () => {
    const photo = await upload(engineer, { nodeId: nodeId('published'), clientKey: 'vp-refile' });
    expect(photo.status).toBe(201);
    expect((await refile(engineer, photo.body.id, nodeId('pmc-draft'))).status).toBe(400);
    expect((await t.prisma.media.findUniqueOrThrow({ where: { id: photo.body.id } })).nodeId).toBe(nodeId('published'));
    // nor may the draft's own author: a team photo never goes on a draft
    expect((await refile(pmc, photo.body.id, nodeId('pmc-draft'))).status).toBe(400);
    expect((await t.prisma.media.findUniqueOrThrow({ where: { id: photo.body.id } })).nodeId).toBe(nodeId('published'));
  });

  it('an upload racing a publish waits for it and files the photo on the now-published place', async () => {
    await t.prisma.projectNode.create({ data: { id: nodeId('racing'), projectId: f.projectA.id, name: 'racing', kind: 'zone', publishedAt: null, authorId: f.memberUser.id } });
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const holding = new Promise<void>((r) => { locked = r; });
    // a publish in flight: the tree write holds the exclusive tree lock with the place published but not committed
    const publish = t.prisma.$transaction(async (tx) => {
      await lockProjectTree(tx, f.projectA.id);
      await tx.projectNode.update({ where: { id: nodeId('racing') }, data: { publishedAt: new Date() } });
      locked();
      await released;
    }, { timeout: 20_000 });
    await holding;
    const upload$ = upload(engineer, { nodeId: nodeId('racing'), clientKey: 'vp-race' }).then((r) => r);
    // barrier: the upload is queued on THIS project's tree lock (an ungranted request for that exact
    // advisory key), not merely slow, and not some other worker's advisory wait. A bigint advisory key shows
    // in pg_locks as its high 32 bits in classid and its low 32 bits in objid, with objsubid 1.
    let waiting = 0;
    for (let i = 0; i < 100 && waiting === 0; i++) {
      const [row] = await t.prisma.$queryRaw<Array<{ n: number }>>`
        WITH k AS (SELECT hashtextextended(${treeLockKey(f.projectA.id)}, 0) AS h)
        SELECT count(*)::int AS n FROM pg_locks, k
        WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1
          AND classid::bigint = ((k.h >> 32) & 4294967295) AND objid::bigint = (k.h & 4294967295)`;
      waiting = row.n;
      if (!waiting) await new Promise((r) => setTimeout(r, 50));
    }
    release();
    await publish;
    const res = await upload$;
    expect(waiting).toBeGreaterThan(0);
    expect(res.status).toBe(201);
    expect((await t.prisma.media.findUniqueOrThrow({ where: { id: res.body.id } })).nodeId).toBe(nodeId('racing'));
  });
});
