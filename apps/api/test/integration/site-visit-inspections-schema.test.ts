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
 * walked during a site visit (who linked it, in which role, their name as they stood, and when), one row per inspection. No server or screen writes it yet; this
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
  const link = (projectId: string, visitId: string, inspectionId: string, by = f.memberUser.id, role = 'pmc') =>
    t.prisma.siteVisitInspection.create({ data: { projectId, visitId, inspectionId, linkedById: by, linkedByRole: role } });
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
      INSERT INTO "SiteVisitInspection" ("projectId","visitId","inspectionId","linkedById","linkedByRole","linkedAt")
      VALUES (${f.projectA.id}, ${visitA}, ${other}, ${f.memberUser.id}, 'pmc', '2020-01-01')`;
    const stamped = await t.prisma.siteVisitInspection.findUniqueOrThrow({ where: { inspectionId: other } });
    expect(stamped.linkedAt.getUTCFullYear()).toBeGreaterThan(2020);
    const listed = await t.prisma.siteVisit.findUniqueOrThrow({ where: { id: visitA }, select: { inspections: { select: { inspectionId: true } } } });
    expect(listed.inspections.map((r) => r.inspectionId).sort()).toEqual([id, other].sort());
  });

  it('an inspection was walked on at most one visit: another visit cannot take it, nor the same one twice', async () => {
    const id = await inspection();
    await link(f.projectA.id, visitA, id);
    await expect(link(f.projectA.id, visitB, id, consultant, 'consultant')).rejects.toThrow(/Unique constraint/i);
    await expect(t.prisma.$executeRaw`
      INSERT INTO "SiteVisitInspection" ("projectId","visitId","inspectionId","linkedById","linkedByRole")
      VALUES (${f.projectA.id}, ${visitA}, ${id}, ${f.memberUser.id}, 'pmc')`).rejects.toThrow(/23505|unique constraint|SiteVisitInspection_pkey/i);
  });

  it('freezes who linked it, as they stood: their role is checked on the project and their name copied', async () => {
    const id = await inspection();
    const row = await t.prisma.$queryRaw<Array<{ linkedByName: string }>>`
      INSERT INTO "SiteVisitInspection" ("projectId","visitId","inspectionId","linkedById","linkedByRole","linkedByName")
      VALUES (${f.projectA.id}, ${visitB}, ${id}, ${consultant}, 'consultant', 'Someone else') RETURNING "linkedByName"`;
    expect(row[0]!.linkedByName).toBe('Meera (Consultant)');
    // a role the linker does not hold, a user of another project, and a blank role are refused
    await expect(link(f.projectA.id, visitB, await inspection(), consultant, 'pmc')).rejects.toThrow(/does not hold role pmc/);
    await expect(link(f.projectA.id, visitA, await inspection(), f.otherUser.id, 'pmc')).rejects.toThrow(/does not hold role pmc/);
    await expect(link(f.projectA.id, visitA, await inspection(), f.memberUser.id, ' ')).rejects.toThrow(/does not hold role|SiteVisitInspection_shape_check/);
  });

  it('is refused on an archived project', async () => {
    const id = await inspection();
    await t.prisma.$executeRaw`UPDATE "Project" SET "archivedAt" = now() WHERE "id" = ${f.projectA.id}`;
    try {
      await expect(link(f.projectA.id, visitA, id)).rejects.toThrow(/is not operable/);
    } finally {
      await t.prisma.$executeRaw`UPDATE "Project" SET "archivedAt" = NULL WHERE "id" = ${f.projectA.id}`;
    }
    expect(await t.prisma.siteVisitInspection.count({ where: { inspectionId: id } })).toBe(0);
  });

  it('never crosses projects: another project\'s inspection, or a visit under another project\'s id, is refused', async () => {
    const foreign = await inspection(f.projectB.id);
    await expect(t.prisma.$executeRaw`
      INSERT INTO "SiteVisitInspection" ("projectId","visitId","inspectionId","linkedById","linkedByRole")
      VALUES (${f.projectA.id}, ${visitA}, ${foreign}, ${f.memberUser.id}, 'pmc')`).rejects.toThrow(/SiteVisitInspection_projectId_inspectionId_fkey/);
    await expect(t.prisma.$executeRaw`
      INSERT INTO "SiteVisitInspection" ("projectId","visitId","inspectionId","linkedById","linkedByRole")
      VALUES (${f.projectB.id}, ${visitA}, ${foreign}, ${f.otherUser.id}, 'pmc')`).rejects.toThrow(/SiteVisitInspection_projectId_visitId_fkey/);
  });

  it('a row is frozen on every writer: not moved to another visit, nor re-attributed, nor re-timed', async () => {
    const id = await inspection();
    await link(f.projectA.id, visitA, id);
    await expect(t.prisma.$executeRaw`UPDATE "SiteVisitInspection" SET "visitId" = ${visitB} WHERE "inspectionId" = ${id}`).rejects.toThrow(frozen);
    await expect(t.prisma.$executeRaw`UPDATE "SiteVisitInspection" SET "linkedById" = ${consultant} WHERE "inspectionId" = ${id}`).rejects.toThrow(frozen);
    await expect(t.prisma.$executeRaw`UPDATE "SiteVisitInspection" SET "linkedAt" = '2020-01-01' WHERE "inspectionId" = ${id}`).rejects.toThrow(frozen);
    await expect(t.prisma.$executeRaw`UPDATE "SiteVisitInspection" SET "linkedByName" = 'Other' WHERE "inspectionId" = ${id}`).rejects.toThrow(frozen);
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

  it('the file re-runs on a database that has it, re-making a lost trigger and check and changing no row', async () => {
    const id = await inspection();
    const row = await link(f.projectA.id, visitA, id);
    await t.prisma.$executeRawUnsafe(`DROP TRIGGER "SiteVisitInspection_frozen" ON "SiteVisitInspection"`);
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "SiteVisitInspection" DROP CONSTRAINT "SiteVisitInspection_shape_check"`);
    replay();
    const objects = await t.prisma.$queryRawUnsafe<Array<{ triggers: number; keys: number }>>(
      `SELECT (SELECT count(*)::int FROM pg_trigger WHERE tgrelid = '"SiteVisitInspection"'::regclass AND NOT tgisinternal) AS triggers,
              (SELECT count(*)::int FROM pg_constraint WHERE conrelid = '"SiteVisitInspection"'::regclass AND contype = 'f') AS keys`);
    expect(objects[0]).toEqual({ triggers: 4, keys: 3 });
    const checks = await t.prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = '"SiteVisitInspection"'::regclass AND conname = 'SiteVisitInspection_shape_check'`);
    expect(checks[0]!.n).toBe(1);
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
      expect(replay).toThrow(/already stands with 8 columns, not 7/);
    } finally {
      await t.prisma.$executeRawUnsafe(`ALTER TABLE "SiteVisitInspection" DROP COLUMN "extra"`);
    }
    // a primary key on other columns is refused
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "SiteVisitInspection" DROP CONSTRAINT "SiteVisitInspection_pkey",
      ADD CONSTRAINT "SiteVisitInspection_pkey" PRIMARY KEY ("projectId", "visitId", "inspectionId")`);
    try {
      expect(replay).toThrow(/primary key \(inspectionId,projectId,visitId\), not \(inspectionId\)/);
    } finally {
      await t.prisma.$executeRawUnsafe(`ALTER TABLE "SiteVisitInspection" DROP CONSTRAINT "SiteVisitInspection_pkey",
        ADD CONSTRAINT "SiteVisitInspection_pkey" PRIMARY KEY ("inspectionId")`);
    }
    // a key under the right name with another delete action is replaced
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "SiteVisitInspection" DROP CONSTRAINT "SiteVisitInspection_projectId_inspectionId_fkey",
      ADD CONSTRAINT "SiteVisitInspection_projectId_inspectionId_fkey" FOREIGN KEY ("projectId", "inspectionId") REFERENCES "Inspection"("projectId", "id")`);
    replay();
    const actions = await t.prisma.$queryRawUnsafe<Array<{ conname: string; confdeltype: string }>>(
      `SELECT conname, confdeltype::text FROM pg_constraint WHERE conrelid = '"SiteVisitInspection"'::regclass AND contype = 'f' ORDER BY conname`);
    expect(actions).toEqual([
      { conname: 'SiteVisitInspection_linkedById_fkey', confdeltype: 'r' },
      { conname: 'SiteVisitInspection_projectId_inspectionId_fkey', confdeltype: 'c' },
      { conname: 'SiteVisitInspection_projectId_visitId_fkey', confdeltype: 'c' },
    ]);
  });

  it('a row goes with its visit (a project removal disables the visit\'s own delete guard, as here)', async () => {
    const id = await inspection();
    await link(f.projectA.id, visitB, id, consultant, 'consultant');
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "SiteVisit" DISABLE TRIGGER "SiteVisit_no_delete"`);
    try {
      await t.prisma.$executeRaw`DELETE FROM "SiteVisit" WHERE "id" = ${visitB}`;
    } finally {
      await t.prisma.$executeRawUnsafe(`ALTER TABLE "SiteVisit" ENABLE TRIGGER "SiteVisit_no_delete"`);
    }
    expect(await t.prisma.siteVisitInspection.count({ where: { visitId: visitB } })).toBe(0);
  });
});
