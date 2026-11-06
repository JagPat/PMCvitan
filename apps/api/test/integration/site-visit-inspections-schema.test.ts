import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * Guided site inspections, step 3b: `20280212000000_site_visit_inspections` adds "SiteVisitInspection", an inspection
 * walked during a site visit (who linked it, and when), one row per inspection. No server or screen writes it yet; this
 * proves what PostgreSQL holds on every writer, and that the file re-runs.
 */
const MIGRATION = join(__dirname, '../../prisma/migrations/20280212000000_site_visit_inspections/migration.sql');

describe('guided inspections: inspections walked on a site visit (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let visitA: string;
  let visitB: string;
  let consultant: string;
  const made: string[] = [];
  const run = randomUUID().slice(0, 8);

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    await t.prisma.$executeRaw`UPDATE "Project" SET "createdAt" = now() - interval '30 days' WHERE "id" = ${f.projectA.id}`;
    visitA = randomUUID();
    const started = await request(t.app.getHttpServer())
      .post(`/projects/${f.projectA.id}/site-visits`)
      .set('Authorization', `Bearer ${t.issueProjectToken(f.memberUser.id, f.projectA.id)}`)
      .send({ id: visitA, claimedAt: new Date(Date.now() - 30 * 60_000).toISOString() });
    expect(started.status).toBe(201);
    consultant = `svi-cons-${run}`;
    await t.prisma.user.create({ data: { id: consultant, projectId: f.projectA.id, role: 'consultant', name: 'Meera (Consultant)', email: `${consultant}@t.local` } });
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: consultant, role: 'consultant', status: 'active' } });
    visitB = randomUUID();
    const second = await request(t.app.getHttpServer())
      .post(`/projects/${f.projectA.id}/site-visits`)
      .set('Authorization', `Bearer ${t.issueProjectToken(consultant, f.projectA.id, 'consultant')}`)
      .send({ id: visitB, claimedAt: new Date(Date.now() - 20 * 60_000).toISOString() });
    expect(second.status).toBe(201);
  });

  afterAll(async () => {
    if (t) {
      await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor',
        'SiteVisitInspection', 'SiteVisitFileRemoval', 'SiteVisitMedia', 'SiteVisitPlace', 'SiteVisitAttendee', 'SiteVisit'], { cascade: true });
      await t.prisma.inspection.deleteMany({ where: { id: { in: made } } });
      await t.prisma.membership.deleteMany({ where: { userId: consultant } });
      await t.prisma.user.deleteMany({ where: { id: consultant } });
    }
    await f?.cleanup();
    await t?.close();
  });

  const inspection = async (projectId = f.projectA.id) => {
    const id = `svi-${run}-${made.length}`;
    made.push(id);
    await t.prisma.inspection.create({ data: { id, projectId, kind: 'review', title: 'Slab check', zone: 'Zone A', date: '6 Nov' } });
    return id;
  };
  const link = (projectId: string, visitId: string, inspectionId: string, by = f.memberUser.id) =>
    t.prisma.siteVisitInspection.create({ data: { projectId, visitId, inspectionId, linkedById: by } });
  const url = (process.env.DATABASE_URL ?? '').split('?')[0]!;
  const replay = () => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url, '-f', MIGRATION], { stdio: 'pipe' });
  const frozen = /is a record and is not changed/;
  const kept = /part of the visit record/;

  it('an inspection of the visit\'s own project goes on the visit, stamped by the database, and the visit lists it', async () => {
    const id = await inspection();
    const before = Date.now();
    const row = await link(f.projectA.id, visitA, id);
    expect(row).toMatchObject({ projectId: f.projectA.id, visitId: visitA, inspectionId: id, linkedById: f.memberUser.id });
    expect(row.linkedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    // a time the writer sends is not kept: the database stamps its own receipt
    const other = await inspection();
    await t.prisma.$executeRaw`
      INSERT INTO "SiteVisitInspection" ("projectId","visitId","inspectionId","linkedById","linkedAt")
      VALUES (${f.projectA.id}, ${visitA}, ${other}, ${f.memberUser.id}, '2020-01-01')`;
    const stamped = await t.prisma.siteVisitInspection.findUniqueOrThrow({ where: { inspectionId: other } });
    expect(stamped.linkedAt.getUTCFullYear()).toBeGreaterThan(2020);
    const listed = await t.prisma.siteVisit.findUniqueOrThrow({ where: { id: visitA }, select: { inspections: { select: { inspectionId: true } } } });
    expect(listed.inspections.map((r) => r.inspectionId).sort()).toEqual([id, other].sort());
  });

  it('an inspection was walked on at most one visit: another visit cannot take it, nor the same one twice', async () => {
    const id = await inspection();
    await link(f.projectA.id, visitA, id);
    await expect(link(f.projectA.id, visitB, id, consultant)).rejects.toThrow(/Unique constraint/i);
    await expect(t.prisma.$executeRaw`
      INSERT INTO "SiteVisitInspection" ("projectId","visitId","inspectionId","linkedById")
      VALUES (${f.projectA.id}, ${visitA}, ${id}, ${f.memberUser.id})`).rejects.toThrow(/23505|unique constraint|SiteVisitInspection_pkey/i);
  });

  it('never crosses projects: another project\'s inspection, or a visit under another project\'s id, is refused', async () => {
    const foreign = await inspection(f.projectB.id);
    await expect(t.prisma.$executeRaw`
      INSERT INTO "SiteVisitInspection" ("projectId","visitId","inspectionId","linkedById")
      VALUES (${f.projectA.id}, ${visitA}, ${foreign}, ${f.memberUser.id})`).rejects.toThrow(/SiteVisitInspection_projectId_inspectionId_fkey/);
    await expect(t.prisma.$executeRaw`
      INSERT INTO "SiteVisitInspection" ("projectId","visitId","inspectionId","linkedById")
      VALUES (${f.projectB.id}, ${visitA}, ${foreign}, ${f.memberUser.id})`).rejects.toThrow(/SiteVisitInspection_projectId_visitId_fkey/);
  });

  it('a row is frozen on every writer: not moved to another visit, nor re-attributed, nor re-timed', async () => {
    const id = await inspection();
    await link(f.projectA.id, visitA, id);
    await expect(t.prisma.$executeRaw`UPDATE "SiteVisitInspection" SET "visitId" = ${visitB} WHERE "inspectionId" = ${id}`).rejects.toThrow(frozen);
    await expect(t.prisma.$executeRaw`UPDATE "SiteVisitInspection" SET "linkedById" = ${consultant} WHERE "inspectionId" = ${id}`).rejects.toThrow(frozen);
    await expect(t.prisma.$executeRaw`UPDATE "SiteVisitInspection" SET "linkedAt" = '2020-01-01' WHERE "inspectionId" = ${id}`).rejects.toThrow(frozen);
    await expect(t.prisma.siteVisitInspection.update({ where: { inspectionId: id }, data: { visitId: visitB } })).rejects.toThrow(frozen);
  });

  it('a row is never deleted or truncated on its own; it goes with its inspection', async () => {
    const id = await inspection();
    await link(f.projectA.id, visitA, id);
    await expect(t.prisma.$executeRaw`DELETE FROM "SiteVisitInspection" WHERE "inspectionId" = ${id}`).rejects.toThrow(kept);
    await expect(t.prisma.siteVisitInspection.delete({ where: { inspectionId: id } })).rejects.toThrow(kept);
    await expect(t.prisma.$executeRawUnsafe(`TRUNCATE "SiteVisitInspection"`)).rejects.toThrow(/never truncated/);
    // the inspection's own delete (a project's removal) cascades below trigger depth 1
    await t.prisma.inspection.delete({ where: { id } });
    expect(await t.prisma.siteVisitInspection.count({ where: { inspectionId: id } })).toBe(0);
  });

  it('the file re-runs on a database that has it, changing nothing', async () => {
    const id = await inspection();
    const row = await link(f.projectA.id, visitA, id);
    replay();
    const objects = await t.prisma.$queryRawUnsafe<Array<{ triggers: number; keys: number }>>(
      `SELECT (SELECT count(*)::int FROM pg_trigger WHERE tgrelid = '"SiteVisitInspection"'::regclass AND NOT tgisinternal) AS triggers,
              (SELECT count(*)::int FROM pg_constraint WHERE conrelid = '"SiteVisitInspection"'::regclass AND contype = 'f') AS keys`);
    expect(objects[0]).toEqual({ triggers: 4, keys: 3 });
    expect(await t.prisma.siteVisitInspection.findUniqueOrThrow({ where: { inspectionId: id } })).toEqual(row);
    await expect(t.prisma.$executeRaw`UPDATE "SiteVisitInspection" SET "visitId" = ${visitB} WHERE "inspectionId" = ${id}`).rejects.toThrow(frozen);
  });

  it('a table standing with another shape is refused, not kept', async () => {
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "SiteVisitInspection" ALTER COLUMN "linkedById" DROP NOT NULL`);
    try {
      expect(replay).toThrow(/SiteVisitInspection.linkedById already stands as text \(not null: f\)/);
    } finally {
      await t.prisma.$executeRawUnsafe(`ALTER TABLE "SiteVisitInspection" ALTER COLUMN "linkedById" SET NOT NULL`);
    }
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "SiteVisitInspection" ADD COLUMN "extra" TEXT`);
    try {
      expect(replay).toThrow(/already stands with 6 columns, not 5/);
    } finally {
      await t.prisma.$executeRawUnsafe(`ALTER TABLE "SiteVisitInspection" DROP COLUMN "extra"`);
    }
  });
});
