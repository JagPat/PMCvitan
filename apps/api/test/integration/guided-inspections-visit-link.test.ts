import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
import { SiteVisitInspectionsParticipant } from '../../src/site-visits/site-visit-inspections.participant';

/**
 * Guided site inspections, step 3c — a checklist walked on a site visit is recorded on the visit. A submit or a finish
 * names the visit in the `x-vitan-site-visit` header (so neither body changes shape); in the same transaction the
 * site-visits module writes the visit's line ("SiteVisitInspection", 20280212000000) and the visit's read lists it. Who
 * may: the visitor and anyone recorded as present, while the visit is not closed (a visit's file's rule).
 *
 * Reproduce-first: at the base the header is ignored, so a walk done on a visit is recorded nowhere on it.
 */
describe('guided site inspections step 3c — a walk recorded on its site visit (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let pmcToken: string;
  let engToken: string;
  let consToken: string;
  let visitA: string;
  let consVisit: string;
  let consultant: string;
  let seq = 0;
  let engAttendee: string;
  const run = randomUUID().slice(0, 8);
  const HEADER = 'x-vitan-site-visit';

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    await t.prisma.$executeRaw`UPDATE "Project" SET "createdAt" = now() - interval '30 days' WHERE "id" = ${f.projectA.id}`;
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    engToken = t.issueProjectToken(f.otherUser.id, f.projectA.id, 'engineer');
    await t.prisma.membership.createMany({
      data: [{ projectId: f.projectA.id, userId: f.otherUser.id, role: 'engineer', status: 'active' }],
      skipDuplicates: true,
    });
    consultant = `gi3c-cons-${run}`;
    await t.prisma.user.create({ data: { id: consultant, projectId: f.projectA.id, role: 'consultant', name: 'Meera (Consultant)', email: `${consultant}@t.local` } });
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: consultant, role: 'consultant', status: 'active' } });
    consToken = t.issueProjectToken(consultant, f.projectA.id, 'consultant');
    visitA = randomUUID();
    expect((await http().post(`/projects/${f.projectA.id}/site-visits`).set('Authorization', `Bearer ${pmcToken}`)
      .send({ id: visitA, claimedAt: new Date(Date.now() - 30 * 60_000).toISOString() })).status).toBe(201);
    consVisit = randomUUID();
    expect((await http().post(`/projects/${f.projectA.id}/site-visits`).set('Authorization', `Bearer ${consToken}`)
      .send({ id: consVisit, claimedAt: new Date(Date.now() - 20 * 60_000).toISOString() })).status).toBe(201);
  });

  afterAll(async () => {
    if (t) {
      const projectId = f.projectA.id;
      await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor',
        'SiteVisitInspection', 'SiteVisitFileRemoval', 'SiteVisitMedia', 'SiteVisitPlace', 'SiteVisitAttendee', 'SiteVisit'], { cascade: true });
      await t.prisma.inspectionEvidence.deleteMany({ where: { projectId } });
      await t.prisma.media.deleteMany({ where: { projectId } });
      await t.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('ALTER TABLE "InspectionItem" DISABLE TRIGGER "InspectionItem_guided_not_deleted"');
        await tx.inspectionItem.deleteMany({ where: { inspection: { projectId } } });
        await tx.$executeRawUnsafe('ALTER TABLE "InspectionItem" ENABLE TRIGGER "InspectionItem_guided_not_deleted"');
      });
      await t.prisma.inspection.deleteMany({ where: { projectId, reinspectionOfId: { not: null } } });
      await t.prisma.inspection.deleteMany({ where: { projectId } });
      await t.prisma.membership.deleteMany({ where: { projectId, userId: { in: [f.otherUser.id, consultant] } } });
      await t.prisma.user.deleteMany({ where: { id: consultant } });
    }
    await f?.cleanup();
    await t?.close();
  });

  function http() { return request(t.app.getHttpServer()); }
  const post = (token: string, path: string, body: object, opts: { key?: string; visit?: string } = {}) => {
    let r = http().post(path).set('Authorization', `Bearer ${token}`);
    if (opts.key) r = r.set('Idempotency-Key', opts.key);
    if (opts.visit !== undefined) r = r.set(HEADER, opts.visit);
    return r.send(body);
  };

  /** A plain two-item checklist. */
  const checklist = async (): Promise<{ id: string; A: string; B: string }> => {
    const title = `Visit walk ${run} ${seq++}`;
    expect((await post(pmcToken, `/projects/${f.projectA.id}/inspections`, { title, zone: 'GF', items: ['A', 'B'] })).status).toBe(201);
    const insp = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: f.projectA.id, title }, include: { items: true } });
    const byName = Object.fromEntries(insp.items.map((i) => [i.name, i.id]));
    return { id: insp.id, A: byName.A!, B: byName.B! };
  };
  const walk = (c: { A: string; B: string }) => ({
    items: [
      { id: c.A, name: 'A', state: 'pass', photos: 0, note: '' },
      { id: c.B, name: 'B', state: 'na', photos: 0, note: '' },
    ],
  });
  const finish = (token: string, c: { id: string; A: string; B: string }, opts: { key?: string; visit?: string } = {}) =>
    post(token, `/projects/${f.projectA.id}/inspections/${c.id}/finish`, walk(c), opts);
  const submit = (token: string, c: { id: string; A: string; B: string }, opts: { key?: string; visit?: string } = {}) =>
    post(token, `/projects/${f.projectA.id}/inspections/${c.id}/submit`, walk(c), opts);
  const lineOf = (inspectionId: string) => t.prisma.siteVisitInspection.findUnique({ where: { inspectionId } });
  type VisitRead = { id: string; inspections: Array<{ inspectionId: string; linkedByRole: string; linkedByName: string }> };
  const readVisit = async (token: string, visitId: string): Promise<VisitRead> => {
    const read = await http().get(`/projects/${f.projectA.id}/site-visits`).set('Authorization', `Bearer ${token}`);
    expect(read.status).toBe(200);
    return ((Array.isArray(read.body) ? read.body : read.body.visits) as VisitRead[]).find((v) => v.id === visitId)!;
  };
  /** nothing of a refused request stays: no receipt, no audit line, no event for the checklist */
  const traces = async (inspectionId: string) => ({
    receipts: await t.prisma.commandExecution.count({ where: { resultRef: inspectionId } }),
    events: await t.prisma.domainEvent.count({ where: { entityId: inspectionId, eventType: { not: 'inspection.created' } } }),
  });
  const stateOf = (id: string) => t.prisma.inspection.findUniqueOrThrow({ where: { id }, select: { submitted: true, decided: true } });

  it('reproduce: a PMC\'s walk finished on their visit is recorded on it, and the visit lists it', async () => {
    const c = await checklist();
    const res = await finish(pmcToken, c, { visit: visitA });
    expect(res.status).toBe(201);
    expect(await stateOf(c.id)).toEqual({ submitted: true, decided: true });
    expect(await lineOf(c.id)).toMatchObject({ visitId: visitA, linkedById: f.memberUser.id, linkedByRole: 'pmc' });
    const visit = await readVisit(engToken, visitA);
    expect(visit.inspections).toEqual([expect.objectContaining({ inspectionId: c.id, linkedByRole: 'pmc', linkedByName: expect.any(String) })]);
    // a role the inspections read serves no checklists to sees none on the visit either (gap-check)
    const client = await readVisit(t.issueProjectToken(f.clientUser.id, f.projectA.id, 'client'), visitA);
    expect(client.inspections).toEqual([]);
  });

  it('a walk without the header is recorded on no visit, as before', async () => {
    const c = await checklist();
    expect((await finish(pmcToken, c)).status).toBe(201);
    expect(await lineOf(c.id)).toBeNull();
  });

  it('an engineer not on the visit is refused and nothing is written; once recorded as present, their submit is recorded on it', async () => {
    const c = await checklist();
    const refused = await submit(engToken, c, { visit: visitA });
    expect(refused.status).toBe(403);
    expect(refused.body.message).toMatch(/Only the visitor and the people recorded on this visit/);
    expect(await stateOf(c.id)).toEqual({ submitted: false, decided: false });
    expect(await lineOf(c.id)).toBeNull();
    expect(await traces(c.id)).toEqual({ receipts: 0, events: 0 });
    engAttendee = randomUUID();
    const added = await http().post(`/projects/${f.projectA.id}/site-visits/${visitA}/attendees`).set('Authorization', `Bearer ${pmcToken}`)
      .send({ id: engAttendee, userId: f.otherUser.id, role: 'engineer' });
    expect(added.status).toBe(201);
    const res = await submit(engToken, c, { visit: visitA });
    expect(res.status).toBe(201);
    expect(await stateOf(c.id)).toEqual({ submitted: true, decided: false });
    expect(await lineOf(c.id)).toMatchObject({ visitId: visitA, linkedById: f.otherUser.id, linkedByRole: 'engineer' });
  });

  it('a malformed header is a 400, and a visit that is not this project\'s is a 404, with nothing written', async () => {
    const c = await checklist();
    const bad = await finish(pmcToken, c, { visit: 'not-a-visit' });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/x-vitan-site-visit/);
    expect((await finish(pmcToken, c, { visit: randomUUID() })).status).toBe(404);
    expect(await stateOf(c.id)).toEqual({ submitted: false, decided: false });
    expect(await lineOf(c.id)).toBeNull();
  });

  it('a keyed resend replays with one line; the same key naming another visit is refused', async () => {
    const c = await checklist();
    const key = `gi3c-${run}-${seq++}`;
    const upper = visitA.toUpperCase();
    expect((await finish(pmcToken, c, { key, visit: visitA })).status).toBe(201);
    // the header is taken lower-cased, so the same visit in capitals is the same request
    expect((await finish(pmcToken, c, { key, visit: upper })).status).toBe(201);
    expect(await t.prisma.siteVisitInspection.count({ where: { inspectionId: c.id } })).toBe(1);
    expect((await finish(pmcToken, c, { key, visit: consVisit })).status).toBe(409);
    expect((await finish(pmcToken, c, { key })).status).toBe(409);
    expect(await lineOf(c.id)).toMatchObject({ visitId: visitA });
  });

  it('the check is taken again under the visit\'s lock: with the early answer skipped, the transaction refuses and writes nothing', async () => {
    const visits = t.app.get(SiteVisitInspectionsParticipant);
    const early = visits.assertMayLink;
    visits.assertMayLink = async () => {};
    try {
      // the consultant's visit, with nobody else on it, and a visit that does not exist
      const a = await checklist();
      const off = await submit(engToken, a, { visit: consVisit });
      expect(off.status).toBe(403);
      const b = await checklist();
      expect((await finish(pmcToken, b, { visit: randomUUID() })).status).toBe(404);
      for (const c of [a, b]) {
        expect(await stateOf(c.id)).toEqual({ submitted: false, decided: false });
        expect(await lineOf(c.id)).toBeNull();
        expect(await traces(c.id)).toEqual({ receipts: 0, events: 0 });
      }
    } finally {
      visits.assertMayLink = early;
    }
  });

  it('a retired attendee may no longer record a walk on the visit', async () => {
    const retired = await http().post(`/projects/${f.projectA.id}/site-visits/${visitA}/attendees/${engAttendee}/retire`)
      .set('Authorization', `Bearer ${pmcToken}`).send({});
    expect(retired.status).toBe(201);
    const c = await checklist();
    expect((await submit(engToken, c, { visit: visitA })).status).toBe(403);
    expect(await lineOf(c.id)).toBeNull();
  });

  it('a closed visit takes no walk, and nothing is written', async () => {
    const c = await checklist();
    // the consultant's visit, with the PMC on it, closed by the PMC
    expect((await http().post(`/projects/${f.projectA.id}/site-visits/${consVisit}/attendees`).set('Authorization', `Bearer ${consToken}`)
      .send({ id: randomUUID(), userId: f.memberUser.id, role: 'pmc' })).status).toBe(201);
    const closed = await http().post(`/projects/${f.projectA.id}/site-visits/${consVisit}/close`).set('Authorization', `Bearer ${pmcToken}`)
      .send({ reason: 'Left open by mistake' });
    expect(closed.status).toBe(201);
    const res = await finish(pmcToken, c, { visit: consVisit });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/closed by the PMC/);
    expect(await stateOf(c.id)).toEqual({ submitted: false, decided: false });
    expect(await lineOf(c.id)).toBeNull();
    expect(await traces(c.id)).toEqual({ receipts: 0, events: 0 });
    // under the transaction's lock too
    const visits = t.app.get(SiteVisitInspectionsParticipant);
    const early = visits.assertMayLink;
    visits.assertMayLink = async () => {};
    try {
      expect((await finish(pmcToken, c, { visit: consVisit })).status).toBe(409);
    } finally {
      visits.assertMayLink = early;
    }
    expect(await lineOf(c.id)).toBeNull();
  });

  it('an ended visit still takes a walk (a checklist finished offline lands when the phone finds signal)', async () => {
    const ended = await http().post(`/projects/${f.projectA.id}/site-visits/${visitA}/end`).set('Authorization', `Bearer ${pmcToken}`)
      .send({ claimedAt: new Date().toISOString() });
    expect(ended.status).toBe(201);
    const c = await checklist();
    expect((await finish(pmcToken, c, { visit: visitA })).status).toBe(201);
    expect(await lineOf(c.id)).toMatchObject({ visitId: visitA, linkedByRole: 'pmc' });
  });
});
