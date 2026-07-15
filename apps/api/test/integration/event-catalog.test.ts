import 'reflect-metadata';
import request from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DOMAIN_EVENT_TYPES } from '@vitan/shared';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * Phase 2 Task 4 Step 4 — the catalog is DUAL-WRITTEN. Driving a representative mutation from
 * each pillar through the real HTTP stack, this proves every one ALSO appends its DomainEvent
 * inside the mutation transaction, attributed to the real caller (`human` + real `actorId`),
 * tenant-stamped with the project's org, and ordered by a gap-safe per-project streamPosition —
 * without changing any existing behaviour (the consequence suite proves that separately).
 */
describe('Phase 2 Task 4 — event catalog dual-write (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let pid: string;
  let uid: string;
  let token: string;

  const post = (path: string, body?: unknown) =>
    request(t.app.getHttpServer()).post(path).set('Authorization', `Bearer ${token}`).send(body ?? {});

  const lastEvent = (eventType: string) =>
    t.prisma.domainEvent.findFirst({ where: { projectId: pid, eventType }, orderBy: { streamPosition: 'desc' } });

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    pid = f.projectA.id;
    uid = f.memberUser.id;
    token = t.issueProjectToken(uid, pid, 'pmc');
    await t.prisma.project.update({ where: { id: pid }, data: { scheduleStartDate: new Date('2026-06-01') } });
  });
  afterAll(async () => {
    // clear the domain rows this suite created (append-only DomainEvent + the pillar entities)
    // so the fixture can delete the project; TRUNCATE fires no row trigger and CASCADE handles
    // child rows (options/items/revisions/…). The suite runs serially against a disposable DB.
    await t?.prisma.$executeRawUnsafe('TRUNCATE "Decision","Activity","Phase","Inspection","Drawing","DailyLog","SiteMaterial","Media","DomainEvent" CASCADE');
    await f?.cleanup();
    await t?.close();
  });

  /** Every event a mutation appends is complete, human-attributed and tenant-stamped. */
  const expectWellFormed = (ev: Awaited<ReturnType<typeof lastEvent>>, entityType: string) => {
    expect(ev, 'the mutation appended a domain event').not.toBeNull();
    expect(ev!.entityType).toBe(entityType);
    expect(ev!.actorKind).toBe('human');
    expect(ev!.actorId, 'attributed to the real caller').toBe(uid);
    expect(ev!.systemActor).toBeNull();
    expect(ev!.organizationId, 'tenant-stamped with the project org').toBe(f.orgA.id);
    expect(typeof ev!.streamPosition).toBe('bigint');
  };

  it('a decision issue appends decision.published', async () => {
    const res = await post(`/projects/${pid}/decisions`, {
      title: 'Slab grade', room: 'GF', publish: true,
      options: [{ label: 'A', material: 'M25', delta: 0, swatch: 'marble' }, { label: 'B', material: 'M30', delta: 100, swatch: 'teak' }],
    });
    expect(res.status).toBeLessThan(300);
    expectWellFormed(await lastEvent('decision.published'), 'Decision');
  });

  it('an activity plan appends activity.created', async () => {
    const res = await post(`/projects/${pid}/activities`, { name: 'Wall', zone: 'GF', plannedStart: 0, plannedEnd: 5 });
    expect(res.status).toBeLessThan(300);
    expectWellFormed(await lastEvent('activity.created'), 'Activity');
  });

  it('a phase append appends phase.created', async () => {
    const res = await post(`/projects/${pid}/phases`, { name: 'Foundation', plannedStart: 0, plannedEnd: 10 });
    expect(res.status).toBeLessThan(300);
    expectWellFormed(await lastEvent('phase.created'), 'Phase');
  });

  it('a checklist issue appends inspection.created', async () => {
    const res = await post(`/projects/${pid}/inspections`, { title: 'Rebar check', zone: 'GF', items: ['Spacing', 'Cover'] });
    expect(res.status).toBeLessThan(300);
    expectWellFormed(await lastEvent('inspection.created'), 'Inspection');
  });

  it('a drawing issue appends drawing.issued (and freezing appends drawing.recipients_frozen)', async () => {
    const res = await post(`/projects/${pid}/drawings`, {
      number: 'A-101', title: 'GF Plan', discipline: 'architectural', rev: 'A', status: 'for_construction',
      publish: true, data: Buffer.from('%PDF-1.4 test').toString('base64'), mime: 'application/pdf',
    });
    expect(res.status).toBeLessThan(300);
    expectWellFormed(await lastEvent('drawing.issued'), 'DrawingRevision');
    expectWellFormed(await lastEvent('drawing.recipients_frozen'), 'DrawingRevision');
  });

  it('starting the daily log appends dailylog.started', async () => {
    const res = await post(`/projects/${pid}/daily-log/start`);
    expect(res.status).toBeLessThan(300);
    expectWellFormed(await lastEvent('dailylog.started'), 'DailyLog');
  });

  it('creating a location appends node.created', async () => {
    const res = await post(`/projects/${pid}/nodes`, { kind: 'zone', name: 'Ground Floor', publish: true });
    expect(res.status).toBeLessThan(300);
    expectWellFormed(await lastEvent('node.created'), 'ProjectNode');
  });

  it('every emitted event is in the shared catalog, and the project stream is gap-safe (contiguous, distinct)', async () => {
    const events = await t.prisma.domainEvent.findMany({ where: { projectId: pid }, orderBy: { streamPosition: 'asc' } });
    expect(events.length, 'the pillar mutations above each appended at least one event').toBeGreaterThanOrEqual(7);
    // no event escapes the declared vocabulary
    for (const e of events) expect(DOMAIN_EVENT_TYPES as readonly string[], `${e.eventType} is a catalog member`).toContain(e.eventType);
    // positions are the contiguous run 0..n-1 — no gap, no duplicate
    const positions = events.map((e) => Number(e.streamPosition));
    expect(positions).toEqual(positions.map((_, i) => i));
  });
});
