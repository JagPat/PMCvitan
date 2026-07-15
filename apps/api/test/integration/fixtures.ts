import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../../src/prisma.service';

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

  await prisma.membership.create({ data: { projectId: projectA.id, userId: memberUser.id, role: 'pmc', status: 'active' } });
  await prisma.membership.create({ data: { projectId: projectB.id, userId: otherUser.id, role: 'pmc', status: 'active' } });
  await prisma.orgMembership.create({ data: { orgId: orgA.id, userId: ownerUser.id, role: 'owner' } });

  const cleanup = async (): Promise<void> => {
    // DomainEvent is append-only (a BEFORE UPDATE OR DELETE trigger blocks row deletes) and its
    // tenant FK is ON DELETE RESTRICT, so a project carrying events cannot be deleted until its
    // events are cleared. TRUNCATE fires no row trigger, so it is the sanctioned reset for the
    // disposable test DB (the suites run serially and share one database). Production never does
    // this — events are immutable there. ProjectEventStream cascades with the project delete.
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "DomainEvent"');
    // reverse foreign-key order, one transaction — a failed test never strands rows
    await prisma.$transaction([
      // command-idempotency receipts (Phase 2 Task 5) reference the project/org tenant; clear
      // them before the project/org rows they hang off (their tenant FK is ON DELETE CASCADE,
      // but an explicit delete keeps the disposable test DB tidy for cross-suite reuse).
      prisma.commandExecution.deleteMany({ where: { OR: [{ projectId: { in: [projectA.id, projectB.id] } }, { organizationId: { in: [orgA.id, orgB.id] } }] } }),
      prisma.securityAuditEvent.deleteMany({ where: { targetUserId: { in: [memberUser.id, ownerUser.id, otherUser.id, strangerUser.id] } } }),
      prisma.passwordCredentialChallenge.deleteMany({ where: { userId: { in: [memberUser.id, ownerUser.id, otherUser.id, strangerUser.id] } } }),
      prisma.auditLog.deleteMany({ where: { projectId: { in: [projectA.id, projectB.id] } } }),
      prisma.notification.deleteMany({ where: { projectId: { in: [projectA.id, projectB.id] } } }),
      prisma.membership.deleteMany({ where: { projectId: { in: [projectA.id, projectB.id] } } }),
      prisma.orgMembership.deleteMany({ where: { orgId: { in: [orgA.id, orgB.id] } } }),
      prisma.user.deleteMany({ where: { id: { in: [memberUser.id, ownerUser.id, otherUser.id, strangerUser.id] } } }),
      prisma.projectNode.deleteMany({ where: { projectId: { in: [projectA.id, projectB.id] } } }),
      prisma.project.deleteMany({ where: { id: { in: [projectA.id, projectB.id] } } }),
      prisma.templateModule.deleteMany({ where: { orgId: { in: [orgA.id, orgB.id] } } }),
      prisma.projectTemplate.deleteMany({ where: { orgId: { in: [orgA.id, orgB.id] } } }),
      prisma.org.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } }),
    ]);
  };

  return { orgA, orgB, projectA, projectB, memberUser, ownerUser, otherUser, strangerUser, cleanup };
}
