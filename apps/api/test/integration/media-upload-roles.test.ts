import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import type { Role } from '@vitan/shared';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
import { StorageService } from '../../src/media/storage.service';

/**
 * #482 (Board decision, 14 Oct 2026) — every project member adds a site photo: the PMC, the engineer, a
 * consultant, a contractor (and the foreman, who signs in as a contractor member) and the client. Proven per role through the real route, guard and service against PostgreSQL.
 *
 * Reproduce-first: every non-PMC/engineer "may add a site photo" probe is 403 at the base and 201 here.
 * Linking a photo to a record (a decision, a daily log, an inspection item) stays the PMC's and engineer's,
 * and an anonymous worker token stays out.
 */
describe('who may add a site photo (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const extra: string[] = [];
  const tokens = {} as Record<Role, string>;
  const px = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
  // not the architect: its action set is pinned (P28) and no User may carry the role until 4d-iii opens it;
  // architects visit as consultant members until then
  const ROLES: Role[] = ['pmc', 'engineer', 'contractor', 'consultant', 'client'];

  const upload = (token: string, body: Record<string, unknown>) =>
    request(t.app.getHttpServer())
      .post(`/projects/${f.projectA.id}/media`)
      .set('Authorization', `Bearer ${token}`)
      .send({ mime: 'image/png', data: px, ...body });

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    tokens.pmc = t.issueProjectToken(f.memberUser.id, f.projectA.id, 'pmc');
    tokens.client = t.issueProjectToken(f.clientUser.id, f.projectA.id, 'client');
    for (const role of ['engineer', 'contractor', 'consultant'] as Role[]) {
      const id = `${f.projectA.id}-${role}`;
      await t.prisma.user.create({ data: { id, projectId: f.projectA.id, role, name: `A ${role}`, email: `${id}@test.local` } });
      await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: id, role, status: 'active' } });
      extra.push(id);
      tokens[role] = t.issueProjectToken(id, f.projectA.id, role);
    }
  });

  afterAll(async () => {
    await t?.prisma.media.deleteMany({ where: { projectId: f.projectA.id } });
    await t?.prisma.projectNode.deleteMany({ where: { projectId: f.projectA.id, id: { startsWith: `${f.projectA.id}-roles-` } } });
    // this suite's own members go before the fixture's teardown, which deletes the project they point at
    await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor', 'MembershipTransition'], { cascade: true });
    await t?.prisma.membership.deleteMany({ where: { userId: { in: extra } } });
    await t?.prisma.user.deleteMany({ where: { id: { in: extra } } });
    await f?.cleanup();
    await t?.close();
  });

  it.each(ROLES)('a %s adds a site photo, placed or not, and it is recorded as theirs', async (role) => {
    const res = await upload(tokens[role], { kind: 'progress', clientKey: `roles-${role}` });
    expect(res.status).toBe(201);
    const row = await t.prisma.media.findUniqueOrThrow({ where: { id: res.body.id } });
    const who = role === 'pmc' ? f.memberUser.id : role === 'client' ? f.clientUser.id : `${f.projectA.id}-${role}`;
    expect(row).toMatchObject({ projectId: f.projectA.id, kind: 'progress', uploadedBy: who });
    // who added it, in which role and when: frozen on the upload's own event
    const ev = await t.prisma.domainEvent.findFirstOrThrow({ where: { projectId: f.projectA.id, eventType: 'media.uploaded', entityId: row.id } });
    expect(ev.actorRole).toBe(role);
  });

  it.each(['contractor', 'consultant', 'client'] as Role[])('a %s may not link a photo to a record', async (role) => {
    for (const body of [
      { kind: 'inspection', inspectionId: 'any', inspectionItemId: 'any' },
      { kind: 'progress', dailyLogId: 'any' },
      { kind: 'progress', decisionId: 'any' },
      { kind: 'material' },
    ]) {
      const res = await upload(tokens[role], { ...body, clientKey: `refused-${role}-${body.kind}-${Object.keys(body).length}` });
      expect(res.status, `${role} ${JSON.stringify(body)}`).toBe(403);
    }
    // nothing was stored by a refusal
    expect(await t.prisma.media.count({ where: { projectId: f.projectA.id, clientKey: { startsWith: `refused-${role}` } } })).toBe(0);
  });

  it('a replayed upload key returns only the caller\'s own plain photo, never another member\'s evidence', async () => {
    // the PMC's record-linked upload under a key the contractor learns
    const evidence = await upload(tokens.pmc, { kind: 'material', clientKey: 'replay-pmc-evidence' });
    expect(evidence.status).toBe(201);
    const stolen = await upload(tokens.contractor, { kind: 'progress', clientKey: 'replay-pmc-evidence' });
    expect(stolen.status).toBe(403);
    expect(stolen.body.id).toBeUndefined();
    // another member's plain photo is not theirs to replay either
    expect((await upload(tokens.consultant, { kind: 'progress', clientKey: 'roles-client' })).status).toBe(403);
    // their own key still replays to the same row (an offline photo uploads exactly once)
    const first = await upload(tokens.contractor, { kind: 'progress', clientKey: 'replay-own' });
    const again = await upload(tokens.contractor, { kind: 'progress', clientKey: 'replay-own' });
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.body.id).toBe(first.body.id);
  });

  it('two concurrent uploads under one new key keep one row and one object: the loser\'s object is cleaned up', async () => {
    const storage = t.app.get(StorageService);
    // explicit barrier: both requests have passed the idempotency read and stored their bytes, under their
    // own keys, before either opens its transaction; then they race the unique and one loses (P2002)
    const putKeys: string[] = [];
    let release!: () => void;
    const bothStored = new Promise<void>((r) => (release = r));
    const realPut = storage.put.bind(storage);
    const put = vi.spyOn(storage, 'put').mockImplementation(async (key, bytes, mime) => {
      putKeys.push(key);
      if (putKeys.length === 2) release();
      const stored = await realPut(key, bytes, mime);
      await bothStored;
      return stored;
    });
    const remove = vi.spyOn(storage, 'remove').mockResolvedValue(undefined);
    try {
      const [a, b] = await Promise.all([
        upload(tokens.contractor, { kind: 'progress', clientKey: 'race-own' }),
        upload(tokens.contractor, { kind: 'progress', clientKey: 'race-own' }),
      ]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect(a.body.id).toBe(b.body.id);
      // the terminal invariant: one row, holding the winner's key; only the loser's object is removed
      const rows = await t.prisma.media.findMany({ where: { projectId: f.projectA.id, clientKey: 'race-own' } });
      expect(rows).toHaveLength(1);
      expect(putKeys).toHaveLength(2);
      expect(putKeys[0]).not.toBe(putKeys[1]);
      const loser = putKeys.find((k) => k !== rows[0].storageKey);
      expect(remove.mock.calls).toEqual([[loser]]);
    } finally {
      put.mockRestore();
      remove.mockRestore();
    }
  });

  it('a replayed key never hands back a photo on a draft hidden from the caller', async () => {
    // a contractor's photo filed (before #881) on the PMC's private draft: hidden from the contractor since #884
    const draft = await t.prisma.projectNode.create({
      data: { id: `${f.projectA.id}-roles-legacy-draft`, projectId: f.projectA.id, name: 'legacy draft', kind: 'zone', publishedAt: null, authorId: f.memberUser.id },
    });
    await t.prisma.media.create({
      data: { projectId: f.projectA.id, kind: 'progress', mime: 'image/png', data: Buffer.from(px, 'base64'), uploadedBy: `${f.projectA.id}-contractor`, nodeId: draft.id, clientKey: 'legacy-on-draft' },
    });
    const replay = await upload(tokens.contractor, { kind: 'progress', clientKey: 'legacy-on-draft' });
    expect(replay.status).toBe(404);
    expect(replay.body.url).toBeUndefined();
  });

  it('a contractor\'s photo goes on a published place, never on a draft (the #881 rule holds for the new roles)', async () => {
    const node = (id: string, publishedAt: Date | null, authorId: string) =>
      t.prisma.projectNode.create({ data: { id: `${f.projectA.id}-${id}`, projectId: f.projectA.id, name: id, kind: 'zone', publishedAt, authorId } });
    const published = await node('roles-published', new Date(), f.memberUser.id);
    const pmcDraft = await node('roles-pmc-draft', null, f.memberUser.id);
    const placed = await upload(tokens.contractor, { kind: 'progress', nodeId: published.id, clientKey: 'place-published' });
    expect(placed.status).toBe(201);
    const hidden = await upload(tokens.contractor, { kind: 'progress', nodeId: pmcDraft.id, clientKey: 'place-hidden' });
    expect(hidden.status).toBe(400);
    expect(await t.prisma.media.count({ where: { clientKey: 'place-hidden' } })).toBe(0);
  });

  it('an anonymous worker token adds nothing', async () => {
    const worker = t.issueProjectToken(f.memberUser.id, f.projectA.id, 'worker' as Role);
    expect((await upload(worker, { kind: 'progress', clientKey: 'roles-worker' })).status).toBe(403);
  });

  it('a member of another project adds nothing here', async () => {
    const other = t.issueProjectToken(f.otherUser.id, f.projectA.id, 'contractor');
    expect((await upload(other, { kind: 'progress', clientKey: 'roles-stranger' })).status).toBe(403);
    expect(await t.prisma.media.count({ where: { clientKey: 'roles-stranger' } })).toBe(0);
  });
});
