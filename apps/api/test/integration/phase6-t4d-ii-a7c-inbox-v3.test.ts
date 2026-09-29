import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture, wipeDecisionEvents, wipeDecisionsVia, wipeMembershipTransitionsVia } from './fixtures';
import { DecisionsQueryService } from '../../src/decisions/decisions.query';
import { DECISIONS_PROJECTION, DECISIONS_INBOX_CATALOG_VERSION } from '../../src/decisions/decisions.projection';
import { OutboxRelay } from '../../src/platform/outbox/relay.service';
import { ProjectionRebuilder } from '../../src/platform/projections/rebuilder.service';
import { ProjectionRebuildOperations } from '../../src/platform/projections/rebuild-operations';
import { catalogVersionFor, readServableGeneration } from '../../src/platform/projections/generation';
import { verifyWriterFence } from '../../src/platform/projections/inbox-repair-seals';
import { compiledCatalogVersion } from '../../src/platform/release-lease.service';
import { listConsumers } from '../../src/platform/outbox/registry';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
import type { DecisionDto } from '../../src/snapshot/types';

/**
 * Phase 6 task 4d unit 4d-ii-a / A7c — `decisions.inbox` v3, proven against live PostgreSQL (the
 * plan's §D: "the `decisions.inbox` projection row/fold/rebuild/filter carrying the awaiting state,
 * the forward-installed holder and the non-`standard` origin (live == projection == rebuild); the
 * two changed consumers' DURABLE contract versions bumped ... `decisions.inbox` (2 → 3) — with the
 * `OutboxConsumerCatalog` rows ... migrated in 4d-ii's OWN catalog-data migration").
 *
 * The contract version is the SUBSTANCE of this unit, not its bookkeeping. Since 4c-ii's version 2
 * the stored DTO changed meaning without a version of its own — the finalized-only cycle (A4a), the
 * non-`standard` origin (A5e), the awaiting state and the installed holder (written by A8a's commands)
 * — so a generation a version-2 serializer built, or a version-2 relay goes on writing, can hold rows
 * this release would not produce and nothing on the rows says so. Version 3 is what makes such a
 * generation unservable (the read falls back to the canonical slice), what refuses a previous-release
 * process at its start, and what the re-issued writer fence reads: a version-2 declaration now stamps
 * exactly as an undeclared write does.
 *
 * The awaiting state and the installed holder have no writer before A8a, and the non-`standard`
 * origin none before A8b, so those three are PLANTED on canonical rows under a whole-table,
 * single-transaction disable (the A7b shape) and the fold is driven by the next decision event of the
 * project — the handler refreshes the WHOLE project's rows from canonical on every event, which is
 * exactly the property these arms prove: live == projection == rebuild, from one serializer.
 */
describe('4d-ii-a / A7c — decisions.inbox v3: the contract version, the fence that follows it, and the fold that carries the awaiting state, the installed holder and the non-standard origin (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let query: DecisionsQueryService;
  let relay: OutboxRelay;
  let ops: ProjectionRebuildOperations;
  let pmcToken: string;
  let clientToken: string;
  let engToken: string;
  const run = randomUUID().slice(0, 8);
  const OPERATOR = `a7c-operator-${run}`;
  const eng = { id: `a7c-eng-${run}`, membershipId: '' };
  const clientB = { id: `a7c-clientb-${run}`, membershipId: '' };

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    query = t.app.get(DecisionsQueryService);
    relay = t.app.get(OutboxRelay);
    ops = new ProjectionRebuildOperations(t.prisma, t.app.get(ProjectionRebuilder));
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    clientToken = t.issueProjectToken(f.clientUser.id, f.projectA.id, 'client');
    await t.prisma.user.create({ data: { id: eng.id, projectId: f.projectA.id, role: 'engineer', name: 'A7c Engineer', email: `${eng.id}@test.local` } });
    eng.membershipId = (await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: eng.id, role: 'engineer', status: 'active' } })).id;
    engToken = t.issueProjectToken(eng.id, f.projectA.id, 'engineer');
    await t.prisma.user.create({ data: { id: clientB.id, projectId: f.projectA.id, role: 'client', name: 'A7c Client B', email: `${clientB.id}@test.local` } });
    clientB.membershipId = (await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: clientB.id, role: 'client', status: 'active' } })).id;
  });

  afterAll(async () => {
    const projectId = f.projectA.id;
    await sanctionedReset(t.prisma, [
      'Notification', 'DecisionConsultationResponse', 'DecisionConsultation', 'DecisionApprovalRevision', 'ChangeRequest',
      'DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor', 'CommandExecution',
      'DecisionProjection', 'ProjectionGeneration',
    ], { cascade: true });
    await wipeDecisionEvents(t.prisma, { decision: { projectId } });
    await wipeDecisionsVia(t.prisma, async (tx) => {
      await tx.decisionOption.deleteMany({ where: { decision: { projectId } } });
      await tx.decision.deleteMany({ where: { projectId } });
    });
    await t.prisma.outboxOperatorAction.deleteMany({ where: { operatorIdentity: OPERATOR } });
    const tmpIds = [eng.id, clientB.id];
    await wipeMembershipTransitionsVia(t.prisma, tmpIds);
    await t.prisma.membership.deleteMany({ where: { userId: { in: tmpIds } } });
    await t.prisma.user.deleteMany({ where: { id: { in: tmpIds } } });
    await f?.cleanup();
    await t?.close();
  });

  const post = (token: string) => (path: string, body: object) =>
    request(t.app.getHttpServer()).post(path).set('Authorization', `Bearer ${token}`).set('Idempotency-Key', randomUUID()).send(body);
  const base = () => `/projects/${f.projectA.id}/decisions`;
  const OPTIONS = [
    { label: 'Option A', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true },
    { label: 'Option B', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false },
  ];
  /** A published decision, client-held unless a member decider is named. */
  const issue = async (over: object = {}): Promise<string> => {
    const title = `A7c ${randomUUID().slice(0, 8)}`;
    const r = await post(pmcToken)(base(), { title, room: 'Kitchen', publish: true, options: OPTIONS, ...over });
    expect(r.status, r.text).toBe(201);
    return (await t.prisma.decision.findFirstOrThrow({ where: { projectId: f.projectA.id, title } })).id;
  };
  /** Drive every pending `decisions.inbox` delivery of project A through the relay (the fold). */
  const applyProjection = async (): Promise<void> => {
    for (let pass = 0; pass < 60; pass++) {
      const ds = await t.prisma.outboxDelivery.findMany({
        where: { consumer: DECISIONS_PROJECTION, projectId: f.projectA.id, status: { in: ['pending', 'leased'] } },
        orderBy: { streamPosition: 'asc' },
      });
      if (!ds.length) return;
      let progressed = false;
      for (const d of ds) {
        const o = await relay.dispatchOne(d.id);
        if (o === 'succeeded' || o === 'duplicate' || o === 'dead') progressed = true;
      }
      if (!progressed) return;
    }
  };
  const activeGen = () => t.prisma.projectionGeneration.findFirstOrThrow({ where: { consumer: DECISIONS_PROJECTION, projectId: f.projectA.id, status: 'active' } });
  /** The PMC's projection-served DTO of one decision, with the generation it came from. */
  const projected = async (did: string): Promise<{ dto: DecisionDto | undefined; generation: number | null }> => {
    const slice = await query.projectionSlice(f.projectA.id, 'pmc', f.memberUser.id);
    return { dto: slice.decisions.find((d) => d.id === did), generation: slice.generation };
  };
  /** The PMC's LIVE DTO of one decision — the canonical slice through the same serializer. */
  const live = async (did: string): Promise<DecisionDto | undefined> =>
    (await query.snapshotSlice(f.projectA.id, 'pmc', f.memberUser.id)).decisions.find((d) => d.id === did);
  /** live == projection (the fold) == rebuild (the seed), for one decision, and the generation is stamped 3. */
  const expectOneSerializer = async (did: string, check: (dto: DecisionDto) => void): Promise<void> => {
    await applyProjection();
    const before = await activeGen();
    expect(before.catalogVersion).toBe(DECISIONS_INBOX_CATALOG_VERSION);
    const folded = await projected(did);
    expect(folded.generation, 'the fold is served from the projection').toBe(before.generation);
    check(folded.dto!);
    expect(folded.dto).toEqual(await live(did));
    const report = await ops.run({ operatorIdentity: OPERATOR, reason: 'A7c: the rebuild seeds from the same serializer', projectId: f.projectA.id, consumers: [DECISIONS_PROJECTION] });
    expect(report.ok, JSON.stringify(report.results)).toBe(true);
    const after = await activeGen();
    expect(after.generation).toBeGreaterThan(before.generation);
    expect(after.catalogVersion, 'the rebuilt generation is stamped at the compiled version').toBe(DECISIONS_INBOX_CATALOG_VERSION);
    const rebuilt = await projected(did);
    expect(rebuilt.generation).toBe(after.generation);
    check(rebuilt.dto!);
    expect(rebuilt.dto).toEqual(await live(did));
  };
  /** A canonical state no shipped command can yet write, planted under the table's seals disabled
   *  wholesale for one statement in one transaction (the A7b shape; the coverage tripwire's
   *  sanctioned whole-table form, which it recognizes by the LITERAL table name). */
  const plantChangeRequest = (sql: string) =>
    t.prisma.$transaction([
      t.prisma.$executeRawUnsafe('ALTER TABLE "ChangeRequest" DISABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe(sql),
      t.prisma.$executeRawUnsafe('ALTER TABLE "ChangeRequest" ENABLE TRIGGER USER'),
    ]);
  const plantDecision = (sql: string) =>
    t.prisma.$transaction([
      t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" DISABLE TRIGGER USER'),
      t.prisma.$executeRawUnsafe(sql),
      t.prisma.$executeRawUnsafe('ALTER TABLE "Decision" ENABLE TRIGGER USER'),
    ]);

  // ── the contract version ──────────────────────────────────────────────────────────────────────

  it('the persisted decisions.inbox contract reads 3, the compiled consumer and the lease agree, and webpush.notify stays at 2 until A7d', async () => {
    const rows = await t.prisma.outboxConsumerCatalog.findMany({
      where: { consumer: { in: [DECISIONS_PROJECTION, 'webpush.notify'] } },
      select: { consumer: true, catalogVersion: true, consumerKind: true, consumerEffect: true },
    });
    const byName = Object.fromEntries(rows.map((r) => [r.consumer, r]));
    expect(byName[DECISIONS_PROJECTION]).toMatchObject({ catalogVersion: 3, consumerKind: 'ordered', consumerEffect: 'db' });
    expect(byName['webpush.notify']?.catalogVersion).toBe(2);
    // the app booted, so `syncConsumerCatalog` accepted the row: compiled == persisted
    expect(catalogVersionFor(DECISIONS_PROJECTION)).toBe(DECISIONS_INBOX_CATALOG_VERSION);
    expect(listConsumers().find((c) => c.name === DECISIONS_PROJECTION)?.catalogVersion).toBe(3);
    // the release lease this process writes names the highest compiled contract: 3, from this consumer alone
    expect(compiledCatalogVersion()).toBe(3);
  });

  it('a generation this release builds is stamped 3 and serves; stamped 2 — what the previous release\'s rebuild CLI leaves — it is refused even when healthy and caught up, and the module read serves LIVE', async () => {
    const did = await issue();
    await applyProjection();
    const gen = await activeGen();
    expect(gen.catalogVersion).toBe(3);
    expect((await projected(did)).generation).toBe(gen.generation);
    expect((await query.moduleDecisions(f.projectA.id, 'pmc', f.memberUser.id)).source).toBe('projection');

    // the same healthy, caught-up generation, stamped by a version-2 binary: refused on its stamp alone
    await t.prisma.projectionGeneration.update({ where: { id: gen.id }, data: { catalogVersion: 2 } });
    expect(await readServableGeneration(t.prisma, DECISIONS_PROJECTION, f.projectA.id)).toBeNull();
    const served = await query.moduleDecisions(f.projectA.id, 'pmc', f.memberUser.id);
    expect(served.source).toBe('live');
    expect(served.decisions.find((d) => d.id === did)).toBeDefined(); // the PMC still sees the register

    await t.prisma.projectionGeneration.update({ where: { id: gen.id }, data: { catalogVersion: 3 } });
    expect(await readServableGeneration(t.prisma, DECISIONS_PROJECTION, f.projectA.id)).not.toBeNull();
  });

  // ── the writer fence follows the contract ─────────────────────────────────────────────────────

  it('the writer fence reads 3: a write declaring 3 is left alone, a write declaring 2 — the previous release\'s relay — STAMPS, an undeclared write stamps; and the deploy verifier accepts the re-issued fence', async () => {
    const fence = await verifyWriterFence(t.prisma);
    expect(fence.findings, 'the re-issued bodies are the canonical ones').toEqual([]);
    expect(fence.installed).toBe(true);

    const gens = await Promise.all(['declared', 'previous', 'undeclared'].map((label, i) =>
      t.prisma.projectionGeneration.create({
        data: { consumer: DECISIONS_PROJECTION, projectId: `a7c-fence-${label}-${run}`, generation: 900 + i, status: 'retired', catalogVersion: 3 },
        select: { id: true, projectId: true },
      })));
    const [declared, previous, undeclared] = gens;
    const write = async (gen: { id: string; projectId: string }, declare: string | null) => {
      await t.prisma.$transaction(async (tx) => {
        if (declare !== null) await tx.$executeRaw`SELECT set_config('vitan.decisions_inbox_catalog_version', ${declare}, true)`;
        await tx.$executeRawUnsafe(
          `INSERT INTO "DecisionProjection" ("id","generationId","projectId","decisionId","status","dto","updatedAt")
           VALUES ($1,$2,$3,$4,'pending','{}'::jsonb, now())`,
          `a7c-fence-row-${gen.projectId}`, gen.id, gen.projectId, `d-${gen.projectId}`);
      });
      return (await t.prisma.projectionGeneration.findUniqueOrThrow({ where: { id: gen.id }, select: { fencedAt: true } })).fencedAt;
    };
    try {
      expect(await write(declared, String(DECISIONS_INBOX_CATALOG_VERSION)), 'this release\'s writer').toBeNull();
      expect(await write(previous, '2'), 'the previous release\'s declaration stamps (RED at the A7b head, where the fence read 2)').not.toBeNull();
      expect(await write(undeclared, null), 'an undeclared write stamps, as before').not.toBeNull();
    } finally {
      // declared, so the cleanup itself does not stamp anything (retired generations, but the
      // discipline is the point); the generations go with their rows
      await t.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('vitan.decisions_inbox_catalog_version', ${String(DECISIONS_INBOX_CATALOG_VERSION)}, true)`;
        await tx.decisionProjection.deleteMany({ where: { generationId: { in: gens.map((g) => g.id) } } });
      });
      await t.prisma.projectionGeneration.deleteMany({ where: { id: { in: gens.map((g) => g.id) } } });
    }
  });

  // ── the fold: live == projection == rebuild for the three meanings v3 carries ─────────────────

  it('the fold carries the non-standard origin: a countersign_rejection request is served as such by the projection, the live slice and the rebuild alike', async () => {
    const did = await issue();
    expect((await post(clientToken)(`${base()}/${did}/approve`, { optionIndex: 0 })).status).toBe(201);
    expect((await post(engToken)(`${base()}/${did}/change`, { reason: 'Disagree', costImpact: 0, timeImpactDays: 0 })).status).toBe(201);
    const open = await t.prisma.changeRequest.findFirstOrThrow({ where: { decisionId: did, status: 'open' } });
    const head = await t.prisma.decisionApprovalRevision.findFirstOrThrow({ where: { decisionId: did }, orderBy: { version: 'desc' } });
    // the origin and the revision it answers are FROZEN by 4d-i's evidence seal; A8b's disagreement
    // command is the only writer, so the state is planted (the row keeps every CHECK on the shape)
    await plantChangeRequest(`UPDATE "ChangeRequest" SET "origin" = 'countersign_rejection', "revisionId" = '${head.id}' WHERE "id" = '${open.id}'`);
    // the plant emits nothing; the project's next decision event folds the WHOLE register
    await issue();
    await expectOneSerializer(did, (dto) => {
      expect(dto.status).toBe('change');
      expect(dto.changeRequest).toMatchObject({ reason: 'Disagree', origin: 'countersign_rejection' });
    });
  });

  it('the fold carries the installed holder: the holder is re-derived from the canonical row on every fold and by the rebuild, never read from an event payload', async () => {
    const did = await issue({ deciderKind: 'member', deciderMembershipId: eng.membershipId });
    await applyProjection();
    expect((await projected(did)).dto).toMatchObject({ deciderKind: 'member', deciderMembershipId: eng.membershipId, deciderUserId: eng.id });
    // the holder moves — A8a's forward writes this with its fact; here the canonical column alone is
    // planted, which is the property under test: the fold reads the ROW, not the forward's payload
    await plantDecision(`UPDATE "Decision" SET "deciderMembershipId" = '${clientB.membershipId}' WHERE "id" = '${did}'`);
    await issue();
    await expectOneSerializer(did, (dto) => {
      expect(dto).toMatchObject({ deciderKind: 'member', deciderMembershipId: clientB.membershipId, deciderUserId: clientB.id });
      expect(dto.deciderUserId).not.toBe(eng.id);
    });
  });

  it('the fold carries the awaiting state: an awaiting_countersign decision is stored, keyed and served as awaiting by the projection, the live slice and the rebuild alike', async () => {
    const did = await issue({ deciderKind: 'member', deciderMembershipId: eng.membershipId });
    await applyProjection();
    expect((await projected(did)).dto?.status).toBe('pending');
    // the state A8a's approve writes under an active chain, planted with the approval tuple NULL as
    // the provisional act leaves the Decision row's own tuple (the revision carries the act)
    await plantDecision(`UPDATE "Decision" SET "status" = 'awaiting_countersign' WHERE "id" = '${did}'`);
    try {
      await issue();
      await expectOneSerializer(did, (dto) => {
        expect(dto.status).toBe('awaiting_countersign');
        expect(dto.draft).toBe(false);
      });
      const gen = await activeGen();
      const row = await t.prisma.decisionProjection.findUniqueOrThrow({ where: { generationId_decisionId: { generationId: gen.id, decisionId: did } } });
      expect(row.status, 'the projection ROW keys the awaiting state').toBe('awaiting_countersign');
      const slice = await query.projectionSlice(f.projectA.id, 'pmc', f.memberUser.id);
      expect(slice.statuses.get(did), 'the readiness map reads it from the projection').toBe('awaiting_countersign');
      expect((await query.snapshotSlice(f.projectA.id, 'pmc', f.memberUser.id)).statuses.get(did)).toBe('awaiting_countersign');
      const served = await query.moduleDecisions(f.projectA.id, 'pmc', f.memberUser.id);
      expect(served.source).toBe('projection');
      expect(served.decisions.find((d) => d.id === did)?.status).toBe('awaiting_countersign');
    } finally {
      await plantDecision(`UPDATE "Decision" SET "status" = 'pending' WHERE "id" = '${did}'`);
    }
  });
});
