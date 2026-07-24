import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { RequirementsService } from '../../src/activities/requirements.service';
import { LabourService } from '../../src/labour/labour.service';
import { CapabilitiesService, MATERIALS_CAPABILITY, LABOUR_CAPABILITY } from '../../src/platform/capabilities.service';
import { SnapshotService } from '../../src/snapshot/snapshot.service';
import { computeLabourSpecFingerprint } from '@vitan/shared';
import type { AuthUser } from '../../src/common/auth';

/**
 * Phase 4 Task 1 — the labour capability + type-routed demand + trusted workforce identity
 * (plan §§B/D/H). Every invariant is proven live against PostgreSQL, reproduce-first.
 *
 * §D — the `labour` pilot capability + type-based capability routing (material→`materials`,
 *   labour→`labour`) + capability-off byte identity.
 * §B — the labour requirement detail written THROUGH the cycle-exempt participant, the
 *   `labourSpecFingerprint`, the DB type↔detail correspondence, the immutable root type, and
 *   labour-detail append-only immutability.
 * §H — first-class `Worker`/`Crew`/`CrewMembership` + `WorkerDevice`→`Worker` binding, all
 *   project-contained (cross-project references unrepresentable in PostgreSQL), the applicable
 *   uniqueness rules, active-window + revocation, and the onboarding authority/idempotency.
 */

describe('Phase 4 Task 1 — labour capability + type-routed demand + workforce identity (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let requirements: RequirementsService;
  let labour: LabourService;
  let capabilities: CapabilitiesService;
  let snapshot: SnapshotService;
  let seq = 0;

  const TRUNCATE =
    'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "MaterialReadinessProjection", "StockTransaction", "MaterialIssue", "StockLot", "CommandExecution", "DeliveryPromise", "DeliveryCommitment", "PurchaseOrderLine", "PurchaseOrderVersion", "PurchaseOrder", "VendorQuoteLine", "QuoteComparison", "VendorQuote", "Rfq", "RequisitionLine", "Requisition", "ApprovedSubstitution", "CrewMembership", "Crew", "WorkerDevice", "Worker", "LabourDemandSlice", "LabourRequirementSpec", "LabourTrade", "LabourSkill", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability"';

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;
  const engineer = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'engineer', projectId }) as AuthUser;
  const client = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'client', projectId }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    requirements = t.app.get(RequirementsService);
    labour = t.app.get(LabourService);
    capabilities = t.app.get(CapabilitiesService);
    snapshot = t.app.get(SnapshotService);
  });
  afterAll(async () => {
    await t?.prisma.$executeRawUnsafe(TRUNCATE);
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe(TRUNCATE);
    for (const [model, where] of [
      ['auditLog', { projectId: { startsWith: 'it-p4-' } }],
      ['activity', { projectId: { startsWith: 'it-p4-' } }],
      ['membership', { projectId: { startsWith: 'it-p4-' } }],
      ['decisionEvent', { decision: { projectId: { startsWith: 'it-p4-' } } }],
      ['decisionOption', { decision: { projectId: { startsWith: 'it-p4-' } } }],
      ['decision', { projectId: { startsWith: 'it-p4-' } }],
      ['project', { id: { startsWith: 'it-p4-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  const freshProject = async (): Promise<string> => {
    const id = `it-p4-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    return id;
  };
  const freshActivity = async (projectId: string): Promise<string> => {
    const id = `IT-P4-ACT-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.activity.create({ data: { id, projectId, name: `Act ${seq}`, zone: 'Zone 1', plannedStart: 0, plannedEnd: 10 } });
    return id;
  };
  const makeApprovedDecision = async (projectId: string, id: string): Promise<void> => {
    await t.prisma.decision.create({
      data: {
        id, projectId, title: id, room: 'Living', photoSwatch: 'sw', status: 'approved',
        publishedAt: new Date(), authorId: f.memberUser.id, approvedOption: 'Option A',
        options: { create: [{ label: 'Option A', optionKey: 'opt-a', material: 'Skilled', delta: 0, swatch: 'sw-a', order: 1 }] },
        events: { create: [{ type: 'approved', actor: 'member' }] },
      },
    });
    await t.prisma.decisionApprovalRevision.create({
      data: { id: `dar-${id}-v1`, projectId, decisionId: id, version: 1, optionKey: 'opt-a', approvedAt: new Date(), approvedById: f.memberUser.id },
    });
  };

  /** Enable labour + seed the catalog a labour requirement/worker needs. */
  const enableLabourWithCatalog = async (projectId: string): Promise<void> => {
    await capabilities.enable(projectId, LABOUR_CAPABILITY, f.memberUser.id);
    await labour.upsertTrade(projectId, { code: 'mason', name: 'Mason' }, pmc(projectId));
    await labour.upsertSkill(projectId, { code: 'bar-bending', name: 'Bar Bending' }, pmc(projectId));
  };

  // a labour requirement command input (direct service call — the controller supplies `type` via
  // the discriminated zod schema; here we pass it explicitly)
  const labourReq = (activityId: string, slices: Array<{ civilDate: string; personShiftQty: number }>, over: Record<string, unknown> = {}) => ({
    type: 'labour', activityId, tradeCode: 'mason', skillCode: 'bar-bending', shift: 'day',
    demandSlices: slices, decisionId: null, responsibleId: null, criticality: 'normal', tolerance: null, ...over,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  const MATERIAL_REQ = {
    type: 'material', materialCategory: 'Cement', make: 'UltraTech', grade: 'OPC 53', attributes: '',
    baseUom: 'bag', qty: '10', requiredBy: '2026-08-15', criticality: 'normal', decisionId: null, responsibleId: null, tolerance: null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  // ── §D capability + type-based routing ──────────────────────────────────────────────────────

  it('§D INERTNESS: labour on ONE project — the other has no labour route, no rows, byte-identical snapshot', async () => {
    const pilot = await freshProject();
    const other = await freshProject();
    const before = await snapshot.build(other, 'pmc', f.memberUser.id);

    await enableLabourWithCatalog(pilot);
    const act = await freshActivity(pilot);
    const created = await requirements.create(pilot, labourReq(act, [{ civilDate: '2026-08-10', personShiftQty: 4 }]), pmc(pilot));
    expect(created.type).toBe('labour');

    // the non-pilot project: every labour surface 404s (the capability does not exist for it)
    await expect(labour.workforce(other, pmc(other))).rejects.toMatchObject({ status: 404 });
    await expect(labour.catalog(other, pmc(other))).rejects.toMatchObject({ status: 404 });
    await expect(labour.upsertTrade(other, { code: 'x', name: 'x' }, pmc(other))).rejects.toMatchObject({ status: 404 });
    // the capability gate 404s BEFORE any activity check, so a dummy activityId never mutates `other`
    await expect(requirements.create(other, labourReq('no-such-activity', [{ civilDate: '2026-08-10', personShiftQty: 1 }]), pmc(other))).rejects.toMatchObject({ status: 404 });

    const after = await snapshot.build(other, 'pmc', f.memberUser.id);
    expect(after).toEqual(before); // byte-for-byte unchanged
    expect(await t.prisma.worker.count({ where: { projectId: other } })).toBe(0);
    expect(await t.prisma.domainEvent.count({ where: { projectId: other } })).toBe(0);
  });

  it('§D TYPE ROUTING: a requirement asserts the capability that matches its type', async () => {
    // materials ON, labour OFF: material OK, labour 404
    const matOnly = await freshProject();
    await capabilities.enable(matOnly, MATERIALS_CAPABILITY, f.memberUser.id);
    const a1 = await freshActivity(matOnly);
    await expect(requirements.create(matOnly, { ...MATERIAL_REQ, activityId: a1 }, pmc(matOnly))).resolves.toMatchObject({ type: 'material' });
    await expect(requirements.create(matOnly, labourReq(a1, [{ civilDate: '2026-08-10', personShiftQty: 1 }]), pmc(matOnly))).rejects.toMatchObject({ status: 404 });

    // labour ON, materials OFF: labour OK, material 404
    const labOnly = await freshProject();
    await enableLabourWithCatalog(labOnly);
    const a2 = await freshActivity(labOnly);
    await expect(requirements.create(labOnly, labourReq(a2, [{ civilDate: '2026-08-10', personShiftQty: 2 }]), pmc(labOnly))).resolves.toMatchObject({ type: 'labour' });
    await expect(requirements.create(labOnly, { ...MATERIAL_REQ, activityId: a2 }, pmc(labOnly))).rejects.toMatchObject({ status: 404 });
  });

  // ── §B labour demand identity + slices + fingerprint + lifecycle ─────────────────────────────

  it('§B DETAIL: create derives qty/uom/requiredBy from slices; fingerprint over (trade,skill,shift); revise + cancel copy the detail', async () => {
    const projectId = await freshProject();
    await enableLabourWithCatalog(projectId);
    const act = await freshActivity(projectId);

    const r1 = await requirements.create(projectId, labourReq(act, [
      { civilDate: '2026-08-12', personShiftQty: 3 },
      { civilDate: '2026-08-10', personShiftQty: 4 },
    ]), pmc(projectId));
    expect(r1.type).toBe('labour');
    expect(r1.spec).toBeNull();
    expect(r1.qty).toBe('7'); // Σ personShiftQty = 3 + 4
    expect(r1.baseUom).toBe('person-shift');
    expect(r1.requiredBy).toBe('2026-08-12'); // max civilDate
    const expectedFp = await computeLabourSpecFingerprint({ tradeCode: 'mason', skillCode: 'bar-bending', shift: 'day' });
    expect(r1.labourSpec!.labourSpecFingerprint).toBe(expectedFp);
    // slices are served ascending, each carrying the spec's shift
    expect(r1.labourSpec!.demandSlices).toEqual([
      { civilDate: '2026-08-10', shift: 'day', personShiftQty: 4 },
      { civilDate: '2026-08-12', shift: 'day', personShiftQty: 3 },
    ]);

    // revise (append-only): a new revision restates the slices; the prior revision is untouched
    const rev1Before = await t.prisma.labourRequirementSpec.findFirstOrThrow({ where: { projectId, requirementId: r1.requirementId, revision: 1 } });
    const r2 = await requirements.revise(projectId, r1.requirementId, labourReq(act, [{ civilDate: '2026-08-10', personShiftQty: 10 }], { expectedRevision: 1 }), pmc(projectId));
    expect(r2.revision).toBe(2);
    expect(r2.qty).toBe('10');
    const rev1After = await t.prisma.labourRequirementSpec.findFirstOrThrow({ where: { projectId, requirementId: r1.requirementId, revision: 1 } });
    expect(JSON.stringify(rev1After)).toBe(JSON.stringify(rev1Before));

    // cancel copies the labour detail onto the cancellation revision (type↔detail holds)
    const r3 = await requirements.cancel(projectId, r1.requirementId, { expectedRevision: 2, reason: 'descoped' }, pmc(projectId));
    expect(r3.status).toBe('cancelled');
    expect(r3.labourSpec!.labourSpecFingerprint).toBe(expectedFp);
    expect(r3.labourSpec!.demandSlices).toHaveLength(1);
  });

  it('§B IMMUTABLE ROOT TYPE: a labour requirement cannot be revised into a material one', async () => {
    const projectId = await freshProject();
    await enableLabourWithCatalog(projectId);
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    const act = await freshActivity(projectId);
    const r = await requirements.create(projectId, labourReq(act, [{ civilDate: '2026-08-10', personShiftQty: 1 }]), pmc(projectId));

    // the service refuses an explicit type change early (400)...
    await expect(requirements.revise(projectId, r.requirementId, { ...MATERIAL_REQ, activityId: act, expectedRevision: 1 }, pmc(projectId))).rejects.toMatchObject({ status: 400 });
    // ...and the DB trigger is the backstop against a raw type-flipping revision
    await expect(
      t.prisma.activityRequirement.create({
        data: { projectId, requirementId: r.requirementId, revision: 2, activityId: act, type: 'material', requiredQty: 1, baseUom: 'bag', requiredBy: new Date('2026-08-15'), createdById: f.memberUser.id },
      }),
    ).rejects.toThrow(/cannot change it to/);
  });

  it('§B TYPE↔DETAIL: labour needs exactly one LabourRequirementSpec and no MaterialRequirementSpec; slices only on labour', async () => {
    const projectId = await freshProject();
    await enableLabourWithCatalog(projectId);
    const act = await freshActivity(projectId);

    // a labour revision with NO labour detail refuses at commit
    await expect(
      t.prisma.$transaction([
        t.prisma.activityRequirementRoot.create({ data: { id: 'it-p4-nolab', projectId, createdById: f.memberUser.id } }),
        t.prisma.activityRequirement.create({ data: { projectId, requirementId: 'it-p4-nolab', revision: 1, activityId: act, type: 'labour', requiredQty: 1, baseUom: 'person-shift', requiredBy: new Date('2026-08-10'), createdById: f.memberUser.id } }),
      ]),
    ).rejects.toThrow(/exactly one LabourRequirementSpec/);

    // a labour revision with a MATERIAL spec refuses at commit
    await expect(
      t.prisma.$transaction([
        t.prisma.activityRequirementRoot.create({ data: { id: 'it-p4-labmat', projectId, createdById: f.memberUser.id } }),
        t.prisma.activityRequirement.create({ data: { projectId, requirementId: 'it-p4-labmat', revision: 1, activityId: act, type: 'labour', requiredQty: 1, baseUom: 'person-shift', requiredBy: new Date('2026-08-10'), createdById: f.memberUser.id } }),
        t.prisma.materialRequirementSpec.create({ data: { projectId, requirementId: 'it-p4-labmat', revision: 1, materialCategory: 'x', make: 'x', grade: 'x', normalizedAttributes: '', specFingerprint: 'x' } }),
        t.prisma.labourRequirementSpec.create({ data: { projectId, requirementId: 'it-p4-labmat', revision: 1, tradeCode: 'mason', shift: 'day', labourSpecFingerprint: 'f' } }),
      ]),
    ).rejects.toThrow(/no MaterialRequirementSpec/);

    // a demand slice on a MATERIAL revision refuses (the slice-typed guard) — build a real
    // material requirement first, then try to attach a slice to it
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    const mat = await requirements.create(projectId, { ...MATERIAL_REQ, activityId: act }, pmc(projectId));
    await expect(
      t.prisma.labourDemandSlice.create({ data: { projectId, requirementId: mat.requirementId, revision: 1, civilDate: new Date('2026-08-10'), personShiftQty: 1 } }),
    ).rejects.toThrow(/may only attach to a labour requirement/);
  });

  it('§B IMMUTABILITY: the labour detail + its slices are database append-only', async () => {
    const projectId = await freshProject();
    await enableLabourWithCatalog(projectId);
    const act = await freshActivity(projectId);
    const r = await requirements.create(projectId, labourReq(act, [{ civilDate: '2026-08-10', personShiftQty: 2 }]), pmc(projectId));
    const spec = await t.prisma.labourRequirementSpec.findFirstOrThrow({ where: { projectId, requirementId: r.requirementId, revision: 1 } });
    const slice = await t.prisma.labourDemandSlice.findFirstOrThrow({ where: { projectId, requirementId: r.requirementId, revision: 1 } });

    await expect(t.prisma.labourRequirementSpec.update({ where: { id: spec.id }, data: { shift: 'night' } })).rejects.toThrow(/append-only/);
    await expect(t.prisma.labourRequirementSpec.delete({ where: { id: spec.id } })).rejects.toThrow(/append-only/);
    await expect(t.prisma.labourDemandSlice.update({ where: { id: slice.id }, data: { personShiftQty: 99 } })).rejects.toThrow(/append-only/);
    await expect(t.prisma.labourDemandSlice.delete({ where: { id: slice.id } })).rejects.toThrow(/append-only/);
  });

  it('§B FINGERPRINT POOLING: same (trade,skill,shift) via two decisions pools to one fingerprint; provenance retained', async () => {
    const projectId = await freshProject();
    await enableLabourWithCatalog(projectId);
    const act = await freshActivity(projectId);
    await makeApprovedDecision(projectId, 'IT-P4-D1');
    await makeApprovedDecision(projectId, 'IT-P4-D2');

    const viaD1 = await requirements.create(projectId, labourReq(act, [{ civilDate: '2026-08-10', personShiftQty: 1 }], { decisionId: 'IT-P4-D1' }), pmc(projectId));
    const viaD2 = await requirements.create(projectId, labourReq(act, [{ civilDate: '2026-08-11', personShiftQty: 1 }], { decisionId: 'IT-P4-D2' }), pmc(projectId));
    expect(viaD2.labourSpec!.labourSpecFingerprint).toBe(viaD1.labourSpec!.labourSpecFingerprint);
    expect(viaD1.labourSpec!.decisionId).toBe('IT-P4-D1');
    expect(viaD1.labourSpec!.decisionVersion).toBe(1);
    expect(viaD1.labourSpec!.optionKey).toBe('opt-a');
    expect(viaD2.labourSpec!.decisionId).toBe('IT-P4-D2');
    // a different shift is a DIFFERENT fingerprint
    const night = await computeLabourSpecFingerprint({ tradeCode: 'mason', skillCode: 'bar-bending', shift: 'night' });
    expect(night).not.toBe(viaD1.labourSpec!.labourSpecFingerprint);
  });

  // ── §H trusted workforce identity + containment + uniqueness ─────────────────────────────────

  it('§H ONBOARDING: worker/crew/membership via the pmc commands; catalog FK + skill validation; idempotency; reads', async () => {
    const projectId = await freshProject();
    await enableLabourWithCatalog(projectId);

    // worker onboarding validates the trade (FK) + skill codes (service, against the catalog)
    await expect(labour.onboardWorker(projectId, { name: 'W', tradeCode: 'welder', skillCodes: [], activeFrom: '2026-06-01' }, pmc(projectId))).rejects.toMatchObject({ status: 400 });
    await expect(labour.onboardWorker(projectId, { name: 'W', tradeCode: 'mason', skillCodes: ['no-such-skill'], activeFrom: '2026-06-01' }, pmc(projectId))).rejects.toMatchObject({ status: 400 });

    const w = await labour.onboardWorker(projectId, { name: 'Ravi', tradeCode: 'mason', skillCodes: ['bar-bending'], activeFrom: '2026-06-01', activeTo: '2026-12-31' }, pmc(projectId));
    const crew = await labour.formCrew(projectId, { name: 'Gang A', inchargeWorkerId: w.id, activeFrom: '2026-06-01' }, pmc(projectId));
    const m = await labour.addCrewMember(projectId, crew.id, { workerId: w.id }, pmc(projectId));
    expect(m.id).toBeTruthy();

    // one ACTIVE membership per (crew, worker): a second add refuses
    await expect(labour.addCrewMember(projectId, crew.id, { workerId: w.id }, pmc(projectId))).rejects.toMatchObject({ status: 400 });
    // remove then re-add is allowed (the partial unique is on active rows only)
    await labour.removeCrewMember(projectId, crew.id, w.id, {}, pmc(projectId));
    await expect(labour.addCrewMember(projectId, crew.id, { workerId: w.id }, pmc(projectId))).resolves.toBeTruthy();

    // onboarding is idempotent through the command ledger
    const key = `it-p4-key-${Date.now() % 1e6}`;
    const t1 = await labour.upsertTrade(projectId, { code: 'painter', name: 'Painter' }, pmc(projectId), key);
    await labour.upsertTrade(projectId, { code: 'painter', name: 'Painter' }, pmc(projectId), key);
    expect(t1.code).toBe('painter');

    // the workforce register read (pmc/engineer)
    const wf = await labour.workforce(projectId, engineer(projectId));
    expect(wf.workers.map((x) => x.name)).toContain('Ravi');
    expect(wf.workers[0]!.tradeCode).toBe('mason');
    expect(wf.crews.map((x) => x.name)).toContain('Gang A');
    const cat = await labour.catalog(projectId, pmc(projectId));
    expect(cat.trades.map((x) => x.code).sort()).toEqual(['mason', 'painter']);
    // the register is a pmc/engineer surface — a client is refused
    await expect(labour.workforce(projectId, client(projectId))).rejects.toMatchObject({ status: 403 });
  });

  it('§H CONTAINMENT: cross-project worker/crew/device references are unrepresentable in PostgreSQL', async () => {
    const p1 = await freshProject();
    const p2 = await freshProject();
    await enableLabourWithCatalog(p1);
    await enableLabourWithCatalog(p2);
    const w1 = await labour.onboardWorker(p1, { name: 'A', tradeCode: 'mason', skillCodes: [], activeFrom: '2026-06-01' }, pmc(p1));
    const crew2 = await labour.formCrew(p2, { name: 'C2', activeFrom: '2026-06-01' }, pmc(p2));

    // a crew in p2 cannot enroll a worker that lives in p1 (composite (projectId, workerId) FK)
    await expect(
      t.prisma.crewMembership.create({ data: { projectId: p2, crewId: crew2.id, workerId: w1.id, addedById: f.memberUser.id } }),
    ).rejects.toThrow();

    // a WorkerDevice in p2 cannot bind a worker that lives in p1 (composite FK)
    await expect(
      t.prisma.workerDevice.create({ data: { projectId: p2, workerId: w1.id, token: `tok-${seq++}` } }),
    ).rejects.toThrow();

    // ...but a same-project binding is accepted (the FK holds within the tenant)
    const w2 = await labour.onboardWorker(p2, { name: 'B', tradeCode: 'mason', skillCodes: [], activeFrom: '2026-06-01' }, pmc(p2));
    await expect(
      t.prisma.workerDevice.create({ data: { projectId: p2, workerId: w2.id, token: `tok-${seq++}` } }),
    ).resolves.toBeTruthy();
  });

  it('§H WORKER LIFECYCLE: revocation stamps the worker once; a duplicate demand slice is refused', async () => {
    const projectId = await freshProject();
    await enableLabourWithCatalog(projectId);
    const w = await labour.onboardWorker(projectId, { name: 'R', tradeCode: 'mason', skillCodes: [], activeFrom: '2026-06-01' }, pmc(projectId));
    await labour.revokeWorker(projectId, w.id, {}, pmc(projectId));
    const row = await t.prisma.worker.findUniqueOrThrow({ where: { id: w.id } });
    expect(row.revokedAt).not.toBeNull();
    expect(row.revokedById).toBe(f.memberUser.id);
    // Task-1 correction F5 — revocation is a CAS `active → revoked` transition, so a second revoke is
    // a truthful CONFLICT (409, the deterministic loser), not a plain 400.
    await expect(labour.revokeWorker(projectId, w.id, {}, pmc(projectId))).rejects.toMatchObject({ status: 409 });

    // one demand slice per (requirement revision, civilDate): the service dedupes, and the DB
    // partial unique is the backstop
    const act = await freshActivity(projectId);
    await expect(
      requirements.create(projectId, labourReq(act, [{ civilDate: '2026-08-10', personShiftQty: 1 }, { civilDate: '2026-08-10', personShiftQty: 2 }]), pmc(projectId)),
    ).rejects.toMatchObject({ status: 400 });
  });
});
