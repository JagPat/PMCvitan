import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture, wipeDecisionEvents, wipeDecisionsVia, seedPublishedDecision, plantLegacyApprovalRevision, plantLegacyDecisionAudit } from './fixtures';
import { RequirementsService } from '../../src/activities/requirements.service';
import { LabourService } from '../../src/labour/labour.service';
import { CapabilitiesService, MATERIALS_CAPABILITY, LABOUR_CAPABILITY } from '../../src/platform/capabilities.service';
import type { AuthUser } from '../../src/common/auth';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * Phase 6 task 4d unit 4d-ii-a / A4b — `decisions.approvedRef` carries the head revision's finality,
 * and every spec writer STATES it (§A.2 "The finality key, stated exactly"; P42's writer arms).
 *
 * A requirement's decision provenance is a composite FK onto the approval register's widened key
 * `(projectId, decisionId, version, optionKey, finalized)`, carried on each spec row as
 * `revisionFinalized`. 4d-i kept that column's DEFAULT (`true`) so previous-release writers keep
 * working through the drain; 4d-iii drops it. Every shipped writer (create, revise and cancel,
 * material and labour) is driven here with the database defaults DROPPED, as 4d-iii will leave them,
 * and every row it writes carries the carrier.
 *
 * WHAT THOSE ARMS DO NOT PROVE, measured: they pass against the delivered writers too, because the
 * Prisma schema still declares `@default(true)` and the client sends that value itself when a writer
 * omits the field. The delivered writers break only once 4d-iii also drops the schema default, where
 * the field becomes required. What catches a writer that does not state the carrier NOW is the
 * static writer sweep (`src/platform/spec-finality-writer-sweep.test.ts`), RED on the delivered
 * writers. These arms stay as the live record that each writer's rows carry it with no database
 * default to fall back on.
 *
 * And a PROVISIONAL head (an approval awaiting countersign) cannot anchor provenance: `approvedRef`
 * refuses it readably, where the base handed out its version and the spec insert crashed on the FK.
 * That arm is RED on the delivered code.
 */
describe('4d-ii-a / A4b — approvedRef carries finality and every spec writer states it (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let requirements: RequirementsService;
  let labour: LabourService;
  let capabilities: CapabilitiesService;
  let seq = 0;
  const run = randomUUID().slice(0, 6);
  const PREFIX = `it-a4b-${run}-`;

  const RESET_TABLES = ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor',
    'ProjectionGeneration', 'DecisionProjection', 'ActivitiesProjection', 'MaterialReadinessProjection',
    'LabourReadinessProjection', 'CashForecastProjection', 'CommandExecution',
    'LabourDemandSlice', 'LabourRequirementSpec', 'LabourTrade', 'LabourSkill',
    'MaterialRequirementSpec', 'ActivityRequirement', 'ActivityRequirementRoot',
    'DecisionApprovalRevision', 'ProjectCapability',
  ] as const;

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    requirements = t.app.get(RequirementsService);
    labour = t.app.get(LabourService);
    capabilities = t.app.get(CapabilitiesService);
  });
  const reset = async () => {
    await sanctionedReset(t.prisma, RESET_TABLES, { cascade: true });
    await wipeDecisionEvents(t.prisma, { decision: { projectId: { startsWith: PREFIX } } });
    await wipeDecisionsVia(t.prisma, async (tx) => {
      await tx.decisionOption.deleteMany({ where: { decision: { projectId: { startsWith: PREFIX } } } });
      await tx.decision.deleteMany({ where: { projectId: { startsWith: PREFIX } } });
    });
    await t.prisma.auditLog.deleteMany({ where: { projectId: { startsWith: PREFIX } } });
    await t.prisma.activity.deleteMany({ where: { projectId: { startsWith: PREFIX } } });
    await t.prisma.membership.deleteMany({ where: { projectId: { startsWith: PREFIX } } });
    await t.prisma.project.deleteMany({ where: { id: { startsWith: PREFIX } } });
  };
  afterEach(async () => { await reset(); });
  afterAll(async () => {
    await reset();
    await f?.cleanup();
    await t?.close();
  });

  const freshProject = async (): Promise<string> => {
    const id = `${PREFIX}${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.clientUser.id, role: 'client', status: 'active' } });
    await capabilities.enable(id, MATERIALS_CAPABILITY, f.memberUser.id);
    await capabilities.enable(id, LABOUR_CAPABILITY, f.memberUser.id);
    await labour.upsertTrade(id, { code: 'mason', name: 'Mason' }, pmc(id));
    await labour.upsertSkill(id, { code: 'bar-bending', name: 'Bar Bending' }, pmc(id));
    return id;
  };
  const freshActivity = async (projectId: string): Promise<string> => {
    const id = `${PREFIX}ACT-${seq++}`;
    await t.prisma.activity.create({ data: { id, projectId, name: `Act ${seq}`, zone: 'Zone 1', plannedStart: 0, plannedEnd: 10 } });
    return id;
  };
  /** An approved decision whose head revision (v1) is FINAL — planted, standing in for an approval that already happened. */
  const approvedDecision = async (projectId: string): Promise<string> => {
    const id = `${PREFIX}DEC-${seq++}`;
    await plantLegacyDecisionAudit(t.prisma, (tx) => seedPublishedDecision(tx, {
      id, projectId, title: id, room: 'Living', photoSwatch: 'sw', status: 'approved',
      authorId: f.memberUser.id, approvedOption: 'Option A',
      events: { create: [{ type: 'approved', actor: 'member' }] },
    }, [
      { label: 'Option A', optionKey: 'opt-a', material: 'Skilled', delta: 0, swatch: 'sw-a', order: 1 },
      { label: 'Option B', optionKey: 'opt-b', material: 'Unskilled', delta: 100, swatch: 'sw-b', order: 2 },
    ]));
    await plantLegacyApprovalRevision(t.prisma, {
      id: `dar-${id}-v1`, projectId, decisionId: id, version: 1, optionKey: 'opt-a', approvedById: f.memberUser.id,
    });
    return id;
  };

  const materialReq = (activityId: string, decisionId: string | null, over: Record<string, unknown> = {}) => ({
    type: 'material', activityId, materialCategory: 'Cement', make: 'UltraTech', grade: 'OPC 53', attributes: '',
    baseUom: 'bag', qty: '10', requiredBy: '2026-08-15', criticality: 'normal', decisionId, responsibleId: null, tolerance: null, ...over,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
  const labourReq = (activityId: string, decisionId: string | null, over: Record<string, unknown> = {}) => ({
    type: 'labour', activityId, tradeCode: 'mason', skillCode: 'bar-bending', shift: 'day',
    demandSlices: [{ civilDate: '2026-08-10', personShiftQty: 4 }], decisionId, responsibleId: null, criticality: 'normal', tolerance: null, ...over,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  /** Run `body` with the two spec columns' DEFAULT dropped — the shape 4d-iii leaves — and restore it. */
  const withoutDefaults = async (body: () => Promise<void>) => {
    await t.prisma.$executeRawUnsafe('ALTER TABLE "MaterialRequirementSpec" ALTER COLUMN "revisionFinalized" DROP DEFAULT');
    await t.prisma.$executeRawUnsafe('ALTER TABLE "LabourRequirementSpec" ALTER COLUMN "revisionFinalized" DROP DEFAULT');
    try {
      await body();
    } finally {
      await t.prisma.$executeRawUnsafe('ALTER TABLE "MaterialRequirementSpec" ALTER COLUMN "revisionFinalized" SET DEFAULT TRUE');
      await t.prisma.$executeRawUnsafe('ALTER TABLE "LabourRequirementSpec" ALTER COLUMN "revisionFinalized" SET DEFAULT TRUE');
    }
  };

  const materialSpecs = (projectId: string, requirementId: string) =>
    t.prisma.materialRequirementSpec.findMany({ where: { projectId, requirementId }, orderBy: { revision: 'asc' } });
  const labourSpecs = (projectId: string, requirementId: string) =>
    t.prisma.labourRequirementSpec.findMany({ where: { projectId, requirementId }, orderBy: { revision: 'asc' } });

  it('P42: with the defaults dropped, the SHIPPED material writers — create, revise, cancel — each state the finality carrier', async () => {
    const projectId = await freshProject();
    const act = await freshActivity(projectId);
    const decisionId = await approvedDecision(projectId);
    await withoutDefaults(async () => {
      const r1 = await requirements.create(projectId, materialReq(act, decisionId), pmc(projectId));
      await requirements.revise(projectId, r1.requirementId, materialReq(act, decisionId, { qty: '12', expectedRevision: 1 }), pmc(projectId));
      await requirements.cancel(projectId, r1.requirementId, { expectedRevision: 2, reason: 'descoped' }, pmc(projectId));
      const specs = await materialSpecs(projectId, r1.requirementId);
      expect(specs.map((s) => [s.revision, s.decisionId, s.decisionVersion, s.revisionFinalized])).toEqual([
        [1, decisionId, 1, true], [2, decisionId, 1, true], [3, decisionId, 1, true],
      ]);
    });
  });

  it('P42: with the defaults dropped, the SHIPPED labour writers — create, revise, cancel — each state the finality carrier', async () => {
    const projectId = await freshProject();
    const act = await freshActivity(projectId);
    const decisionId = await approvedDecision(projectId);
    await withoutDefaults(async () => {
      const r1 = await requirements.create(projectId, labourReq(act, decisionId), pmc(projectId));
      await requirements.revise(projectId, r1.requirementId, labourReq(act, decisionId, { expectedRevision: 1, demandSlices: [{ civilDate: '2026-08-10', personShiftQty: 6 }] }), pmc(projectId));
      await requirements.cancel(projectId, r1.requirementId, { expectedRevision: 2, reason: 'descoped' }, pmc(projectId));
      const specs = await labourSpecs(projectId, r1.requirementId);
      expect(specs.map((s) => [s.revision, s.decisionId, s.decisionVersion, s.revisionFinalized])).toEqual([
        [1, decisionId, 1, true], [2, decisionId, 1, true], [3, decisionId, 1, true],
      ]);
    });
  });

  it('P42: a spec naming NO decision states the carrier too, for both types', async () => {
    const projectId = await freshProject();
    const act = await freshActivity(projectId);
    await withoutDefaults(async () => {
      const m = await requirements.create(projectId, materialReq(act, null), pmc(projectId));
      const l = await requirements.create(projectId, labourReq(act, null), pmc(projectId));
      await requirements.cancel(projectId, m.requirementId, { expectedRevision: 1, reason: 'descoped' }, pmc(projectId));
      await requirements.cancel(projectId, l.requirementId, { expectedRevision: 1, reason: 'descoped' }, pmc(projectId));
      expect((await materialSpecs(projectId, m.requirementId)).map((s) => [s.decisionId, s.revisionFinalized])).toEqual([[null, true], [null, true]]);
      expect((await labourSpecs(projectId, l.requirementId)).map((s) => [s.decisionId, s.revisionFinalized])).toEqual([[null, true], [null, true]]);
    });
  });

  it('P42: the DEFAULTS still hold through the drain — a spec inserted without the column lands true', async () => {
    const projectId = await freshProject();
    const act = await freshActivity(projectId);
    const decisionId = await approvedDecision(projectId);
    const r = await requirements.create(projectId, materialReq(act, decisionId), pmc(projectId));
    // the previous release's three-field write shape: a revision and its spec in ONE transaction (the
    // type↔detail correspondence is judged at commit), the spec naming the provenance but not the carrier
    await t.prisma.$transaction(async (tx) => {
      await tx.activityRequirement.create({
        data: { projectId, requirementId: r.requirementId, revision: 2, activityId: act, type: 'material', requiredQty: '10', baseUom: 'bag', requiredBy: new Date('2026-08-15'), criticality: 'normal', status: 'open', createdById: f.memberUser.id },
      });
      await tx.$executeRawUnsafe(
        `INSERT INTO "MaterialRequirementSpec" ("id","projectId","requirementId","revision","materialCategory","make","grade","normalizedAttributes","specFingerprint","decisionId","decisionVersion","optionKey")
         SELECT gen_random_uuid()::text,"projectId","requirementId",2,"materialCategory","make","grade","normalizedAttributes","specFingerprint","decisionId","decisionVersion","optionKey"
           FROM "MaterialRequirementSpec" WHERE "projectId" = $1 AND "requirementId" = $2 AND "revision" = 1`,
        projectId, r.requirementId,
      );
    });
    expect((await materialSpecs(projectId, r.requirementId)).map((s) => [s.revision, s.revisionFinalized])).toEqual([[1, true], [2, true]]);
  });

  it('a PROVISIONAL head cannot anchor provenance: approvedRef refuses it readably, for both types', async () => {
    const projectId = await freshProject();
    const act = await freshActivity(projectId);
    const decisionId = await approvedDecision(projectId);
    // a v2 head awaiting countersign, planted with the register's insert seals disabled by name for
    // this one insert (nothing writes a provisional revision before A8a and 4d-iii's activation)
    const SEALS = ['DecisionApprovalRevision_t4c_provenance', 'DecisionApprovalRevision_t4d_birth', 'DecisionApprovalRevision_t4d_birth_paired', 'DecisionApprovalRevision_t4d_claim', 'DecisionApprovalRevision_t4d_claim_deferred'];
    await t.prisma.$transaction(async (tx) => {
      for (const s of SEALS) await tx.$executeRawUnsafe(`ALTER TABLE "DecisionApprovalRevision" DISABLE TRIGGER "${s}"`);
      await tx.$executeRawUnsafe(
        `INSERT INTO "DecisionApprovalRevision" ("id","projectId","decisionId","version","optionKey","approvedAt","approvedById","finalized","approvedFrom","approvedByName","approvedByRole")
         VALUES ($1, $2, $3, 2, 'opt-b', now(), $4, FALSE, 'change', 'Member', 'pmc')`,
        `dar-${decisionId}-v2`, projectId, decisionId, f.memberUser.id,
      );
      for (const s of SEALS) await tx.$executeRawUnsafe(`ALTER TABLE "DecisionApprovalRevision" ENABLE TRIGGER "${s}"`);
    });
    for (const input of [materialReq(act, decisionId), labourReq(act, decisionId)]) {
      const refusal = await requirements.create(projectId, input, pmc(projectId)).then(() => null, (e: unknown) => e as { status?: number; message?: string });
      expect(refusal, `${input.type}: the provisional head must be refused`).not.toBeNull();
      expect(refusal!.status).toBe(400);
      expect(refusal!.message).toMatch(/provisional until the architect countersigns/);
    }
    expect(await t.prisma.activityRequirement.count({ where: { projectId } })).toBe(0);
  });
});
