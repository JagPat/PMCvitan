import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * #482 follow-up of #881 (owner's order) — a photo filed on a private draft place BEFORE #881 made drafts
 * unfileable is as private as the place. Only the draft's author sees it, nobody else can move it, and
 * deleting the draft cannot hand it to the team:
 *   1. the snapshot photo list leaves it out for everyone but the author;
 *   2. inspection evidence carries no signed path to it for anyone but the author (snapshot and module read);
 *   3. deleting a draft that still carries a photo is refused (the FK would unfile it into the team view);
 *   4. re-filing or unfiling it is answered 404 for anyone but the author.
 * Proven through the real routes against PostgreSQL. Reproduce-first: each probe fails on #881's head.
 */
describe('photos already on a private draft place stay private (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let author: string; // the PMC who drafted the place
  let otherPmc: string;
  let engineer: string;
  const otherPmcId = () => `${f.projectA.id}-ld-pmc2`;
  const engineerId = () => `${f.projectA.id}-ld-engineer`;
  const nodeId = (name: string) => `${f.projectA.id}-ld-${name}`;
  const inspectionId = () => `INSP-LD-${f.projectA.id}`;
  const px = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  let legacyId: string;

  const http = () => request(t.app.getHttpServer());
  const snapshot = (token: string) => http().get(`/projects/${f.projectA.id}/snapshot`).set('Authorization', `Bearer ${token}`);
  const inspections = (token: string) => http().get(`/projects/${f.projectA.id}/inspections`).set('Authorization', `Bearer ${token}`);
  const refile = (token: string, mediaId: string, to: string | null) =>
    http().patch(`/projects/${f.projectA.id}/media/${mediaId}/node`).set('Authorization', `Bearer ${token}`).send({ nodeId: to });
  const removeNode = (token: string, id: string) => http().delete(`/projects/${f.projectA.id}/nodes/${id}`).set('Authorization', `Bearer ${token}`);
  const reviewEvidence = (body: { reviews: Array<{ id: string; items: Array<{ evidence: string[] }> }> }) =>
    (body.reviews.find((r) => r.id === inspectionId())?.items ?? []).flatMap((it) => it.evidence);

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    author = t.issueProjectToken(f.memberUser.id, f.projectA.id, 'pmc');
    for (const [id, role] of [[otherPmcId(), 'pmc'], [engineerId(), 'engineer']] as const) {
      await t.prisma.user.create({ data: { id, projectId: f.projectA.id, role, name: id, email: `${id}@test.local` } });
      await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: id, role, status: 'active' } });
    }
    otherPmc = t.issueProjectToken(otherPmcId(), f.projectA.id, 'pmc');
    engineer = t.issueProjectToken(engineerId(), f.projectA.id, 'engineer');
    const node = (name: string, publishedAt: Date | null) =>
      t.prisma.projectNode.create({ data: { id: nodeId(name), projectId: f.projectA.id, name, kind: 'zone', publishedAt, authorId: f.memberUser.id } });
    await node('published', new Date());
    await node('draft', null);
    // a photo filed on the author's draft before #881 (no route can file one now), linked as evidence
    // on a submitted review the whole PMC team sees
    legacyId = (await t.prisma.media.create({
      data: { projectId: f.projectA.id, kind: 'inspection', mime: 'image/png', uploadedBy: f.memberUser.id, data: px, nodeId: nodeId('draft') },
    })).id;
    await t.prisma.inspection.create({
      data: { id: inspectionId(), projectId: f.projectA.id, kind: 'review', title: 'Slab check', zone: 'Zone A', date: '14 Oct', submitted: true },
    });
    const item = await t.prisma.inspectionItem.create({ data: { inspectionId: inspectionId(), name: 'Cover', result: 'PASS' } });
    await t.prisma.inspectionEvidence.create({ data: { projectId: f.projectA.id, inspectionId: inspectionId(), inspectionItemId: item.id, mediaId: legacyId } });
  });

  afterAll(async () => {
    await t?.prisma.inspectionEvidence.deleteMany({ where: { inspectionId: inspectionId() } });
    await t?.prisma.inspectionItem.deleteMany({ where: { inspectionId: inspectionId() } });
    await t?.prisma.inspection.deleteMany({ where: { id: inspectionId() } });
    await t?.prisma.media.deleteMany({ where: { projectId: f.projectA.id } });
    await t?.prisma.projectNode.deleteMany({ where: { id: { startsWith: `${f.projectA.id}-ld-` } } });
    await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor', 'MembershipTransition'], { cascade: true });
    await t?.prisma.membership.deleteMany({ where: { userId: { in: [otherPmcId(), engineerId()] } } });
    await t?.prisma.user.deleteMany({ where: { id: { in: [otherPmcId(), engineerId()] } } });
    await f?.cleanup();
    await t?.close();
  });

  it('1. the snapshot photo list shows it to the draft\'s author only', async () => {
    const ids = (body: { photos: Array<{ id: string }> }) => body.photos.map((p) => p.id);
    const mine = await snapshot(author);
    expect(mine.status).toBe(200);
    expect(ids(mine.body)).toContain(legacyId);
    for (const token of [otherPmc, engineer]) {
      const theirs = await snapshot(token);
      expect(theirs.status).toBe(200);
      expect(ids(theirs.body)).not.toContain(legacyId);
      expect(JSON.stringify(theirs.body.photos)).not.toContain(nodeId('draft'));
    }
  });

  it('2. inspection evidence carries no signed path to it for anyone but the author', async () => {
    // the module read (GET …/inspections) and the snapshot slice both bake evidence
    expect(reviewEvidence((await inspections(author)).body)).toHaveLength(1);
    expect(reviewEvidence((await snapshot(author)).body)).toHaveLength(1);
    const theirs = await inspections(otherPmc);
    expect(theirs.status).toBe(200);
    expect(theirs.body.reviews.map((r: { id: string }) => r.id)).toContain(inspectionId());
    expect(reviewEvidence(theirs.body)).toEqual([]);
    expect(reviewEvidence((await snapshot(otherPmc)).body)).toEqual([]);
    expect(JSON.stringify(theirs.body)).not.toContain(legacyId);
  });

  it('4. nobody but the author can re-file or unfile it; the author can', async () => {
    for (const token of [otherPmc, engineer]) {
      expect((await refile(token, legacyId, nodeId('published'))).status).toBe(404);
      expect((await refile(token, legacyId, null)).status).toBe(404);
    }
    expect((await t.prisma.media.findUniqueOrThrow({ where: { id: legacyId } })).nodeId).toBe(nodeId('draft'));
  });

  it('3. deleting the draft while it carries the photo is refused, and allowed once the author moves it', async () => {
    const refused = await removeNode(author, nodeId('draft'));
    expect(refused.status).toBe(400);
    expect(refused.body.message).toContain('photo');
    expect(await t.prisma.projectNode.count({ where: { id: nodeId('draft') } })).toBe(1);
    expect((await t.prisma.media.findUniqueOrThrow({ where: { id: legacyId } })).nodeId).toBe(nodeId('draft'));
    // the author decides where it goes: here, onto a published place, which shows it to the team
    expect((await refile(author, legacyId, nodeId('published'))).status).toBe(200);
    expect((await removeNode(author, nodeId('draft'))).status).toBe(200);
    expect(await t.prisma.projectNode.count({ where: { id: nodeId('draft') } })).toBe(0);
  });
});
