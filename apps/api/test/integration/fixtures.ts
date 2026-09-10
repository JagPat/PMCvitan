import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../../src/prisma.service';

import { sanctionedReset } from '../../prisma/sanctioned-reset';
import { effectCoverageVersion } from '../../src/platform/external-effects';
export interface TwoProjectFixture {
  orgA: { id: string };
  orgB: { id: string };
  projectA: { id: string };
  projectB: { id: string };
  /** active pmc membership on projectA */
  memberUser: { id: string };
  /** owner of orgA with NO project membership (super-admin path) */
  ownerUser: { id: string };
  /** active pmc membership on projectB (the other tenant) */
  otherUser: { id: string };
  /** no memberships anywhere */
  strangerUser: { id: string };
  /** Phase 6 task 4b — active CLIENT membership on projectA: publication re-validates the
   *  holder's standing at the DB, and most suites publish client-held (default-kind)
   *  decisions there, so the project must actually HAVE an active client. Invisible to
   *  drawing distributions (engineer/contractor only) and to every stranger/authz probe. */
  clientUser: { id: string };
  cleanup: () => Promise<void>;
}

/**
 * Two isolated organizations, each with one project, plus four users with
 * deterministic memberships — the minimum world in which tenant isolation
 * and live access can be PROVEN rather than assumed. Every id is unique per
 * run so suites can never collide with each other or with leftover rows.
 */
export async function createTwoProjectFixture(prisma: PrismaService): Promise<TwoProjectFixture> {
  const run = randomUUID().slice(0, 8);
  const id = (label: string) => `it-${label}-${run}`;

  const orgA = await prisma.org.create({ data: { id: id('orga'), name: `Org A ${run}`, slug: id('orga') } });
  const orgB = await prisma.org.create({ data: { id: id('orgb'), name: `Org B ${run}`, slug: id('orgb') } });

  const projectData = (pid: string, orgId: string, name: string) => ({
    id: pid,
    orgId,
    name,
    short: name,
    descriptor: '',
    stage: 'Planning',
    siteCode: pid.toUpperCase().slice(0, 8),
    projStart: '01 Jan 2026',
    projEnd: '31 Dec 2026',
    elapsedPct: 0,
    todayDay: 0,
    milestonePct: 0,
  });
  const projectA = await prisma.project.create({ data: projectData(id('proja'), orgA.id, `Project A ${run}`) });
  const projectB = await prisma.project.create({ data: projectData(id('projb'), orgB.id, `Project B ${run}`) });

  const user = (label: string) => ({ id: id(label), projectId: projectA.id, role: 'pmc', name: label, email: `${id(label)}@test.local` });
  const memberUser = await prisma.user.create({ data: user('member') });
  const ownerUser = await prisma.user.create({ data: { ...user('owner'), projectId: projectA.id } });
  const otherUser = await prisma.user.create({ data: { ...user('other'), projectId: projectB.id } });
  const strangerUser = await prisma.user.create({ data: { ...user('stranger') } });
  const clientUser = await prisma.user.create({ data: { ...user('client4b'), role: 'client' } });

  await prisma.membership.create({ data: { projectId: projectA.id, userId: memberUser.id, role: 'pmc', status: 'active' } });
  await prisma.membership.create({ data: { projectId: projectA.id, userId: clientUser.id, role: 'client', status: 'active' } });
  await prisma.membership.create({ data: { projectId: projectB.id, userId: otherUser.id, role: 'pmc', status: 'active' } });
  await prisma.orgMembership.create({ data: { orgId: orgA.id, userId: ownerUser.id, role: 'owner' } });

  const cleanup = async (): Promise<void> => {
    // DomainEvent is append-only (a BEFORE UPDATE OR DELETE trigger blocks row deletes) and its
    // tenant FK is ON DELETE RESTRICT, so a project carrying events cannot be deleted until its
    // events are cleared. TRUNCATE fires no row trigger, so it is the sanctioned reset for the
    // disposable test DB (the suites run serially and share one database). Production never does
    // this — events are immutable there. ProjectEventStream cascades with the project delete.
    // OutboxDelivery (Task 6) FK-references DomainEvent, so truncate them together; ProcessedEvent
    // and ProjectionCursor carry no FK but are cleared for a clean per-suite slate.
    await sanctionedReset(prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor'], { cascade: true });
    // reverse foreign-key order, one transaction — a failed test never strands rows
    await prisma.$transaction([
      // command-idempotency receipts (Phase 2 Task 5) reference the project/org tenant; clear
      // them before the project/org rows they hang off (their tenant FK is ON DELETE CASCADE,
      // but an explicit delete keeps the disposable test DB tidy for cross-suite reuse).
      prisma.commandExecution.deleteMany({ where: { OR: [{ projectId: { in: [projectA.id, projectB.id] } }, { organizationId: { in: [orgA.id, orgB.id] } }] } }),
      prisma.securityAuditEvent.deleteMany({ where: { targetUserId: { in: [memberUser.id, ownerUser.id, otherUser.id, strangerUser.id, clientUser.id] } } }),
      prisma.passwordCredentialChallenge.deleteMany({ where: { userId: { in: [memberUser.id, ownerUser.id, otherUser.id, strangerUser.id, clientUser.id] } } }),
      prisma.auditLog.deleteMany({ where: { projectId: { in: [projectA.id, projectB.id] } } }),
      prisma.notification.deleteMany({ where: { projectId: { in: [projectA.id, projectB.id] } } }),
      prisma.membership.deleteMany({ where: { projectId: { in: [projectA.id, projectB.id] } } }),
      prisma.orgMembership.deleteMany({ where: { orgId: { in: [orgA.id, orgB.id] } } }),
      // Phase 6 unit 6.1a — the canonical party is ORG-scoped and records WHO created it, with a
      // NO ACTION creator key: attribution for an external firm is not something a user delete may
      // silently drop. So the identity rows have to go before the users who made them, and in
      // their own dependency order — association, then the firm rows that reference the party,
      // then the party. (Each source row cascades with whichever of the two it hangs off.)
      // A suite that created no vendor or company deletes nothing here.
      // ORDER is load-bearing: the source→association key is ON DELETE RESTRICT, so the
      // association cannot be removed while a directory row still justifies it. Companies go
      // first (taking their source rows with them by cascade), and only then the association.
      // The reverse order — which this teardown originally used — is now refused by PostgreSQL,
      // which is the seal doing its job rather than a problem with the teardown.
      prisma.projectCompany.deleteMany({ where: { projectId: { in: [projectA.id, projectB.id] } } }),
      prisma.projectParty.deleteMany({ where: { projectId: { in: [projectA.id, projectB.id] } } }),
      prisma.vendor.deleteMany({ where: { orgId: { in: [orgA.id, orgB.id] } } }),
      prisma.externalParty.deleteMany({ where: { orgId: { in: [orgA.id, orgB.id] } } }),
      prisma.user.deleteMany({ where: { id: { in: [memberUser.id, ownerUser.id, otherUser.id, strangerUser.id, clientUser.id] } } }),
      prisma.projectNode.deleteMany({ where: { projectId: { in: [projectA.id, projectB.id] } } }),
      prisma.project.deleteMany({ where: { id: { in: [projectA.id, projectB.id] } } }),
      prisma.templateModule.deleteMany({ where: { orgId: { in: [orgA.id, orgB.id] } } }),
      prisma.projectTemplate.deleteMany({ where: { orgId: { in: [orgA.id, orgB.id] } } }),
      prisma.org.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } }),
    ]);
  };

  return { orgA, orgB, projectA, projectB, memberUser, ownerUser, otherUser, strangerUser, clientUser, cleanup };
}

/** Phase 6 task 4a (round 12) — approval `DecisionEvent` rows are undeletable EVIDENCE
 *  (`DecisionEvent_no_withdrawn_approval` refuses their DELETE, so erasing one cannot launder a
 *  legacy approval before a withdrawal). Suites that approve decisions therefore wipe events
 *  through THIS sanctioned destructive-reset helper, which disables the named seal for exactly
 *  the wipe — the same contract as the DomainEvent TRUNCATE and the seed's guarded transaction. */
export async function wipeDecisionEvents(
  prisma: PrismaService,
  where: Record<string, unknown>,
): Promise<void> {
  // Phase 6 unit 4d-i — TWO new names join the delivered one (§A.3's "one new name", which
  // became two once the correspondence trigger landed here rather than in 4d-iii):
  // `DecisionEvent_t4d_append_only` refuses every UPDATE and DELETE on the register, and
  // `DecisionEvent_t4d_correspondence` is a DEFERRED constraint trigger — a wipe that removes an
  // audit row would otherwise leave its event unmatched and abort at commit.
  await prisma.$executeRawUnsafe('ALTER TABLE "DecisionEvent" DISABLE TRIGGER "DecisionEvent_no_withdrawn_approval"');
  await prisma.$executeRawUnsafe('ALTER TABLE "DecisionEvent" DISABLE TRIGGER "DecisionEvent_t4d_append_only"');
  await prisma.$executeRawUnsafe('ALTER TABLE "DecisionEvent" DISABLE TRIGGER "DecisionEvent_t4d_correspondence"');
  try {
    await prisma.decisionEvent.deleteMany({ where });
  } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE "DecisionEvent" ENABLE TRIGGER "DecisionEvent_t4d_correspondence"');
    await prisma.$executeRawUnsafe('ALTER TABLE "DecisionEvent" ENABLE TRIGGER "DecisionEvent_t4d_append_only"');
    await prisma.$executeRawUnsafe('ALTER TABLE "DecisionEvent" ENABLE TRIGGER "DecisionEvent_no_withdrawn_approval"');
  }
}

/** Phase 6 unit 4b — an APPROVED decision is now permanent register evidence in a LIVE database:
 *  the consolidated `Decision_t4a_d_no_delete` arm and the independent `Decision_t4b_evidence_no_delete`
 *  seal each refuse its DELETE (approval standing, the legacy approver columns, the attribution
 *  tuple, the migration stamp, approval revisions and approval events). Suites that approve a
 *  decision therefore wipe it through THIS sanctioned destructive-reset helper, which disables
 *  both named seals for exactly the wipe — the same contract as `wipeDecisionEvents` above, the
 *  DomainEvent TRUNCATE, and the seed's guarded transaction. Both are re-enabled in `finally`, so
 *  no failure path leaves the shared database's evidence seals off for a later probe. */
export async function wipeDecisions(
  prisma: PrismaService,
  where: Record<string, unknown>,
): Promise<void> {
  await wipeDecisionsVia(prisma, async (tx) => {
    // CHILD-FIRST, and SCOPED to the decisions this reset actually targets. The three 4d chain
    // facts hold `ON DELETE NO ACTION` composite FKs to `Decision`, so their rows would block the
    // parent's deletion; an unscoped `deleteMany({})` would clear another parallel suite's rows
    // in the shared database, which is the pollution class these fixtures exist to avoid.
    const targets = await tx.decision.findMany({ where, select: { id: true } });
    const decisionId = { in: targets.map((d) => d.id) };
    if (targets.length > 0) {
      await tx.decisionStrandedResolution.deleteMany({ where: { decisionId } });
      await tx.decisionCountersign.deleteMany({ where: { decisionId } });
      await tx.decisionForward.deleteMany({ where: { decisionId } });
    }
    return tx.decision.deleteMany({ where });
  });
}

/** The same sanctioned bypass for a reset that is not a plain `decision.deleteMany` — a TRUNCATE,
 *  or a delete that must run together with its children.
 *
 *  ONE interactive transaction, like `prisma/seed.ts` (R6-F4) and the t4a suite (R14-F2): PostgreSQL
 *  DDL is transactional, so a wipe that throws rolls the DISABLE back with it, and the ACCESS
 *  EXCLUSIVE lock `ALTER TABLE` takes means a PARALLEL suite's probe never observes the seal off —
 *  it blocks until this transaction commits, by which time the triggers are enabled again. */
export async function wipeDecisionsVia(
  prisma: PrismaService,
  wipe: (tx: TxClient) => Promise<unknown>,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('ALTER TABLE "Decision" DISABLE TRIGGER "Decision_t4a_d_no_delete"');
    // Phase 6 unit 4d-i — the three chain FACTS hold same-project composite FKs to `Decision`
    // with `ON DELETE NO ACTION`, so a scenario that created one could never tear its decision
    // down: a restrictive FK blocks the parent's deletion and a cascading one would meet the
    // fact's own DELETE seal. They are therefore deleted CHILD-FIRST inside this same
    // transaction, under their row seals disabled by name for that reset only (#561's review
    // round 2, finding 9). Dark today — nothing writes them until 4d-ii — so these deletes clear
    // nothing yet; the protocol exists from the unit that installs the seals, not from the one
    // that first trips over them.
    await tx.$executeRawUnsafe('ALTER TABLE "DecisionForward" DISABLE TRIGGER "DecisionForward_t4d_append_only"');
    await tx.$executeRawUnsafe('ALTER TABLE "DecisionCountersign" DISABLE TRIGGER "DecisionCountersign_t4d_append_only"');
    await tx.$executeRawUnsafe('ALTER TABLE "DecisionStrandedResolution" DISABLE TRIGGER "DecisionStrandedResolution_t4d_append_only"');
    await tx.$executeRawUnsafe('ALTER TABLE "Decision" DISABLE TRIGGER "Decision_t4b_evidence_no_delete"');
    await tx.$executeRawUnsafe('ALTER TABLE "Decision" DISABLE TRIGGER "Decision_t4b_no_truncate"');
    // Phase 6 task 4b — the published-record delete seal and the widened published-parent
    // option freeze join the same sanctioned bypass (a reset deletes options with their head).
    await tx.$executeRawUnsafe('ALTER TABLE "Decision" DISABLE TRIGGER "Decision_t4b2_record_no_delete"');
    await tx.$executeRawUnsafe('ALTER TABLE "DecisionOption" DISABLE TRIGGER "DecisionOption_t4a_frozen"');
    await wipe(tx);
    await tx.$executeRawUnsafe('ALTER TABLE "DecisionOption" ENABLE TRIGGER "DecisionOption_t4a_frozen"');
    await tx.$executeRawUnsafe('ALTER TABLE "Decision" ENABLE TRIGGER "Decision_t4b2_record_no_delete"');
    await tx.$executeRawUnsafe('ALTER TABLE "Decision" ENABLE TRIGGER "Decision_t4b_no_truncate"');
    await tx.$executeRawUnsafe('ALTER TABLE "Decision" ENABLE TRIGGER "Decision_t4b_evidence_no_delete"');
    await tx.$executeRawUnsafe('ALTER TABLE "DecisionStrandedResolution" ENABLE TRIGGER "DecisionStrandedResolution_t4d_append_only"');
    await tx.$executeRawUnsafe('ALTER TABLE "DecisionCountersign" ENABLE TRIGGER "DecisionCountersign_t4d_append_only"');
    await tx.$executeRawUnsafe('ALTER TABLE "DecisionForward" ENABLE TRIGGER "DecisionForward_t4d_append_only"');
    await tx.$executeRawUnsafe('ALTER TABLE "Decision" ENABLE TRIGGER "Decision_t4a_d_no_delete"');
  }, { timeout: 60_000, maxWait: 30_000 });
}

type TxClient = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

/** Phase 6 task 4b — seed a PUBLISHED decision the way the seals now demand: the row births
 *  UNPUBLISHED with its 2-4 option set nested in the same create, and publication is a
 *  same-transaction UPDATE. (The deferred option floor re-counts a published choice at commit;
 *  the option freeze refuses option INSERTs into an already-published parent; the publication
 *  arm re-validates the holder's standing — the project must hold an active member of the
 *  decision's decider role, `client` by default.) Returns the published row. */
export async function seedPublishedDecision(
  prisma: PrismaService,
  data: { id: string } & Record<string, unknown>,
  options?: Array<Record<string, unknown>>,
): Promise<{ id: string }> {
  const opts = options ?? [
    { label: 'Option A', optionKey: 'a', material: 'Granite', delta: 0, swatch: 'sw1', recommended: true, order: 0 },
    { label: 'Option B', optionKey: 'b', material: 'Quartz', delta: 20000, swatch: 'sw2', recommended: false, order: 1 },
  ];
  return prisma.$transaction(async (tx) => {
    await tx.decision.create({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: { ...(data as any), publishedAt: null, options: { createMany: { data: opts as any } } },
    });
    return tx.decision.update({ where: { id: data.id }, data: { publishedAt: new Date() } });
  });
}

/**
 * Plant a `DecisionApprovalRevision` the way HISTORY holds one — with no source command.
 *
 * Phase 6 unit 4c-ii seals the register: a NEW revision must name the `decisions.approve` receipt
 * it is the product of, checked at DEFERRED COMMIT for a SUCCEEDED completion whose `resultRef`
 * is this decision. That seal is why 4c can treat the register's COUNT as cycle evidence, and it
 * is deliberately INSERT-scoped — every LEGACY revision carries a NULL there and keeps it, because
 * backfilling one would invent provenance for an approval whose command was never recorded.
 *
 * A test fixture, though, CREATES those legacy-shaped rows fresh, and the trigger is right to
 * refuse them: it cannot tell a simulated import from a forgery, and it should not try. So the
 * fixture declares itself, by name, for exactly that one statement — the same contract
 * `sanctionedReset` uses to bypass the append-only seals, and for the same reason: the bypass is
 * the sanctioned path, and naming it is what keeps it visible.
 *
 * ONE transaction, so a throwing insert rolls the DISABLE back with it and no failure path can
 * leave the seal off. Guarded on the trigger's existence, because a suite may run against a
 * database migrated to an earlier point.
 *
 * Use this ONLY for rows standing in for history. A revision that is meant to be the product of
 * an approval should go through `decisions.approve`, which now writes its own provenance.
 */
export async function plantLegacyApprovalRevision(
  prisma: PrismaService,
  data: { id: string; projectId: string; decisionId: string; version: number; optionKey: string; approvedById?: string | null; onBehalfOf?: string | null },
): Promise<void> {
  const toggle = (action: 'DISABLE' | 'ENABLE'): string =>
    `DO $do$ BEGIN IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'DecisionApprovalRevision_t4c_provenance') THEN `
    + `EXECUTE 'ALTER TABLE "DecisionApprovalRevision" ${action} TRIGGER "DecisionApprovalRevision_t4c_provenance"'; END IF; END $do$`;
  await prisma.$transaction([
    prisma.$executeRawUnsafe(toggle('DISABLE')),
    prisma.decisionApprovalRevision.create({
      data: {
        id: data.id, projectId: data.projectId, decisionId: data.decisionId, version: data.version,
        optionKey: data.optionKey, approvedAt: new Date(),
        approvedById: data.approvedById ?? null, onBehalfOf: data.onBehalfOf ?? null,
      },
    }),
    prisma.$executeRawUnsafe(toggle('ENABLE')),
  ]);
}

/**
 * Phase 6 unit 4d-i — plant a raw `DomainEvent` the way `emitEvent` does: allocate and insert in
 * ONE transaction.
 *
 * `DomainEvent_t4d_envelope` requires an event to sit at `ProjectEventStream.nextPosition - 1` of
 * a stream row THIS TRANSACTION moved (§A.2). That is the increment-then-insert protocol
 * `emitEvent` follows, and it is what makes allocations and events one-to-one: a writer that
 * skips the increment lands on `nextPosition` and is refused; one that increments once and
 * inserts twice has its second insert refused; and the deferred converse refuses an increment
 * whose position no event took.
 *
 * So a probe that needs a raw row cannot choose a position, and cannot allocate in one statement
 * and insert in another — the earlier version of this helper did exactly that, and it only ever
 * worked because the seal was not yet asking. `columns`/`values` are appended to the fixed
 * envelope so an arm can add `actorRole` or an explicit `eventId`.
 *
 * It also COPIES THE PERSISTED CATALOG'S INTENT for `effectKey` (§A.2 (b), the shape this
 * helper was specified with; #582 round 2, finding 1). The envelope seal now resolves
 * `dispatchIntent.(coverageVersion, effectKey)` in `ExternalEffectCatalog` and compares the
 * event type and the invalidation flag, so a plant with no intent is refused — correctly, and
 * for a reason that has nothing to do with what most arms are probing. The default key is
 * `decision.drafted`: it invalidates nothing, may not push and is not `pairingRequired`, so a
 * bare plant owes no push and no pairing claim. An arm that needs another key names it; an arm
 * that wants to probe the intent arm itself passes its own `"dispatchIntent"` column, which is
 * left untouched.
 *
 * Returns the position the plant consumed. A legacy-SHAPE plant — a pre-4d row that by
 * construction cannot satisfy these seals — uses `plantLegacyEvent` instead, which declares a
 * NAMED bypass.
 */
export async function insertRawEvent(
  prisma: PrismaService,
  spec: {
    projectId: string;
    organizationId: string;
    eventId: string;
    eventType?: string;
    entityType?: string;
    entityId?: string;
    /** the catalog key whose PERSISTED intent this plant copies. Defaults to `decision.drafted`
     *  — no invalidation, no push, no pairing claim owed. Ignored when the caller supplies its
     *  own `"dispatchIntent"` column. */
    effectKey?: string;
    /** extra column names, already quoted, e.g. `"actorRole"` */
    columns?: string[];
    /** matching SQL value expressions, e.g. `'pmc'` */
    values?: string[];
  },
): Promise<number> {
  const ownIntent = (spec.columns ?? []).some((c) => c.includes('dispatchIntent'));
  const effectKey = spec.effectKey ?? 'decision.drafted';
  const columns = [...(spec.columns ?? [])];
  const values = [...(spec.values ?? [])];
  return prisma.$transaction(async (tx) => {
    if (!ownIntent) {
      // THIS RELEASE's definition of the key, named by version rather than ranked (#582's review
      // round 8, finding 3). Two generations of every key now coexist from the moment 4d-i
      // commits — the one this source computes and the outgoing one a still-serving process
      // emits — so "pick a row for the key" is no longer a question with one answer. The previous
      // form ordered by `coverageVersion DESC` and called the winner the newest, but a coverage
      // version is a SHA-256: sorting it lexicographically ranks nothing, and the row it happened
      // to return was decided by which hash sorted higher. A plant stands in for a CURRENT
      // writer, so it names the version a current writer computes.
      const cat = await tx.$queryRawUnsafe<Array<{ coverageVersion: string; eventType: string; invalidate: boolean }>>(
        `SELECT "coverageVersion","eventType","invalidate" FROM "ExternalEffectCatalog"
          WHERE "effectKey" = $1 AND "coverageVersion" = $2 AND "retiredAt" IS NULL`,
        effectKey,
        effectCoverageVersion(),
      );
      const row = cat[0];
      if (!row) throw new Error(`insertRawEvent: no unretired ExternalEffectCatalog row for '${effectKey}' at coverage ${effectCoverageVersion()}`);
      columns.push('"dispatchIntent"');
      values.push(
        `'${JSON.stringify({ effectKey, coverageVersion: row.coverageVersion, invalidate: row.invalidate })}'::jsonb`,
      );
      // the seal requires the event's type to equal the catalog row's, so the plant takes it
      // from the row rather than from a caller that did not name one.
      spec = { ...spec, eventType: spec.eventType ?? row.eventType };
    }
    const cols = columns.length > 0 ? `,${columns.join(',')}` : '';
    const vals = values.length > 0 ? `,${values.join(',')}` : '';
    const rows = await tx.$queryRawUnsafe<Array<{ at: bigint }>>(
      `UPDATE "ProjectEventStream" SET "nextPosition" = "nextPosition" + 1
        WHERE "projectId" = $1 RETURNING "nextPosition" - 1 AS "at"`,
      spec.projectId,
    );
    const at = Number(rows[0]!.at);
    await tx.$executeRawUnsafe(
      `INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","actorKind","systemActor","entityType","entityId"${cols})`
      + ` VALUES ('${spec.eventId}','${spec.eventType ?? 'x'}',1,'${spec.organizationId}','${spec.projectId}',${at},'system','system:seed','${spec.entityType ?? 'Decision'}','${spec.entityId ?? 'x'}'${vals})`,
    );
    return at;
  });
}

/**
 * Phase 6 unit 4d-i — the NAMED BYPASS for a LEGACY-SHAPE raw event plant.
 *
 * Some probes need a position that is part of the sentence: a pre-cutover row that must sit
 * BEFORE a later one, two deliveries whose relative order is the whole point. Those cannot take
 * whatever the allocator hands out, and by construction they are pre-4d shapes the 4d seals are
 * right to refuse. So they declare themselves BY NAME for exactly the plant.
 *
 * FOUR names, because the allocator is now sealed as a whole (§A.2): the envelope seal would
 * refuse the chosen position, the pairing seal would demand a claim, and moving the counter past
 * the plant afterwards would trip BOTH allocator arms — `_t4d_allocation` admits only `+1`, and
 * `_t4d_allocation_bound` requires every increment to carry its own event. A legacy plant has
 * neither, so the counter is set directly, inside the same bypass, and every seal goes back on in
 * `finally`. The same contract `scripts/upgrade-proof.sh` uses for its legacy plants.
 *
 * Guarded on the triggers' existence, because a suite may run against an earlier migration point.
 */
export async function plantLegacyEvent<T>(
  prisma: PrismaService,
  projectId: string,
  highestPosition: number,
  plant: () => Promise<T>,
): Promise<T> {
  const NAMES: Array<[table: string, trigger: string]> = [
    ['DomainEvent', 'DomainEvent_t4d_envelope'],
    ['DomainEvent', 'DomainEvent_t4d_pairing_claimed'],
    ['ProjectEventStream', 'ProjectEventStream_t4d_allocation'],
    ['ProjectEventStream', 'ProjectEventStream_t4d_allocation_bound'],
  ];
  const toggle = (action: 'DISABLE' | 'ENABLE'): string =>
    'DO $do$ BEGIN '
    + NAMES.map(([table, trigger]) =>
        `IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = '${trigger}') THEN `
        + `EXECUTE 'ALTER TABLE "${table}" ${action} TRIGGER "${trigger}"'; END IF; `).join('')
    + 'END $do$';
  await prisma.$executeRawUnsafe(toggle('DISABLE'));
  try {
    const out = await plant();
    // the counter is set PAST the hand-chosen positions, so the allocator is never left behind its
    // own stream once the seals go back on. Conditional: a counter already ahead is left alone.
    await prisma.$executeRawUnsafe(
      `UPDATE "ProjectEventStream" SET "nextPosition" = $2::bigint + 1
        WHERE "projectId" = $1 AND "nextPosition" < $2::bigint + 1`,
      projectId,
      highestPosition,
    );
    return out;
  } finally {
    await prisma.$executeRawUnsafe(toggle('ENABLE'));
  }
}

/**
 * Phase 6 unit 4d-i — run a HISTORICAL decision plant with the correspondence seal named off.
 *
 * `DecisionEvent_t4d_correspondence` is the WEAK converse of §A.3 obligation 7: an `approved`
 * audit row on a decision that COMMITTED `approved` owes a `decision.approved` event in the same
 * transaction. Every delivered writer satisfies it — `decisions.approve` inserts the audit row
 * and emits in one transaction. A FIXTURE that fabricates an already-approved decision does not,
 * and cannot: it is standing in for an approval that happened before this database existed, and
 * the trigger is right to refuse it, because it cannot tell a simulated import from a forgery.
 *
 * So the fixture declares itself, by name, for exactly that plant — the same contract
 * `plantLegacyApprovalRevision` and `sanctionedReset` use, and for the same reason: the bypass is
 * the sanctioned path, and naming it is what keeps it visible.
 *
 * The seal is DEFERRED, so the disable must be COMMITTED before the plant's own transaction
 * opens (a trigger disabled at INSERT time queues no commit-time firing). It is re-enabled in
 * `finally`, so no failing plant leaves the seal off for a later probe. Guarded on the trigger's
 * existence, because a suite may run against a database migrated to an earlier point.
 */
export async function plantLegacyDecisionAudit<T>(
  prisma: PrismaService,
  plant: () => Promise<T>,
): Promise<T> {
  const toggle = (action: 'DISABLE' | 'ENABLE'): string =>
    `DO $do$ BEGIN IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'DecisionEvent_t4d_correspondence') THEN `
    + `EXECUTE 'ALTER TABLE "DecisionEvent" ${action} TRIGGER "DecisionEvent_t4d_correspondence"'; END IF; END $do$`;
  await prisma.$executeRawUnsafe(toggle('DISABLE'));
  try {
    return await plant();
  } finally {
    await prisma.$executeRawUnsafe(toggle('ENABLE'));
  }
}
