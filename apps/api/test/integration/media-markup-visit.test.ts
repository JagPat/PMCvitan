import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * Stage 1 photo markup, site visits first (Jagrut, 19 Oct 2026: "yes to all" on the media plan): a marked-up copy of a
 * photo on a visit is uploaded as a NEW visit file naming the photo it was drawn on. The original is kept as it was, the
 * copy takes its camera time and location, and only someone who may add a file to the visit may add the copy.
 * Proven through the real upload route against PostgreSQL.
 */
describe('Stage 1 markup — a marked-up copy on a site visit (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const run = randomUUID().slice(0, 8);
  const extra: string[] = [];
  let pmcToken: string;
  let consultantToken: string;
  let engineerToken: string;
  let visitId: string;
  let otherVisitId: string;
  let originalId: string;
  const px = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');

  const http = () => request(t.app.getHttpServer());
  const visits = () => `/projects/${f.projectA.id}/site-visits`;
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const upload = (token: string, body: Record<string, unknown>) =>
    http().post(`/projects/${f.projectA.id}/media`).set('Authorization', `Bearer ${token}`).send({ mime: 'image/png', data: px, ...body });
  const visitFile = (token: string, visit: string, body: Record<string, unknown> = {}, siteVisit: Record<string, unknown> = {}) =>
    upload(token, { kind: 'visit', siteVisit: { visitId: visit, ...siteVisit }, ...body });
  const member = async (role: 'consultant' | 'engineer') => {
    const id = `mkv-${role}-${run}`;
    extra.push(id);
    await t.prisma.user.create({ data: { id, projectId: f.projectA.id, role, name: `Sam (${role})`, email: `${id}@t.local` } });
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: id, role, status: 'active' } });
    return id;
  };

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    await t.prisma.$executeRaw`UPDATE "Project" SET "createdAt" = now() - interval '30 days' WHERE "id" = ${f.projectA.id}`;
    const consultant = await member('consultant');
    const engineer = await member('engineer');
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    consultantToken = t.issueProjectToken(consultant, f.projectA.id, 'consultant');
    engineerToken = t.issueProjectToken(engineer, f.projectA.id, 'engineer');
    // the PMC's visit, with the consultant present; the consultant's own visit beside it
    visitId = randomUUID();
    expect((await http().post(visits()).set('Authorization', `Bearer ${pmcToken}`).send({ id: visitId, claimedAt: ago(30) })).status).toBe(201);
    expect((await http().post(`${visits()}/${visitId}/attendees`).set('Authorization', `Bearer ${pmcToken}`)
      .send({ id: randomUUID(), userId: consultant, role: 'consultant' })).status).toBe(201);
    otherVisitId = randomUUID();
    expect((await http().post(visits()).set('Authorization', `Bearer ${consultantToken}`).send({ id: otherVisitId, claimedAt: ago(20) })).status).toBe(201);
    const original = await visitFile(pmcToken, visitId, { takenAt: '19 Oct 2026 · 10:05 AM', geoLat: 23.03, geoLng: 72.51 }, { note: 'East wall' });
    expect(original.status).toBe(201);
    originalId = original.body.id;
  });

  afterAll(async () => {
    if (t) {
      await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor',
        'SiteVisitMedia', 'SiteVisitPlace', 'SiteVisitAttendee', 'SiteVisit'], { cascade: true });
      await t.prisma.media.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] }, sourceMediaId: { not: null } } });
      await t.prisma.media.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
      await t.prisma.membership.deleteMany({ where: { userId: { in: extra } } });
      await t.prisma.user.deleteMany({ where: { id: { in: extra } } });
    }
    await f?.cleanup();
    await t?.close();
  });

  it('someone present adds a marked-up copy: a new visit file linked to the original, with its camera time and place', async () => {
    const res = await visitFile(consultantToken, visitId, { sourceMediaId: originalId }, { note: 'Crack circled' });
    expect(res.status).toBe(201);
    expect(res.body.id).not.toBe(originalId);
    const copy = await t.prisma.media.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(copy).toMatchObject({ kind: 'visit', sourceMediaId: originalId, takenAt: '19 Oct 2026 · 10:05 AM', geoLat: 23.03, geoLng: 72.51, uploadedBy: extra[0] });
    const link = await t.prisma.siteVisitMedia.findUniqueOrThrow({ where: { mediaId: res.body.id } });
    expect(link).toMatchObject({ visitId, note: 'Crack circled', addedByRole: 'consultant' });
    // the original is kept exactly as it was
    expect(await t.prisma.media.findUniqueOrThrow({ where: { id: originalId }, select: { sourceMediaId: true, takenAt: true } }))
      .toEqual({ sourceMediaId: null, takenAt: '19 Oct 2026 · 10:05 AM' });
  });

  it('a copy is only of a file on the same visit, and only by someone who may add to that visit', async () => {
    // a file of another visit, or none at all
    const elsewhere = await visitFile(consultantToken, otherVisitId);
    expect(elsewhere.status).toBe(201);
    expect((await visitFile(pmcToken, visitId, { sourceMediaId: elsewhere.body.id })).status).toBe(404);
    expect((await visitFile(pmcToken, visitId, { sourceMediaId: 'no-such-file' })).status).toBe(404);
    // a site photo that is on no visit
    const site = await upload(pmcToken, { kind: 'progress' });
    expect(site.status).toBe(201);
    expect((await visitFile(pmcToken, visitId, { sourceMediaId: site.body.id })).status).toBe(404);
    // the engineer is not on the PMC's visit
    const key = `mkv-refused-${run}`;
    expect((await visitFile(engineerToken, visitId, { sourceMediaId: originalId, clientKey: key })).status).toBe(403);
    expect(await t.prisma.media.count({ where: { projectId: f.projectA.id, clientKey: key } })).toBe(0);
  });

  it('a copy is never anything but a visit file, and never resends a camera time or location', async () => {
    expect((await upload(pmcToken, { kind: 'progress', sourceMediaId: originalId })).status).toBe(400);
    for (const extraBody of [{ takenAt: '20 Oct 2026 · 9:00 AM' }, { geoLat: 1 }, { geoLng: 1 }]) {
      expect((await visitFile(pmcToken, visitId, { sourceMediaId: originalId, ...extraBody })).status).toBe(400);
    }
    expect((await visitFile(pmcToken, visitId, { sourceMediaId: '   ' })).status).toBe(400);
  });

  it('a closed visit takes no copy', async () => {
    const photo = await visitFile(consultantToken, otherVisitId);
    expect(photo.status).toBe(201);
    expect((await http().post(`${visits()}/${otherVisitId}/close`).set('Authorization', `Bearer ${pmcToken}`).send({ reason: 'Left open' })).status).toBe(201);
    const key = `mkv-closed-${run}`;
    expect((await visitFile(consultantToken, otherVisitId, { sourceMediaId: photo.body.id, clientKey: key })).status).toBe(409);
    expect(await t.prisma.media.count({ where: { projectId: f.projectA.id, clientKey: key } })).toBe(0);
  });
});
