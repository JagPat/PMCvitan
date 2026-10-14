import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
import { DecisionsQueryService } from '../../src/decisions/decisions.query';
import { readViewerFeed, servedNotifications } from '../../src/snapshot/served-notifications';
import { treeLockKey } from '../../src/common/tree-lock';
import { readinessLockKey } from '../../src/common/readiness-lock';
import type { Role } from '../../src/common/auth';

/**
 * Site Visits (#792) SV1-b, unit 1 — the commands that start, end and close a visit, the members' read, and the
 * visit notices in the feed. The database rules themselves are SV1-a's (`site-visits-sv1a.test.ts`); this proves
 * the server asks them first (a clear 4xx), writes each act with its event and notice, and takes its locks in one
 * order so two valid acts never deadlock (#834).
 */
describe('Site Visits SV1-b — start, end and close (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const run = randomUUID().slice(0, 8);
  const extraUsers: string[] = [];
  let consultant: string;
  let place: { id: string; name: string };
  let draft: string;
  let otherSitePlace: string;
  let pmcToken: string;
  let consultantToken: string;
  let clientToken: string;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    // the start window is [max(receipt − 7 days, project start), receipt]; give project A a month of history
    await t.prisma.$executeRaw`UPDATE "Project" SET "createdAt" = now() - interval '30 days' WHERE "id" = ${f.projectA.id}`;
    consultant = `sv1b-cons-${run}`;
    extraUsers.push(consultant);
    await t.prisma.user.create({ data: { id: consultant, projectId: f.projectA.id, role: 'consultant', name: 'Meera (Consultant)', email: `${consultant}@t.local` } });
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: consultant, role: 'consultant', status: 'active' } });
    const node = (projectId: string, name: string, published = true) => t.prisma.projectNode.create({
      data: { projectId, name, kind: 'zone', order: 0, authorId: f.memberUser.id, publishedAt: published ? new Date() : null },
    });
    const a = await node(f.projectA.id, `Tower A ${run}`);
    place = { id: a.id, name: a.name };
    draft = (await node(f.projectA.id, `Draft ${run}`, false)).id;
    otherSitePlace = (await node(f.projectB.id, `Other site ${run}`)).id;
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    consultantToken = t.issueProjectToken(consultant, f.projectA.id, 'consultant');
    clientToken = t.issueProjectToken(f.clientUser.id, f.projectA.id, 'client');
  });

  afterAll(async () => {
    // the record is immutable; the disposable test DB clears it by the sanctioned reset, before the users it names
    if (t) {
      await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor',
        'SiteVisitPlace', 'SiteVisitAttendee', 'SiteVisit'], { cascade: true });
      await t.prisma.membership.deleteMany({ where: { userId: { in: extraUsers } } });
      await t.prisma.user.deleteMany({ where: { id: { in: extraUsers } } });
    }
    await f?.cleanup();
    await t?.close();
  });

  const http = () => request(t.app.getHttpServer());
  const base = () => `/projects/${f.projectA.id}/site-visits`;
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const start = (token: string, body: Record<string, unknown>, key?: string) => {
    const r = http().post(base()).set('Authorization', `Bearer ${token}`);
    return (key ? r.set('Idempotency-Key', key) : r).send(body);
  };
  const end = (token: string, visitId: string, claimedAt = ago(1)) =>
    http().post(`${base()}/${visitId}/end`).set('Authorization', `Bearer ${token}`).send({ claimedAt });
  const close = (token: string, visitId: string, reason = 'Left open overnight') =>
    http().post(`${base()}/${visitId}/close`).set('Authorization', `Bearer ${token}`).send({ reason });
  const eventsOf = (visitId: string) => t.prisma.domainEvent.findMany({
    where: { entityType: 'SiteVisit', entityId: visitId }, orderBy: { streamPosition: 'asc' },
    select: { eventType: true, actorRole: true, actorName: true, payload: true },
  });
  const noticesOf = async (visitId: string) => {
    const evs = await t.prisma.domainEvent.findMany({ where: { entityType: 'SiteVisit', entityId: visitId }, select: { eventId: true } });
    return t.prisma.notification.findMany({ where: { eventId: { in: evs.map((e) => e.eventId) } }, select: { kind: true } });
  };
  /** Finish a visitor's open visit so the next test can start one (S2: one open visit per visitor). */
  const finish = async (token: string, visitId: string) => expect((await end(token, visitId)).status).toBe(201);

  it('the PMC starts a visit with no place and a device location; it is read back with its event and notice', async () => {
    const id = randomUUID();
    const res = await start(pmcToken, { id, claimedAt: ago(5), location: { lat: 23.03, lng: 72.58, accuracyM: 12, at: ago(5) } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id, visitorId: f.memberUser.id, visitorRole: 'pmc', status: 'open', startTimeAdjusted: false, startPlace: null,
      location: { kind: 'device', lat: 23.03, lng: 72.58, accuracyM: 12, approximate: false },
    });
    expect(res.body.visitorName).not.toBe('');
    const evs = await eventsOf(id);
    expect(evs.map((e) => [e.eventType, e.actorRole, e.actorName])).toEqual([['sitevisit.started', 'pmc', res.body.visitorName]]);
    expect(await noticesOf(id)).toEqual([{ kind: 'sitevisit.started' }]);
    // every member reads it, the client included
    const list = await http().get(base()).set('Authorization', `Bearer ${clientToken}`);
    expect(list.status).toBe(200);
    expect(list.body.find((v: { id: string }) => v.id === id)).toMatchObject({ id, status: 'open' });
    await finish(pmcToken, id);
  });

  it('a consultant starts a visit at a published place; its name is frozen, and a poor fix reads as approximate', async () => {
    const id = randomUUID();
    const res = await start(consultantToken, { id, claimedAt: ago(2), nodeId: place.id, location: { lat: 23.03, lng: 72.58, accuracyM: 250, at: ago(2) } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ visitorRole: 'consultant', startPlace: { nodeId: place.id, name: place.name }, location: { approximate: true } });
    expect((await eventsOf(id))[0]?.payload).toEqual({ placeName: place.name });
    await finish(consultantToken, id);
  });

  it('a start with no location records "none" and is never blocked (Q6); a claim from the future is replaced by the receipt', async () => {
    const id = randomUUID();
    const res = await start(pmcToken, { id, claimedAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ location: { kind: 'none' }, startTimeAdjusted: true });
    await finish(pmcToken, id);
  });

  it('refuses: a second open visit (S2), a reused id, a draft or another project\'s place, and roles that do not visit', async () => {
    const id = randomUUID();
    expect((await start(pmcToken, { id, claimedAt: ago(1) })).status).toBe(201);
    expect((await start(pmcToken, { id: randomUUID(), claimedAt: ago(1) })).status).toBe(409);
    await finish(pmcToken, id);
    expect((await start(consultantToken, { id, claimedAt: ago(1) })).status).toBe(409);
    expect((await start(pmcToken, { id: randomUUID(), claimedAt: ago(1), nodeId: draft })).status).toBe(400);
    expect((await start(pmcToken, { id: randomUUID(), claimedAt: ago(1), nodeId: otherSitePlace })).status).toBe(400);
    expect((await start(clientToken, { id: randomUUID(), claimedAt: ago(1) })).status).toBe(403);
    expect((await start(pmcToken, { id: randomUUID(), claimedAt: 'yesterday' })).status).toBe(400);
    expect((await start(pmcToken, { id: randomUUID(), claimedAt: ago(1), location: { lat: 23, lng: 72, accuracyM: -1, at: ago(1) } })).status).toBe(400);
    // nothing was written by any refusal
    expect(await t.prisma.siteVisit.count({ where: { projectId: f.projectA.id, visitorId: f.memberUser.id, status: 'open' } })).toBe(0);
  });

  it('a device id written in capitals is stored lowercase, and the device can end the visit by it (Codex 4265859188)', async () => {
    const id = randomUUID();
    const res = await start(pmcToken, { id: id.toUpperCase(), claimedAt: ago(1) });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(id);
    expect((await end(pmcToken, id.toUpperCase())).status).toBe(201);
  });

  it('the visit list pages back through every visit, newest first (Codex 4265859179)', async () => {
    for (let i = 0; i < 3; i += 1) {
      const id = randomUUID();
      expect((await start(consultantToken, { id, claimedAt: ago(40 + i) })).status).toBe(201);
      await finish(consultantToken, id);
    }
    const page = (query: string) => http().get(`${base()}${query}`).set('Authorization', `Bearer ${clientToken}`);
    const all = await page('?limit=200');
    expect(all.status).toBe(200);
    const ids: string[] = all.body.map((v: { id: string }) => v.id);
    expect(ids.length).toBeGreaterThanOrEqual(3);
    const walked: string[] = [];
    let before: string | undefined;
    for (;;) {
      const res = await page(`?limit=2${before ? `&before=${before}` : ''}`);
      expect(res.status).toBe(200);
      if (res.body.length === 0) break;
      walked.push(...res.body.map((v: { id: string }) => v.id));
      before = walked[walked.length - 1];
    }
    expect(walked).toEqual(ids);
    expect((await page(`?before=${randomUUID()}`)).status).toBe(404);
    expect((await page('?limit=0')).status).toBe(400);
    expect((await page('?limit=201')).status).toBe(400);
  });

  it('`status=open` lists every open visit whatever its age, so a screen knows who is on site beyond its first page (#874)', async () => {
    const open = randomUUID();
    expect((await start(consultantToken, { id: open, claimedAt: ago(60 * 24 * 3) })).status).toBe(201);
    const ended = randomUUID();
    expect((await start(pmcToken, { id: ended, claimedAt: ago(5) })).status).toBe(201);
    await finish(pmcToken, ended);
    const res = await http().get(`${base()}?status=open&limit=200`).set('Authorization', `Bearer ${clientToken}`);
    expect(res.status).toBe(200);
    const listed: { id: string; status: string }[] = res.body;
    expect(listed.map((v) => v.id)).toContain(open);
    expect(listed.map((v) => v.id)).not.toContain(ended);
    expect(listed.every((v) => v.status === 'open')).toBe(true);
    expect((await http().get(`${base()}?status=ended`).set('Authorization', `Bearer ${clientToken}`)).status).toBe(400);
    await finish(consultantToken, open);
  });

  it('an open page continues past a visit that ended between pages (Codex 4276569151)', async () => {
    const older = randomUUID();
    expect((await start(consultantToken, { id: older, claimedAt: ago(60 * 24 * 4) })).status).toBe(201);
    const newer = randomUUID();
    expect((await start(pmcToken, { id: newer, claimedAt: ago(60 * 24 * 2) })).status).toBe(201);
    const page = (query: string) => http().get(`${base()}${query}`).set('Authorization', `Bearer ${clientToken}`);
    const first: string[] = (await page('?status=open&limit=200')).body.map((v: { id: string }) => v.id);
    expect(first.indexOf(newer)).toBeLessThan(first.indexOf(older));
    // the last row of the previous page ends before the next page is asked for
    await finish(pmcToken, newer);
    const next = await page(`?status=open&before=${newer}`);
    expect(next.status).toBe(200);
    expect(next.body.map((v: { id: string }) => v.id)).toContain(older);
    await finish(consultantToken, older);
  });

  it('a retried start with the same Idempotency-Key lands once', async () => {
    const id = randomUUID();
    const key = `sv1b-${randomUUID()}`;
    const body = { id, claimedAt: ago(1) };
    expect((await start(pmcToken, body, key)).status).toBe(201);
    const again = await start(pmcToken, body, key);
    expect(again.status).toBe(201);
    expect(again.body.id).toBe(id);
    expect(await eventsOf(id)).toHaveLength(1);
    await finish(pmcToken, id);
  });

  it('only the visitor ends their visit, once; the end is paired with its event and notice', async () => {
    const id = randomUUID();
    expect((await start(consultantToken, { id, claimedAt: ago(10) })).status).toBe(201);
    expect((await end(pmcToken, id)).status).toBe(403);
    const ended = await end(consultantToken, id, ago(3));
    expect(ended.status).toBe(201);
    expect(ended.body).toMatchObject({ status: 'ended', endTimeAdjusted: false });
    expect((await end(consultantToken, id)).status).toBe(409);
    expect((await eventsOf(id)).map((e) => e.eventType)).toEqual(['sitevisit.started', 'sitevisit.ended']);
    expect((await noticesOf(id)).map((n) => n.kind).sort()).toEqual(['sitevisit.ended', 'sitevisit.started']);
    expect((await end(consultantToken, randomUUID())).status).toBe(404);
  });

  it('the PMC closes a visit left open (S1); the visitor\'s later end is recorded as a late end and the close stands', async () => {
    const id = randomUUID();
    expect((await start(consultantToken, { id, claimedAt: ago(30) })).status).toBe(201);
    expect((await close(consultantToken, id)).status).toBe(403);
    const closed = await close(pmcToken, id, 'Visitor left without ending');
    expect(closed.status).toBe(201);
    expect(closed.body).toMatchObject({ status: 'closed', closedById: f.memberUser.id, closeReason: 'Visitor left without ending', lateEndedAt: null });
    expect((await close(pmcToken, id)).status).toBe(409);
    const late = await end(consultantToken, id, ago(20));
    expect(late.status).toBe(201);
    expect(late.body.status).toBe('closed');
    expect(late.body.lateEndedAt).not.toBeNull();
    // the read says whether the late end kept its claim or was recorded at its receipt (Codex 4265859183)
    expect(closed.body.lateEndTimeAdjusted).toBeNull();
    expect(late.body.lateEndTimeAdjusted).toBe(false);
    expect((await end(consultantToken, id)).status).toBe(409);
    const evs = await eventsOf(id);
    expect(evs.map((e) => [e.eventType, e.actorRole])).toEqual([
      ['sitevisit.started', 'consultant'], ['sitevisit.closed', 'pmc'], ['sitevisit.late_end_recorded', 'consultant'],
    ]);
    expect(evs[1]?.payload).toEqual({ visitorName: evs[0]?.actorName });
  });

  it('every member is served the visit notices, rendered from their events (F50)', async () => {
    const id = randomUUID();
    expect((await start(consultantToken, { id, claimedAt: ago(4), nodeId: place.id })).status).toBe(201);
    const name = (await eventsOf(id))[0]!.actorName!;
    expect((await close(pmcToken, id)).status).toBe(201);
    const decisionsQuery = t.app.get(DecisionsQueryService);
    const viewers: Array<[Role, string]> = [['pmc', f.memberUser.id], ['client', f.clientUser.id], ['consultant', consultant]];
    for (const [role, userId] of viewers) {
      const served = servedNotifications(await readViewerFeed(t.prisma, decisionsQuery, f.projectA.id, role, userId), role, userId, decisionsQuery);
      const texts = served.map((n) => n.text);
      expect(texts).toContain(`Site visit started: ${name} — ${place.name}`);
      expect(texts).toContain(`Site visit closed by the PMC: ${name}`);
    }
  });

  // ── #834: the lock order ─────────────────────────────────────────────────────────────────────

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

  it('#834 (Codex 4260951368): a start at a place waits behind the same PMC\'s node write, which then takes their identity without deadlock', async () => {
    // A node writer's order: the tree lock, the node row, then (at its event) the actor's identity.
    const held = gate();
    const release = gate();
    const writer = t.prisma.$transaction(async (q) => {
      await q.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, treeLockKey(f.projectA.id));
      await q.$executeRawUnsafe(`SELECT 1 FROM "ProjectNode" WHERE "id" = $1 FOR UPDATE`, place.id);
      held.open();
      await release.p;
      await q.$executeRawUnsafe(`SELECT 1 FROM "UserIdentity" WHERE "userId" = $1 FOR UPDATE`, f.memberUser.id);
    }, { timeout: 30_000 });
    await held.p;
    const id = randomUUID();
    const starting = start(pmcToken, { id, claimedAt: ago(1), nodeId: place.id }).then((r) => r);
    // the start waits (on the tree lock), and must hold nothing the writer needs next
    expect(await waitingOn(['advisory', 'transactionid', 'tuple'])).toBe(true);
    release.open();
    await writer;
    const res = await starting;
    expect(res.status).toBe(201);
    expect(res.body.startPlace).toEqual({ nodeId: place.id, name: place.name });
    await finish(pmcToken, id);
  });

  it('#834 (Codex 4260951386): a visit act waits behind the same PMC\'s membership change, which locks identity before the project row', async () => {
    // A membership command's order: the readiness lock, the actor's identity (its envelope), then the project row
    // (its transition seal's operability check) — the reverse of a visit act's project-then-identity.
    const held = gate();
    const release = gate();
    const membership = t.prisma.$transaction(async (q) => {
      await q.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, readinessLockKey(f.projectA.id));
      await q.$executeRawUnsafe(`SELECT 1 FROM "UserIdentity" WHERE "userId" = $1 FOR UPDATE`, f.memberUser.id);
      held.open();
      await release.p;
      await q.$queryRawUnsafe(`SELECT phase6_project_operable($1)`, f.projectA.id);
    }, { timeout: 30_000 });
    await held.p;
    const id = randomUUID();
    const starting = start(pmcToken, { id, claimedAt: ago(1) }).then((r) => r);
    expect(await waitingOn(['advisory', 'transactionid', 'tuple'])).toBe(true);
    release.open();
    await membership;
    expect((await starting).status).toBe(201);
    await finish(pmcToken, id);
  });

  it('a start waits behind an archive holding the project row, which then takes the same PMC\'s identity without deadlock', async () => {
    // An archive's order: the project row, then (at its event) the actor's identity.
    const held = gate();
    const release = gate();
    const archive = t.prisma.$transaction(async (q) => {
      await q.$executeRawUnsafe(`SELECT 1 FROM "Project" WHERE "id" = $1 FOR UPDATE`, f.projectA.id);
      held.open();
      await release.p;
      await q.$executeRawUnsafe(`SELECT 1 FROM "UserIdentity" WHERE "userId" = $1 FOR UPDATE`, f.memberUser.id);
    }, { timeout: 30_000 });
    await held.p;
    const id = randomUUID();
    const starting = start(pmcToken, { id, claimedAt: ago(1) }).then((r) => r);
    expect(await waitingOn(['transactionid', 'tuple'])).toBe(true);
    release.open();
    await archive;
    expect((await starting).status).toBe(201);
    await finish(pmcToken, id);
  });
});
