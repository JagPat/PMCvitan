import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { RequirementsService } from '../../src/activities/requirements.service';
import { DecisionsService } from '../../src/decisions/decisions.service';
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
 *
 * ROUND 2 (each RED at `d0897a6`): the IMMUTABLE `DecisionApprovalRevision` register —
 *   monotonic versions across provable AND unprovable legacy approvals · ambiguous selected
 *   option refuses (no label fallback, no event-count identity) · forged provenance triples
 *   unrepresentable (composite register FK) · commit-time material↔spec pairing both ways ·
 *   single-source UOM (the spec table has no unit column) · both-ordering removal-vs-create
 *   accountability · database-immutable roots and register rows.
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
    'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "CommandExecution", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability"';

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
      ['notification', { projectId: { startsWith: 'it-p3-' } }],
      ['changeRequest', { decision: { projectId: { startsWith: 'it-p3-' } } }],
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

  /** An APPROVED decision with real options, a recorded selection, a real approval-event
   *  history AND its immutable approval-register head (round 2) — `decisions.approvedRef`
   *  serves provenance from the register row alone. */
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
    // the register head: version = the recorded approval count, pinning the selected option
    await t.prisma.decisionApprovalRevision.create({
      data: {
        id: `dar-${id}-v${approvals.length}`, projectId, decisionId: id, version: approvals.length,
        optionKey: 'opt-a', approvedAt: new Date(), approvedById: f.memberUser.id,
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

  // ── Round-2 reproduce-first probes (each RED at d0897a6) ──────────────────────────────────

  it('R2-1 MONOTONIC VERSIONS: a legacy approval reapproves as version 2 — with or without a backfilled register row', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    const decisions = t.app.get(DecisionsService);

    // (a) a backfilled legacy approval (register v1) reopened for change: the REAL approve
    // command appends v2 IN THE SAME TRANSACTION, pinning the newly selected option's key
    // and the approver's identity (on behalf of the client — never disguised)
    await makeApprovedDecision(projectId, 'IT-P3-LEG1');
    await t.prisma.decision.update({ where: { id: 'IT-P3-LEG1' }, data: { status: 'change' } });
    await t.prisma.changeRequest.create({ data: { decisionId: 'IT-P3-LEG1', reason: 'shade', costImpact: 0, timeImpactDays: 0, status: 'open' } });
    await decisions.approve(projectId, 'IT-P3-LEG1', { optionIndex: 1 }, pmc(projectId));
    const head1 = await t.prisma.decisionApprovalRevision.findFirstOrThrow({ where: { decisionId: 'IT-P3-LEG1' }, orderBy: { version: 'desc' } });
    expect(head1.version).toBe(2);
    expect(head1.optionKey).toBe('opt-b'); // optionIndex 1 → Option B — the option REALLY selected
    expect(head1.approvedById).toBe(f.memberUser.id);
    expect(head1.onBehalfOf).toBe('client');

    // (b) an UNPROVABLE legacy history (two recorded approvals, NO register rows — the
    // migration's ambiguous-skip case): the next approval must version PAST that history,
    // never collide into a false "version 1"
    await t.prisma.decision.create({
      data: {
        id: 'IT-P3-LEG2', projectId, title: 'x', room: 'x', photoSwatch: 'sw', status: 'change',
        publishedAt: new Date(), authorId: f.memberUser.id, approvedOption: 'Option A',
        options: { create: [
          { label: 'Option A', optionKey: 'opt-a', material: 'Teak', delta: 0, swatch: 'sw-a', order: 1 },
          { label: 'Option B', optionKey: 'opt-b', material: 'Walnut', delta: 100, swatch: 'sw-b', order: 2 },
        ] },
        events: { create: [{ type: 'approved', actor: 'm' }, { type: 'reapproved', actor: 'm' }] },
      },
    });
    await t.prisma.changeRequest.create({ data: { decisionId: 'IT-P3-LEG2', reason: 'again', costImpact: 0, timeImpactDays: 0, status: 'open' } });
    await decisions.approve(projectId, 'IT-P3-LEG2', { optionIndex: 0 }, pmc(projectId));
    const rows2 = await t.prisma.decisionApprovalRevision.findMany({ where: { decisionId: 'IT-P3-LEG2' } });
    expect(rows2).toHaveLength(1); // nothing fabricated for the unprovable past
    expect(rows2[0]!.version).toBe(3); // floor = the two recorded approvals
  });

  it('R2-2 MISSING/AMBIGUOUS SELECTED OPTION REFUSES: an approved decision with no register row cannot anchor provenance', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    const activityId = await freshActivity(projectId);
    // approved + published, a recorded label matching NO option, NO register row — exactly the
    // migration's ambiguous-skip state. At d0897a6 the label FALLBACK stored the raw label.
    await t.prisma.decision.create({
      data: {
        id: 'IT-P3-AMB', projectId, title: 'x', room: 'x', photoSwatch: 'sw', status: 'approved',
        publishedAt: new Date(), authorId: f.memberUser.id, approvedOption: 'A label nobody has',
        options: { create: [
          { label: 'Option A', optionKey: 'opt-a', material: 'Teak', delta: 0, swatch: 'sw-a', order: 1 },
        ] },
      },
    });
    const attempt = requirements.create(projectId, { ...CEMENT, activityId, decisionId: 'IT-P3-AMB' }, pmc(projectId));
    await expect(attempt).rejects.toMatchObject({ status: 400, message: expect.stringContaining('operator repair') });
  });

  it('R2-3 FORGED PROVENANCE IS UNREPRESENTABLE: the composite register FK refuses a fabricated triple', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    const activityId = await freshActivity(projectId);
    await makeApprovedDecision(projectId, 'IT-P3-REAL'); // register holds ONLY (v1, opt-a)

    await expect(
      t.prisma.$transaction([
        t.prisma.activityRequirementRoot.create({ data: { id: 'it-p3-forge', projectId, createdById: f.memberUser.id } }),
        t.prisma.activityRequirement.create({
          data: { projectId, requirementId: 'it-p3-forge', revision: 1, activityId, requiredQty: 1, baseUom: 'bag', requiredBy: new Date('2026-08-15'), createdById: f.memberUser.id },
        }),
        t.prisma.materialRequirementSpec.create({
          data: {
            projectId, requirementId: 'it-p3-forge', revision: 1,
            materialCategory: 'cement', make: 'x', grade: 'x', normalizedAttributes: '', specFingerprint: 'forged',
            decisionId: 'IT-P3-REAL', decisionVersion: 999, optionKey: 'DOES-NOT-EXIST',
          },
        }),
      ]),
    ).rejects.toThrow(/provenance|Foreign key/i);
  });

  it('R2-4 MATERIAL WITHOUT SPEC REFUSES AT COMMIT', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    const activityId = await freshActivity(projectId);
    await expect(
      t.prisma.$transaction([
        t.prisma.activityRequirementRoot.create({ data: { id: 'it-p3-nospec', projectId, createdById: f.memberUser.id } }),
        t.prisma.activityRequirement.create({
          data: { projectId, requirementId: 'it-p3-nospec', revision: 1, activityId, requiredQty: 1, baseUom: 'bag', requiredBy: new Date('2026-08-15'), createdById: f.memberUser.id },
        }),
      ]),
    ).rejects.toThrow(/exactly one MaterialRequirementSpec/);
  });

  it('R2-5 NON-MATERIAL WITH SPEC REFUSES AT COMMIT', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    const activityId = await freshActivity(projectId);
    await expect(
      t.prisma.$transaction([
        t.prisma.activityRequirementRoot.create({ data: { id: 'it-p3-labspec', projectId, createdById: f.memberUser.id } }),
        t.prisma.activityRequirement.create({
          data: { projectId, requirementId: 'it-p3-labspec', revision: 1, activityId, type: 'labour', requiredQty: 4, baseUom: 'nos', requiredBy: new Date('2026-08-20'), createdById: f.memberUser.id },
        }),
        t.prisma.materialRequirementSpec.create({
          data: { projectId, requirementId: 'it-p3-labspec', revision: 1, materialCategory: 'x', make: 'x', grade: 'x', normalizedAttributes: '', specFingerprint: 'x' },
        }),
      ]),
    ).rejects.toThrow(/no MaterialRequirementSpec/);
  });

  it('R2-6 SINGLE-SOURCE UOM: the spec table has no unit column to disagree with the revision', async () => {
    const cols = await t.prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'MaterialRequirementSpec' AND column_name = 'baseUom'`,
    );
    expect(cols).toHaveLength(0); // the duplicated column is GONE — disagreement is unrepresentable
    await expect(
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "MaterialRequirementSpec" ("id","projectId","requirementId","revision","materialCategory","make","grade","normalizedAttributes","specFingerprint","baseUom") VALUES ('x','p','r',1,'c','m','g','','f','kg')`,
      ),
    ).rejects.toThrow(/baseUom/);

    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    const activityId = await freshActivity(projectId);
    const r = await requirements.create(projectId, { ...CEMENT, activityId }, pmc(projectId));
    expect(r.spec!.baseUom).toBe(r.baseUom); // the served reference carries the revision's unit
  });

  it('R2-7/8 BOTH ORDERINGS: removal-before-create refuses; create-before-removal stays historically attributable', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    const activityId = await freshActivity(projectId);
    await t.prisma.membership.create({ data: { projectId, userId: f.strangerUser.id, role: 'engineer', status: 'active' } });

    // create BEFORE removal: the requirement commits against the then-active membership...
    const r = await requirements.create(projectId, { ...CEMENT, activityId, responsibleId: f.strangerUser.id }, pmc(projectId));
    expect(r.responsibleId).toBe(f.strangerUser.id);
    // ...then the member is removed (removals are STATUS FLIPS, exactly what members.service
    // does) — the requirement stays historically attributable, and the membership row that
    // carries the attribution cannot be hard-deleted out from under it (composite FK)
    await t.prisma.membership.update({ where: { projectId_userId: { projectId, userId: f.strangerUser.id } }, data: { status: 'removed' } });
    const list = await requirements.list(projectId, pmc(projectId));
    expect(list.requirements.find((x) => x.requirementId === r.requirementId)!.responsibleId).toBe(f.strangerUser.id);
    await expect(
      t.prisma.membership.delete({ where: { projectId_userId: { projectId, userId: f.strangerUser.id } } }),
    ).rejects.toThrow();

    // removal BEFORE create: the readiness-locked in-transaction check refuses the removed member
    await expect(
      requirements.create(projectId, { ...CEMENT, activityId, responsibleId: f.strangerUser.id }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('R2-9 IMMUTABLE ROOT AND REGISTER: direct UPDATE and DELETE are DATABASE-rejected', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    const activityId = await freshActivity(projectId);
    const r = await requirements.create(projectId, { ...CEMENT, activityId }, pmc(projectId));
    await makeApprovedDecision(projectId, 'IT-P3-IMM');

    await expect(t.prisma.activityRequirementRoot.update({ where: { id: r.requirementId }, data: { createdById: f.otherUser.id } })).rejects.toThrow(/append-only/);
    await expect(t.prisma.activityRequirementRoot.delete({ where: { id: r.requirementId } })).rejects.toThrow(/append-only/);
    await expect(t.prisma.decisionApprovalRevision.update({ where: { id: 'dar-IT-P3-IMM-v1' }, data: { optionKey: 'opt-b' } })).rejects.toThrow(/append-only/);
    await expect(t.prisma.decisionApprovalRevision.delete({ where: { id: 'dar-IT-P3-IMM-v1' } })).rejects.toThrow(/append-only/);
  });
});
