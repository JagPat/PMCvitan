import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { RequirementsService } from '../../src/activities/requirements.service';
import { CapabilitiesService, MATERIALS_CAPABILITY } from '../../src/platform/capabilities.service';
import { SnapshotService } from '../../src/snapshot/snapshot.service';
import { OutboxRelay } from '../../src/platform/outbox/relay.service';
import { DECISIONS_PROJECTION } from '../../src/decisions/decisions.projection';
import { createRequirementSchema } from '../../src/contracts';
import type { AuthUser } from '../../src/common/auth';
import type { CreateRequirementInput } from '../../src/contracts';

/**
 * Phase 3 Task 1 + its CORRECTION — live-PG proofs.
 *
 * The original Task-1 acceptance (capability inertness §D, append-only revisions §F,
 * fingerprint pooling §B, decimal/UOM round-trips, §G events, isolation + idempotency) PLUS the
 * review-mandated reproduce-first probes (each RED at `24ee03f`):
 *   pending/change decision refused · fabricated version/option rejected · server-derived
 *   approved provenance · database-enforced UPDATE/DELETE refusal · cross-project lineage
 *   refusal · DATE requiredBy round-trip · foreign/inactive responsible refusal · type-neutral
 *   non-material structure · complete event payload · read-policy enforcement.
 */

describe('Phase 3 Task 1 (corrected) — capability + requirements (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let requirements: RequirementsService;
  let capabilities: CapabilitiesService;
  let snapshot: SnapshotService;
  let relay: OutboxRelay;
  let seq = 0;

  const TRUNCATE =
    'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "CommandExecution", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "ProjectCapability"';

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;
  const client = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'client', projectId }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    requirements = t.app.get(RequirementsService);
    capabilities = t.app.get(CapabilitiesService);
    snapshot = t.app.get(SnapshotService);
    relay = t.app.get(OutboxRelay);
  });
  afterAll(async () => {
    await t?.prisma.$executeRawUnsafe(TRUNCATE);
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe(TRUNCATE);
    for (const [model, where] of [
      ['decisionEvent', { decision: { projectId: { startsWith: 'it-p3-' } } }],
      ['decisionOption', { decision: { projectId: { startsWith: 'it-p3-' } } }],
      ['decision', { projectId: { startsWith: 'it-p3-' } }],
      ['activity', { projectId: { startsWith: 'it-p3-' } }],
      ['auditLog', { projectId: { startsWith: 'it-p3-' } }],
      ['membership', { projectId: { startsWith: 'it-p3-' } }],
      ['project', { id: { startsWith: 'it-p3-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  const freshProject = async (): Promise<string> => {
    const id = `it-p3-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    return id;
  };

  const freshActivity = async (projectId: string): Promise<string> => {
    const id = `IT-P3-ACT-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.activity.create({ data: { id, projectId, name: `Act ${seq}`, zone: 'Zone 1', plannedStart: 0, plannedEnd: 10 } });
    return id;
  };

  /** An APPROVED decision with real options, a recorded selection and a real approval-event
   *  history — what `decisions.approvedRef` resolves provenance from. */
  const makeApprovedDecision = async (projectId: string, id: string, approvals: Array<'approved' | 'reapproved'> = ['approved']): Promise<void> => {
    await t.prisma.decision.create({
      data: {
        id, projectId, title: id, room: 'Living', photoSwatch: 'sw', status: 'approved',
        publishedAt: new Date(), authorId: f.memberUser.id, approvedOption: 'Option A',
        options: { create: [
          { label: 'Option A', optionKey: 'opt-a', material: 'Teak', delta: 0, swatch: 'sw-a', order: 1 },
          { label: 'Option B', optionKey: 'opt-b', material: 'Walnut', delta: 100, swatch: 'sw-b', order: 2 },
        ] },
        events: { create: approvals.map((type) => ({ type, actor: 'member' })) },
      },
    });
  };

  const CEMENT: Omit<CreateRequirementInput, 'activityId'> = {
    materialCategory: 'Cement', make: 'UltraTech', grade: 'OPC 53', attributes: 'grey, 50kg bags',
    baseUom: 'bag', qty: '120.5', requiredBy: '2026-08-15', criticality: 'normal',
    decisionId: null, responsibleId: null, tolerance: null,
  };

  it('§D INERTNESS: two projects, one org, capability on ONE — the other is byte-for-byte unchanged', async () => {
    const pilot = await freshProject();
    const other = await freshProject();
    const otherActivity = await freshActivity(other);
    const before = await snapshot.build(other, 'pmc', f.memberUser.id);

    await capabilities.enable(pilot, MATERIALS_CAPABILITY, f.memberUser.id);
    const pilotActivity = await freshActivity(pilot);
    const created = await requirements.create(pilot, { ...CEMENT, activityId: pilotActivity }, pmc(pilot));
    expect(created.revision).toBe(1);

    await expect(requirements.list(other, pmc(other))).rejects.toMatchObject({ status: 404 });
    await expect(requirements.create(other, { ...CEMENT, activityId: otherActivity }, pmc(other))).rejects.toMatchObject({ status: 404 });
    const after = await snapshot.build(other, 'pmc', f.memberUser.id);
    expect(after).toEqual(before);
    expect(await t.prisma.domainEvent.count({ where: { projectId: other } })).toBe(0);
    expect(await t.prisma.outboxDelivery.count({ where: { projectId: other } })).toBe(0);
    const evs = await t.prisma.domainEvent.findMany({ where: { projectId: pilot }, select: { eventType: true } });
    expect(evs.map((e) => e.eventType)).toEqual(['requirement.created']);
  });

  it('§F REVISIONS: append-only history, byte-identical priors, CAS conflicts, cancelled refuses', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    const activityId = await freshActivity(projectId);

    const r1 = await requirements.create(projectId, { ...CEMENT, activityId }, pmc(projectId));
    const rev1Before = await t.prisma.activityRequirement.findUniqueOrThrow({ where: { id: r1.id }, include: { materialSpec: true } });

    const r2 = await requirements.revise(projectId, r1.requirementId, { ...CEMENT, activityId, qty: '200', expectedRevision: 1 }, pmc(projectId));
    expect(r2.revision).toBe(2);
    expect(r2.qty).toBe('200');
    const rev1After = await t.prisma.activityRequirement.findUniqueOrThrow({ where: { id: r1.id }, include: { materialSpec: true } });
    expect(JSON.stringify(rev1After)).toBe(JSON.stringify(rev1Before));

    await expect(
      requirements.revise(projectId, r1.requirementId, { ...CEMENT, activityId, qty: '300', expectedRevision: 1 }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });

    const r3 = await requirements.cancel(projectId, r1.requirementId, { expectedRevision: 2, reason: 'scope removed' }, pmc(projectId));
    expect(r3.revision).toBe(3);
    expect(r3.status).toBe('cancelled');
    expect(r3.spec?.specFingerprint).toBe(r2.spec?.specFingerprint); // spec copied verbatim
    await expect(
      requirements.revise(projectId, r1.requirementId, { ...CEMENT, activityId, expectedRevision: 3 }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      requirements.cancel(projectId, r1.requirementId, { expectedRevision: 3, reason: 'again' }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 400 });

    const list = await requirements.list(projectId, pmc(projectId));
    expect(list.requirements).toHaveLength(1);
    expect(list.requirements[0]).toMatchObject({ revision: 3, status: 'cancelled', revisions: 3 });
  });

  it('§B IDENTITY: identical technical material via two decisions POOLS to one fingerprint; provenance retained; DB CHECKs hold', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    const activityId = await freshActivity(projectId);
    await makeApprovedDecision(projectId, 'IT-P3-D1');
    await makeApprovedDecision(projectId, 'IT-P3-D2');

    const viaD1 = await requirements.create(projectId, { ...CEMENT, activityId, decisionId: 'IT-P3-D1' }, pmc(projectId));
    const viaD2 = await requirements.create(projectId, { ...CEMENT, activityId, make: ' ULTRATECH ', decisionId: 'IT-P3-D2' }, pmc(projectId));
    expect(viaD2.spec!.specFingerprint).toBe(viaD1.spec!.specFingerprint);
    expect(viaD1.spec!.decisionId).toBe('IT-P3-D1');
    expect(viaD2.spec!.decisionId).toBe('IT-P3-D2');
    const otherGrade = await requirements.create(projectId, { ...CEMENT, activityId, grade: 'OPC 43' }, pmc(projectId));
    expect(otherGrade.spec!.specFingerprint).not.toBe(viaD1.spec!.specFingerprint);

    // database backstops: a root is required, and revision >= 1 / qty > 0 are CHECK-refused raw
    await t.prisma.activityRequirementRoot.create({ data: { id: 'raw-root', projectId, createdById: f.memberUser.id } });
    const rawBase = { projectId, requirementId: 'raw-root', activityId, requiredQty: 1, baseUom: 'bag', requiredBy: new Date(), createdById: f.memberUser.id };
    await expect(t.prisma.activityRequirement.create({ data: { ...rawBase, revision: 0 } })).rejects.toThrow();
    await expect(t.prisma.activityRequirement.create({ data: { ...rawBase, revision: 1, requiredQty: 0 } })).rejects.toThrow();
  });

  it('DECIMAL/UOM: canonical round-trip, refusals for precision/zero/uom', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    const activityId = await freshActivity(projectId);

    const exact = await requirements.create(projectId, { ...CEMENT, activityId, qty: '12.345678' }, pmc(projectId));
    expect(exact.qty).toBe('12.345678');
    const padded = await requirements.create(projectId, { ...CEMENT, activityId, qty: '007.10' }, pmc(projectId));
    expect(padded.qty).toBe('7.1');
    for (const qty of ['1.2345678', '0', '-2', '1e3']) {
      await expect(requirements.create(projectId, { ...CEMENT, activityId, qty }, pmc(projectId)), qty).rejects.toMatchObject({ status: 400 });
    }
    await expect(requirements.create(projectId, { ...CEMENT, activityId, baseUom: 'bags' }, pmc(projectId))).rejects.toMatchObject({ status: 400 });
  });

  it('§G EVENTS: created/revised/cancelled ride the command tx with the COMPLETE payload; ordered consumers no-op past them', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    const activityId = await freshActivity(projectId);

    const r1 = await requirements.create(projectId, { ...CEMENT, activityId }, pmc(projectId));
    await requirements.revise(projectId, r1.requirementId, { ...CEMENT, activityId, qty: '9', expectedRevision: 1 }, pmc(projectId));
    await requirements.cancel(projectId, r1.requirementId, { expectedRevision: 2, reason: 'done' }, pmc(projectId));

    const evs = await t.prisma.domainEvent.findMany({ where: { projectId }, orderBy: { streamPosition: 'asc' } });
    expect(evs.map((e) => e.eventType)).toEqual(['requirement.created', 'requirement.revised', 'requirement.cancelled']);
    // the COMPLETE documented payload (correction finding 4): identity, revision, activity,
    // FULL spec reference, quantity, unit and the civil needed-by date
    const p = evs[1]!.payload as Record<string, unknown>;
    for (const key of ['requirementId', 'revision', 'activityId', 'specRef', 'qty', 'baseUom', 'requiredBy', 'status']) {
      expect(p, key).toHaveProperty(key);
    }
    expect(p.revision).toBe(2);
    expect(p.qty).toBe('9');
    expect(p.requiredBy).toBe('2026-08-15');
    const specRef = p.specRef as Record<string, unknown>;
    for (const key of ['materialCategory', 'make', 'grade', 'normalizedAttributes', 'baseUom', 'specFingerprint', 'decisionId', 'decisionVersion', 'optionKey']) {
      expect(specRef, key).toHaveProperty(key);
    }
    expect((evs[2]!.payload as { reason: string }).reason).toBe('done');

    const ds = await t.prisma.outboxDelivery.findMany({ where: { consumer: DECISIONS_PROJECTION, projectId }, orderBy: { streamPosition: 'asc' } });
    expect(ds.length).toBe(3);
    for (const d of ds) expect(await relay.dispatchOne(d.id)).toBe('succeeded');
    const gen = await t.prisma.projectionGeneration.findFirst({ where: { consumer: DECISIONS_PROJECTION, projectId, status: 'active' } });
    expect(gen?.appliedPosition).toBe(evs[2]!.streamPosition);
  });

  it('ISOLATION + IDEMPOTENCY: foreign refs refuse; a keyed replay returns the same row and appends nothing', async () => {
    const p1 = await freshProject();
    const p2 = await freshProject();
    await capabilities.enable(p1, MATERIALS_CAPABILITY, f.memberUser.id);
    const a1 = await freshActivity(p1);
    const a2 = await freshActivity(p2);
    await makeApprovedDecision(p2, 'IT-P3-D9');

    await expect(requirements.create(p1, { ...CEMENT, activityId: a2 }, pmc(p1))).rejects.toMatchObject({ status: 400 });
    await expect(requirements.create(p1, { ...CEMENT, activityId: a1, decisionId: 'IT-P3-D9' }, pmc(p1))).rejects.toMatchObject({ status: 400 });

    const key = `it-p3-key-${Date.now() % 1e6}`;
    const first = await requirements.create(p1, { ...CEMENT, activityId: a1 }, pmc(p1), key);
    const replay = await requirements.create(p1, { ...CEMENT, activityId: a1 }, pmc(p1), key);
    expect(replay.id).toBe(first.id);
    expect(await t.prisma.activityRequirement.count({ where: { projectId: p1 } })).toBe(1);
    expect(await t.prisma.domainEvent.count({ where: { projectId: p1, eventType: 'requirement.created' } })).toBe(1);
  });

  // ── The correction's reproduce-first probes (each RED at 24ee03f) ─────────────────────────

  it('CORRECTION 1a: a pending or reopened decision cannot anchor provenance', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    const activityId = await freshActivity(projectId);
    await t.prisma.decision.create({
      data: { id: 'IT-P3-PEND', projectId, title: 'x', room: 'x', photoSwatch: 'sw', status: 'pending', publishedAt: new Date(), authorId: f.memberUser.id },
    });
    await t.prisma.decision.create({
      data: { id: 'IT-P3-CHG', projectId, title: 'x', room: 'x', photoSwatch: 'sw', status: 'change', publishedAt: new Date(), authorId: f.memberUser.id, approvedOption: 'Option A' },
    });
    for (const decisionId of ['IT-P3-PEND', 'IT-P3-CHG']) {
      await expect(
        requirements.create(projectId, { ...CEMENT, activityId, decisionId }, pmc(projectId)), decisionId,
      ).rejects.toMatchObject({ status: 400 });
    }
  });

  it('CORRECTION 1b: caller-authored decisionVersion/optionKey are REJECTED at the contract boundary', () => {
    const body = { ...CEMENT, activityId: 'ACT-X', decisionId: 'DL-011', decisionVersion: 999, optionKey: 'DOES-NOT-EXIST' };
    const parsed = createRequirementSchema.safeParse(body);
    expect(parsed.success).toBe(false); // strict schema: fabricated provenance keys never reach the service
  });

  it('CORRECTION 1c: provenance is SERVER-derived — real approval count + the decision\'s own selected option', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    const activityId = await freshActivity(projectId);
    await makeApprovedDecision(projectId, 'IT-P3-REAPP', ['approved', 'reapproved']);

    const r = await requirements.create(projectId, { ...CEMENT, activityId, decisionId: 'IT-P3-REAPP' }, pmc(projectId));
    expect(r.spec!.decisionId).toBe('IT-P3-REAPP');
    expect(r.spec!.decisionVersion).toBe(2); // approved + reapproved — the REAL counter
    expect(r.spec!.optionKey).toBe('opt-a'); // the selected option's key, resolved server-side
  });

  it('CORRECTION 2a: direct UPDATE and DELETE of a revision (and its spec) are DATABASE-rejected', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    const activityId = await freshActivity(projectId);
    const r = await requirements.create(projectId, { ...CEMENT, activityId }, pmc(projectId));

    await expect(t.prisma.activityRequirement.update({ where: { id: r.id }, data: { criticality: 'critical' } })).rejects.toThrow(/append-only/);
    await expect(t.prisma.activityRequirement.delete({ where: { id: r.id } })).rejects.toThrow(/append-only/);
    const spec = await t.prisma.materialRequirementSpec.findFirstOrThrow({ where: { projectId, requirementId: r.requirementId, revision: 1 } });
    await expect(t.prisma.materialRequirementSpec.update({ where: { id: spec.id }, data: { grade: 'tampered' } })).rejects.toThrow(/append-only/);
    await expect(t.prisma.materialRequirementSpec.delete({ where: { id: spec.id } })).rejects.toThrow(/append-only/);
  });

  it('CORRECTION 2b: revision lineage CANNOT cross projects (root FK)', async () => {
    const p1 = await freshProject();
    const p2 = await freshProject();
    await capabilities.enable(p1, MATERIALS_CAPABILITY, f.memberUser.id);
    const a1 = await freshActivity(p1);
    const a2 = await freshActivity(p2);
    const r = await requirements.create(p1, { ...CEMENT, activityId: a1 }, pmc(p1));

    // revision 2 of the SAME requirementId in ANOTHER project: the (projectId, rootId) FK refuses
    await expect(
      t.prisma.activityRequirement.create({
        data: { projectId: p2, requirementId: r.requirementId, revision: 2, activityId: a2, requiredQty: 1, baseUom: 'bag', requiredBy: new Date(), createdById: f.memberUser.id },
      }),
    ).rejects.toThrow();
  });

  it('CORRECTION 3a: requiredBy is a civil DATE column and round-trips', async () => {
    const cols = await t.prisma.$queryRawUnsafe<Array<{ data_type: string }>>(
      `SELECT data_type FROM information_schema.columns WHERE table_name = 'ActivityRequirement' AND column_name = 'requiredBy'`,
    );
    expect(cols[0]!.data_type).toBe('date');

    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    const activityId = await freshActivity(projectId);
    const r = await requirements.create(projectId, { ...CEMENT, activityId, requiredBy: '2026-09-01' }, pmc(projectId));
    expect(r.requiredBy).toBe('2026-09-01');
  });

  it('CORRECTION 3b: a foreign or inactive responsible member is refused; an active member is accepted', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    const activityId = await freshActivity(projectId);
    await t.prisma.membership.create({ data: { projectId, userId: f.strangerUser.id, role: 'engineer', status: 'removed' } });

    // never a member of this project
    await expect(
      requirements.create(projectId, { ...CEMENT, activityId, responsibleId: f.otherUser.id }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 400 });
    // a member whose membership is no longer active
    await expect(
      requirements.create(projectId, { ...CEMENT, activityId, responsibleId: f.strangerUser.id }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 400 });
    // an ACTIVE eligible member is accepted (and the composite FK holds it)
    const ok = await requirements.create(projectId, { ...CEMENT, activityId, responsibleId: f.memberUser.id }, pmc(projectId));
    expect(ok.responsibleId).toBe(f.memberUser.id);
  });

  it('CORRECTION 3c: the common contract is TYPE-NEUTRAL — a non-material revision needs no fake material fields', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    const activityId = await freshActivity(projectId);

    // a labour-type revision is structurally valid with NO MaterialRequirementSpec row
    await t.prisma.activityRequirementRoot.create({ data: { id: 'it-p3-labour', projectId, createdById: f.memberUser.id } });
    await t.prisma.activityRequirement.create({
      data: { projectId, requirementId: 'it-p3-labour', revision: 1, activityId, type: 'labour', requiredQty: 4, baseUom: 'nos', requiredBy: new Date('2026-08-20'), createdById: f.memberUser.id },
    });
    const list = await requirements.list(projectId, pmc(projectId));
    const labour = list.requirements.find((r) => r.requirementId === 'it-p3-labour')!;
    expect(labour.type).toBe('labour');
    expect(labour.spec).toBeNull();
  });

  it('CORRECTION 4: the full register is a pmc/engineer read — other roles are refused', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    await expect(requirements.list(projectId, client(projectId))).rejects.toMatchObject({ status: 403 });
    await expect(requirements.list(projectId, pmc(projectId))).resolves.toBeTruthy();
  });
});
