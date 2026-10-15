import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * #482 site photos — a previous-release app (or an offline draft from before #927) uploads its progress photos with
 * no log and then sends the count it saw. Each such photo is filed on the project's open log (the latest log, while
 * unsent), so the day's count (legacy photos + photos filed on the log) holds it once and the send never has to
 * record it as a legacy photo, which the freeze on `legacyPhotos` would not allow.
 *
 * Reproduce-first: at the base a log-less photo stays unfiled, so the sent log holds 0 filed photos and 0 legacy ones
 * while its sender counted 2.
 */
describe('a progress photo sent without a log is filed on the open log (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let token: string;
  let tokenB: string;
  const logs: string[] = [];
  const px = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');

  const upload = (body: Record<string, unknown>, projectId = f.projectA.id, as = token) =>
    request(t.app.getHttpServer())
      .post(`/projects/${projectId}/media`)
      .set('Authorization', `Bearer ${as}`)
      .send({ mime: 'image/png', data: px, kind: 'progress', ...body });
  const filedOn = async (clientKey: string, projectId = f.projectA.id) =>
    (await t.prisma.media.findFirstOrThrow({ where: { projectId, clientKey }, select: { dailyLogId: true } })).dailyLogId;
  const newLog = async (data: { submitted?: boolean; logDate: string; projectId?: string }) => {
    const log = await t.prisma.dailyLog.create({
      data: { projectId: data.projectId ?? f.projectA.id, date: 'open log photo', logDate: new Date(data.logDate), submitted: data.submitted ?? false },
    });
    logs.push(log.id);
    return log;
  };

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    token = t.issueProjectToken(f.memberUser.id, f.projectA.id, 'pmc');
    tokenB = t.issueProjectToken(f.otherUser.id, f.projectB.id, 'pmc');
  });

  afterEach(async () => {
    await t.prisma.media.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
    await t.prisma.dailyLog.deleteMany({ where: { id: { in: logs.splice(0) } } });
  });

  afterAll(async () => {
    await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor'], { cascade: true });
    await f?.cleanup();
    await t?.close();
  });

  it('a log-less photo is filed on the open log, so the sent count holds it once and nothing becomes legacy', async () => {
    await newLog({ logDate: '2026-10-14', submitted: true });
    const open = await newLog({ logDate: '2026-10-15' });
    expect((await upload({ clientKey: 'old-app-1' })).status).toBe(201);
    expect((await upload({ clientKey: 'old-app-2' })).status).toBe(201);
    expect(await filedOn('old-app-1')).toBe(open.id);
    expect(await filedOn('old-app-2')).toBe(open.id);
    // the old app sends the count it saw: every one of those photos is filed on the log, none is legacy
    await t.prisma.dailyLog.update({ where: { id: open.id }, data: { submitted: true, progress: 2 } });
    const sent = await t.prisma.dailyLog.findUniqueOrThrow({ where: { id: open.id } });
    const filed = await t.prisma.media.count({ where: { projectId: f.projectA.id, dailyLogId: open.id, kind: 'progress' } });
    expect({ legacy: sent.legacyPhotos, filed, progress: sent.progress }).toEqual({ legacy: 0, filed: 2, progress: 2 });
  });

  it('with the latest log sent there is no open log: the photo stays unfiled', async () => {
    await newLog({ logDate: '2026-10-14' }); // an older unsent log is not the open one
    await newLog({ logDate: '2026-10-15', submitted: true });
    expect((await upload({ clientKey: 'after-send' })).status).toBe(201);
    expect(await filedOn('after-send')).toBeNull();
  });

  it('a named log is kept, and a non-progress photo is never filed by default', async () => {
    const older = await newLog({ logDate: '2026-10-14', submitted: true });
    await newLog({ logDate: '2026-10-15' });
    expect((await upload({ clientKey: 'named', dailyLogId: older.id })).status).toBe(201);
    expect((await upload({ clientKey: 'material', kind: 'material' })).status).toBe(201);
    expect(await filedOn('named')).toBe(older.id);
    expect(await filedOn('material')).toBeNull();
  });

  it('another project\'s open log is never used', async () => {
    const otherOpen = await newLog({ logDate: '2026-10-15', projectId: f.projectB.id });
    expect((await upload({ clientKey: 'no-log-here' })).status).toBe(201);
    expect(await filedOn('no-log-here')).toBeNull();
    expect((await upload({ clientKey: 'b-photo' }, f.projectB.id, tokenB)).status).toBe(201);
    expect(await filedOn('b-photo', f.projectB.id)).toBe(otherOpen.id);
  });
});
