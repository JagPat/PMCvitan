import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * Guided site inspections, step 3a — a PMC checks and decides in ONE walk (proposal decision 1, approved by Jagrut
 * 5 Nov 2026). `POST …/inspections/:id/finish` submits the walk's results and decides them in one command: no item
 * failed → approved; any failed → rejected with exactly the failed items and one re-inspection, by default re-checked
 * by the PMC who walked it. The submit's rules hold (the evidence rule above all), and anyone else's walk is still a
 * submit to the PMC's review queue.
 *
 * Reproduce-first: at the base the route does not exist (404), so a PMC's walk takes two commands and can stop between.
 */

describe('guided site inspections step 3a — check and decide in one walk (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let pmcToken: string;
  let engToken: string;
  let seq = 0;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    engToken = t.issueProjectToken(f.ownerUser.id, f.projectA.id, 'engineer');
    await t.prisma.membership.createMany({
      data: [{ projectId: f.projectA.id, userId: f.ownerUser.id, role: 'engineer', status: 'active' }],
      skipDuplicates: true,
    });
  });

  afterAll(async () => {
    const projectId = f.projectA.id;
    await t.prisma.inspectionEvidence.deleteMany({ where: { projectId } });
    await t.prisma.media.deleteMany({ where: { projectId } });
    await t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "InspectionItem" DISABLE TRIGGER "InspectionItem_guided_not_deleted"');
      await tx.inspectionItem.deleteMany({ where: { inspection: { projectId } } });
      await tx.$executeRawUnsafe('ALTER TABLE "InspectionItem" ENABLE TRIGGER "InspectionItem_guided_not_deleted"');
    });
    // a re-inspection points at its parent: children first
    await t.prisma.inspection.deleteMany({ where: { projectId, reinspectionOfId: { not: null } } });
    await t.prisma.inspection.deleteMany({ where: { projectId } });
    await t.prisma.membership.deleteMany({ where: { projectId, userId: f.ownerUser.id } });
    await f?.cleanup();
    await t?.close();
  });

  const http = () => request(t.app.getHttpServer());
  const post = (token: string, path: string, body: object, key?: string) => {
    const r = http().post(path).set('Authorization', `Bearer ${token}`);
    return (key ? r.set('Idempotency-Key', key) : r).send(body);
  };
  const px = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');

  /** A guided checklist: A asks for 1 photo always, B is plain. */
  const checklist = async (): Promise<{ id: string; A: string; B: string }> => {
    const title = `Walk ${seq++}`;
    const res = await post(pmcToken, `/projects/${f.projectA.id}/inspections`, {
      title, zone: 'GF', workType: 'RCC slab',
      items: [{ name: 'A', lookAt: 'Cover blocks', passRule: 'Gap at least 25 mm', record: { kind: 'photo', count: 1, when: 'always' } }, 'B'],
    });
    expect(res.status).toBe(201);
    const insp = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: f.projectA.id, title }, include: { items: true } });
    const byName = Object.fromEntries(insp.items.map((i) => [i.name, i.id]));
    return { id: insp.id, A: byName.A!, B: byName.B! };
  };
  const photo = (c: { id: string }, itemId: string) => post(pmcToken, `/projects/${f.projectA.id}/media`, {
    kind: 'inspection', mime: 'image/png', data: px, inspectionId: c.id, inspectionItemId: itemId, clientKey: `gi3a-${seq++}`,
  });
  type State = 'pass' | 'fail' | 'na';
  const walk = (c: { id: string; A: string; B: string }, a: State, b: State, extra: object = {}, note = '') => ({
    items: [
      { id: c.A, name: 'A', state: a, photos: 0, note: a === 'fail' ? note : '' },
      { id: c.B, name: 'B', state: b, photos: 0, note: b === 'fail' ? note : '' },
    ],
    ...extra,
  });
  const finish = (token: string, c: { id: string }, body: object, key?: string) =>
    post(token, `/projects/${f.projectA.id}/inspections/${c.id}/finish`, body, key);
  /** the walk's own events (the checklist's creation and its evidence have theirs) */
  const events = (entityId: string) => t.prisma.domainEvent.findMany({
    where: { projectId: f.projectA.id, entityId, eventType: { in: ['inspection.submitted', 'inspection.approved', 'inspection.rejected'] } }, orderBy: { streamPosition: 'asc' },
    select: { eventId: true, eventType: true, causedByEventId: true },
  });

  it('reproduce: a PMC walk with nothing failed is submitted and approved by one command', async () => {
    const c = await checklist();
    expect((await photo(c, c.A)).status).toBe(201);
    const res = await finish(pmcToken, c, walk(c, 'pass', 'na'));
    expect(res.status).toBe(201);
    const insp = await t.prisma.inspection.findUniqueOrThrow({ where: { id: c.id }, include: { items: true } });
    expect(insp).toMatchObject({ submitted: true, decided: true, submittedById: f.memberUser.id, decidedById: f.memberUser.id });
    expect(Object.fromEntries(insp.items.map((i) => [i.name, i.state]))).toEqual({ A: 'pass', B: 'na' });
    expect(await t.prisma.inspection.count({ where: { reinspectionOfId: c.id } })).toBe(0);
    // the approval is caused by the walk's submission, in that order
    const evs = await events(c.id);
    expect(evs.map((e) => e.eventType)).toEqual(['inspection.submitted', 'inspection.approved']);
    expect(evs[1]!.causedByEventId).toBe(evs[0]!.eventId);
  });

  it('a failed item rejects exactly the failed items into one re-check, by default the walking PMC\'s, due in 3 days', async () => {
    const c = await checklist();
    expect((await photo(c, c.A)).status).toBe(201);
    const res = await finish(pmcToken, c, walk(c, 'fail', 'pass', {}, 'Two blocks missing at the east edge'));
    expect(res.status).toBe(201);
    const insp = await t.prisma.inspection.findUniqueOrThrow({ where: { id: c.id }, include: { items: true } });
    expect(insp).toMatchObject({ submitted: true, decided: true });
    expect(Object.fromEntries(insp.items.map((i) => [i.name, i.rejected]))).toEqual({ A: true, B: false });
    const child = await t.prisma.inspection.findFirstOrThrow({ where: { reinspectionOfId: c.id }, include: { items: true } });
    expect(child.assigneeId).toBe(f.memberUser.id);
    expect(child.items.map((i) => i.name)).toEqual(['A']);
    // the re-check carries the guidance the item was issued with
    expect(child.items[0]).toMatchObject({ lookAt: 'Cover blocks', passRule: 'Gap at least 25 mm', recordKind: 'photo', recordCount: 1, recordWhen: 'always' });
    const days = Math.round((child.dueDate!.getTime() - child.inspectionDate!.getTime()) / 86_400_000);
    expect(days).toBe(3);
    const evs = await events(c.id);
    expect(evs.map((e) => e.eventType)).toEqual(['inspection.submitted', 'inspection.rejected']);
    expect(evs[1]!.causedByEventId).toBe(evs[0]!.eventId);
  });

  it('the re-check can be named to an engineer, with its own due date', async () => {
    const c = await checklist();
    await photo(c, c.A);
    const res = await finish(pmcToken, c, walk(c, 'pass', 'fail', { assigneeId: f.ownerUser.id, dueInDays: 5 }, 'Cracked'));
    // B is plain: a failed plain item needs a linked recording too
    expect(res.status).toBe(400);
    await photo(c, c.B);
    const ok = await finish(pmcToken, c, walk(c, 'pass', 'fail', { assigneeId: f.ownerUser.id, dueInDays: 5 }, 'Cracked'));
    expect(ok.status).toBe(201);
    const child = await t.prisma.inspection.findFirstOrThrow({ where: { reinspectionOfId: c.id }, include: { items: true } });
    expect(child.assigneeId).toBe(f.ownerUser.id);
    expect(child.items.map((i) => i.name)).toEqual(['B']);
    expect(Math.round((child.dueDate!.getTime() - child.inspectionDate!.getTime()) / 86_400_000)).toBe(5);
  });

  it('the submit\'s rules hold: a guided pass without its recording is refused and nothing is written', async () => {
    const c = await checklist();
    const res = await finish(pmcToken, c, walk(c, 'pass', 'pass'));
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('These items need the recordings they ask for before you can submit: A (1 photo)');
    const insp = await t.prisma.inspection.findUniqueOrThrow({ where: { id: c.id }, include: { items: true } });
    expect(insp).toMatchObject({ submitted: false, decided: false });
    expect(insp.items.every((i) => i.state === null)).toBe(true);
    expect(await events(c.id)).toEqual([]);
  });

  it('an ineligible re-checker refuses the whole walk: nothing is submitted', async () => {
    const c = await checklist();
    await photo(c, c.A);
    const res = await finish(pmcToken, c, walk(c, 'fail', 'pass', { assigneeId: f.strangerUser.id }, 'Missing'));
    expect(res.status).toBe(400);
    const insp = await t.prisma.inspection.findUniqueOrThrow({ where: { id: c.id } });
    expect(insp).toMatchObject({ submitted: false, decided: false });
    expect(await t.prisma.inspection.count({ where: { reinspectionOfId: c.id } })).toBe(0);
  });

  it('only a PMC finishes a walk; an engineer\'s walk is a submit to the review queue, as before', async () => {
    const c = await checklist();
    await photo(c, c.A);
    expect((await finish(engToken, c, walk(c, 'pass', 'pass'))).status).toBe(403);
    const submitted = await post(engToken, `/projects/${f.projectA.id}/inspections/${c.id}/submit`, walk(c, 'pass', 'pass'));
    expect(submitted.status).toBe(201);
    expect(await t.prisma.inspection.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ submitted: true, decided: false });
    // a submitted checklist is not walked again
    const again = await finish(pmcToken, c, walk(c, 'pass', 'pass'));
    expect(again.status).toBe(400);
    expect(again.body.message).toBe('This checklist has already been submitted and is awaiting review.');
  });

  it('a keyed resend replays without a second re-check; the same key with another walk is refused', async () => {
    const c = await checklist();
    await photo(c, c.A);
    const key = `gi3a-key-${seq++}`;
    const body = walk(c, 'fail', 'pass', {}, 'Missing blocks');
    expect((await finish(pmcToken, c, body, key)).status).toBe(201);
    expect((await finish(pmcToken, c, body, key)).status).toBe(201);
    expect(await t.prisma.inspection.count({ where: { reinspectionOfId: c.id } })).toBe(1);
    expect((await finish(pmcToken, c, walk(c, 'pass', 'pass'), key)).status).toBe(409);
  });

  it('an unknown field is refused at the boundary', async () => {
    const c = await checklist();
    expect((await finish(pmcToken, c, { ...walk(c, 'pass', 'pass'), approve: true })).status).toBe(400);
  });
});
