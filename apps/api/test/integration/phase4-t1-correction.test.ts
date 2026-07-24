import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { RequirementsService } from '../../src/activities/requirements.service';
import { LabourService } from '../../src/labour/labour.service';
import { CapabilitiesService, MATERIALS_CAPABILITY, LABOUR_CAPABILITY } from '../../src/platform/capabilities.service';
import { computeLabourSpecFingerprint } from '@vitan/shared';
import type { AuthUser } from '../../src/common/auth';

/**
 * Phase 4 Task 1 CORRECTION — the review findings, proven live against PostgreSQL.
 *
 * F2 — the labour DEMAND SEAL (deferred commit): a labour revision is rejected unless it carries ≥1
 *   slice, `baseUom='person-shift'`, `requiredQty=SUM(personShiftQty)`, `requiredBy=MAX(civilDate)`,
 *   and a canonical `labourSpecFingerprint` — enforced in the DB, not just the service.
 * F3 — SKILL REFERENCES in PostgreSQL: a spec skillCode composite FK + a Worker.skillCodes[] trigger
 *   reject a nonexistent OR cross-project skill (hostile raw inserts).
 * F4 — the requirement register READS when materials OR labour is enabled; 404 only when neither.
 * F5 — WORKFORCE LIFECYCLE: attributable idempotent crew revocation; CAS worker/crew/membership
 *   transitions with one winner + a deterministic 409 loser under concurrency.
 *
 * (F1 read-encapsulation — the nested-include boundary detection + the Labour query contract — is
 *  proven by `src/platform/module-registry/boundary.test.ts`, RED before the analyzer extension.)
 */
describe('Phase 4 Task 1 correction — DB seals + list availability + workforce lifecycle (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let requirements: RequirementsService;
  let labour: LabourService;
  let capabilities: CapabilitiesService;
  let seq = 0;

  const TRUNCATE =
    'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "MaterialReadinessProjection", "StockTransaction", "MaterialIssue", "StockLot", "CommandExecution", "DeliveryPromise", "DeliveryCommitment", "PurchaseOrderLine", "PurchaseOrderVersion", "PurchaseOrder", "VendorQuoteLine", "QuoteComparison", "VendorQuote", "Rfq", "RequisitionLine", "Requisition", "ApprovedSubstitution", "CrewMembership", "Crew", "WorkerDevice", "Worker", "LabourDemandSlice", "LabourRequirementSpec", "LabourTrade", "LabourSkill", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability"';

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    requirements = t.app.get(RequirementsService);
    labour = t.app.get(LabourService);
    capabilities = t.app.get(CapabilitiesService);
  });
  afterAll(async () => {
    await t?.prisma.$executeRawUnsafe(TRUNCATE);
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe(TRUNCATE);
    for (const [model, where] of [
      ['auditLog', { projectId: { startsWith: 'it-p4c-' } }],
      ['activity', { projectId: { startsWith: 'it-p4c-' } }],
      ['membership', { projectId: { startsWith: 'it-p4c-' } }],
      ['project', { id: { startsWith: 'it-p4c-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  const freshProject = async (): Promise<string> => {
    const id = `it-p4c-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    return id;
  };
  const freshActivity = async (projectId: string): Promise<string> => {
    const id = `IT-P4C-ACT-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.activity.create({ data: { id, projectId, name: `Act ${seq}`, zone: 'Zone 1', plannedStart: 0, plannedEnd: 10 } });
    return id;
  };
  const enableLabour = async (projectId: string): Promise<void> => {
    await capabilities.enable(projectId, LABOUR_CAPABILITY, f.memberUser.id);
    await labour.upsertTrade(projectId, { code: 'mason', name: 'Mason' }, pmc(projectId));
    await labour.upsertSkill(projectId, { code: 'bar-bending', name: 'Bar Bending' }, pmc(projectId));
  };
  // a valid labour requirement (2 + 5 = 7 person-shifts; requiredBy = max civil date)
  const labourReq = (activityId: string) =>
    ({
      type: 'labour', activityId, tradeCode: 'mason', skillCode: 'bar-bending', shift: 'day',
      demandSlices: [{ civilDate: '2026-08-10', personShiftQty: 2 }, { civilDate: '2026-08-12', personShiftQty: 5 }],
      decisionId: null, responsibleId: null, criticality: 'normal', tolerance: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

  /** Insert a hostile labour revision (root reused) directly, overriding one demand field, and assert
   *  the DEFERRED demand-seal trigger ABORTS the commit (F2). Returns the rejection. */
  const forgeLabourRevision = async (
    projectId: string,
    requirementId: string,
    activityId: string,
    revision: number,
    over: { baseUom?: string; requiredQty?: number; requiredBy?: string; fingerprint?: string; slices?: Array<{ d: string; q: number }> },
  ): Promise<void> => {
    const baseUom = over.baseUom ?? 'person-shift';
    const slices = over.slices ?? [{ d: '2026-08-12', q: 7 }];
    const requiredQty = over.requiredQty ?? (slices.length ? slices.reduce((s, x) => s + x.q, 0) : 0);
    const requiredBy = over.requiredBy ?? (slices.length ? slices.reduce((m, x) => (x.d > m ? x.d : m), slices[0].d) : '2026-08-12');
    const fingerprint = over.fingerprint ?? (await computeLabourSpecFingerprint({ tradeCode: 'mason', skillCode: 'bar-bending', shift: 'day' }));
    await t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO "ActivityRequirement" ("id","projectId","requirementId","revision","activityId","type","requiredQty","baseUom","requiredBy","criticality","status","createdById") VALUES ($1,$2,$3,$4,$5,'labour',$6,$7,$8::date,'normal','open',$9)`,
        `${requirementId}-r${revision}`, projectId, requirementId, revision, activityId, requiredQty, baseUom, requiredBy, f.memberUser.id,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "LabourRequirementSpec" ("id","projectId","requirementId","revision","tradeCode","skillCode","shift","labourSpecFingerprint") VALUES ($1,$2,$3,$4,'mason','bar-bending','day',$5)`,
        `lrs-${requirementId}-r${revision}`, projectId, requirementId, revision, fingerprint,
      );
      for (const [i, s] of slices.entries()) {
        await tx.$executeRawUnsafe(
          `INSERT INTO "LabourDemandSlice" ("id","projectId","requirementId","revision","civilDate","personShiftQty") VALUES ($1,$2,$3,$4,$5::date,$6)`,
          `lds-${requirementId}-r${revision}-${i}`, projectId, requirementId, revision, s.d, s.q,
        );
      }
    });
  };

  // ── F2 — the demand seal (deferred commit) ──────────────────────────────────────────────────
  it('F2 SEAL: a labour revision with no slice / wrong baseUom / wrong sum / wrong needed-by / forged fingerprint is REJECTED at commit', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    const req = await requirements.create(projectId, labourReq(act), pmc(projectId));
    const rid = req.requirementId;

    // no slice (requiredQty > 0 so the pre-existing qty CHECK passes and the demand SEAL is what fires)
    await expect(forgeLabourRevision(projectId, rid, act, 2, { slices: [], requiredQty: 5 })).rejects.toThrow(/at least one demand slice/);
    // wrong baseUom
    await expect(forgeLabourRevision(projectId, rid, act, 3, { baseUom: 'bag' })).rejects.toThrow(/baseUom must be person-shift/);
    // requiredQty != SUM
    await expect(forgeLabourRevision(projectId, rid, act, 4, { requiredQty: 99 })).rejects.toThrow(/requiredQty .* must equal SUM/);
    // requiredBy != MAX(civilDate)
    await expect(forgeLabourRevision(projectId, rid, act, 5, { requiredBy: '2026-09-30' })).rejects.toThrow(/requiredBy .* must equal MAX/);
    // forged fingerprint
    await expect(forgeLabourRevision(projectId, rid, act, 6, { fingerprint: 'deadbeef' })).rejects.toThrow(/labourSpecFingerprint does not match/);

    // sanity: a COHERENT hostile revision (all invariants satisfied) commits — the seal is precise
    await forgeLabourRevision(projectId, rid, act, 7, {});
    const ok = await t.prisma.labourRequirementSpec.findFirst({ where: { projectId, requirementId: rid, revision: 7 } });
    expect(ok).not.toBeNull();
  });

  // ── F3 — skill references enforced in PostgreSQL ─────────────────────────────────────────────
  it('F3 SKILL FK: a LabourRequirementSpec skillCode that is nonexistent OR cross-project is rejected by PostgreSQL', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    const req = await requirements.create(projectId, labourReq(act), pmc(projectId));
    const rid = req.requirementId;
    // a spec revision whose skillCode is absent from the catalog → composite FK rejects
    await expect(
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "LabourRequirementSpec" ("id","projectId","requirementId","revision","tradeCode","skillCode","shift","labourSpecFingerprint") VALUES ($1,$2,$3,$4,'mason','ghost-skill','day','x')`,
        `lrs-ghost-${rid}`, projectId, rid, 2,
      ),
    ).rejects.toThrow(/foreign key|violates/i);

    // a cross-project skill: the OTHER project defines 'welding'; referencing it from THIS project's
    // spec must fail (the composite (projectId, skillCode) FK requires the SAME project's catalog)
    const other = await freshProject();
    await enableLabour(other);
    await labour.upsertSkill(other, { code: 'welding', name: 'Welding' }, pmc(other));
    await expect(
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "LabourRequirementSpec" ("id","projectId","requirementId","revision","tradeCode","skillCode","shift","labourSpecFingerprint") VALUES ($1,$2,$3,$4,'mason','welding','day','x')`,
        `lrs-cross-${rid}`, projectId, rid, 3,
      ),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it('F3 WORKER SKILLS: a Worker.skillCodes element that is nonexistent OR cross-project is rejected by the DB trigger', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    // nonexistent skill in the array
    await expect(
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "Worker" ("id","projectId","name","tradeCode","skillCodes","activeFrom","createdById") VALUES ($1,$2,'R','mason', ARRAY['ghost-skill'], '2026-06-01'::date, $3)`,
        `wk-ghost-${seq++}`, projectId, f.memberUser.id,
      ),
    ).rejects.toThrow(/not a skill in this project/i);
    // cross-project skill (defined only in `other`)
    const other = await freshProject();
    await enableLabour(other);
    await labour.upsertSkill(other, { code: 'welding', name: 'Welding' }, pmc(other));
    await expect(
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "Worker" ("id","projectId","name","tradeCode","skillCodes","activeFrom","createdById") VALUES ($1,$2,'R','mason', ARRAY['welding'], '2026-06-01'::date, $3)`,
        `wk-cross-${seq++}`, projectId, f.memberUser.id,
      ),
    ).rejects.toThrow(/not a skill in this project/i);
    // a VALID same-project skill array is accepted
    const w = await labour.onboardWorker(projectId, { name: 'R', tradeCode: 'mason', skillCodes: ['bar-bending'], activeFrom: '2026-06-01' }, pmc(projectId));
    expect(w.id).toBeTruthy();
  });

  // ── F4 — the register reads when materials OR labour is enabled ──────────────────────────────
  it('F4 LIST: a labour-only pilot can create then LIST its requirements; a project with NEITHER capability 404s', async () => {
    // labour-only project: materials OFF, labour ON
    const projectId = await freshProject();
    await enableLabour(projectId);
    expect(await capabilities.isEnabled(projectId, MATERIALS_CAPABILITY)).toBe(false);
    const act = await freshActivity(projectId);
    const created = await requirements.create(projectId, labourReq(act), pmc(projectId));
    const listed = await requirements.list(projectId, pmc(projectId));
    expect(listed.requirements.map((r) => r.requirementId)).toContain(created.requirementId);
    expect(listed.requirements.find((r) => r.requirementId === created.requirementId)?.type).toBe('labour');

    // neither capability → 404
    const bare = await freshProject();
    await expect(requirements.list(bare, pmc(bare))).rejects.toMatchObject({ status: 404 });
  });

  // ── F5 — workforce lifecycle: attributable idempotent crew revocation + CAS ──────────────────
  it('F5 CREW REVOKE: attributable + idempotent; a keyed replay revokes exactly once', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const crew = await labour.formCrew(projectId, { name: 'Gang A', activeFrom: '2026-06-01' }, pmc(projectId));
    await labour.revokeCrew(projectId, crew.id, {}, pmc(projectId), 'key-1');
    // a keyed REPLAY is the same command — no second stamp, no error
    await labour.revokeCrew(projectId, crew.id, {}, pmc(projectId), 'key-1');
    const row = await t.prisma.crew.findUniqueOrThrow({ where: { id: crew.id } });
    expect(row.revokedAt).not.toBeNull();
    expect(row.revokedById).toBe(f.memberUser.id);
    // a FRESH-key revoke of an already-revoked crew is a truthful 409 (deterministic loser)
    await expect(labour.revokeCrew(projectId, crew.id, {}, pmc(projectId), 'key-2')).rejects.toMatchObject({ status: 409 });
  });

  it('F5 CAS: concurrent worker revokes / crew revokes / membership removals each have ONE winner + a 409 loser', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);

    // worker revoke race (different keys, same worker) → exactly one succeeds
    const w = await labour.onboardWorker(projectId, { name: 'R', tradeCode: 'mason', skillCodes: [], activeFrom: '2026-06-01' }, pmc(projectId));
    const wr = await Promise.allSettled([
      labour.revokeWorker(projectId, w.id, {}, pmc(projectId), 'wr-a'),
      labour.revokeWorker(projectId, w.id, {}, pmc(projectId), 'wr-b'),
    ]);
    expect(wr.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(wr.filter((r) => r.status === 'rejected')).toHaveLength(1);

    // crew revoke race → exactly one succeeds
    const c = await labour.formCrew(projectId, { name: 'Gang', activeFrom: '2026-06-01' }, pmc(projectId));
    const cr = await Promise.allSettled([
      labour.revokeCrew(projectId, c.id, {}, pmc(projectId), 'cr-a'),
      labour.revokeCrew(projectId, c.id, {}, pmc(projectId), 'cr-b'),
    ]);
    expect(cr.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(cr.filter((r) => r.status === 'rejected')).toHaveLength(1);

    // membership removal race → exactly one succeeds (the one active membership)
    const c2 = await labour.formCrew(projectId, { name: 'Gang2', activeFrom: '2026-06-01' }, pmc(projectId));
    const w2 = await labour.onboardWorker(projectId, { name: 'S', tradeCode: 'mason', skillCodes: [], activeFrom: '2026-06-01' }, pmc(projectId));
    await labour.addCrewMember(projectId, c2.id, { workerId: w2.id }, pmc(projectId));
    const mr = await Promise.allSettled([
      labour.removeCrewMember(projectId, c2.id, w2.id, {}, pmc(projectId), 'mr-a'),
      labour.removeCrewMember(projectId, c2.id, w2.id, {}, pmc(projectId), 'mr-b'),
    ]);
    expect(mr.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(mr.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });
});
