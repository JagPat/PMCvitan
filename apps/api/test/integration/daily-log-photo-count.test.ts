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
 * route against PostgreSQL. A log's photos run to its send, and the next log's begin there (#920 review).
 *
 * Reproduce-first: on ee345e3 the snapshot serves the stored `progress` (7) in every probe below but the last; on
 * e2e540f a sent log serves 7 and a later log counts the earlier one's photos.
 */
describe('a log\'s photo count is the photos taken while it was the open log (live PG)', () => {
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

  it('counts a sent log\'s photos up to its send, read from the photos, never the number the device sent', async () => {
    await t.prisma.dailyLog.update({ where: { id: logId() }, data: { submitted: true } });
    const { submittedAt } = await t.prisma.dailyLog.findUniqueOrThrow({ where: { id: logId() }, select: { submittedAt: true } });
    // the device sent 7; the photos say 3
    expect((await snapshot()).dailyLog.progress).toBe(3);
    // an upload that began before the send and committed after it is still this log's
    await photo('during-send', new Date(submittedAt!.getTime() - 1).toISOString());
    // a photo taken after the send waits for the next log
    await photo('after-send', new Date(submittedAt!.getTime() + 1000).toISOString());
    expect((await snapshot()).dailyLog.progress).toBe(4);
  });

  it('starts a later log on the same day at the earlier log\'s send, so no photo counts on both', async () => {
    const { submittedAt } = await t.prisma.dailyLog.findUniqueOrThrow({ where: { id: logId() }, select: { submittedAt: true } });
    await t.prisma.dailyLog.create({
      data: { id: `${pid()}-pc-log-2`, projectId: pid(), date: '02 Jun 2026', logDate: new Date('2026-06-02'), createdAt: new Date(submittedAt!.getTime() + 2000), checkedIn: true, submitted: false, progress: 7 },
    });
    // only the photo taken after the first log was sent; the 2 Jun photos before it are the first log's
    expect((await snapshot()).dailyLog).toMatchObject({ id: `${pid()}-pc-log-2`, progress: 1 });
  });

  it('starts today\'s log at the day\'s start when the earlier log was sent the evening before', async () => {
    await t.prisma.dailyLog.update({ where: { id: `${pid()}-pc-log-2` }, data: { submitted: true } });
    await t.prisma.dailyLog.create({ data: { id: `${pid()}-pc-log-3`, projectId: pid(), date: '05 Jun 2099', logDate: new Date('2099-06-05'), checkedIn: true, submitted: false, progress: 7 } });
    await photo('jun-5-morning', '2099-06-04T18:30:00Z'); // 5 Jun 2099, 00:00 IST
    expect((await snapshot()).dailyLog).toMatchObject({ id: `${pid()}-pc-log-3`, progress: 1 });
  });

  it('keeps the stored count for a log with no civil day, which no window can be drawn for', async () => {
    await t.prisma.dailyLog.update({ where: { id: `${pid()}-pc-log-3` }, data: { logDate: null, createdAt: new Date('2099-06-05T00:00:00Z') } });
    await t.prisma.dailyLog.updateMany({ where: { projectId: pid(), id: { not: `${pid()}-pc-log-3` } }, data: { logDate: null } });
    expect((await snapshot()).dailyLog.progress).toBe(7);
  });
});
