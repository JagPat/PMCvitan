import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { ConflictException, BadRequestException } from '@nestjs/common';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { executeCommand, hashRequest, type CommandScope } from '../../src/platform/commands';
import { DecisionsService } from '../../src/decisions/decisions.service';
import type { Actor } from '../../src/common/actor';
import type { AuthUser } from '../../src/common/auth';

/**
 * Phase 2 Task 5 — the Command-Idempotency Ledger, proven against live PostgreSQL.
 *
 * A retried/duplicated command (offline replay, network retry, double-tap) executes its
 * effect exactly once and replays the same result. The receipt is actor-scoped: the lookup
 * keys on scopeKind + the matching scope id(s) + actorId + commandType + idempotencyKey, so
 * no response ever crosses to another actor. Scope-specific PARTIAL unique indexes mean an
 * org-scoped key never constrains a project-scoped row. These are the Step-1 probes.
 */
describe('Phase 2 Task 5 — command-idempotency ledger (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  // a SECOND project in the SAME org as projectA — to prove the project partial index keys on
  // projectId, so the same (actor, command, key) on two projects of one org does NOT collide.
  let projectA2: string;
  const alpha: Actor = { actorId: 'cmd-actor-alpha', actorName: 'Alpha', actorRole: 'pmc', actorKind: 'human' };
  const beta: Actor = { actorId: 'cmd-actor-beta', actorName: 'Beta', actorRole: 'pmc', actorKind: 'human' };

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    projectA2 = `it-proja2-${Date.now() % 1e7}`;
    await t.prisma.project.create({
      data: {
        id: projectA2, orgId: f.orgA.id, name: 'Project A2', short: 'A2', descriptor: '', stage: 'Planning',
        siteCode: 'A2', projStart: '01 Jan 2026', projEnd: '31 Dec 2026', elapsedPct: 0, todayDay: 0, milestonePct: 0,
      },
    });
  });
  afterAll(async () => {
    await t?.prisma.commandExecution.deleteMany({ where: { projectId: projectA2 } });
    await t?.prisma.project.delete({ where: { id: projectA2 } }).catch(() => {});
    await t?.prisma.$executeRawUnsafe('TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor"');
    await f?.cleanup();
    await t?.close();
  });
  // each test cleans its own ledger + effect rows so counts start from zero
  afterEach(async () => {
    await t.prisma.commandExecution.deleteMany({ where: { OR: [{ projectId: { in: [f.projectA.id, projectA2] } }, { organizationId: f.orgA.id }] } });
    await t.prisma.auditLog.deleteMany({ where: { action: 'test.command' } });
  });

  const projScope = (projectId: string): CommandScope => ({ scopeKind: 'project', projectId });
  const orgScope = (organizationId: string): CommandScope => ({ scopeKind: 'org', organizationId });

  /** A minimal keyed command whose single canonical effect is one AuditLog row tagged `marker`,
   *  so "executed exactly once" is a row count. Returns the ledger outcome. */
  const runCmd = (opts: {
    scope: CommandScope; actor: Actor; commandType?: string; key?: string | null; hash?: string; marker: string;
    fail?: boolean;
  }) =>
    executeCommand(t.prisma, {
      scope: opts.scope,
      actor: opts.actor,
      commandType: opts.commandType ?? 'test.command',
      idempotencyKey: opts.key === undefined ? 'key-1' : opts.key,
      requestHash: opts.hash ?? hashRequest({ marker: opts.marker }),
      run: async (tx) => {
        await tx.auditLog.create({
          data: { projectId: opts.scope.scopeKind === 'project' ? opts.scope.projectId : null, actor: opts.actor.actorName, actorId: opts.actor.actorId, actorRole: opts.actor.actorRole, action: 'test.command', entity: 'Test', entityId: opts.marker },
        });
        if (opts.fail) throw new BadRequestException('mutation blew up after the effect');
        return { resultRef: opts.marker };
      },
    });

  const effectCount = (marker: string) => t.prisma.auditLog.count({ where: { action: 'test.command', entityId: marker } });
  const receiptCount = (scope: CommandScope, actorId: string, key = 'key-1', commandType = 'test.command') =>
    t.prisma.commandExecution.count({
      where: scope.scopeKind === 'project'
        ? { scopeKind: 'project', projectId: scope.projectId, actorId, commandType, idempotencyKey: key }
        : { scopeKind: 'org', organizationId: scope.organizationId, actorId, commandType, idempotencyKey: key },
    });

  it('two CONCURRENT identical commands → exactly one effect + one receipt; the loser replays the same result', async () => {
    const scope = projScope(f.projectA.id);
    const both = await Promise.all([
      runCmd({ scope, actor: alpha, marker: 'conc' }),
      runCmd({ scope, actor: alpha, marker: 'conc' }),
    ]);
    expect(await effectCount('conc'), 'the mutation ran exactly once').toBe(1);
    expect(await receiptCount(scope, alpha.actorId)).toBe(1);
    // exactly one is a fresh execution and one is a replay, and both return the same resultRef
    expect(both.filter((o) => !o.replayed)).toHaveLength(1);
    expect(both.filter((o) => o.replayed)).toHaveLength(1);
    expect(both[0].resultRef).toBe(both[1].resultRef);
  });

  it('the SAME key across two DIFFERENT actors does NOT collide and never returns one actor’s result to the other', async () => {
    const scope = projScope(f.projectA.id);
    const a = await runCmd({ scope, actor: alpha, marker: 'a-only' });
    const b = await runCmd({ scope, actor: beta, marker: 'b-only' });
    // two independent effects and two receipts — the actor-scoped subject keeps them apart
    expect(await effectCount('a-only')).toBe(1);
    expect(await effectCount('b-only')).toBe(1);
    expect(await receiptCount(scope, alpha.actorId)).toBe(1);
    expect(await receiptCount(scope, beta.actorId)).toBe(1);
    expect(a.resultRef).toBe('a-only');
    expect(b.resultRef).toBe('b-only'); // beta got ITS result, never alpha's
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(false);
  });

  it('the SAME actor+key+command across two projects of ONE org → two independent executions (project index keys on projectId)', async () => {
    const one = await runCmd({ scope: projScope(f.projectA.id), actor: alpha, marker: 'p1' });
    const two = await runCmd({ scope: projScope(projectA2), actor: alpha, marker: 'p2' });
    expect(one.replayed).toBe(false);
    expect(two.replayed).toBe(false); // the org partial index (WHERE scopeKind='org') never constrains project rows
    expect(await effectCount('p1')).toBe(1);
    expect(await effectCount('p2')).toBe(1);
    expect(await receiptCount(projScope(f.projectA.id), alpha.actorId)).toBe(1);
    expect(await receiptCount(projScope(projectA2), alpha.actorId)).toBe(1);
  });

  it('a DUPLICATE org-scoped key (same actor/command) is deduped by the org partial index — one effect, the retry replays', async () => {
    const scope = orgScope(f.orgA.id);
    const first = await runCmd({ scope, actor: alpha, marker: 'org1' });
    const second = await runCmd({ scope, actor: alpha, marker: 'org1' });
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true); // the org index rejected the duplicate reserve → replay
    expect(await effectCount('org1')).toBe(1);
    expect(await receiptCount(scope, alpha.actorId)).toBe(1);
  });

  it('same key + DIFFERENT request payload → 409 (a key binds to exactly one request)', async () => {
    const scope = projScope(f.projectA.id);
    await runCmd({ scope, actor: alpha, marker: 'x', hash: hashRequest({ v: 1 }) });
    await expect(runCmd({ scope, actor: alpha, marker: 'x', hash: hashRequest({ v: 2 }) })).rejects.toBeInstanceOf(ConflictException);
    expect(await effectCount('x'), 'the conflicting retry produced no second effect').toBe(1);
  });

  it('a mutation that FAILS mid-transaction leaves NO receipt and NO effect — the key stays retryable', async () => {
    const scope = projScope(f.projectA.id);
    await expect(runCmd({ scope, actor: alpha, marker: 'boom', fail: true })).rejects.toBeInstanceOf(BadRequestException);
    expect(await effectCount('boom'), 'the failed effect rolled back with its reservation').toBe(0);
    expect(await receiptCount(scope, alpha.actorId), 'no reserved row survives a rollback').toBe(0);
    // the SAME key now succeeds — the failure did not permanently block it
    const retry = await runCmd({ scope, actor: alpha, marker: 'boom' });
    expect(retry.replayed).toBe(false);
    expect(await effectCount('boom')).toBe(1);
  });

  it('the receipt commits ATOMICALLY with the mutation — a succeeded receipt carries resultRef + completedAt', async () => {
    const scope = projScope(f.projectA.id);
    const out = await runCmd({ scope, actor: alpha, marker: 'atomic' });
    const row = await t.prisma.commandExecution.findFirstOrThrow({ where: { scopeKind: 'project', projectId: f.projectA.id, actorId: alpha.actorId, commandType: 'test.command', idempotencyKey: 'key-1' } });
    expect(row.status).toBe('succeeded');
    expect(row.resultRef).toBe('atomic');
    expect(row.completedAt).toBeInstanceOf(Date);
    expect(row.organizationId, 'the tenant is DERIVED from the project, never supplied').toBe(f.orgA.id);
    expect(out.resultRef).toBe('atomic');
  });

  it('missing-key behavior is gated: OFF → runs directly with no receipt; ON → rejected before any effect', async () => {
    const scope = projScope(f.projectA.id);
    // enforcement OFF (default): a legacy client with no key still works — today's behavior, no ledger row
    const legacy = await runCmd({ scope, actor: alpha, key: null, marker: 'legacy' });
    expect(legacy.replayed).toBe(false);
    expect(await effectCount('legacy')).toBe(1);
    expect(await t.prisma.commandExecution.count({ where: { projectId: f.projectA.id } }), 'an unkeyed command writes no receipt').toBe(0);

    // enforcement ON: a missing key is refused (capability/version gate), and nothing runs
    process.env.COMMAND_KEY_ENFORCED = 'true';
    try {
      await expect(runCmd({ scope, actor: alpha, key: null, marker: 'refused' })).rejects.toBeInstanceOf(BadRequestException);
      expect(await effectCount('refused'), 'a rejected command never touched the database').toBe(0);
    } finally {
      delete process.env.COMMAND_KEY_ENFORCED;
    }
  });
});

/**
 * The decision pillar wired onto the ledger — the reference integration. A retried approve
 * with the same key locks the decision exactly once and replays the same snapshot; a fresh
 * key on an already-locked decision is a truthful 409 (you cannot approve twice).
 */
describe('Phase 2 Task 5 — decision pillar is idempotent end-to-end (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let svc: DecisionsService;
  let user: AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    svc = t.app.get(DecisionsService);
    user = { sub: f.memberUser.id, role: 'pmc', projectId: f.projectA.id };
  });
  afterAll(async () => {
    await t?.prisma.$executeRawUnsafe('TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor"');
    await f?.cleanup();
    await t?.close();
  });

  /** seed one published, pending decision with two options. */
  const seedDecision = async (id: string): Promise<string> => {
    await t.prisma.decision.create({
      data: { id, projectId: f.projectA.id, title: `Counter ${id}`, room: 'Kitchen', status: 'pending', ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id, publishedAt: new Date() },
    });
    await t.prisma.decisionOption.createMany({
      data: [
        { decisionId: id, label: 'Granite', optionKey: 'a', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true, order: 0 },
        { decisionId: id, label: 'Quartz', optionKey: 'b', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false, order: 1 },
      ],
    });
    return id;
  };
  const cleanupDecision = async (id: string) => {
    await t.prisma.commandExecution.deleteMany({ where: { projectId: f.projectA.id } });
    await t.prisma.$executeRawUnsafe('TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor"');
    await t.prisma.auditLog.deleteMany({ where: { entityId: id } });
    await t.prisma.notification.deleteMany({ where: { projectId: f.projectA.id } });
    await t.prisma.changeRequest.deleteMany({ where: { decisionId: id } });
    await t.prisma.decisionEvent.deleteMany({ where: { decisionId: id } });
    await t.prisma.decisionOption.deleteMany({ where: { decisionId: id } });
    await t.prisma.decision.deleteMany({ where: { id } });
  };

  it('approving twice with the SAME key locks the decision exactly once and replays the same result', async () => {
    const id = await seedDecision('DL-idem-1');
    const key = 'approve-key-abc';
    const first = await svc.approve(f.projectA.id, id, { optionIndex: 0 }, user, key);
    const second = await svc.approve(f.projectA.id, id, { optionIndex: 0 }, user, key);

    const d = await t.prisma.decision.findUniqueOrThrow({ where: { id } });
    expect(d.status).toBe('approved');
    expect(d.material).toBe('Granite');
    // exactly one lock event, one audit, one receipt — the replay added nothing
    expect(await t.prisma.decisionEvent.count({ where: { decisionId: id, type: 'approved' } })).toBe(1);
    expect(await t.prisma.auditLog.count({ where: { entityId: id, action: 'decision.approve' } })).toBe(1);
    expect(await t.prisma.commandExecution.count({ where: { projectId: f.projectA.id, commandType: 'decisions.approve', idempotencyKey: key } })).toBe(1);
    // both calls return the same committed snapshot shape (the decision reads as approved in each)
    const firstDec = first.decisions.find((x) => x.id === id);
    const secondDec = second.decisions.find((x) => x.id === id);
    expect(firstDec?.status).toBe('approved');
    expect(secondDec?.status).toBe('approved');
    await cleanupDecision(id);
  });

  it('a FRESH key on an already-locked decision is a truthful 409 — idempotency never masks a real double-approve', async () => {
    const id = await seedDecision('DL-idem-2');
    await svc.approve(f.projectA.id, id, { optionIndex: 0 }, user, 'key-one');
    await expect(svc.approve(f.projectA.id, id, { optionIndex: 1 }, user, 'key-two')).rejects.toBeInstanceOf(ConflictException);
    // the failed second attempt left no receipt (its reservation rolled back with the CAS 409)
    expect(await t.prisma.commandExecution.count({ where: { projectId: f.projectA.id, idempotencyKey: 'key-two' } })).toBe(0);
    await cleanupDecision(id);
  });
});
