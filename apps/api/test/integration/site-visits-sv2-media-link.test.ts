import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * Site Visits (#792) SV2, the database half of "media on a visit": `20280114000000_site_visits_sv2_visit_media` adds
 * "SiteVisitMedia", one row per file a visitor adds on a visit (with an optional note of at most 500 characters and an optional Fine / Concern / Action needed rating).
 * No server or screen writes it yet; this proves what PostgreSQL holds on every writer, and that the file re-runs.
 */
const MIGRATION = join(__dirname, '../../prisma/migrations/20280114000000_site_visits_sv2_visit_media/migration.sql');

describe('Site Visits SV2 — files on a visit (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let visitA: string;

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
  });

  afterAll(async () => {
    if (t) {
      await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor',
        'SiteVisitMedia', 'SiteVisitPlace', 'SiteVisitAttendee', 'SiteVisit'], { cascade: true });
      await t.prisma.media.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
    }
    await f?.cleanup();
    await t?.close();
  });

  const photo = (projectId: string) => t.prisma.media.create({
    data: { projectId, kind: 'progress', mime: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff]), sizeBytes: 3, uploadedBy: f.memberUser.id },
  });
  const link = (projectId: string, visitId: string, mediaId: string, note?: string) => t.prisma.siteVisitMedia.create({
    data: { projectId, visitId, mediaId, note, addedById: f.memberUser.id },
  });

  it('a file in the visit\'s own project goes on the visit with a note, and the visit lists it', async () => {
    const m = await photo(f.projectA.id);
    const row = await link(f.projectA.id, visitA, m.id, 'Crack above the lintel, east wall');
    expect(row).toMatchObject({ visitId: visitA, mediaId: m.id, note: 'Crack above the lintel, east wall', addedById: f.memberUser.id });
    expect(row.addedAt).toBeInstanceOf(Date);
    const listed = await t.prisma.siteVisit.findUnique({ where: { id: visitA }, select: { media: { select: { mediaId: true } } } });
    expect(listed?.media.map((r) => r.mediaId)).toEqual([m.id]);
    expect((await link(f.projectA.id, visitA, (await photo(f.projectA.id)).id)).note).toBeNull();
  });

  it('a file belongs to at most one visit', async () => {
    const m = await photo(f.projectA.id);
    await link(f.projectA.id, visitA, m.id);
    await expect(link(f.projectA.id, visitA, m.id)).rejects.toThrow(/Unique constraint|SiteVisitMedia_pkey/i);
  });

  it('no writer can put another project\'s file on a visit, or a file on another project\'s visit', async () => {
    const other = await photo(f.projectB.id);
    await expect(link(f.projectA.id, visitA, other.id)).rejects.toThrow(/SiteVisitMedia_projectId_mediaId_fkey|Foreign key/i);
    await expect(link(f.projectB.id, visitA, other.id)).rejects.toThrow(/SiteVisitMedia_projectId_visitId_fkey|Foreign key/i);
    await expect(t.prisma.$executeRaw`
      INSERT INTO "SiteVisitMedia" ("projectId","visitId","mediaId","addedById")
      VALUES (${f.projectA.id}, ${visitA}, ${other.id}, ${f.memberUser.id})`)
      .rejects.toThrow(/SiteVisitMedia_projectId_mediaId_fkey|foreign key/i);
    await expect(link(f.projectA.id, randomUUID(), (await photo(f.projectA.id)).id)).rejects.toThrow(/SiteVisitMedia_projectId_visitId_fkey|Foreign key/i);
  });

  it('a note holds 500 characters and refuses a 501st', async () => {
    expect((await link(f.projectA.id, visitA, (await photo(f.projectA.id)).id, 'x'.repeat(500))).note).toHaveLength(500);
    await expect(link(f.projectA.id, visitA, (await photo(f.projectA.id)).id, 'x'.repeat(501))).rejects.toThrow();
  });

  it('a file carries a Fine / Concern / Action needed rating or none, and nothing else', async () => {
    for (const rating of ['fine', 'concern', 'action_needed'] as const) {
      const row = await t.prisma.siteVisitMedia.create({
        data: { projectId: f.projectA.id, visitId: visitA, mediaId: (await photo(f.projectA.id)).id, rating, addedById: f.memberUser.id },
      });
      expect(row.rating).toBe(rating);
    }
    expect((await link(f.projectA.id, visitA, (await photo(f.projectA.id)).id)).rating).toBeNull();
    const m = await photo(f.projectA.id);
    await expect(t.prisma.$executeRaw`
      INSERT INTO "SiteVisitMedia" ("projectId","visitId","mediaId","rating","addedById")
      VALUES (${f.projectA.id}, ${visitA}, ${m.id}, 'urgent'::"SiteVisitRating", ${f.memberUser.id})`)
      .rejects.toThrow(/invalid input value for enum/i);
  });

  it('removing the file removes it from the visit, and the visit stays', async () => {
    const m = await photo(f.projectA.id);
    await link(f.projectA.id, visitA, m.id);
    await t.prisma.media.delete({ where: { id: m.id } });
    expect(await t.prisma.siteVisitMedia.findUnique({ where: { mediaId: m.id } })).toBeNull();
    expect(await t.prisma.siteVisit.findUnique({ where: { id: visitA }, select: { id: true } })).toEqual({ id: visitA });
  });

  it('the migration re-runs as a no-op on a database that already has it', async () => {
    const before = await t.prisma.siteVisitMedia.count({ where: { visitId: visitA } });
    await t.prisma.$executeRawUnsafe(readFileSync(MIGRATION, 'utf8'));
    await t.prisma.$executeRawUnsafe(readFileSync(MIGRATION, 'utf8'));
    expect(await t.prisma.siteVisitMedia.count({ where: { visitId: visitA } })).toBe(before);
    const fks = await t.prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM pg_constraint WHERE conrelid = '"SiteVisitMedia"'::regclass AND contype = 'f'`;
    expect(Number(fks[0].n)).toBe(3);
    const labels = await t.prisma.$queryRaw<Array<{ l: string }>>`
      SELECT enumlabel AS l FROM pg_enum WHERE enumtypid = 'public."SiteVisitRating"'::regtype ORDER BY enumsortorder`;
    expect(labels.map((r) => r.l)).toEqual(['fine', 'concern', 'action_needed']);
  });
});
