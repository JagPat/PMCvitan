import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * Real civil dates over real PostgreSQL (Phase 0 Task 6): latest-log selection
 * crosses a YEAR boundary correctly because it orders by the civil day column,
 * never a display string or the creation instant alone.
 */
describe('real dates (integration)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    await t.prisma.project.update({
      where: { id: f.projectA.id },
      data: { scheduleStartDate: new Date('2026-06-01T00:00:00.000Z'), timeZone: 'Asia/Kolkata' },
    });
  });

  afterAll(async () => {
    await t.prisma.dailyLog.deleteMany({ where: { projectId: f.projectA.id } });
    await t.prisma.activity.deleteMany({ where: { projectId: f.projectA.id } });
    await f?.cleanup();
    await t?.close();
  });

  it('latest-log selection crosses a year boundary (2026-12-31 vs 2027-01-01), independent of labels and creation order', async () => {
    // created in REVERSE order (the January log first) with lexically-tricky labels —
    // logDate must decide, not createdAt and never the display string
    await t.prisma.dailyLog.create({
      data: { projectId: f.projectA.id, date: '01 Jan 2027', logDate: new Date('2027-01-01T00:00:00.000Z'), createdAt: new Date('2027-01-01T04:00:00.000Z') },
    });
    await t.prisma.dailyLog.create({
      data: { projectId: f.projectA.id, date: '31 Dec 2026', logDate: new Date('2026-12-31T00:00:00.000Z'), createdAt: new Date('2027-01-02T09:00:00.000Z') },
    });

    const token = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    const res = await request(t.app.getHttpServer())
      .get(`/projects/${f.projectA.id}/snapshot`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.dailyLog.logDate).toBe('2027-01-01');
    expect(res.body.dailyLog.date).toBe('01 Jan 2027');
    expect(res.body.project.scheduleStartDate).toBe('2026-06-01');
  });

  it('starting an activity records the server civil date in the project zone — never todayDay', async () => {
    const act = await t.prisma.activity.create({
      data: { id: `it-act-date-${Date.now()}`, projectId: f.projectA.id, name: 'Datable', zone: 'GF', plannedStart: 0, plannedEnd: 2, order: 50, gateMaterial: 'na', gateTeam: 'na', gateInspection: 'na' },
    });
    const token = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    await request(t.app.getHttpServer())
      .post(`/projects/${f.projectA.id}/activities/${act.id}/start`)
      .set('Authorization', `Bearer ${token}`)
      .expect(201);

    const after = await t.prisma.activity.findUniqueOrThrow({ where: { id: act.id } });
    const todayIST = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date());
    expect(after.actualStartDate?.toISOString().slice(0, 10)).toBe(todayIST);
    // the legacy offset stays coherent (derived from the anchor), not copied from todayDay (0 here)
    const expectedOffset = Math.round((new Date(`${todayIST}T00:00:00Z`).getTime() - new Date('2026-06-01T00:00:00Z').getTime()) / 86_400_000);
    expect(after.actualStart).toBe(expectedOffset);
  });
});
