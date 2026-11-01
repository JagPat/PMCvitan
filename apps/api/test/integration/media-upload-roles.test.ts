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
 * Every member's site photo may be filed on the day's log it was taken for; linking a photo to any other record
 * (a decision, an inspection item) stays the PMC's and engineer's, and an anonymous worker token stays out.
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
      { kind: 'progress', decisionId: 'any' },
      { kind: 'material' },
    ]) {
      const res = await upload(tokens[role], { ...body, clientKey: `refused-${role}-${body.kind}-${Object.keys(body).length}` });
      expect(res.status, `${role} ${JSON.stringify(body)}`).toBe(403);
    }
    // nothing was stored by a refusal
    expect(await t.prisma.media.count({ where: { projectId: f.projectA.id, clientKey: { startsWith: `refused-${role}` } } })).toBe(0);
  });

  it.each(ROLES)('a %s files a site photo on the day\'s log it was taken for, and its replay is the same photo', async (role) => {
    const log = await t.prisma.dailyLog.create({ data: { projectId: f.projectA.id, date: 'roles log', logDate: new Date('2026-10-15') } });
    try {
      const first = await upload(tokens[role], { kind: 'progress', dailyLogId: log.id, clientKey: `log-${role}` });
      expect(first.status).toBe(201);
      expect(await t.prisma.media.findUniqueOrThrow({ where: { id: first.body.id } })).toMatchObject({ dailyLogId: log.id, kind: 'progress' });
      const again = await upload(tokens[role], { kind: 'progress', dailyLogId: log.id, clientKey: `log-${role}` });
      expect(again.status).toBe(201);
      expect(again.body.id).toBe(first.body.id);
      // another project's log is never theirs to file on
      const otherLog = await t.prisma.dailyLog.create({ data: { projectId: f.projectB.id, date: 'other log' } });
      try {
        expect((await upload(tokens[role], { kind: 'progress', dailyLogId: otherLog.id, clientKey: `log-other-${role}` })).status).toBe(400);
        expect(await t.prisma.media.count({ where: { clientKey: `log-other-${role}` } })).toBe(0);
      } finally {
        await t.prisma.dailyLog.delete({ where: { id: otherLog.id } });
      }
    } finally {
      await t.prisma.media.deleteMany({ where: { dailyLogId: log.id } });
      await t.prisma.dailyLog.delete({ where: { id: log.id } });
    }
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

  it.each(['pmc', 'engineer'] as Role[])('#904: a %s\'s replay is their own upload, as it was sent', async (role) => {
    // an honest retry (a lost answer, a second tab) is the same photo
    const first = await upload(tokens[role], { kind: 'material', clientKey: `904-own-${role}` });
    expect(first.status).toBe(201);
    const again = await upload(tokens[role], { kind: 'material', clientKey: `904-own-${role}` });
    expect([again.status, again.body.id]).toEqual([201, first.body.id]);
    // a key another member used is not theirs: refused, not answered with that member's photo
    const client = await upload(tokens.client, { kind: 'progress', clientKey: `904-client-${role}` });
    expect(client.status).toBe(201);
    const taken = await upload(tokens[role], { kind: 'progress', clientKey: `904-client-${role}` });
    expect([taken.status, taken.body.id]).toEqual([403, undefined]);
    // nor is their own key sent for something else: another kind, or a decision, day's log or inspection the stored
    // photo is not on (Codex on #1255: the request's links are stored as sent, so each is compared)
    expect((await upload(tokens[role], { kind: 'progress', clientKey: `904-own-${role}` })).status).toBe(403);
    for (const link of [{ decisionId: 'not-this' }, { dailyLogId: 'not-this' }, { inspectionId: 'not-this' }]) {
      expect((await upload(tokens[role], { kind: 'material', ...link, clientKey: `904-own-${role}` })).status, JSON.stringify(link)).toBe(403);
    }
    // nor another file under it: another type, or other bytes (Codex round 2 on #1255)
    expect((await upload(tokens[role], { kind: 'material', mime: 'image/jpeg', clientKey: `904-own-${role}` })).status).toBe(403);
    expect((await upload(tokens[role], { kind: 'material', data: Buffer.from([0x89, 0x50, 0x4e]).toString('base64'), clientKey: `904-own-${role}` })).status).toBe(403);
    // an empty link is none, as the upload stored it
    expect((await upload(tokens[role], { kind: 'material', decisionId: '', dailyLogId: '', clientKey: `904-own-${role}` })).body.id).toBe(first.body.id);
    // nothing new was stored, and the two photos are as they were
    const rows = await t.prisma.media.findMany({ where: { projectId: f.projectA.id, clientKey: { in: [`904-own-${role}`, `904-client-${role}`] } }, orderBy: { clientKey: 'asc' } });
    expect(rows.map((r) => [r.clientKey, r.kind, r.uploadedBy])).toEqual([
      [`904-client-${role}`, 'progress', f.clientUser.id],
      [`904-own-${role}`, 'material', role === 'pmc' ? f.memberUser.id : `${f.projectA.id}-${role}`],
    ]);
  });

  it('#904: a PMC upload that loses its new key to another member\'s at the unique is refused, and its object cleaned up', async () => {
    const storage = t.app.get(StorageService);
    // forced order: both requests pass the idempotency read and store their bytes; the client's commits first, and
    // only then does the PMC's open its transaction and meet the unique (P2002)
    let pmcStored!: () => void;
    const pmcAtPut = new Promise<void>((r) => (pmcStored = r));
    let clientDone!: () => void;
    const clientAnswered = new Promise<void>((r) => (clientDone = r));
    const putKeys: string[] = [];
    const realPut = storage.put.bind(storage);
    const put = vi.spyOn(storage, 'put').mockImplementation(async (key, bytes, mime) => {
      putKeys.push(key);
      const stored = await realPut(key, bytes, mime);
      if (key.includes('/material/')) { pmcStored(); await clientAnswered; } else await pmcAtPut;
      return stored;
    });
    const remove = vi.spyOn(storage, 'remove').mockResolvedValue(undefined);
    try {
      const clientReq = upload(tokens.client, { kind: 'progress', clientKey: '904-race' }).then((r) => { clientDone(); return r; });
      const [client, pmc] = await Promise.all([clientReq, upload(tokens.pmc, { kind: 'material', clientKey: '904-race' })]);
      const rows = await t.prisma.media.findMany({ where: { projectId: f.projectA.id, clientKey: '904-race' } });
      expect(rows.map((r) => [r.kind, r.uploadedBy])).toEqual([['progress', f.clientUser.id]]);
      expect([client.status, client.body.id]).toEqual([201, rows[0].id]);
      // the PMC's material photo was never stored: refused, never handed the client's photo as its own
      expect([pmc.status, pmc.body.id]).toEqual([403, undefined]);
      expect(putKeys).toHaveLength(2);
      expect(remove.mock.calls).toEqual([[putKeys.find((k) => k !== rows[0].storageKey)]]);
    } finally {
      put.mockRestore();
      remove.mockRestore();
    }
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

  it('another member\'s key on a place hidden from the caller is not found, never refused as taken (Codex round 1 on #1262)', async () => {
    // the engineer's private draft, hidden from everyone else; the contractor's photo filed on it before #881
    const draft = await t.prisma.projectNode.create({
      data: { id: `${f.projectA.id}-roles-engineer-draft`, projectId: f.projectA.id, name: 'engineer draft', kind: 'zone', publishedAt: null, authorId: `${f.projectA.id}-engineer` },
    });
    await t.prisma.media.create({
      data: { projectId: f.projectA.id, kind: 'progress', mime: 'image/png', data: Buffer.from(px, 'base64'), uploadedBy: `${f.projectA.id}-contractor`, nodeId: draft.id, clientKey: 'hidden-other' },
    });
    // the PMC (site-record role) and a narrowed role: both 404, as an unknown record, not 403 'belongs to another photo'
    for (const role of ['pmc', 'consultant'] as Role[]) {
      const replay = await upload(tokens[role], { kind: 'progress', clientKey: 'hidden-other' });
      expect([role, replay.status, replay.body.url]).toEqual([role, 404, undefined]);
    }
    expect(await t.prisma.media.count({ where: { projectId: f.projectA.id, clientKey: 'hidden-other' } })).toBe(1);
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
