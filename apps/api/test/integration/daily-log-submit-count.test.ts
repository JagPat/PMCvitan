import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * #482 site photos (Board, 14 Oct 2026) — the day's photo count a send stores is the server's own: the progress
 * photos filed on the log, counted under the log row's lock. A photo a member deleted before the send is never
 * counted, whichever of the two reaches the row first, and a count the sender's app carried is never stored over it.
 *
 * Reproduce-first: at the base the send stores the app's `progress` as given, so a photo deleted while the send waited
 * on the delete's lock stays counted (Codex 4318519710).
 */
describe('a send stores the photos filed on the log (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let pmc: string;
  const logs: string[] = [];
  const px = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

  const http = () => request(t.app.getHttpServer());
  // the newest log of the project, so the send picks it
  const newLog = async () => {
    const log = await t.prisma.dailyLog.create({ data: { projectId: f.projectA.id, date: 'send count', logDate: new Date('2099-01-01'), checkedIn: true } });
    logs.push(log.id);
    return log;
  };
  const filed = async (dailyLogId: string) =>
    (await t.prisma.media.create({ data: { projectId: f.projectA.id, kind: 'progress', mime: 'image/png', uploadedBy: f.memberUser.id, data: px, dailyLogId } })).id;
  const send = (progress: number) =>
    http().post(`/projects/${f.projectA.id}/daily-log/submit`).set('Authorization', `Bearer ${pmc}`)
      .send({ checkedIn: true, checkinTime: '09:00', progress, crew: [] });
  const stored = async (id: string) => (await t.prisma.dailyLog.findUniqueOrThrow({ where: { id } })).progress;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    pmc = t.issueProjectToken(f.memberUser.id, f.projectA.id, 'pmc');
  });

  afterEach(async () => {
    await t.prisma.media.deleteMany({ where: { dailyLogId: { in: logs } } });
    await t.prisma.dailyLog.deleteMany({ where: { id: { in: logs.splice(0) } } });
  });

  afterAll(async () => {
    await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor', 'MembershipTransition', 'CommandExecution'], { cascade: true });
    await f?.cleanup();
    await t?.close();
  });

  it('stores the photos filed on the log, not the count the app sent', async () => {
    const log = await newLog();
    await filed(log.id);
    await filed(log.id);
    expect((await send(5)).status).toBe(201);
    expect(await stored(log.id)).toBe(2);
  });

  it('a delete that holds the log row first is never counted by the send that waited for it (Codex 4318519710)', async () => {
    const log = await newLog();
    await filed(log.id);
    const gone = await filed(log.id);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    // the delete, as media's remove() runs it: the log row FOR SHARE, then the photo row, not yet committed
    const deleting = t.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "DailyLog" WHERE "id" = ${log.id} FOR SHARE`;
      await tx.media.delete({ where: { id: gone } });
      locked();
      await held;
    }, { timeout: 20_000 });
    await isLocked;
    // the app still counts the photo it saw
    const sending = send(2).then((r) => r);
    // released only once PostgreSQL shows the send waiting on the log row, never after a guessed delay
    const blocked = async (): Promise<boolean> =>
      (await t.prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%"DailyLog"%'`)[0]!.n > 0;
    const deadline = Date.now() + 10_000;
    while (!(await blocked())) {
      if (Date.now() > deadline) { release(); await deleting; throw new Error('the send never waited on the log row lock'); }
      await new Promise((r) => setTimeout(r, 20));
    }
    release();
    await deleting;
    expect((await sending).status).toBe(201);
    expect(await stored(log.id)).toBe(1);
  });
});
