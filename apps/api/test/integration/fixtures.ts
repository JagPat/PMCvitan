import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../../src/prisma.service';

import { sanctionedReset } from '../../prisma/sanctioned-reset';
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
  await prisma.$executeRawUnsafe('ALTER TABLE "DecisionEvent" DISABLE TRIGGER "DecisionEvent_no_withdrawn_approval"');
  try {
    await prisma.decisionEvent.deleteMany({ where });
  } finally {
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
  await wipeDecisionsVia(prisma, (tx) => tx.decision.deleteMany({ where }));
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
