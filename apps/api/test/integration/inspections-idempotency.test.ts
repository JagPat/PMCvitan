import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { InspectionsService } from '../../src/inspections/inspections.service';
import type { AuthUser } from '../../src/common/auth';

/**
 * Phase 2 Task 10 (Module 3) — the inspection COMMANDS are idempotent under the Task-5 CommandExecution
 * ledger. A retried command (network retry / offline write-ahead replay / double-tap) carrying the SAME
 * idempotency key applies EXACTLY ONCE and replays the same success; the SAME key with a DIFFERENT payload
 * is a 409; the receipt is ACTOR-scoped (two actors, same key = two independent executions); a keyed
 * replay short-circuits BEFORE the terminal state-machine guards (so a retried submit/decide replays
 * cleanly instead of hitting "already submitted"/"already decided"); and an UNKEYED command keeps working
 * (additive rollout).
 */

describe('Phase 2 Task 10 (Module 3) — inspection commands are idempotent (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let svc: InspectionsService;
  let projSeq = 0;

  const asPmc = (sub: string, projectId: string): AuthUser => ({ sub, role: 'pmc', projectId }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    svc = t.app.get(InspectionsService);
  });
  afterAll(async () => {
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    const pids = { startsWith: 'it-inidem-' };
    await t.prisma.$executeRawUnsafe('TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "InspectionsProjection"');
    await t.prisma.commandExecution.deleteMany({ where: { projectId: pids } });
    await t.prisma.inspectionItem.deleteMany({ where: { inspection: { projectId: pids } } });
    await t.prisma.inspection.deleteMany({ where: { projectId: pids } });
    await t.prisma.notification.deleteMany({ where: { projectId: pids } });
    await t.prisma.auditLog.deleteMany({ where: { projectId: pids } });
    await t.prisma.membership.deleteMany({ where: { projectId: pids } });
    await t.prisma.user.deleteMany({ where: { id: { startsWith: 'it-inidem-u-' } } });
    await t.prisma.project.deleteMany({ where: { id: pids } });
  });

  /** A fresh project with TWO active pmc members (for the actor-scoping probe) + one engineer. */
  const freshProject = async (): Promise<{ p: string; pmcA: string; pmcB: string }> => {
    const p = `it-inidem-${Date.now() % 1e6}-${projSeq++}`;
    await t.prisma.project.create({
      data: { id: p, orgId: f.orgA.id, name: p, short: 'O', descriptor: '', stage: 'x', siteCode: 'O', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    });
    const pmcA = `it-inidem-u-pmcA-${projSeq}`;
    const pmcB = `it-inidem-u-pmcB-${projSeq}`;
    for (const [id, name] of [[pmcA, 'PMC A'], [pmcB, 'PMC B']] as const) {
      await t.prisma.user.create({ data: { id, projectId: p, role: 'pmc', name, email: `${id}@t.local` } });
      await t.prisma.membership.create({ data: { projectId: p, userId: id, role: 'pmc', status: 'active' } });
    }
    return { p, pmcA, pmcB };
  };

  const createInput = (over: Partial<{ title: string; items: string[] }> = {}) => ({
    title: over.title ?? 'Slab QA', zone: 'GF', items: over.items ?? ['Rebar', 'Cover'],
  });

  it('create: the SAME key creates the inspection EXACTLY ONCE and replays (no duplicate inspection/event/audit)', async () => {
    const { p, pmcA } = await freshProject();
    await svc.create(p, createInput(), asPmc(pmcA, p), 'k-create-1');
    await svc.create(p, createInput(), asPmc(pmcA, p), 'k-create-1'); // retry, same key + payload
    expect(await t.prisma.inspection.count({ where: { projectId: p } })).toBe(1);
    expect(await t.prisma.domainEvent.count({ where: { projectId: p, eventType: 'inspection.created' } })).toBe(1);
    expect(await t.prisma.auditLog.count({ where: { projectId: p, action: 'inspection.create' } })).toBe(1);
  });

  it('create: the SAME key with a DIFFERENT payload is a 409 (never silently applies a different command)', async () => {
    const { p, pmcA } = await freshProject();
    await svc.create(p, createInput({ title: 'Slab QA' }), asPmc(pmcA, p), 'k-create-2');
    await expect(svc.create(p, createInput({ title: 'Plaster QA' }), asPmc(pmcA, p), 'k-create-2')).rejects.toBeInstanceOf(ConflictException);
    expect(await t.prisma.inspection.count({ where: { projectId: p, title: 'Plaster QA' } })).toBe(0);
  });

  it('create: the SAME key from TWO actors is two independent executions (actor-scoped receipt)', async () => {
    const { p, pmcA, pmcB } = await freshProject();
    await svc.create(p, createInput({ title: 'A QA' }), asPmc(pmcA, p), 'shared-key');
    await svc.create(p, createInput({ title: 'B QA' }), asPmc(pmcB, p), 'shared-key'); // NOT collapsed into A's receipt
    expect(await t.prisma.inspection.count({ where: { projectId: p } })).toBe(2);
  });

  it('create: two DISTINCT creates (different titles) are two records — payload dedup is NOT used', async () => {
    const { p, pmcA } = await freshProject();
    await svc.create(p, createInput({ title: 'A-1' }), asPmc(pmcA, p), 'k-a');
    await svc.create(p, createInput({ title: 'A-2' }), asPmc(pmcA, p), 'k-b');
    expect(await t.prisma.inspection.count({ where: { projectId: p } })).toBe(2);
  });

  it('submit: the SAME key replays exactly once and never hits the "already submitted" guard', async () => {
    const { p, pmcA } = await freshProject();
    await svc.create(p, createInput({ items: ['Rebar'] }), asPmc(pmcA, p), 'k-c');
    const insp = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: p }, include: { items: true } });
    const items = insp.items.map((it) => ({ id: it.id, state: 'pass' as const, photos: 0, note: '' }));
    await svc.submit(p, insp.id, { items }, asPmc(pmcA, p), 'k-submit-1');
    await svc.submit(p, insp.id, { items }, asPmc(pmcA, p), 'k-submit-1'); // keyed retry → replay, not a 400
    expect(await t.prisma.domainEvent.count({ where: { projectId: p, eventType: 'inspection.submitted' } })).toBe(1);
    expect(await t.prisma.auditLog.count({ where: { projectId: p, action: 'inspection.submit' } })).toBe(1);
    const after = await t.prisma.inspection.findUniqueOrThrow({ where: { id: insp.id } });
    expect(after.submitted).toBe(true);
  });

  it('decide (approve): the SAME key approves once and replays (no second approved event)', async () => {
    const { p, pmcA } = await freshProject();
    await svc.create(p, createInput({ items: ['Rebar'] }), asPmc(pmcA, p), 'k-d');
    const insp = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: p }, include: { items: true } });
    await svc.submit(p, insp.id, { items: insp.items.map((it) => ({ id: it.id, state: 'pass' as const, photos: 0, note: '' })) }, asPmc(pmcA, p), 'k-sub');
    await svc.decide(p, insp.id, { approve: true, rejectedItemIds: [] }, asPmc(pmcA, p), 'k-decide-1');
    await svc.decide(p, insp.id, { approve: true, rejectedItemIds: [] }, asPmc(pmcA, p), 'k-decide-1'); // keyed retry → replay
    expect(await t.prisma.domainEvent.count({ where: { projectId: p, eventType: 'inspection.approved' } })).toBe(1);
    expect(await t.prisma.auditLog.count({ where: { projectId: p, action: 'inspection.approve' } })).toBe(1);
    const after = await t.prisma.inspection.findUniqueOrThrow({ where: { id: insp.id } });
    expect(after.decided).toBe(true);
  });

  it('legacy: an UNKEYED create still works (additive rollout — unkeyed clients keep functioning)', async () => {
    const { p, pmcA } = await freshProject();
    await svc.create(p, createInput(), asPmc(pmcA, p), undefined);
    expect(await t.prisma.inspection.count({ where: { projectId: p } })).toBe(1);
  });
});
