import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
import { SnapshotService } from '../../src/snapshot/snapshot.service';

/**
 * #482 site photos unit 3 (board, 14 Oct 2026) — the day's photo count is the server's count of every member's
 * progress photos filed on that log, including ones added after the log was sent. It reads the photos filed on
 * the log (Media.dailyLogId, unit 2), never a time window. A log from before photos were filed on it keeps its
 * stored count: the served count is the larger of the two.
 *
 * Reproduce-first: at the base the snapshot serves the stored `progress` only, so another member's photo and a
 * photo added after the send are never counted.
 */
describe('the day\'s photo count reads the photos filed on the log (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let snapshots: SnapshotService;
  let contractor: string;
  let pmc: string;
  const extra: string[] = [];
  const logs: string[] = [];
  const px = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');

  const upload = (token: string, body: Record<string, unknown>) =>
    request(t.app.getHttpServer())
      .post(`/projects/${f.projectA.id}/media`)
      .set('Authorization', `Bearer ${token}`)
      .send({ mime: 'image/png', data: px, kind: 'progress', ...body });
  const newLog = async (data: { submitted?: boolean; progress?: number; logDate?: string } = {}) => {
    const log = await t.prisma.dailyLog.create({
      data: { projectId: f.projectA.id, date: 'count log', logDate: new Date(data.logDate ?? '2026-10-15'), submitted: data.submitted ?? false, progress: data.progress ?? 0 },
    });
    logs.push(log.id);
    return log;
  };
  const served = async () => (await snapshots.build(f.projectA.id, 'pmc', f.memberUser.id)).dailyLog;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    snapshots = t.app.get(SnapshotService);
    pmc = t.issueProjectToken(f.memberUser.id, f.projectA.id, 'pmc');
    const id = `${f.projectA.id}-count-contractor`;
    await t.prisma.user.create({ data: { id, projectId: f.projectA.id, role: 'contractor', name: 'A contractor', email: `${id}@test.local` } });
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: id, role: 'contractor', status: 'active' } });
    extra.push(id);
    contractor = t.issueProjectToken(id, f.projectA.id, 'contractor');
  });

  afterEach(async () => {
    await t.prisma.media.deleteMany({ where: { projectId: f.projectA.id } });
    await t.prisma.dailyLog.deleteMany({ where: { id: { in: logs.splice(0) } } });
  });

  afterAll(async () => {
    await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor', 'MembershipTransition'], { cascade: true });
    await t?.prisma.membership.deleteMany({ where: { userId: { in: extra } } });
    await t?.prisma.user.deleteMany({ where: { id: { in: extra } } });
    await f?.cleanup();
    await t?.close();
  });

  it('every member\'s photo filed on the log counts, with no send', async () => {
    const log = await newLog();
    expect((await upload(pmc, { dailyLogId: log.id, clientKey: 'count-pmc' })).status).toBe(201);
    expect((await upload(contractor, { dailyLogId: log.id, clientKey: 'count-contractor' })).status).toBe(201);
    expect(await served()).toMatchObject({ id: log.id, progress: 2 });
  });

  it('a photo added after the log was sent still counts', async () => {
    const log = await newLog({ submitted: true, progress: 1 });
    expect((await upload(pmc, { dailyLogId: log.id, clientKey: 'after-1' })).status).toBe(201);
    expect((await upload(contractor, { dailyLogId: log.id, clientKey: 'after-2' })).status).toBe(201);
    expect(await served()).toMatchObject({ id: log.id, submitted: true, progress: 2 });
  });

  it('a log from before photos were filed on it keeps its stored count', async () => {
    const log = await newLog({ submitted: true, progress: 4 });
    expect((await upload(contractor, { clientKey: 'unfiled' })).status).toBe(201);
    expect(await served()).toMatchObject({ id: log.id, progress: 4 });
  });

  it('photos filed on another log, unfiled photos and other kinds never count on this one', async () => {
    const older = await newLog({ logDate: '2026-10-14' });
    const today = await newLog();
    expect((await upload(contractor, { dailyLogId: older.id, clientKey: 'older' })).status).toBe(201);
    expect((await upload(contractor, { clientKey: 'loose' })).status).toBe(201);
    expect((await upload(pmc, { kind: 'material', dailyLogId: today.id, clientKey: 'material' })).status).toBe(201);
    expect((await upload(pmc, { dailyLogId: today.id, clientKey: 'today' })).status).toBe(201);
    expect(await served()).toMatchObject({ id: today.id, progress: 1 });
  });
});
