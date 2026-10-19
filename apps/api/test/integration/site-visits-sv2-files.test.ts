import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
import { treeLockKey } from '../../src/common/tree-lock';

/**
 * Site Visits (#792) SV2, the server half of "media on a visit": the photo upload names a visit, and the file is added to
 * it (Jagrut, 19 Oct 2026: office staff and site engineers add photos from their phones; the visitor and anyone
 * recorded as present may add, not after the visit is closed). A visit file is its own kind, so it shows inside its
 * visit only, never on the Site Map, the Dashboard or the daily log. Proven through the real routes against PostgreSQL.
 */
describe('Site Visits SV2 — adding files to a visit (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const run = randomUUID().slice(0, 8);
  const extra: string[] = [];
  let consultant: string;
  let engineer: string;
  let place: { id: string; name: string };
  let pmcToken: string;
  let consultantToken: string;
  let engineerToken: string;
  let clientToken: string;
  let visitId: string;
  let attendeeId: string;
  const px = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');

  const http = () => request(t.app.getHttpServer());
  const visits = () => `/projects/${f.projectA.id}/site-visits`;
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const upload = (token: string, body: Record<string, unknown>) =>
    http().post(`/projects/${f.projectA.id}/media`).set('Authorization', `Bearer ${token}`).send({ mime: 'image/png', data: px, ...body });
  const visitFile = (token: string, visit: string, extraBody: Record<string, unknown> = {}, siteVisit: Record<string, unknown> = {}) =>
    upload(token, { kind: 'visit', siteVisit: { visitId: visit, ...siteVisit }, ...extraBody });
  const readVisit = async (visit: string) => {
    const res = await http().get(visits()).set('Authorization', `Bearer ${clientToken}`);
    expect(res.status).toBe(200);
    return res.body.find((v: { id: string }) => v.id === visit);
  };
  const member = async (role: 'consultant' | 'engineer') => {
    const id = `sv2f-${role}-${run}`;
    extra.push(id);
    await t.prisma.user.create({ data: { id, projectId: f.projectA.id, role, name: `Sam (${role})`, email: `${id}@t.local` } });
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: id, role, status: 'active' } });
    return id;
  };

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    await t.prisma.$executeRaw`UPDATE "Project" SET "createdAt" = now() - interval '30 days' WHERE "id" = ${f.projectA.id}`;
    consultant = await member('consultant');
    engineer = await member('engineer');
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    consultantToken = t.issueProjectToken(consultant, f.projectA.id, 'consultant');
    engineerToken = t.issueProjectToken(engineer, f.projectA.id, 'engineer');
    clientToken = t.issueProjectToken(f.clientUser.id, f.projectA.id, 'client');
    const n = await t.prisma.projectNode.create({
      data: { projectId: f.projectA.id, name: `Tower A ${run}`, kind: 'zone', order: 0, authorId: f.memberUser.id, publishedAt: new Date() },
    });
    place = { id: n.id, name: n.name };
    // the PMC's visit, with the consultant recorded as present
    visitId = randomUUID();
    expect((await http().post(visits()).set('Authorization', `Bearer ${pmcToken}`).send({ id: visitId, claimedAt: ago(30) })).status).toBe(201);
    attendeeId = randomUUID();
    const added = await http().post(`${visits()}/${visitId}/attendees`).set('Authorization', `Bearer ${pmcToken}`)
      .send({ id: attendeeId, userId: consultant, role: 'consultant' });
    expect(added.status).toBe(201);
  });

  afterAll(async () => {
    if (t) {
      await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor',
        'SiteVisitMedia', 'SiteVisitPlace', 'SiteVisitAttendee', 'SiteVisit'], { cascade: true });
      await t.prisma.media.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
      await t.prisma.projectNode.deleteMany({ where: { projectId: f.projectA.id, name: { endsWith: run } } });
      await t.prisma.membership.deleteMany({ where: { userId: { in: extra } } });
      await t.prisma.user.deleteMany({ where: { id: { in: extra } } });
    }
    await f?.cleanup();
    await t?.close();
  });

  it('the visitor adds a photo with a note, a rating and its place; the visit lists it with who added it and when', async () => {
    const res = await visitFile(pmcToken, visitId, { nodeId: place.id, takenAt: '19 Oct 2026 · 10:05 AM' },
      { note: '  Crack above the lintel  ', rating: 'concern' });
    expect(res.status).toBe(201);
    const row = await t.prisma.media.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row).toMatchObject({ kind: 'visit', uploadedBy: f.memberUser.id, nodeId: place.id });
    const visit = await readVisit(visitId);
    const file = visit.files.find((x: { mediaId: string }) => x.mediaId === res.body.id);
    expect(file).toMatchObject({
      mime: 'image/png', takenAt: '19 Oct 2026 · 10:05 AM', note: 'Crack above the lintel', rating: 'concern',
      place: { nodeId: place.id, name: place.name }, addedById: f.memberUser.id, addedByRole: 'pmc',
    });
    expect(file.addedByName).not.toBe('');
    expect(file.url).toMatch(new RegExp(`/media/${res.body.id}`));
    // the upload keeps its own event, attributed to the adder
    const ev = await t.prisma.domainEvent.findFirstOrThrow({ where: { eventType: 'media.uploaded', entityId: res.body.id } });
    expect(ev.actorRole).toBe('pmc');
  });

  it('someone recorded as present adds a file; a member who is not on the visit, or no longer on it, cannot', async () => {
    const byAttendee = await visitFile(consultantToken, visitId, {}, { rating: 'fine' });
    expect(byAttendee.status).toBe(201);
    expect((await readVisit(visitId)).files.find((x: { mediaId: string }) => x.mediaId === byAttendee.body.id))
      .toMatchObject({ addedById: consultant, addedByRole: 'consultant', note: null, rating: 'fine', place: null });
    for (const token of [engineerToken, clientToken]) {
      const refused = await visitFile(token, visitId, { clientKey: `sv2f-refused-${run}-${token.slice(-6)}` });
      expect(refused.status).toBe(403);
    }
    // nothing was stored by a refusal
    expect(await t.prisma.media.count({ where: { projectId: f.projectA.id, clientKey: { startsWith: `sv2f-refused-${run}` } } })).toBe(0);
    // retired from the visit: no longer present
    const second = randomUUID();
    expect((await http().post(`${visits()}/${visitId}/attendees`).set('Authorization', `Bearer ${pmcToken}`)
      .send({ id: second, userId: engineer, role: 'engineer' })).status).toBe(201);
    expect((await visitFile(engineerToken, visitId)).status).toBe(201);
    expect((await http().post(`${visits()}/${visitId}/attendees/${second}/retire`).set('Authorization', `Bearer ${pmcToken}`)).status).toBe(201);
    expect((await visitFile(engineerToken, visitId)).status).toBe(403);
  });

  it('an ended visit still takes files (an offline phone catching up); a closed one takes none', async () => {
    const consultantVisit = randomUUID();
    expect((await http().post(visits()).set('Authorization', `Bearer ${consultantToken}`).send({ id: consultantVisit, claimedAt: ago(20) })).status).toBe(201);
    expect((await visitFile(consultantToken, consultantVisit)).status).toBe(201);
    expect((await http().post(`${visits()}/${consultantVisit}/close`).set('Authorization', `Bearer ${pmcToken}`).send({ reason: 'Left open' })).status).toBe(201);
    const closed = await visitFile(consultantToken, consultantVisit, { clientKey: `sv2f-closed-${run}` });
    expect(closed.status).toBe(409);
    expect(await t.prisma.media.count({ where: { clientKey: `sv2f-closed-${run}` } })).toBe(0);
    // an ended visit (by its visitor) takes a late file
    const ended = randomUUID();
    expect((await http().post(visits()).set('Authorization', `Bearer ${consultantToken}`).send({ id: ended, claimedAt: ago(15) })).status).toBe(201);
    expect((await http().post(`${visits()}/${ended}/end`).set('Authorization', `Bearer ${consultantToken}`).send({ claimedAt: ago(1) })).status).toBe(201);
    expect((await visitFile(consultantToken, ended)).status).toBe(201);
  });

  it('a visit file names its visit and nothing else; an unknown visit or another project\'s is not found', async () => {
    expect((await upload(pmcToken, { kind: 'progress', siteVisit: { visitId } })).status).toBe(400);
    expect((await upload(pmcToken, { kind: 'visit' })).status).toBe(400);
    expect((await visitFile(pmcToken, visitId, {}, { note: '   ' })).status).toBe(400);
    expect((await visitFile(pmcToken, visitId, {}, { rating: 'urgent' })).status).toBe(400);
    expect((await visitFile(pmcToken, visitId, { dailyLogId: 'any' })).status).toBe(400);
    expect((await visitFile(pmcToken, visitId, { decisionId: 'any' })).status).toBe(400);
    expect((await visitFile(pmcToken, randomUUID())).status).toBe(404);
    // the other project's PMC cannot reach this project's visit through their own project
    const otherToken = t.issueProjectToken(f.otherUser.id, f.projectB.id);
    const other = await request(t.app.getHttpServer()).post(`/projects/${f.projectB.id}/media`).set('Authorization', `Bearer ${otherToken}`)
      .send({ mime: 'image/png', data: px, kind: 'visit', siteVisit: { visitId } });
    expect(other.status).toBe(404);
  });

  it('a replayed upload returns the same file, on the visit once', async () => {
    const key = `sv2f-replay-${run}`;
    const first = await visitFile(consultantToken, visitId, { clientKey: key }, { note: 'East wall' });
    expect(first.status).toBe(201);
    const again = await visitFile(consultantToken, visitId, { clientKey: key }, { note: 'East wall' });
    expect(again.status).toBe(201);
    expect(again.body.id).toBe(first.body.id);
    expect(await t.prisma.siteVisitMedia.count({ where: { mediaId: first.body.id } })).toBe(1);
    expect(await t.prisma.domainEvent.count({ where: { eventType: 'media.uploaded', entityId: first.body.id } })).toBe(1);
  });

  it('visit files stay inside their visit: not on the Site Map, the Dashboard photos or the daily log', async () => {
    const onPlace = await visitFile(pmcToken, visitId, { nodeId: place.id });
    expect(onPlace.status).toBe(201);
    const plain = await upload(pmcToken, { kind: 'progress', nodeId: place.id });
    expect(plain.status).toBe(201);
    const snap = await http().get(`/projects/${f.projectA.id}/snapshot`).set('Authorization', `Bearer ${clientToken}`);
    expect(snap.status).toBe(200);
    const photoIds = (snap.body.photos as Array<{ id: string }>).map((p) => p.id);
    expect(photoIds).toContain(plain.body.id);
    expect(photoIds).not.toContain(onPlace.body.id);
    const progressIds = ((snap.body.dailyLog?.photos ?? []) as Array<{ id: string }>).map((p) => p.id);
    expect(progressIds).not.toContain(onPlace.body.id);
  });

  it('a file on a visit is part of its record: the PMC cannot delete it, and a plain photo still can be', async () => {
    const onVisit = await visitFile(consultantToken, visitId, {}, { note: 'Kept' });
    expect(onVisit.status).toBe(201);
    const refused = await http().delete(`/media/${onVisit.body.id}`).set('Authorization', `Bearer ${pmcToken}`);
    expect(refused.status).toBe(409);
    expect(await t.prisma.media.count({ where: { id: onVisit.body.id } })).toBe(1);
    expect(await t.prisma.siteVisitMedia.count({ where: { mediaId: onVisit.body.id } })).toBe(1);
    const plain = await upload(pmcToken, { kind: 'progress' });
    expect((await http().delete(`/media/${plain.body.id}`).set('Authorization', `Bearer ${pmcToken}`)).status).toBe(200);
  });

  // ── #988: the lock order against a place's removal ───────────────────────────────────────────

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
  const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };

  // A place's removal, as `NodesService.remove` runs it, by the SAME person who is adding the file: the tree lock first;
  // then, with records filed on the place, their unfile events lock the actor's identity before the node is deleted,
  // and with none, the node is deleted first and the identity is locked at its `node.removed` event.
  it.each([
    ['with records filed on the place (identity, then the node)', true],
    ['with nothing filed on the place (the node, then identity)', false],
  ])('a visit file on a place being removed by the same person waits for the removal, without deadlock: %s', async (_label, identityFirst) => {
    const doomed = await t.prisma.projectNode.create({
      data: { projectId: f.projectA.id, name: `Scaffold ${randomUUID().slice(0, 4)} ${run}`, kind: 'zone', order: 0, authorId: f.memberUser.id, publishedAt: new Date() },
    });
    const held = gate();
    const release = gate();
    const identity = `SELECT 1 FROM "UserIdentity" WHERE "userId" = $1 FOR UPDATE`;
    const removal = t.prisma.$transaction(async (q) => {
      await q.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, treeLockKey(f.projectA.id));
      if (identityFirst) await q.$queryRawUnsafe(identity, f.memberUser.id);
      else await q.$executeRawUnsafe(`DELETE FROM "ProjectNode" WHERE "id" = $1`, doomed.id);
      held.open();
      await release.p;
      if (identityFirst) await q.$executeRawUnsafe(`DELETE FROM "ProjectNode" WHERE "id" = $1`, doomed.id);
      else await q.$queryRawUnsafe(identity, f.memberUser.id);
    }, { timeout: 30_000 });
    await held.p;
    const adding = visitFile(pmcToken, visitId, { nodeId: doomed.id }).then((r) => r);
    // the upload waits on the tree lock, holding no node, file or identity the removal needs next
    expect(await waitingOn(['advisory'])).toBe(true);
    release.open();
    await removal;
    const res = await adding;
    // the place is gone by the time the upload runs: a clear refusal, never a deadlock (500)
    expect(res.status).toBe(400);
  });
});
