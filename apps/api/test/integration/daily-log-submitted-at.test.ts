import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * #482 site photos — the instant a daily log was sent is the database's to stamp (migration 20280113000000). A
 * log's photos are the ones taken between the previous log's send and its own, so this boundary must hold one
 * value whoever writes the row. Proven against PostgreSQL.
 *
 * Reproduce-first: before the migration the column does not exist.
 */
describe('a daily log\'s sent instant is stamped by the database (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const pid = () => f.projectA.id;
  const row = (id: string) => t.prisma.dailyLog.findUniqueOrThrow({ where: { id }, select: { submitted: true, submittedAt: true } });
  const create = (id: string, submitted: boolean) =>
    t.prisma.dailyLog.create({ data: { id: `${pid()}-${id}`, projectId: pid(), date: '02 Jun 2026', logDate: new Date('2026-06-02'), submitted } });

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
  });

  afterAll(async () => {
    await t?.prisma.dailyLog.deleteMany({ where: { projectId: f?.projectA.id } });
    await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor', 'MembershipTransition'], { cascade: true });
    await f?.cleanup();
    await t?.close();
  });

  it('carries no stamp while the log is unsent, even when a writer supplies one', async () => {
    const log = await create('open', false);
    expect((await row(log.id)).submittedAt).toBeNull();
    await t.prisma.dailyLog.update({ where: { id: log.id }, data: { submittedAt: new Date('2020-01-01T00:00:00Z') } });
    expect((await row(log.id)).submittedAt).toBeNull();
  });

  it('stamps the instant the log is sent, from the database clock, not the writer\'s value', async () => {
    const log = await create('send', false);
    const before = Date.now();
    await t.prisma.dailyLog.update({ where: { id: log.id }, data: { submitted: true, submittedAt: new Date('2020-01-01T00:00:00Z') } });
    const after = Date.now();
    const at = (await row(log.id)).submittedAt!.getTime();
    // the database and the test share this machine's clock; allow for the round trip
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(at).toBeLessThanOrEqual(after + 1000);
  });

  it('keeps the first stamp while the log stays sent, whatever a later write sends', async () => {
    const log = await create('keep', false);
    await t.prisma.dailyLog.update({ where: { id: log.id }, data: { submitted: true } });
    const first = (await row(log.id)).submittedAt!;
    await t.prisma.dailyLog.update({ where: { id: log.id }, data: { submitted: true, progress: 4, submittedAt: new Date('2030-01-01T00:00:00Z') } });
    expect((await row(log.id)).submittedAt).toEqual(first);
  });

  it('stamps a log inserted as sent, and clears the stamp if the log is ever un-sent', async () => {
    const log = await create('inserted-sent', true);
    expect((await row(log.id)).submittedAt).not.toBeNull();
    await t.prisma.dailyLog.update({ where: { id: log.id }, data: { submitted: false } });
    expect((await row(log.id)).submittedAt).toBeNull();
  });
});
