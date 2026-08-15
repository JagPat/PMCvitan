import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../../src/prisma.service';

export interface TwoProjectFixture {
  orgA: { id: string };
  orgB: { id: string };
  projectA: { id: string };
  projectB: { id: string };
  /** active pmc membership on projectA */
  memberUser: { id: string };
  /** active CLIENT membership on projectA — Phase 6 task 4b (see below) */
  clientUser: { id: string };
  /** active CLIENT membership on projectB */
  otherClientUser: { id: string };
  /** owner of orgA with NO project membership (super-admin path) */
  ownerUser: { id: string };
  /** active pmc membership on projectB (the other tenant) */
  otherUser: { id: string };
  /** no memberships anywhere */
  strangerUser: { id: string };
  cleanup: () => Promise<void>;
}

/**
 * Two isolated organizations, each with one project, plus six users with
 * deterministic memberships — the minimum world in which tenant isolation
 * and live access can be PROVEN rather than assumed. Every id is unique per
 * run so suites can never collide with each other or with leftover rows.
 *
 * Phase 6 task 4b: each project also carries an ACTIVE CLIENT. A decision's default decider is
 * the client, and `Decision_t4b_publication_seal` refuses publishing into a project with no
 * active one — it would birth the holderless state the removal guard exists to prevent. A
 * clientless project is not a smaller world, it is an IMPOSSIBLE one, and eighteen suites were
 * publishing decisions into it. The client belongs in the minimum world, not in eighteen copies
 * of a per-suite workaround.
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
  const clientUser = await prisma.user.create({ data: { ...user('client'), role: 'client' } });
  const otherClientUser = await prisma.user.create({ data: { ...user('otherclient'), projectId: projectB.id, role: 'client' } });

  await prisma.membership.create({ data: { projectId: projectA.id, userId: memberUser.id, role: 'pmc', status: 'active' } });
  await prisma.membership.create({ data: { projectId: projectB.id, userId: otherUser.id, role: 'pmc', status: 'active' } });
  await prisma.membership.create({ data: { projectId: projectA.id, userId: clientUser.id, role: 'client', status: 'active' } });
  await prisma.membership.create({ data: { projectId: projectB.id, userId: otherClientUser.id, role: 'client', status: 'active' } });
  await prisma.orgMembership.create({ data: { orgId: orgA.id, userId: ownerUser.id, role: 'owner' } });

  const cleanup = async (): Promise<void> => {
    // DomainEvent is append-only (a BEFORE UPDATE OR DELETE trigger blocks row deletes) and its
    // tenant FK is ON DELETE RESTRICT, so a project carrying events cannot be deleted until its
    // events are cleared. TRUNCATE fires no row trigger, so it is the sanctioned reset for the
    // disposable test DB (the suites run serially and share one database). Production never does
    // this — events are immutable there. ProjectEventStream cascades with the project delete.
    // OutboxDelivery (Task 6) FK-references DomainEvent, so truncate them together; ProcessedEvent
    // and ProjectionCursor carry no FK but are cleared for a clean per-suite slate.
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor" CASCADE');
    // Phase 6 task 4b — the DECISION wipe runs BEFORE the membership wipe below, the same
    // ordering lesson `prisma/seed.ts` learned at 4a round 5 and which 4b extends: a membership
    // that HOLDS a published open decision cannot be removed (`Membership_t4b_holder_seal`), so a
    // project still carrying decisions would refuse its own teardown.
    //
    // It is CONDITIONAL, and that is load-bearing rather than an optimisation. `wipeDecisions`
    // disables named triggers, and `ALTER TABLE` takes an ACCESS EXCLUSIVE lock on all three
    // decision tables — in a suite that still holds a concurrent session reading them (the §I
    // certification races keep a second client open), an unconditional exclusive lock in every
    // teardown DEADLOCKS against it. Most suites own no decisions by this point, so the common
    // path never takes the lock at all.
    if (await prisma.decision.count({ where: { projectId: { in: [projectA.id, projectB.id] } } })) {
      await wipeDecisions(prisma, { projectId: { in: [projectA.id, projectB.id] } });
      await prisma.decisionApprovalRevision.deleteMany({ where: { projectId: { in: [projectA.id, projectB.id] } } });
    }
    // reverse foreign-key order, one transaction — a failed test never strands rows
    await prisma.$transaction([
      // command-idempotency receipts (Phase 2 Task 5) reference the project/org tenant; clear
      // them before the project/org rows they hang off (their tenant FK is ON DELETE CASCADE,
      // but an explicit delete keeps the disposable test DB tidy for cross-suite reuse).
      prisma.commandExecution.deleteMany({ where: { OR: [{ projectId: { in: [projectA.id, projectB.id] } }, { organizationId: { in: [orgA.id, orgB.id] } }] } }),
      prisma.securityAuditEvent.deleteMany({ where: { targetUserId: { in: [memberUser.id, ownerUser.id, otherUser.id, strangerUser.id, clientUser.id, otherClientUser.id] } } }),
      prisma.passwordCredentialChallenge.deleteMany({ where: { userId: { in: [memberUser.id, ownerUser.id, otherUser.id, strangerUser.id, clientUser.id, otherClientUser.id] } } }),
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
      prisma.user.deleteMany({ where: { id: { in: [memberUser.id, ownerUser.id, otherUser.id, strangerUser.id, clientUser.id, otherClientUser.id] } } }),
      prisma.projectNode.deleteMany({ where: { projectId: { in: [projectA.id, projectB.id] } } }),
      prisma.project.deleteMany({ where: { id: { in: [projectA.id, projectB.id] } } }),
      prisma.templateModule.deleteMany({ where: { orgId: { in: [orgA.id, orgB.id] } } }),
      prisma.projectTemplate.deleteMany({ where: { orgId: { in: [orgA.id, orgB.id] } } }),
      prisma.org.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } }),
    ]);
  };

  return { orgA, orgB, projectA, projectB, memberUser, clientUser, otherClientUser, ownerUser, otherUser, strangerUser, cleanup };
}

/**
 * Phase 6 task 4b — give an AD-HOC project its client.
 *
 * `createTwoProjectFixture` seeds one for each of its two projects, but many suites build their
 * own throwaway project and then publish a decision into it. A decision's default decider is the
 * client, and `Decision_t4b_publication_seal` refuses publishing into a project with no active
 * one.
 *
 * This adds a MEMBERSHIP only — standing is what the seal reads, and a person holding a client
 * membership on one project and the same role elsewhere is an ordinary multi-project human (and
 * `Membership` is unique per (project, user), so it must be a DIFFERENT person from the caller's
 * pmc — `f.clientUser` is the natural one). It
 * deliberately mints no `User` row: those carry a project FK, so a new one would have to be torn
 * down before the project in every caller's teardown, and this way every existing teardown that
 * clears memberships already covers it.
 */
export async function seedProjectClient(prisma: PrismaService, projectId: string, userId: string): Promise<void> {
  await prisma.membership.create({ data: { projectId, userId, role: 'client', status: 'active' } });
}

/**
 * Phase 6 task 4b — the sanctioned destructive reset for DECISION rows.
 *
 * A published decision's options are frozen (`DecisionOption_t4b_published_frozen`), a withdrawn
 * decision is a permanent register entry (`Decision_t4a_d_no_delete`), its options are part of the
 * frozen question (`DecisionOption_t4a_frozen`), and its approval events are undeletable evidence
 * (`DecisionEvent_no_withdrawn_approval`). All four are correct in production and all four stand
 * between a test suite and a clean slate, so this helper disables exactly those NAMED seals for
 * exactly this wipe — the same contract as {@link wipeDecisionEvents} and the DomainEvent TRUNCATE.
 *
 * Callers pass the decision `where` they already used, so the wipe stays scoped to their own rows.
 */
export async function wipeDecisions(prisma: PrismaService, where: Record<string, unknown>): Promise<void> {
  const seals: Array<[string, string]> = [
    ['DecisionOption', 'DecisionOption_t4a_frozen'],
    ['DecisionOption', 'DecisionOption_t4b_published_frozen'],
    ['Decision', 'Decision_t4a_d_no_delete'],
    ['DecisionEvent', 'DecisionEvent_no_withdrawn_approval'],
  ];
  for (const [table, trigger] of seals) {
    await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"`);
  }
  try {
    await prisma.decisionEvent.deleteMany({ where: { decision: where } });
    await prisma.decisionOption.deleteMany({ where: { decision: where } });
    await prisma.changeRequest.deleteMany({ where: { decision: where } });
    await prisma.decision.deleteMany({ where });
  } finally {
    for (const [table, trigger] of [...seals].reverse()) {
      await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER "${trigger}"`);
    }
  }
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
