import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * #482 site photos — an unsent log's photo count has one owner, the photos the project holds: every
 * progress photo from the start of the log's civil day on the site's calendar, whoever added it. Before,
 * the count was a number the engineer's device kept and sent, so a photo another member added never
 * reached it (#916 review). A sent log shows the count it was sent with. Proven through the real snapshot
 * route against PostgreSQL.
 *
 * Reproduce-first: on ee345e3 the snapshot serves the stored `progress` (7) in the unsent probes below.
 */
describe('an unsent log\'s photo count is the photos taken since its day began (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let pmc: string;
  const pid = () => f.projectA.id;
  const logId = () => `${pid()}-pc-log`;
  const snapshot = async () =>
    (await request(t.app.getHttpServer()).get(`/projects/${pid()}/snapshot`).set('Authorization', `Bearer ${pmc}`).expect(200)).body;
  const photo = (label: string, createdAt: string, kind = 'progress') =>
    t.prisma.media.create({ data: { id: `${pid()}-pc-${label}`, projectId: pid(), kind, mime: 'image/png', uploadedBy: f.memberUser.id, createdAt: new Date(createdAt) } });

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    pmc = t.issueProjectToken(f.memberUser.id, pid(), 'pmc');
    await t.prisma.project.update({ where: { id: pid() }, data: { timeZone: 'Asia/Kolkata' } });
    await t.prisma.dailyLog.create({ data: { id: logId(), projectId: pid(), date: '02 Jun 2026', logDate: new Date('2026-06-02'), checkedIn: true, submitted: false, progress: 7 } });
  });

  afterAll(async () => {
    await t?.prisma.media.deleteMany({ where: { projectId: f?.projectA.id } });
    await t?.prisma.dailyLog.deleteMany({ where: { projectId: f?.projectA.id } });
    await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor', 'MembershipTransition'], { cascade: true });
    await f?.cleanup();
    await t?.close();
  });

  it('counts the progress photos from the start of the log\'s civil day, by the site\'s clock, from any member', async () => {
    // 2 Jun in India begins at 1 Jun 18:30Z
    await photo('before', '2026-06-01T18:29:00Z'); // 1 Jun, 23:59 IST
    await photo('first', '2026-06-01T18:30:00Z'); // 2 Jun, 00:00 IST
    await photo('noon', '2026-06-02T06:30:00Z');
    await photo('inspection', '2026-06-02T06:30:00Z', 'inspection');
    expect((await snapshot()).dailyLog.progress).toBe(2);
  });

  it('keeps counting while the log is unsent: a photo taken the next day, before it is sent, is on it', async () => {
    await photo('next-day', '2026-06-03T04:00:00Z');
    expect((await snapshot()).dailyLog.progress).toBe(3);
  });

  it('shows a sent log\'s count as it was sent', async () => {
    await t.prisma.dailyLog.update({ where: { id: logId() }, data: { submitted: true } });
    expect((await snapshot()).dailyLog.progress).toBe(7);
  });

  it('keeps the stored count for a log with no civil day, which no window can be drawn for', async () => {
    await t.prisma.dailyLog.update({ where: { id: logId() }, data: { submitted: false, logDate: null } });
    expect((await snapshot()).dailyLog.progress).toBe(7);
  });
});
