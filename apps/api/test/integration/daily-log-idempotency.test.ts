import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { DailyLogService } from '../../src/daily-log/daily-log.service';
import type { AuthUser } from '../../src/common/auth';

/**
 * Phase 2 Task 10 (correction, finding 3) — the four daily-log commands are idempotent end-to-end,
 * proven against live PostgreSQL. Each command now runs through the Task-5 CommandExecution ledger:
 * the same `Idempotency-Key` + payload replays the committed result exactly once; a different payload
 * under the same key is a 409; concurrent duplicates resolve to a single winner; the receipt is
 * actor-scoped, so the same key from two actors is two independent executions. No duplicate rows,
 * audits or events.
 */
describe('Phase 2 Task 10 (correction) — daily-log commands are idempotent (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let svc: DailyLogService;
  let user: AuthUser;
  let user2: AuthUser;
  let member2Id: string;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    svc = t.app.get(DailyLogService);
    user = { sub: f.memberUser.id, role: 'engineer', projectId: f.projectA.id };
    // a SECOND active member on projectA — for cross-actor isolation of the receipt subject
    member2Id = `it-dlidem-m2-${Date.now() % 1e7}`;
    await t.prisma.user.create({ data: { id: member2Id, projectId: f.projectA.id, role: 'engineer', name: 'Member 2', email: `${member2Id}@test.local` } });
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: member2Id, role: 'engineer', status: 'active' } });
    user2 = { sub: member2Id, role: 'engineer', projectId: f.projectA.id };
  });
  afterAll(async () => {
    await t?.prisma.membership.deleteMany({ where: { userId: member2Id } });
    await t?.prisma.user.deleteMany({ where: { id: member2Id } });
    await t?.prisma.$executeRawUnsafe('TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DailyLogProjection"');
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    const p = f.projectA.id;
    await t.prisma.commandExecution.deleteMany({ where: { projectId: p } });
    await t.prisma.$executeRawUnsafe('TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DailyLogProjection"');
    await t.prisma.auditLog.deleteMany({ where: { projectId: p } });
    await t.prisma.notification.deleteMany({ where: { projectId: p } });
    await t.prisma.siteMaterial.deleteMany({ where: { projectId: p } });
    await t.prisma.crewRow.deleteMany({ where: { dailyLog: { projectId: p } } });
    await t.prisma.dailyLog.deleteMany({ where: { projectId: p } });
  });

  const p = () => f.projectA.id;

  it('start: the SAME key creates the day log exactly once and replays (no duplicate log/event/audit)', async () => {
    await svc.start(p(), user, 'k-start');
    await svc.start(p(), user, 'k-start'); // replay
    expect(await t.prisma.dailyLog.count({ where: { projectId: p() } })).toBe(1);
    expect(await t.prisma.domainEvent.count({ where: { projectId: p(), eventType: 'dailylog.started' } })).toBe(1);
    expect(await t.prisma.auditLog.count({ where: { projectId: p(), action: 'dailylog.start' } })).toBe(1);
    expect(await t.prisma.commandExecution.count({ where: { projectId: p(), commandType: 'daily-log.start', idempotencyKey: 'k-start' } })).toBe(1);
  });

  it('start: two CONCURRENT same-key starts resolve to a single log (one winner)', async () => {
    await Promise.all([svc.start(p(), user, 'k-cc'), svc.start(p(), user, 'k-cc')]);
    expect(await t.prisma.dailyLog.count({ where: { projectId: p() } })).toBe(1);
    expect(await t.prisma.commandExecution.count({ where: { projectId: p(), commandType: 'daily-log.start', idempotencyKey: 'k-cc' } })).toBe(1);
  });

  it('addMaterial: SAME key adds once; a DIFFERENT payload under the same key is a 409', async () => {
    await svc.start(p(), user, 'k-s2');
    await svc.addMaterial(p(), { name: 'Cement', qty: '10 bags', zone: 'GF', swatch: 'tile' }, user, 'k-mat');
    await svc.addMaterial(p(), { name: 'Cement', qty: '10 bags', zone: 'GF', swatch: 'tile' }, user, 'k-mat'); // replay
    expect(await t.prisma.siteMaterial.count({ where: { projectId: p() } })).toBe(1);
    expect(await t.prisma.commandExecution.count({ where: { projectId: p(), commandType: 'daily-log.addMaterial', idempotencyKey: 'k-mat' } })).toBe(1);
    // same key, DIFFERENT payload → truthful 409; no second material, no extra receipt
    await expect(svc.addMaterial(p(), { name: 'Sand', qty: '2 t', zone: 'GF', swatch: 'tile' }, user, 'k-mat')).rejects.toBeInstanceOf(ConflictException);
    expect(await t.prisma.siteMaterial.count({ where: { projectId: p() } })).toBe(1);
  });

  it('addMaterial: the SAME key from TWO actors is two independent executions (actor-scoped receipt)', async () => {
    await svc.start(p(), user, 'k-s3');
    const mat = { name: 'Tiles', qty: '400', zone: 'L1', swatch: 'marble' };
    await svc.addMaterial(p(), mat, user, 'shared-key');
    await svc.addMaterial(p(), mat, user2, 'shared-key'); // different actor, same key → NOT a replay
    expect(await t.prisma.siteMaterial.count({ where: { projectId: p() } })).toBe(2);
    expect(await t.prisma.commandExecution.count({ where: { projectId: p(), commandType: 'daily-log.addMaterial', idempotencyKey: 'shared-key' } })).toBe(2);
  });

  it('submit: the SAME key applies the submission exactly once and replays', async () => {
    await svc.start(p(), user, 'k-s4');
    const body = { checkedIn: true, checkinTime: '09:00', progress: 50, crew: [{ trade: 'Mason', count: 3 }] };
    await svc.submit(p(), body, user, 'k-sub');
    await svc.submit(p(), body, user, 'k-sub'); // replay
    const log = await t.prisma.dailyLog.findFirstOrThrow({ where: { projectId: p() } });
    expect(log.submitted).toBe(true);
    expect(await t.prisma.domainEvent.count({ where: { projectId: p(), eventType: 'dailylog.submitted' } })).toBe(1);
    expect(await t.prisma.auditLog.count({ where: { projectId: p(), action: 'dailylog.submit' } })).toBe(1);
    expect(await t.prisma.commandExecution.count({ where: { projectId: p(), commandType: 'daily-log.submit', idempotencyKey: 'k-sub' } })).toBe(1);
  });

  it('legacy path: no key still works (unkeyed clients keep functioning during rollout)', async () => {
    await svc.start(p(), user); // no idempotencyKey
    expect(await t.prisma.dailyLog.count({ where: { projectId: p() } })).toBe(1);
    // an unkeyed command writes NO ledger receipt
    expect(await t.prisma.commandExecution.count({ where: { projectId: p(), commandType: 'daily-log.start' } })).toBe(0);
  });
});
