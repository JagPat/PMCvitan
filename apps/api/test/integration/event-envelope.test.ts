import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { emitEvent, type EmitInput } from '../../src/platform/events';
import type { Actor } from '../../src/common/actor';

/**
 * Phase 2 Task 4 — the DomainEvent envelope, proven against live PostgreSQL.
 *
 * The event + its gap-safe stream position + the mutation commit in ONE transaction; ordering
 * is (projectId, streamPosition), NEVER occurredAt; the tenant key cannot be forged; the
 * attribution truth table is a CHECK; the store is append-only at the database; and a project
 * always has its stream counter (and cannot emit without one). These are the Step-1 probes.
 */
describe('Phase 2 Task 4 — domain-event envelope (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const human: Actor = { actorId: '', actorName: 'Priya (PMC)', actorRole: 'pmc', actorKind: 'human' };

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    human.actorId = f.memberUser.id;
  });
  afterAll(async () => {
    await t?.prisma.$executeRawUnsafe('TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor"');
    await f?.cleanup();
    await t?.close();
  });

  /** emit one event inside a real interactive transaction, like a command would. */
  const emit = (over: Partial<EmitInput> = {}) =>
    t.prisma.$transaction((tx) =>
      emitEvent(tx, { projectId: f.projectA.id, actor: human, eventType: 'decision.approved', entityType: 'Decision', entityId: 'D-1', effectKey: 'decision.approved', dispatch: {}, ...over }),
    );

  const streamOf = (projectId: string) => t.prisma.projectEventStream.findUnique({ where: { projectId } });

  it('appends a COMPLETE, tenant-derived envelope in one transaction (organizationId is the project’s real org)', async () => {
    const { eventId } = await emit({ entityId: 'D-complete', payload: { title: 'Slab grade' } });
    const ev = await t.prisma.domainEvent.findUniqueOrThrow({ where: { eventId } });
    expect(ev.organizationId, 'org is DERIVED from the project, never passed by the caller').toBe(f.orgA.id);
    expect(ev.projectId).toBe(f.projectA.id);
    expect(ev.eventType).toBe('decision.approved');
    expect(ev.payloadVersion).toBe(1);
    expect(ev.actorId).toBe(f.memberUser.id);
    expect(ev.actorKind).toBe('human');
    expect(ev.systemActor).toBeNull();
    expect(ev.entityType).toBe('Decision');
    expect(ev.entityId).toBe('D-complete');
    expect(ev.payload).toEqual({ title: 'Slab grade' });
    expect(ev.occurredAt).toBeInstanceOf(Date);
    expect(typeof ev.streamPosition).toBe('bigint');
  });

  it('a system actor writes actorKind=system + systemActor (and null actorId)', async () => {
    const sys: Actor = { actorId: 'system:migrator', actorName: 'Migration', actorRole: 'system', actorKind: 'system' };
    const { eventId } = await emit({ actor: sys, entityId: 'D-sys' });
    const ev = await t.prisma.domainEvent.findUniqueOrThrow({ where: { eventId } });
    expect(ev.actorKind).toBe('system');
    expect(ev.systemActor).toBe('system:migrator');
    expect(ev.actorId).toBeNull();
  });

  it('a rolled-back mutation writes NO event and does NOT advance the stream position', async () => {
    const before = (await streamOf(f.projectA.id))!.nextPosition;
    await expect(
      t.prisma.$transaction(async (tx) => {
        await emitEvent(tx, { projectId: f.projectA.id, actor: human, eventType: 'decision.approved', entityType: 'Decision', entityId: 'D-rollback', effectKey: 'decision.approved', dispatch: {} });
        throw new Error('boom'); // the command failed after emitting — everything rolls back
      }),
    ).rejects.toThrow('boom');
    const after = (await streamOf(f.projectA.id))!.nextPosition;
    expect(after, 'the counter is not advanced by a rolled-back emit').toBe(before);
    expect(await t.prisma.domainEvent.count({ where: { projectId: f.projectA.id, entityId: 'D-rollback' } })).toBe(0);
  });

  it('concurrent emits get DISTINCT, CONTIGUOUS, gap-safe positions (no skip, no duplicate)', async () => {
    const base = (await streamOf(f.projectA.id))!.nextPosition;
    const N = 6;
    // Fire N emits concurrently; the counter row-lock serializes them, so a transaction that
    // committed earlier gets the lower position and none is ever skipped past.
    const results = await Promise.all(Array.from({ length: N }, (_, i) => emit({ entityId: `D-conc-${i}` })));
    const positions = results.map((r) => Number(r.streamPosition)).sort((a, b) => a - b);
    const expected = Array.from({ length: N }, (_, i) => Number(base) + i);
    expect(positions, 'positions are exactly the contiguous run — distinct, ordered, no gap').toEqual(expected);
    expect(new Set(positions).size).toBe(N);
  });

  it('two events at the SAME (projectId, streamPosition) are rejected — position is the identity, not occurredAt', async () => {
    // identical occurredAt, distinct positions coexist and order deterministically by position…
    const at = '2026-07-15 09:00:00';
    const max = Number((await streamOf(f.projectA.id))!.nextPosition) + 500;
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","actorKind","systemActor","entityType","entityId","occurredAt") VALUES ('ev-tie-a','x',1,'${f.orgA.id}','${f.projectA.id}',${max},'system','system:seed','Decision','a','${at}'),('ev-tie-b','x',1,'${f.orgA.id}','${f.projectA.id}',${max + 1},'system','system:seed','Decision','b','${at}')`,
    );
    const ordered = await t.prisma.domainEvent.findMany({ where: { eventId: { in: ['ev-tie-a', 'ev-tie-b'] } }, orderBy: { streamPosition: 'asc' } });
    expect(ordered.map((e) => e.eventId)).toEqual(['ev-tie-a', 'ev-tie-b']);
    // …but two events cannot share a position.
    await expect(
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","actorKind","systemActor","entityType","entityId") VALUES ('ev-dup','x',1,'${f.orgA.id}','${f.projectA.id}',${max},'system','system:seed','Decision','d')`,
      ),
    ).rejects.toThrow(/unique|duplicate|already exists/i);
  });

  it('a forged tenant (organizationId that is not the project’s org) is rejected by the composite FK', async () => {
    // projectA belongs to orgA; claiming orgB is rejected.
    await expect(
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","actorKind","systemActor","entityType","entityId") VALUES ('ev-forge','x',1,'${f.orgB.id}','${f.projectA.id}',90001,'system','system:seed','Decision','x')`,
      ),
    ).rejects.toThrow(/foreign key|constraint/i);
    // control: the project's REAL org is accepted at the same position slot.
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","actorKind","systemActor","entityType","entityId") VALUES ('ev-real','x',1,'${f.orgA.id}','${f.projectA.id}',90001,'system','system:seed','Decision','x')`,
    );
    expect((await t.prisma.domainEvent.findUnique({ where: { eventId: 'ev-real' } }))?.organizationId).toBe(f.orgA.id);
  });

  it('the attribution truth table is a CHECK — invalid kind / human-without-actorId / system-without-systemActor all reject', async () => {
    const ins = (id: string, cols: string) =>
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","entityType","entityId",${cols.split('=')[0]}) VALUES ('${id}','x',1,'${f.orgA.id}','${f.projectA.id}',${90100 + id.length},'Decision','x',${cols.split('=')[1]})`,
      );
    // invalid actorKind
    await expect(ins('ev-badkind', `"actorKind"='robot'`)).rejects.toThrow(/constraint|check/i);
    // human with null actorId (actorId omitted → NULL)
    await expect(ins('ev-humannull', `"actorKind"='human'`)).rejects.toThrow(/constraint|check/i);
    // system with null systemActor
    await expect(ins('ev-sysnull', `"actorKind"='system'`)).rejects.toThrow(/constraint|check/i);
  });

  it('the store is APPEND-ONLY — UPDATE and DELETE on a domain event are refused by the database', async () => {
    const { eventId } = await emit({ entityId: 'D-immutable' });
    await expect(t.prisma.$executeRawUnsafe(`UPDATE "DomainEvent" SET "eventType"='tampered' WHERE "eventId"='${eventId}'`)).rejects.toThrow(/append-only/i);
    await expect(t.prisma.$executeRawUnsafe(`DELETE FROM "DomainEvent" WHERE "eventId"='${eventId}'`)).rejects.toThrow(/append-only/i);
    // the row is untouched
    expect((await t.prisma.domainEvent.findUnique({ where: { eventId } }))?.eventType).toBe('decision.approved');
  });

  it('every project has its stream counter, and a project WITHOUT one cannot emit', async () => {
    // The AFTER INSERT trigger created a counter for projectA at creation.
    expect(await streamOf(f.projectA.id)).not.toBeNull();
    // A project whose counter was removed cannot emit (the invariant that guards gap-safety).
    const tmpOrg = await t.prisma.org.create({ data: { id: `it-ev-org-${Date.now() % 1e6}`, name: 'Tmp', slug: `it-ev-org-${Date.now() % 1e6}` } });
    const tmp = await t.prisma.project.create({
      data: { id: `it-ev-nostream-${Date.now() % 1e6}`, orgId: tmpOrg.id, name: 'Tmp', short: 'T', descriptor: '', stage: 'x', siteCode: 'T', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    });
    expect(await streamOf(tmp.id), 'the trigger auto-created its counter on insert').not.toBeNull();
    await t.prisma.projectEventStream.delete({ where: { projectId: tmp.id } });
    await expect(
      t.prisma.$transaction((tx) => emitEvent(tx, { projectId: tmp.id, actor: human, eventType: 'project.created', entityType: 'Project', entityId: tmp.id, effectKey: 'project.created', dispatch: {} })),
    ).rejects.toThrow();
    await t.prisma.project.delete({ where: { id: tmp.id } });
    await t.prisma.org.delete({ where: { id: tmpOrg.id } });
  });
});
