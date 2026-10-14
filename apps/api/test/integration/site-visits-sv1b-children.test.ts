import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
import { treeLockKey } from '../../src/common/tree-lock';

/**
 * Site Visits (#792) SV1-b, unit 2 — the visitor adds and retires the places walked and the people present. The
 * database rules are SV1-a's (`site-visits-sv1a.test.ts`); this proves the server asks them first (a clear 4xx),
 * writes each change with its one event naming the row, returns the rows with the visit, and takes the tree lock
 * before the visit row so a place add never deadlocks against a node removal.
 */
describe('Site Visits SV1-b unit 2 — places and attendees (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const run = randomUUID().slice(0, 8);
  const extraUsers: string[] = [];
  let consultant: string;
  let place: { id: string; name: string };
  let second: { id: string; name: string };
  let draft: string;
  let pmcToken: string;
  let consultantToken: string;
  let clientToken: string;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    await t.prisma.$executeRaw`UPDATE "Project" SET "createdAt" = now() - interval '30 days' WHERE "id" = ${f.projectA.id}`;
    consultant = `sv1b2-cons-${run}`;
    extraUsers.push(consultant);
    await t.prisma.user.create({ data: { id: consultant, projectId: f.projectA.id, role: 'consultant', name: 'Meera (Consultant)', email: `${consultant}@t.local` } });
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: consultant, role: 'consultant', status: 'active' } });
    const node = async (name: string, published = true) => {
      const n = await t.prisma.projectNode.create({
        data: { projectId: f.projectA.id, name, kind: 'zone', order: 0, authorId: f.memberUser.id, publishedAt: published ? new Date() : null },
      });
      return { id: n.id, name: n.name };
    };
    place = await node(`Tower A ${run}`);
    second = await node(`Tower B ${run}`);
    draft = (await node(`Draft ${run}`, false)).id;
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    consultantToken = t.issueProjectToken(consultant, f.projectA.id, 'consultant');
    clientToken = t.issueProjectToken(f.clientUser.id, f.projectA.id, 'client');
  });

  afterAll(async () => {
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
  const post = (token: string, path: string, body: Record<string, unknown> = {}, key?: string) => {
    const r = http().post(`${base()}${path}`).set('Authorization', `Bearer ${token}`);
    return (key ? r.set('Idempotency-Key', key) : r).send(body);
  };
  const startVisit = async (token: string, minutesAgo = 60) => {
    const id = randomUUID();
    expect((await post(token, '', { id, claimedAt: ago(minutesAgo) })).status).toBe(201);
    return id;
  };
  const addPlace = (token: string, visitId: string, nodeId: string, body: Record<string, unknown> = {}, key?: string) =>
    post(token, `/${visitId}/places`, { id: randomUUID(), nodeId, claimedAt: ago(5), ...body }, key);
  const addAttendee = (token: string, visitId: string, body: Record<string, unknown>) =>
    post(token, `/${visitId}/attendees`, { id: randomUUID(), ...body });
  const eventsOf = (visitId: string) => t.prisma.domainEvent.findMany({
    where: { entityType: 'SiteVisit', entityId: visitId }, orderBy: { streamPosition: 'asc' },
    select: { eventId: true, eventType: true, actorRole: true, payload: true },
  });
  const end = (token: string, visitId: string) => post(token, `/${visitId}/end`, { claimedAt: ago(1) });

  it('the visitor adds a place walked and retires it; each change is one event naming the row, with no notice', async () => {
    const visitId = await startVisit(consultantToken);
    const id = randomUUID();
    const added = await addPlace(consultantToken, visitId, place.id, { id, claimedAt: ago(10) });
    expect(added.status).toBe(201);
    expect(added.body.places).toEqual([expect.objectContaining({
      id, nodeId: place.id, name: place.name, addedTimeAdjusted: false, addedAfterEnd: false, retiredAt: null,
    })]);
    const retired = await post(consultantToken, `/${visitId}/places/${id}/retire`);
    expect(retired.status).toBe(201);
    expect(retired.body.places[0].retiredAt).not.toBeNull();
    expect((await post(consultantToken, `/${visitId}/places/${id}/retire`)).status).toBe(409);
    expect((await post(consultantToken, `/${visitId}/places/${randomUUID()}/retire`)).status).toBe(404);
    const evs = await eventsOf(visitId);
    expect(evs.map((e) => [e.eventType, e.actorRole, e.payload])).toEqual([
      ['sitevisit.started', 'consultant', {}],
      ['sitevisit.place_added', 'consultant', { rowId: id, placeName: place.name }],
      ['sitevisit.place_retired', 'consultant', { rowId: id }],
    ]);
    const notices = await t.prisma.notification.findMany({ where: { eventId: { in: evs.map((e) => e.eventId) } }, select: { kind: true } });
    expect(notices).toEqual([{ kind: 'sitevisit.started' }]);
    // the place is free to be added again once retired
    expect((await addPlace(consultantToken, visitId, place.id)).status).toBe(201);
    expect((await end(consultantToken, visitId)).status).toBe(201);
  });

  it('refuses a place that is not the visitor\'s to add, not a published place, already on the visit, or a reused id', async () => {
    const visitId = await startVisit(consultantToken);
    expect((await addPlace(pmcToken, visitId, place.id)).status).toBe(403);
    expect((await addPlace(clientToken, visitId, place.id)).status).toBe(403);
    expect((await addPlace(consultantToken, visitId, draft)).status).toBe(400);
    expect((await addPlace(consultantToken, visitId, `missing-${run}`)).status).toBe(400);
    expect((await addPlace(consultantToken, randomUUID(), place.id)).status).toBe(404);
    const id = randomUUID();
    expect((await addPlace(consultantToken, visitId, place.id, { id })).status).toBe(201);
    expect((await addPlace(consultantToken, visitId, place.id)).status).toBe(409);
    expect((await addPlace(consultantToken, visitId, second.id, { id })).status).toBe(409);
    expect((await addPlace(consultantToken, visitId, second.id, { claimedAt: 'soon' })).status).toBe(400);
    expect((await t.prisma.siteVisitPlace.count({ where: { visitId } }))).toBe(1);
    expect((await end(consultantToken, visitId)).status).toBe(201);
  });

  it('a place added after the end is marked so and recorded at its receipt; a visit the PMC closed takes no change', async () => {
    const ended = await startVisit(consultantToken);
    expect((await end(consultantToken, ended)).status).toBe(201);
    const late = await addPlace(consultantToken, ended, second.id, { claimedAt: ago(30) });
    expect(late.status).toBe(201);
    expect(late.body.places[0]).toMatchObject({ addedAfterEnd: true, addedTimeAdjusted: true });

    const closed = await startVisit(consultantToken);
    const attendee = await addAttendee(consultantToken, closed, { guestName: 'Ravi (site engineer)' });
    expect(attendee.status).toBe(201);
    expect((await post(pmcToken, `/${closed}/close`, { reason: 'Left open' })).status).toBe(201);
    expect((await addPlace(consultantToken, closed, place.id)).status).toBe(409);
    expect((await addAttendee(consultantToken, closed, { guestName: 'Late guest' })).status).toBe(409);
    expect((await post(consultantToken, `/${closed}/attendees/${attendee.body.attendees[0].id}/retire`)).status).toBe(409);
  });

  it('the visitor names a member in a role they hold, or a guest; the name is frozen and the member listed once', async () => {
    const visitId = await startVisit(pmcToken);
    const member = await addAttendee(pmcToken, visitId, { userId: consultant, role: 'consultant' });
    expect(member.status).toBe(201);
    expect(member.body.attendees).toEqual([expect.objectContaining({
      kind: 'member', userId: consultant, role: 'consultant', name: 'Meera (Consultant)', retiredAt: null,
    })]);
    const guest = await addAttendee(pmcToken, visitId, { guestName: '  Ravi (site engineer)  ' });
    expect(guest.status).toBe(201);
    expect(guest.body.attendees[1]).toMatchObject({ kind: 'guest', userId: null, role: null, name: 'Ravi (site engineer)' });

    expect((await addAttendee(pmcToken, visitId, { userId: consultant, role: 'consultant' })).status).toBe(409);
    expect((await addAttendee(pmcToken, visitId, { userId: f.clientUser.id, role: 'consultant' })).status).toBe(400);
    expect((await addAttendee(pmcToken, visitId, { userId: `nobody-${run}`, role: 'client' })).status).toBe(400);
    expect((await addAttendee(pmcToken, visitId, { guestName: '   ' })).status).toBe(400);
    expect((await addAttendee(pmcToken, visitId, { guestName: 'x'.repeat(121) })).status).toBe(400);
    expect((await addAttendee(pmcToken, visitId, { userId: consultant, role: 'consultant', guestName: 'Both' })).status).toBe(400);
    expect((await addAttendee(consultantToken, visitId, { guestName: 'Not my visit' })).status).toBe(403);

    const memberId = member.body.attendees[0].id as string;
    const retired = await post(pmcToken, `/${visitId}/attendees/${memberId}/retire`);
    expect(retired.status).toBe(201);
    expect(retired.body.attendees[0].retiredAt).not.toBeNull();
    // once retired, the same member can be named again
    expect((await addAttendee(pmcToken, visitId, { userId: consultant, role: 'consultant' })).status).toBe(201);
    expect((await eventsOf(visitId)).map((e) => e.eventType)).toEqual([
      'sitevisit.started', 'sitevisit.attendee_added', 'sitevisit.attendee_added', 'sitevisit.attendee_retired', 'sitevisit.attendee_added',
    ]);
    // every member reads the rows with the visit
    const list = await http().get(base()).set('Authorization', `Bearer ${clientToken}`);
    expect(list.body.find((v: { id: string }) => v.id === visitId).attendees).toHaveLength(3);
    expect((await end(pmcToken, visitId)).status).toBe(201);
  });

  it('a retried place add with the same Idempotency-Key lands once', async () => {
    const visitId = await startVisit(pmcToken);
    const key = `sv1b2-${randomUUID()}`;
    const body = { id: randomUUID(), nodeId: place.id, claimedAt: ago(5) };
    expect((await post(pmcToken, `/${visitId}/places`, body, key)).status).toBe(201);
    const again = await post(pmcToken, `/${visitId}/places`, body, key);
    expect(again.status).toBe(201);
    expect(again.body.places).toHaveLength(1);
    expect((await eventsOf(visitId)).filter((e) => e.eventType === 'sitevisit.place_added')).toHaveLength(1);
    expect((await end(pmcToken, visitId)).status).toBe(201);
  });

  // ── the lock order ───────────────────────────────────────────────────────────────────────────

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

  it('a place add waits behind a node removal, which then reaches the visit row through its start place without deadlock', async () => {
    // A node removal's order: the tree lock, then (through `SiteVisit.startNodeId`'s ON DELETE SET NULL) the row of
    // every visit that started at that node. A place add that locked the visit row before the tree lock deadlocked.
    const visitId = randomUUID();
    expect((await post(consultantToken, '', { id: visitId, claimedAt: ago(60), nodeId: place.id })).status).toBe(201);
    const held = gate();
    const release = gate();
    const removal = t.prisma.$transaction(async (q) => {
      await q.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, treeLockKey(f.projectA.id));
      held.open();
      await release.p;
      await q.$executeRawUnsafe(`SELECT 1 FROM "SiteVisit" WHERE "id" = $1 FOR UPDATE`, visitId);
    }, { timeout: 30_000 });
    await held.p;
    const adding = addPlace(consultantToken, visitId, second.id).then((r) => r);
    // the add waits on the tree lock, holding nothing the removal needs next
    expect(await waitingOn(['advisory'])).toBe(true);
    release.open();
    await removal;
    const res = await adding;
    expect(res.status).toBe(201);
    expect(res.body.places[0]).toMatchObject({ nodeId: second.id, name: second.name });
    expect((await end(consultantToken, visitId)).status).toBe(201);
  });
});
