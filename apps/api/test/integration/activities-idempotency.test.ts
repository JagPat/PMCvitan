import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { ActivitiesService } from '../../src/activities/activities.service';
import { PhasesService } from '../../src/activities/phases.service';
import type { AuthUser } from '../../src/common/auth';
import type { CreateActivityInput } from '../../src/contracts';

/**
 * Phase 2 Task 10 (Module 4) — the activity + phase COMMANDS are idempotent under the Task-5
 * CommandExecution ledger. A retried command (network retry / offline write-ahead replay / double-tap)
 * carrying the SAME idempotency key applies EXACTLY ONCE and replays the same success; the SAME key with
 * a DIFFERENT payload is a 409; the receipt is ACTOR-scoped (two actors, same key = two independent
 * executions); a keyed replay short-circuits BEFORE the terminal state-machine guards (so a retried
 * start/complete replays cleanly instead of hitting "not in a startable state"/"only a running
 * activity"); and an UNKEYED command keeps working (additive rollout).
 */

describe('Phase 2 Task 10 (Module 4) — activity/phase commands are idempotent (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let svc: ActivitiesService;
  let phasesSvc: PhasesService;
  let projSeq = 0;

  const asPmc = (sub: string, projectId: string): AuthUser => ({ sub, role: 'pmc', projectId }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    svc = t.app.get(ActivitiesService);
    phasesSvc = t.app.get(PhasesService);
  });
  afterAll(async () => {
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    const pids = { startsWith: 'it-actidem-' };
    await t.prisma.$executeRawUnsafe('TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "ActivitiesProjection"');
    await t.prisma.commandExecution.deleteMany({ where: { projectId: pids } });
    await t.prisma.gateOverride.deleteMany({ where: { projectId: pids } });
    await t.prisma.inspectionItem.deleteMany({ where: { inspection: { projectId: pids } } });
    await t.prisma.inspection.deleteMany({ where: { projectId: pids } });
    await t.prisma.activity.deleteMany({ where: { projectId: pids } });
    await t.prisma.phase.deleteMany({ where: { projectId: pids } });
    await t.prisma.notification.deleteMany({ where: { projectId: pids } });
    await t.prisma.auditLog.deleteMany({ where: { projectId: pids } });
    await t.prisma.membership.deleteMany({ where: { projectId: pids } });
    await t.prisma.user.deleteMany({ where: { id: { startsWith: 'it-actidem-u-' } } });
    await t.prisma.project.deleteMany({ where: { id: pids } });
  });

  /** A fresh project with TWO active pmc members (for the actor-scoping probe). */
  const freshProject = async (): Promise<{ p: string; pmcA: string; pmcB: string }> => {
    const p = `it-actidem-${Date.now() % 1e6}-${projSeq++}`;
    await t.prisma.project.create({
      data: { id: p, orgId: f.orgA.id, name: p, short: 'O', descriptor: '', stage: 'x', siteCode: 'O', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    });
    const pmcA = `it-actidem-u-pmcA-${projSeq}`;
    const pmcB = `it-actidem-u-pmcB-${projSeq}`;
    for (const [id, name] of [[pmcA, 'PMC A'], [pmcB, 'PMC B']] as const) {
      await t.prisma.user.create({ data: { id, projectId: p, role: 'pmc', name, email: `${id}@t.local` } });
      await t.prisma.membership.create({ data: { projectId: p, userId: id, role: 'pmc', status: 'active' } });
    }
    return { p, pmcA, pmcB };
  };

  const createInput = (over: Partial<CreateActivityInput> = {}): CreateActivityInput => ({
    name: 'Slab pour', zone: 'GF', plannedStart: 0, plannedEnd: 5, gateMaterial: 'na', gateTeam: 'na', ...over,
  }) as CreateActivityInput;

  /** Plan an activity (default readiness passes: no linked decision, gates n/a) and return its id. */
  const planned = async (p: string, pmcA: string, name: string, key?: string): Promise<string> => {
    await svc.create(p, createInput({ name }), asPmc(pmcA, p), key);
    return (await t.prisma.activity.findFirstOrThrow({ where: { projectId: p, name } })).id;
  };

  const futureIso = () => new Date(Date.now() + 86_400_000).toISOString();

  it('create: the SAME key creates the activity EXACTLY ONCE and replays (no duplicate activity/event/audit)', async () => {
    const { p, pmcA } = await freshProject();
    await svc.create(p, createInput(), asPmc(pmcA, p), 'k-create-1');
    await svc.create(p, createInput(), asPmc(pmcA, p), 'k-create-1'); // retry, same key + payload
    expect(await t.prisma.activity.count({ where: { projectId: p } })).toBe(1);
    expect(await t.prisma.domainEvent.count({ where: { projectId: p, eventType: 'activity.created' } })).toBe(1);
    expect(await t.prisma.auditLog.count({ where: { projectId: p, action: 'activity.create' } })).toBe(1);
  });

  it('create: the SAME key with a DIFFERENT payload is a 409 (never silently applies a different command)', async () => {
    const { p, pmcA } = await freshProject();
    await svc.create(p, createInput({ name: 'Slab pour' }), asPmc(pmcA, p), 'k-create-2');
    await expect(svc.create(p, createInput({ name: 'Plaster' }), asPmc(pmcA, p), 'k-create-2')).rejects.toBeInstanceOf(ConflictException);
    expect(await t.prisma.activity.count({ where: { projectId: p, name: 'Plaster' } })).toBe(0);
  });

  it('create: the SAME key from TWO actors is two independent executions (actor-scoped receipt)', async () => {
    const { p, pmcA, pmcB } = await freshProject();
    await svc.create(p, createInput({ name: 'A act' }), asPmc(pmcA, p), 'shared-key');
    await svc.create(p, createInput({ name: 'B act' }), asPmc(pmcB, p), 'shared-key'); // NOT collapsed into A's receipt
    expect(await t.prisma.activity.count({ where: { projectId: p } })).toBe(2);
  });

  it('create: two DISTINCT creates (different names) are two records — payload dedup is NOT used', async () => {
    const { p, pmcA } = await freshProject();
    await svc.create(p, createInput({ name: 'A-1' }), asPmc(pmcA, p), 'k-a');
    await svc.create(p, createInput({ name: 'A-2' }), asPmc(pmcA, p), 'k-b');
    expect(await t.prisma.activity.count({ where: { projectId: p } })).toBe(2);
  });

  it('start: the SAME key starts exactly once and replays — never the "not startable" 409', async () => {
    const { p, pmcA } = await freshProject();
    const id = await planned(p, pmcA, 'Startable', 'k-c');
    await svc.start(p, id, asPmc(pmcA, p), 'k-start-1');
    await svc.start(p, id, asPmc(pmcA, p), 'k-start-1'); // keyed retry → replay, not "not in a startable state"
    expect(await t.prisma.domainEvent.count({ where: { projectId: p, eventType: 'activity.started' } })).toBe(1);
    expect(await t.prisma.auditLog.count({ where: { projectId: p, action: 'activity.start' } })).toBe(1);
    expect((await t.prisma.activity.findUniqueOrThrow({ where: { id } })).status).toBe('in_progress');
  });

  it('start: the SAME key naming a DIFFERENT activity is a 409 (the payload is part of the receipt)', async () => {
    const { p, pmcA } = await freshProject();
    const a = await planned(p, pmcA, 'Start A', 'k-d');
    const b = await planned(p, pmcA, 'Start B', 'k-e');
    await svc.start(p, a, asPmc(pmcA, p), 'k-start-2');
    await expect(svc.start(p, b, asPmc(pmcA, p), 'k-start-2')).rejects.toBeInstanceOf(ConflictException);
    expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: b } })).status).toBe('not_started'); // untouched
  });

  it('complete: the SAME key claims exactly once (ONE closing inspection) and replays — never "only a running activity"', async () => {
    const { p, pmcA } = await freshProject();
    const id = await planned(p, pmcA, 'Completable', 'k-f');
    await svc.start(p, id, asPmc(pmcA, p), 'k-start-3');
    await svc.complete(p, id, asPmc(pmcA, p), 'k-complete-1');
    await svc.complete(p, id, asPmc(pmcA, p), 'k-complete-1'); // keyed retry → replay, not a 409 for awaiting_signoff
    expect(await t.prisma.domainEvent.count({ where: { projectId: p, eventType: 'activity.completion_requested' } })).toBe(1);
    expect(await t.prisma.auditLog.count({ where: { projectId: p, action: 'activity.complete_requested' } })).toBe(1);
    expect(await t.prisma.inspection.count({ where: { projectId: p, activityId: id, closing: true } })).toBe(1); // exactly ONE closing
    expect((await t.prisma.activity.findUniqueOrThrow({ where: { id } })).status).toBe('awaiting_signoff');
  });

  it('complete: the SAME key naming a DIFFERENT activity is a 409', async () => {
    const { p, pmcA } = await freshProject();
    const a = await planned(p, pmcA, 'Complete A', 'k-g');
    const b = await planned(p, pmcA, 'Complete B', 'k-h');
    await svc.start(p, a, asPmc(pmcA, p), 'k-start-4');
    await svc.start(p, b, asPmc(pmcA, p), 'k-start-5');
    await svc.complete(p, a, asPmc(pmcA, p), 'k-complete-2');
    await expect(svc.complete(p, b, asPmc(pmcA, p), 'k-complete-2')).rejects.toBeInstanceOf(ConflictException);
    expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: b } })).status).toBe('in_progress'); // no claim applied
    expect(await t.prisma.inspection.count({ where: { projectId: p, activityId: b, closing: true } })).toBe(0);
  });

  it('override: the SAME key mints EXACTLY ONE override row and replays (no duplicate exception/event)', async () => {
    const { p, pmcA } = await freshProject();
    const id = await planned(p, pmcA, 'Overridable', 'k-i');
    const input = { gate: 'material' as const, state: 'ok' as const, reason: 'Advance PO cleared', expiresAt: futureIso() };
    await svc.override(p, id, input, asPmc(pmcA, p), 'k-override-1');
    await svc.override(p, id, input, asPmc(pmcA, p), 'k-override-1'); // retry, same key + payload
    expect(await t.prisma.gateOverride.count({ where: { projectId: p, activityId: id } })).toBe(1);
    expect(await t.prisma.domainEvent.count({ where: { projectId: p, eventType: 'activity.override_granted' } })).toBe(1);
    expect(await t.prisma.auditLog.count({ where: { projectId: p, action: 'activity.override' } })).toBe(1);
  });

  it('override: the SAME key with a DIFFERENT payload is a 409 (no second exception row)', async () => {
    const { p, pmcA } = await freshProject();
    const id = await planned(p, pmcA, 'Override guard', 'k-j');
    const expiresAt = futureIso();
    await svc.override(p, id, { gate: 'material', state: 'ok', reason: 'Advance PO cleared', expiresAt }, asPmc(pmcA, p), 'k-override-2');
    await expect(
      svc.override(p, id, { gate: 'team', state: 'ok', reason: 'Crew mobilized', expiresAt }, asPmc(pmcA, p), 'k-override-2'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await t.prisma.gateOverride.count({ where: { projectId: p, activityId: id } })).toBe(1);
    expect(await t.prisma.gateOverride.count({ where: { projectId: p, activityId: id, gate: 'team' } })).toBe(0);
  });

  it('phases.create: the SAME key creates the phase EXACTLY ONCE and replays (no duplicate phase/event/audit)', async () => {
    const { p, pmcA } = await freshProject();
    await phasesSvc.create(p, { name: 'Structure', plannedStart: 0, plannedEnd: 10 }, asPmc(pmcA, p), 'k-phase-1');
    await phasesSvc.create(p, { name: 'Structure', plannedStart: 0, plannedEnd: 10 }, asPmc(pmcA, p), 'k-phase-1'); // retry
    expect(await t.prisma.phase.count({ where: { projectId: p } })).toBe(1);
    expect(await t.prisma.domainEvent.count({ where: { projectId: p, eventType: 'phase.created' } })).toBe(1);
    expect(await t.prisma.auditLog.count({ where: { projectId: p, action: 'phase.create' } })).toBe(1);
  });

  it('phases.create: the SAME key with a DIFFERENT payload is a 409 (never silently applies a different phase)', async () => {
    const { p, pmcA } = await freshProject();
    await phasesSvc.create(p, { name: 'Structure', plannedStart: 0, plannedEnd: 10 }, asPmc(pmcA, p), 'k-phase-2');
    await expect(
      phasesSvc.create(p, { name: 'Finishes', plannedStart: 0, plannedEnd: 10 }, asPmc(pmcA, p), 'k-phase-2'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await t.prisma.phase.count({ where: { projectId: p, name: 'Finishes' } })).toBe(0);
  });

  it('legacy: an UNKEYED create still works (additive rollout — unkeyed clients keep functioning)', async () => {
    const { p, pmcA } = await freshProject();
    await svc.create(p, createInput(), asPmc(pmcA, p), undefined);
    expect(await t.prisma.activity.count({ where: { projectId: p } })).toBe(1);
  });
});
