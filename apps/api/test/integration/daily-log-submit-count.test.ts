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

  it('a photo delete under way is never counted by the send that waits for it (Codex 4318519710, r4319015964)', async () => {
    const log = await newLog();
    await filed(log.id);
    const gone = await filed(log.id);
    // backends of this database waiting on a lock, this test's own holder aside
    const waiting = async (): Promise<number> =>
      (await t.prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)[0]!.n;
    const until = async (n: number, what: string, giveUp: () => Promise<void>): Promise<void> => {
      const deadline = Date.now() + 10_000;
      while ((await waiting()) < n) {
        if (Date.now() > deadline) { await giveUp(); throw new Error(what); }
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let holding!: () => void;
    const isHolding = new Promise<void>((r) => { holding = r; });
    // the photo row is held by another transaction, so the real delete stops part-way, after its first statements
    const holder = t.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Media" WHERE "id" = ${gone} FOR UPDATE`;
      holding();
      await held;
    }, { timeout: 20_000 });
    await isHolding;
    const deleting = http().delete(`/media/${gone}`).set('Authorization', `Bearer ${pmc}`).then((r) => r);
    const giveUp = async () => { release(); await holder; await deleting; };
    await until(1, 'the delete never reached the photo row', giveUp);
    // the app still counts the photo it saw
    const sending = send(2).then((r) => r);
    // released only once PostgreSQL shows the send waiting too (on the log row the delete holds), never after a delay
    await until(2, 'the send never waited on the delete', giveUp);
    release();
    await holder;
    expect((await deleting).status).toBe(200);
    expect((await sending).status).toBe(201);
    expect(await stored(log.id)).toBe(1);
  });
});
