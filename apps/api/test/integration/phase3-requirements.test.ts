import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { RequirementsService } from '../../src/activities/requirements.service';
import { CapabilitiesService, MATERIALS_CAPABILITY } from '../../src/platform/capabilities.service';
import { SnapshotService } from '../../src/snapshot/snapshot.service';
import { OutboxRelay } from '../../src/platform/outbox/relay.service';
import { DECISIONS_PROJECTION } from '../../src/decisions/decisions.projection';
import type { AuthUser } from '../../src/common/auth';
import type { CreateRequirementInput } from '../../src/contracts';

/**
 * Phase 3 Task 1 — live-PG proofs (plan §§B/D/F/G, Task-1 acceptance ONLY):
 *  • §D pilot inertness: two projects in ONE org, capability enabled on one — the non-pilot
 *    project's routes 404, its snapshot is deep-equal before/after, and it has ZERO
 *    requirement events/deliveries;
 *  • §F revision immutability: revise/cancel APPEND revisions; prior revisions stay
 *    byte-identical; CAS conflicts on a stale expectedRevision; cancelled heads refuse;
 *  • §B identity: identical technical material via two different decisions → ONE fingerprint
 *    (pooling), provenance retained per row; DB CHECKs refuse revision 0 / non-positive qty;
 *  • decimal/UOM round-trip: canonical persistence of decimal strings; refusals;
 *  • §G events: created/revised/cancelled appended on the command tx; existing ordered
 *    consumers advance past them as no-ops;
 *  • tenant isolation + idempotency: foreign activity/decision refs refuse; a keyed replay
 *    returns the same row and appends nothing.
 */

describe('Phase 3 Task 1 — capability + requirements (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let requirements: RequirementsService;
  let capabilities: CapabilitiesService;
  let snapshot: SnapshotService;
  let relay: OutboxRelay;
  let seq = 0;

  const TRUNCATE =
    'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "CommandExecution", "ActivityRequirement", "ProjectCapability"';

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;

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
    await t.prisma.activity.create({
      data: { id, projectId, name: `Act ${seq}`, zone: 'Zone 1', plannedStart: 0, plannedEnd: 10 },
      select: { id: true },
    });
    return id;
  };

  const CEMENT: Omit<CreateRequirementInput, 'activityId'> = {
    materialCategory: 'Cement', make: 'UltraTech', grade: 'OPC 53', attributes: 'grey, 50kg bags',
    baseUom: 'bag', qty: '120.5', requiredBy: '2026-08-15', criticality: 'normal',
    decisionId: null, decisionVersion: null, optionKey: null, responsibleId: null, tolerance: null,
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

    // the NON-pilot project: every requirement surface behaves as if the feature does not exist
    await expect(requirements.list(other, pmc(other))).rejects.toMatchObject({ status: 404 });
    await expect(requirements.create(other, { ...CEMENT, activityId: otherActivity }, pmc(other))).rejects.toMatchObject({ status: 404 });
    // …its snapshot is DEEP-EQUAL to the pre-enable capture (no new keys, no changed values)
    const after = await snapshot.build(other, 'pmc', f.memberUser.id);
    expect(after).toEqual(before);
    // …and it has ZERO Phase-3 events or deliveries
    expect(await t.prisma.domainEvent.count({ where: { projectId: other } })).toBe(0);
    expect(await t.prisma.outboxDelivery.count({ where: { projectId: other } })).toBe(0);
    // the pilot project emitted exactly one requirement event
    const evs = await t.prisma.domainEvent.findMany({ where: { projectId: pilot }, select: { eventType: true } });
    expect(evs.map((e) => e.eventType)).toEqual(['requirement.created']);
  });

  it('§F REVISIONS: append-only history, byte-identical priors, CAS conflicts, cancelled refuses', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    const activityId = await freshActivity(projectId);

    const r1 = await requirements.create(projectId, { ...CEMENT, activityId }, pmc(projectId));
    const rev1Before = await t.prisma.activityRequirement.findUniqueOrThrow({ where: { id: r1.id } });

    const r2 = await requirements.revise(projectId, r1.requirementId, { ...CEMENT, activityId, qty: '200', expectedRevision: 1 }, pmc(projectId));
    expect(r2.revision).toBe(2);
    expect(r2.qty).toBe('200');
    // revision 1 is retained BYTE-IDENTICAL — nothing was edited
    const rev1After = await t.prisma.activityRequirement.findUniqueOrThrow({ where: { id: r1.id } });
    expect(JSON.stringify(rev1After)).toBe(JSON.stringify(rev1Before));

    // CAS: a stale expectedRevision conflicts
    await expect(
      requirements.revise(projectId, r1.requirementId, { ...CEMENT, activityId, qty: '300', expectedRevision: 1 }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });

    const r3 = await requirements.cancel(projectId, r1.requirementId, { expectedRevision: 2, reason: 'scope removed' }, pmc(projectId));
    expect(r3.revision).toBe(3);
    expect(r3.status).toBe('cancelled');
    // a cancelled requirement can be neither revised nor re-cancelled
    await expect(
      requirements.revise(projectId, r1.requirementId, { ...CEMENT, activityId, expectedRevision: 3 }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      requirements.cancel(projectId, r1.requirementId, { expectedRevision: 3, reason: 'again' }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 400 });

    // the list read serves the head revision + the revision count
    const list = await requirements.list(projectId, pmc(projectId));
    expect(list.requirements).toHaveLength(1);
    expect(list.requirements[0]).toMatchObject({ revision: 3, status: 'cancelled', revisions: 3 });
  });

  it('§B IDENTITY: identical technical material via two decisions POOLS to one fingerprint; provenance retained; DB CHECKs hold', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    const activityId = await freshActivity(projectId);
    for (const id of ['IT-P3-D1', 'IT-P3-D2']) {
      await t.prisma.decision.create({
        data: { id, projectId, title: id, room: 'Living', photoSwatch: 'sw', status: 'approved', publishedAt: new Date(), authorId: f.memberUser.id },
      });
    }

    const viaD1 = await requirements.create(projectId, { ...CEMENT, activityId, decisionId: 'IT-P3-D1', optionKey: 'a' }, pmc(projectId));
    const viaD2 = await requirements.create(projectId, { ...CEMENT, activityId, make: ' ULTRATECH ', decisionId: 'IT-P3-D2', optionKey: 'b' }, pmc(projectId));
    // ONE technical identity — the fingerprint pools across decision provenance
    expect(viaD2.specFingerprint).toBe(viaD1.specFingerprint);
    expect(viaD1.decisionId).toBe('IT-P3-D1');
    expect(viaD2.decisionId).toBe('IT-P3-D2');
    // a different grade is a DIFFERENT identity
    const otherGrade = await requirements.create(projectId, { ...CEMENT, activityId, grade: 'OPC 43' }, pmc(projectId));
    expect(otherGrade.specFingerprint).not.toBe(viaD1.specFingerprint);

    // the database backstops (§B/§F): revision >= 1 and qty > 0 are CHECK-refused even raw
    await expect(
      t.prisma.activityRequirement.create({
        data: { projectId, requirementId: 'raw-r0', revision: 0, activityId, materialCategory: 'x', make: 'x', grade: 'x', normalizedAttributes: '', baseUom: 'bag', specFingerprint: 'f', requiredQty: 1, requiredBy: new Date(), createdById: 'x' },
      }),
    ).rejects.toThrow();
    await expect(
      t.prisma.activityRequirement.create({
        data: { projectId, requirementId: 'raw-q0', revision: 1, activityId, materialCategory: 'x', make: 'x', grade: 'x', normalizedAttributes: '', baseUom: 'bag', specFingerprint: 'f', requiredQty: 0, requiredBy: new Date(), createdById: 'x' },
      }),
    ).rejects.toThrow();
  });

  it('DECIMAL/UOM: canonical round-trip, refusals for precision/zero/uom', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    const activityId = await freshActivity(projectId);

    const exact = await requirements.create(projectId, { ...CEMENT, activityId, qty: '12.345678' }, pmc(projectId));
    expect(exact.qty).toBe('12.345678'); // survives numeric(18,6) byte-identically
    const padded = await requirements.create(projectId, { ...CEMENT, activityId, qty: '007.10' }, pmc(projectId));
    expect(padded.qty).toBe('7.1'); // canonicalized once, stable thereafter

    for (const qty of ['1.2345678', '0', '-2', '1e3']) {
      await expect(requirements.create(projectId, { ...CEMENT, activityId, qty }, pmc(projectId)), qty).rejects.toMatchObject({ status: 400 });
    }
    await expect(requirements.create(projectId, { ...CEMENT, activityId, baseUom: 'bags' }, pmc(projectId))).rejects.toMatchObject({ status: 400 });
  });

  it('§G EVENTS: created/revised/cancelled ride the command tx; ordered consumers no-op past them', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    const activityId = await freshActivity(projectId);

    const r1 = await requirements.create(projectId, { ...CEMENT, activityId }, pmc(projectId));
    await requirements.revise(projectId, r1.requirementId, { ...CEMENT, activityId, qty: '9', expectedRevision: 1 }, pmc(projectId));
    await requirements.cancel(projectId, r1.requirementId, { expectedRevision: 2, reason: 'done' }, pmc(projectId));

    const evs = await t.prisma.domainEvent.findMany({ where: { projectId }, orderBy: { streamPosition: 'asc' } });
    expect(evs.map((e) => e.eventType)).toEqual(['requirement.created', 'requirement.revised', 'requirement.cancelled']);
    expect((evs[1]!.payload as { revision: number }).revision).toBe(2);

    // an existing ordered projection consumer treats requirement.* as no-ops and stays contiguous
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
    await t.prisma.decision.create({
      data: { id: 'IT-P3-D9', projectId: p2, title: 'x', room: 'x', photoSwatch: 'sw', status: 'approved', publishedAt: new Date(), authorId: f.memberUser.id },
    });

    // cross-project activity + decision references are refused (service + composite FK backstop)
    await expect(requirements.create(p1, { ...CEMENT, activityId: a2 }, pmc(p1))).rejects.toMatchObject({ status: 400 });
    await expect(requirements.create(p1, { ...CEMENT, activityId: a1, decisionId: 'IT-P3-D9' }, pmc(p1))).rejects.toMatchObject({ status: 400 });

    // idempotency: the same key replays the SAME requirement — one revision row, one event
    const key = `it-p3-key-${Date.now() % 1e6}`;
    const first = await requirements.create(p1, { ...CEMENT, activityId: a1 }, pmc(p1), key);
    const replay = await requirements.create(p1, { ...CEMENT, activityId: a1 }, pmc(p1), key);
    expect(replay.id).toBe(first.id);
    expect(await t.prisma.activityRequirement.count({ where: { projectId: p1 } })).toBe(1);
    expect(await t.prisma.domainEvent.count({ where: { projectId: p1, eventType: 'requirement.created' } })).toBe(1);
  });
});
