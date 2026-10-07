import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { emitEvent, type EmitInput } from '../../src/platform/events';
import type { EventActor } from '../../src/common/actor';
import { CommercialActivationService } from '../../src/commercial/commercial-activation.service';
import { CommercialBudgetService } from '../../src/commercial/commercial-budget.service';
import { COMMERCIAL_MONEY_EVENT } from '../../src/commercial/cash-forecast.projection';
import { reevaluateAll } from '../../src/commercial/commercial-reevaluate.cli';
import { COMMERCIAL_CAPABILITY } from '../../src/platform/capabilities.service';
import { newInstanceId, writeLease } from '../../src/platform/release-lease.service';
import { SERVER_GENERATION, SERVER_GENERATION_MINIMUM, readServerMinimum } from '../../src/platform/server-generation';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * Phase 6 task 4d-iii / R0c — the system emitters WRITE the system pair R0b admits, the lease records
 * its build's server generation, and the event-writing operator CLIs take the server-generation fence
 * (`docs/superpowers/plans/2026-10-05-4d-iii-additive-units.md`, R0c). Proven against live PostgreSQL:
 *
 * - a `system` actor naming a registered automation commits with (`system`, that name) and keeps its
 *   `systemActor`; one naming none still commits with no pair; a non-system or unregistered pair on a
 *   system actor is refused before the stream moves;
 * - §L activation (`commercial-activation`) and the §J sweep (`commercial-reevaluate`) commit their
 *   `commercial.money_moved` with the pair and the operator's id as `systemActor` (the effects
 *   processor's `decisions-effects` re-notification is proven in the A7d suite, where its crossing is);
 * - each operator path REFUSES, writing nothing, when its compiled generation is below the persisted
 *   minimum, read `FOR SHARE` inside its own write transaction;
 * - `writeLease` records the compiled generation, 3.
 */
describe('4d-iii / R0c — system emitters write the system pair; the lease records its generation; the CLI fence (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let activation: CommercialActivationService;
  let budget: CommercialBudgetService;
  let seq = 0;

  const RESET_TABLES = ['BudgetException', 'BudgetLine', 'CommitmentAttribution', 'CostHead',
    'DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor',
    'ProjectionGeneration', 'CashForecastProjection', 'CommandExecution', 'ProjectCapability',
  ] as const;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    activation = t.app.get(CommercialActivationService);
    budget = t.app.get(CommercialBudgetService);
  });
  const wipe = async () => {
    await sanctionedReset(t.prisma, RESET_TABLES, { cascade: true });
    for (const [model, where] of [
      ['auditLog', { projectId: { startsWith: 'it-r0c-' } }],
      ['membership', { projectId: { startsWith: 'it-r0c-' } }],
      ['project', { id: { startsWith: 'it-r0c-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  };
  afterEach(async () => { await wipe(); });
  afterAll(async () => {
    if (t) await wipe();
    await f?.cleanup();
    await t?.close();
  });

  const freshProject = async (): Promise<string> => {
    const id = `it-r0c-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    return id;
  };
  const plan = { costHeads: [{ code: 'CIVIL', name: 'Civil works' }], materialLines: [], labourLines: [], reason: 'r0c activation' };
  const moneyEvents = (projectId: string, reason?: string) => t.prisma.domainEvent.findMany({
    where: { projectId, eventType: COMMERCIAL_MONEY_EVENT, ...(reason ? { payload: { path: ['reason'], equals: reason } } : {}) },
    select: { actorId: true, actorKind: true, systemActor: true, actorRole: true, actorName: true },
    orderBy: { streamPosition: 'asc' },
  });
  const position = async (projectId: string) =>
    (await t.prisma.projectEventStream.findUniqueOrThrow({ where: { projectId } })).nextPosition;

  // ── emitEvent ────────────────────────────────────────────────────────────────────────────────

  const input = (actor: EventActor, extra: Partial<EmitInput> = {}): EmitInput => ({
    projectId: f.projectA.id, actor, eventType: 'activity.completion_requested', entityType: 'Activity',
    entityId: `R0C-${randomUUID()}`, effectKey: 'activity.completion_requested',
    dispatch: { push: { body: 'completion requested' } }, ...extra,
  });
  const inTx = <T>(body: (tx: Prisma.TransactionClient) => Promise<T>) => t.prisma.$transaction(body);

  it('a system actor naming a registered automation commits with the system pair and keeps its systemActor; one naming none commits with no pair', async () => {
    const named = await inTx((tx) => emitEvent(tx, input({ actorId: 'system:r0c-probe', actorKind: 'system', actorRole: 'system', automation: 'decisions-effects' })));
    expect(await t.prisma.domainEvent.findUniqueOrThrow({ where: { eventId: named.eventId } }))
      .toMatchObject({ actorId: null, actorKind: 'system', systemActor: 'system:r0c-probe', actorRole: 'system', actorName: 'decisions-effects' });
    const bare = await inTx((tx) => emitEvent(tx, input({ actorId: 'system:r0c-probe', actorKind: 'system', actorRole: 'system' })));
    expect(await t.prisma.domainEvent.findUniqueOrThrow({ where: { eventId: bare.eventId } }))
      .toMatchObject({ actorKind: 'system', actorRole: null, actorName: null });
  });

  it('a system actor carrying a non-system pair, another automation\'s pair, an explicit NULL beside its automation, or naming an unregistered automation, is refused before the stream moves', async () => {
    const before = await position(f.projectA.id);
    const system: EventActor = { actorId: 'system:r0c-probe', actorKind: 'system', actorRole: 'system' };
    await expect(inTx((tx) => emitEvent(tx, input(system, { actorEnvelope: { actorRole: 'pmc', actorName: 'Someone' } }))))
      .rejects.toThrow(/registered automation/);
    await expect(inTx((tx) => emitEvent(tx, input(system, { actorEnvelope: { actorRole: 'system', actorName: 'unregistered' } }))))
      .rejects.toThrow(/registered automation/);
    await expect(inTx((tx) => emitEvent(tx, input({ ...system, automation: 'decisions-effects' }, { actorEnvelope: { actorRole: 'system', actorName: 'commercial-activation' } }))))
      .rejects.toThrow(/registered automation/);
    // Codex 4202818435 — an explicit NULL on an actor naming its automation would drop the attribution
    await expect(inTx((tx) => emitEvent(tx, input({ ...system, automation: 'decisions-effects' }, { actorEnvelope: null }))))
      .rejects.toThrow(/registered automation/);
    await expect(inTx((tx) => emitEvent(tx, input({ ...system, automation: 'unregistered' as never }))))
      .rejects.toThrow(/not a registered automation/);
    expect(await position(f.projectA.id)).toBe(before);
  });

  // ── the two operator paths ───────────────────────────────────────────────────────────────────

  it('§L activation commits commercial.money_moved with (`system`, `commercial-activation`), the operator as systemActor', async () => {
    const projectId = await freshProject();
    await activation.activate(projectId, f.memberUser.id, plan);
    const events = await moneyEvents(projectId, 'activation');
    expect(events).toEqual([{ actorId: null, actorKind: 'system', systemActor: f.memberUser.id, actorRole: 'system', actorName: 'commercial-activation' }]);
  });

  it('the §J sweep commits commercial.money_moved with (`system`, `commercial-reevaluate`), the operator as systemActor', async () => {
    const projectId = await freshProject();
    await activation.activate(projectId, f.memberUser.id, plan);
    await reevaluateAll(t.prisma, budget, { userId: f.memberUser.id, reason: 'r0c sweep' });
    const events = await moneyEvents(projectId, 'fold_correction');
    expect(events).toEqual([{ actorId: null, actorKind: 'system', systemActor: f.memberUser.id, actorRole: 'system', actorName: 'commercial-reevaluate' }]);
  });

  it('activation compiled below the persisted minimum is REFUSED inside its transaction and writes nothing', async () => {
    const minimum = (await readServerMinimum(t.prisma))!.minimumGeneration;
    expect(minimum).toBe(SERVER_GENERATION_MINIMUM);
    const projectId = await freshProject();
    await expect(activation.activate(projectId, f.memberUser.id, plan, { compiledGeneration: minimum - 1 }))
      .rejects.toThrow(/server-generation fence: this build compiles server generation 1, below the persisted minimum 2/);
    expect(await t.prisma.projectCapability.count({ where: { projectId, capability: COMMERCIAL_CAPABILITY } })).toBe(0);
    expect(await t.prisma.costHead.count({ where: { projectId } })).toBe(0);
    expect(await t.prisma.domainEvent.count({ where: { projectId } })).toBe(0);
    // at the minimum itself it is admitted
    await activation.activate(projectId, f.memberUser.id, plan, { compiledGeneration: minimum });
    expect(await t.prisma.projectCapability.count({ where: { projectId, capability: COMMERCIAL_CAPABILITY } })).toBe(1);
  });

  it('the sweep compiled below the persisted minimum is REFUSED inside its transaction and writes nothing', async () => {
    const projectId = await freshProject();
    await activation.activate(projectId, f.memberUser.id, plan);
    const before = await position(projectId);
    await expect(reevaluateAll(t.prisma, budget, { userId: f.memberUser.id, reason: 'r0c stale sweep' }, { compiledGeneration: SERVER_GENERATION_MINIMUM - 1 }))
      .rejects.toThrow(/server-generation fence/);
    expect(await position(projectId)).toBe(before);
    expect(await moneyEvents(projectId, 'fold_correction')).toEqual([]);
    expect(await t.prisma.auditLog.count({ where: { projectId, action: 'commercial.reevaluate' } })).toBe(0);
  });

  // ── the lease ────────────────────────────────────────────────────────────────────────────────

  it('writeLease records the compiled server generation, 3 (rolled back: a committed lease is permanent)', async () => {
    expect(SERVER_GENERATION).toBe(3);
    const ROLLBACK = new Error('rolled back on purpose');
    let recorded: number | null | undefined;
    await t.prisma.$transaction(async (tx) => {
      const instanceId = newInstanceId();
      await writeLease(tx, { instanceId, catalogVersion: 3, release: 'r0c-probe' });
      const [row] = await tx.$queryRawUnsafe<Array<{ g: number | null }>>(`SELECT "serverGeneration" AS g FROM "ReleaseLease" WHERE "instanceId" = $1`, instanceId);
      recorded = row?.g;
      throw ROLLBACK;
    }).catch((e) => { if (e !== ROLLBACK) throw e; });
    expect(recorded).toBe(3);
  });
});
