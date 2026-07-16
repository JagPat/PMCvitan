import { afterEach, describe, it, expect, vi } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { OrgsService } from './orgs.service';
import { NodeInitParticipant } from '../nodes/node-init.participant';
import { ActivityParticipant } from '../activities/activity.participant';
import { InspectionParticipant } from '../inspections/inspection.participant';
import type { PrismaService } from '../prisma.service';
import { Prisma } from '@prisma/client';
import { registerConsumer, unregisterConsumer } from '../platform/outbox/registry';

const PROJECT_INIT_TEST_CONSUMER = 'project-init.unit-test';

afterEach(() => unregisterConsumer(PROJECT_INIT_TEST_CONSUMER));

/** Task 7 — the project-init participants are leaf providers (no deps); a fresh instance
 *  per construction lets these unit tests drive createProject through the same mock tx. */
const initParticipants = () => [new NodeInitParticipant(), new ActivityParticipant(), new InspectionParticipant()] as const;

function makeAtomicProjectInit(throwFromInspection = false) {
  const created = {
    projects: [] as Record<string, unknown>[],
    memberships: [] as Record<string, unknown>[],
    streams: [] as Record<string, unknown>[],
    events: [] as Record<string, unknown>[],
    deliveries: [] as Record<string, unknown>[],
    nodes: [] as Record<string, unknown>[],
    phases: [] as Record<string, unknown>[],
    activities: [] as Record<string, unknown>[],
    inspections: [] as Record<string, unknown>[],
  };
  const sourceProject = { id: 'ambli', orgId: 'org1', archivedAt: null };
  const sourceNodes = [{ id: 'z1', projectId: 'ambli', parentId: null, name: 'Ground Floor', kind: 'zone', order: 0 }];
  const sourcePhases = [{ id: 'ph1', projectId: 'ambli', name: 'Structure', order: 1, plannedStart: 2, plannedEnd: 8 }];
  const sourceActivities = [{ id: 'ACT-31', projectId: 'ambli', name: 'Source work', zone: 'GF', plannedStart: 2, plannedEnd: 8, gateMaterial: 'ok', gateTeam: 'wait', gateInspection: 'na', phaseId: 'ph1', nodeId: 'z1', order: 0 }];
  const sourceInspections = [{ id: 'INSP-22', projectId: 'ambli', kind: 'checklist', title: 'Source QA', zone: 'GF', nodeId: 'z1', items: [{ name: 'Check', order: 0 }] }];
  const module = {
    id: 'mod-kitchen', orgId: 'org1', archivedAt: null, name: 'Kitchen', anchorKind: 'zone',
    payload: {
      nodes: [{ key: 'k', parentKey: null, name: 'Kitchen', kind: 'room', order: 0 }],
      phases: [{ name: 'Kitchen Fitout', order: 2, plannedStart: 9, plannedEnd: 12 }],
      activities: [{ name: 'Kitchen work', zone: 'GF', plannedStart: 9, plannedEnd: 12, nodeKey: 'k', phaseName: 'Kitchen Fitout', order: 1 }],
      inspections: [{ title: 'Kitchen QA', zone: 'GF', nodeKey: 'k', items: ['Kitchen check'] }],
    },
  };
  const explicitModule = {
    id: 'mod-bathroom', orgId: 'org1', archivedAt: null, name: 'Bathroom', anchorKind: 'zone',
    payload: {
      nodes: [{ key: 'b', parentKey: null, name: 'Bathroom', kind: 'room', order: 1 }],
      phases: [{ name: 'Bathroom Fitout', order: 3, plannedStart: 13, plannedEnd: 16 }],
      activities: [{ name: 'Bathroom work', zone: 'GF', plannedStart: 13, plannedEnd: 16, nodeKey: 'b', phaseName: 'Bathroom Fitout', order: 2 }],
      inspections: [{ title: 'Bathroom QA', zone: 'GF', nodeKey: 'b', items: ['Bathroom check'] }],
    },
  };
  const modules = [module, explicitModule];
  const template = { id: 'tpl-house', orgId: 'org1', archivedAt: null, items: [{ moduleId: 'mod-kitchen', count: 1, underZone: 'Ground Floor' }] };
  let rowId = 0;

  const tx = {
    $executeRaw: vi.fn(async () => 0),
    project: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => where.id === 'ambli' ? sourceProject : null),
      findUniqueOrThrow: vi.fn(async () => ({ orgId: 'org1', scheduleStartDate: new Date('2026-07-03T00:00:00.000Z') })),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.projects.push(data);
        created.streams.push({ projectId: data.id });
        return data;
      }),
    },
    membership: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { created.memberships.push(data); return data; }) },
    projectEventStream: { update: vi.fn(async () => ({ nextPosition: 1n })) },
    domainEvent: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { const row = { eventId: 'evt-test', ...data }; created.events.push(row); return row; }) },
    outboxDelivery: {
      createMany: vi.fn(async ({ data }: { data: Record<string, unknown>[] }) => {
        created.deliveries.push(...data);
        return { count: data.length };
      }),
    },
    projectTemplate: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => where.id === template.id ? template : null) },
    templateModule: {
      findMany: vi.fn(async () => modules),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => modules.find((candidate) => candidate.id === where.id) ?? null),
    },
    projectNode: {
      findMany: vi.fn(async ({ where }: { where: { projectId: string } }) => where.projectId === 'ambli' ? sourceNodes : created.nodes),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { const row = { id: `node-${++rowId}`, ...data }; created.nodes.push(row); return row; }),
    },
    phase: {
      findMany: vi.fn(async () => sourcePhases),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { const row = { id: `phase-${++rowId}`, ...data }; created.phases.push(row); return row; }),
    },
    activity: {
      findMany: vi.fn(async ({ where }: { where?: { projectId?: string } } = {}) => where?.projectId === 'ambli' ? sourceActivities : [{ id: 'ACT-40' }]),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { created.activities.push(data); return data; }),
    },
    inspection: {
      findMany: vi.fn(async ({ where }: { where?: { projectId?: string } } = {}) => where?.projectId === 'ambli' ? sourceInspections : [{ id: 'INSP-22' }]),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { created.inspections.push(data); return data; }),
    },
  };

  const topLevel = {
    project: {
      findUnique: vi.fn(async () => sourceProject),
      findUniqueOrThrow: vi.fn(async () => ({ orgId: 'org1' })),
    },
    projectTemplate: { findUnique: vi.fn(async () => template) },
    templateModule: {
      findMany: vi.fn(async () => modules),
      findUnique: vi.fn(async () => module),
    },
    projectNode: { findMany: vi.fn(async () => sourceNodes) },
    phase: { findMany: vi.fn(async () => sourcePhases) },
    activity: { findMany: vi.fn(async () => sourceActivities) },
    inspection: { findMany: vi.fn(async () => sourceInspections) },
  };
  const prisma = {
    orgMembership: { findUnique: vi.fn(async () => ({ role: 'owner' })) },
    user: { findUnique: vi.fn(async () => ({ name: 'Tester' })) },
    ...topLevel,
    $transaction: vi.fn(async (run: (client: typeof tx) => Promise<unknown>, options?: unknown) => {
      const lengths = Object.fromEntries(Object.entries(created).map(([key, rows]) => [key, rows.length]));
      try {
        return await run(tx);
      } catch (error) {
        for (const [key, rows] of Object.entries(created)) rows.length = lengths[key]!;
        throw error;
      }
    }),
  };
  const nodeInit = { createForInit: vi.fn((client, args) => client.projectNode.create(args)) };
  const activityInit = {
    createForInit: vi.fn((client, args) => client.activity.create(args)),
    createPhaseForInit: vi.fn((client, args) => client.phase.create(args)),
  };
  const inspectionInit = {
    createForInit: vi.fn(async (client, args) => {
      if (throwFromInspection) throw new Error('injected inspection failure');
      return client.inspection.create(args);
    }),
  };
  const svc = new OrgsService(
    prisma as unknown as PrismaService,
    { today: () => '2026-07-03' },
    nodeInit as unknown as NodeInitParticipant,
    activityInit as unknown as ActivityParticipant,
    inspectionInit as unknown as InspectionParticipant,
  );
  registerConsumer({
    name: PROJECT_INIT_TEST_CONSUMER,
    kind: 'unordered',
    effect: 'external',
    deliveryFor: () => ({}),
    handle: async () => undefined,
  });
  return {
    svc,
    prisma,
    tx,
    topLevel,
    created,
    sourcePhases,
    sourceActivities,
    module,
    participants: { nodeInit, activityInit, inspectionInit },
  };
}

function make(orgRole: string | null) {
  const projects: unknown[] = [];
  const memberships: unknown[] = [];
  const orgMemberships: unknown[] = [];
  const prisma = {
    orgMembership: {
      findUnique: vi.fn(async () => (orgRole ? { role: orgRole } : null)),
      create: vi.fn(async ({ data }: { data: unknown }) => { orgMemberships.push(data); return data; }),
      findMany: vi.fn(async () => []),
    },
    org: {
      create: vi.fn(async ({ data }: { data: { name: string; slug: string } }) => ({ id: 'org1', ...data })),
      findUnique: vi.fn(async () => ({ id: 'org1', projects })),
    },
    project: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { projects.push(data); return data; }),
      findUnique: vi.fn(async () => ({ orgId: 'org1' })),
      findUniqueOrThrow: vi.fn(async () => ({ orgId: 'org1', timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') })),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => ({ id: where.id, ...data })),
    },
    membership: {
      create: vi.fn(async ({ data }: { data: unknown }) => { memberships.push(data); return data; }),
      findUnique: vi.fn(async () => null as { role: string; status: string } | null),
    },
    // resolveActor (Task 3) + the platform event kernel (Task 4) now run inside these mutations
    user: { findUnique: vi.fn(async () => ({ name: 'Tester' })) },
    projectEventStream: { update: vi.fn(async () => ({ nextPosition: 1n })) },
    domainEvent: { create: vi.fn(async () => ({ eventId: 'evt-test' })) },
    activity: { findMany: vi.fn(async () => []) },
    inspection: { findMany: vi.fn(async () => []) },
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(async (arg: unknown) =>
      typeof arg === 'function' ? (arg as (tx: unknown) => Promise<unknown>)(prisma) : Promise.all(arg as Promise<unknown>[])),
  };
  const svc = new OrgsService(prisma as unknown as PrismaService, { today: () => '2026-07-03' }, ...initParticipants());
  return { svc, prisma, projects, memberships, orgMemberships };
}

describe('OrgsService.createProject', () => {
  it('lets an org owner create a project and enrols them as PMC', async () => {
    const { svc, projects, memberships } = make('owner');
    const p = await svc.createProject('org1', 'u1', { name: 'Villa at Satellite', short: 'Satellite Villa', descriptor: '', stage: 'Planning', siteCode: '', projStart: '', projEnd: '' });
    expect(p.short).toBe('Satellite Villa');
    expect(projects).toHaveLength(1);
    expect((memberships[0] as { role: string; userId: string }).role).toBe('pmc');
    expect((memberships[0] as { userId: string }).userId).toBe('u1');
  });

  it('forbids a non-admin (plain member) from creating a project', async () => {
    const { svc, projects } = make('member');
    await expect(
      svc.createProject('org1', 'u2', { name: 'X', short: 'X', descriptor: '', stage: 'Planning', siteCode: '', projStart: '', projEnd: '' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(projects).toHaveLength(0);
  });

  it('forbids a non-member entirely', async () => {
    const { svc } = make(null);
    await expect(
      svc.createProject('org1', 'stranger', { name: 'X', short: 'X', descriptor: '', stage: 'Planning', siteCode: '', projStart: '', projEnd: '' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('uses one Serializable transaction for every initialization read and participant write', async () => {
    const { svc, prisma, tx, topLevel, participants } = makeAtomicProjectInit();

    await svc.createProject('org1', 'u1', {
      name: 'Atomic Villa', short: 'Atomic Villa', descriptor: '', stage: 'Planning', siteCode: '', projStart: '', projEnd: '',
      structureFrom: 'ambli', templateId: 'tpl-house',
      modules: [{ moduleId: 'mod-bathroom', count: 1, underZone: 'Ground Floor' }],
    } as never);

    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(prisma.$transaction.mock.calls[0]![1]).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    for (const delegate of Object.values(topLevel)) {
      for (const method of Object.values(delegate)) expect(method).not.toHaveBeenCalled();
    }
    const requiredReadsAndLocks = [
      tx.project.findUnique,
      tx.projectTemplate.findUnique,
      tx.templateModule.findMany,
      tx.projectNode.findMany,
      tx.phase.findMany,
      tx.activity.findMany,
      tx.inspection.findMany,
      tx.$executeRaw,
    ];
    for (const readOrLock of requiredReadsAndLocks) expect(readOrLock).toHaveBeenCalled();
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(tx.activity.findMany).toHaveBeenCalledTimes(2);
    expect(tx.inspection.findMany).toHaveBeenCalledTimes(2);
    const projectWriteOrder = tx.project.create.mock.invocationCallOrder[0]!;
    for (const readOrLock of requiredReadsAndLocks) {
      expect(Math.max(...readOrLock.mock.invocationCallOrder)).toBeLessThan(projectWriteOrder);
    }
    for (const participant of [participants.nodeInit, participants.activityInit, participants.inspectionInit]) {
      for (const method of Object.values(participant)) {
        expect(method).toHaveBeenCalled();
        for (const call of method.mock.calls) expect(call[0]).toBe(tx);
      }
    }
  });

  it('writes the complete source, template, and explicit-module union exactly once', async () => {
    const { svc, created } = makeAtomicProjectInit();

    await svc.createProject('org1', 'u1', {
      name: 'Union Villa', short: 'Union Villa', descriptor: '', stage: 'Planning', siteCode: '', projStart: '', projEnd: '',
      structureFrom: 'ambli', templateId: 'tpl-house',
      modules: [{ moduleId: 'mod-bathroom', count: 1, underZone: 'Ground Floor' }],
    } as never);

    const exactlyOnce = (rows: Record<string, unknown>[], field: string, expected: string[]) => {
      expect(rows.map((row) => row[field])).toEqual(expected);
      expect(new Set(rows.map((row) => row[field])).size).toBe(expected.length);
    };
    exactlyOnce(created.nodes, 'name', ['Ground Floor', 'Kitchen', 'Bathroom']);
    exactlyOnce(created.phases, 'name', ['Structure', 'Kitchen Fitout', 'Bathroom Fitout']);
    exactlyOnce(created.activities, 'name', ['Source work', 'Kitchen work', 'Bathroom work']);
    exactlyOnce(created.inspections, 'title', ['Source QA', 'Kitchen QA', 'Bathroom QA']);
    expect(created.deliveries).toHaveLength(1);
    expect(created.deliveries[0]).toMatchObject({ consumer: PROJECT_INIT_TEST_CONSUMER });
  });

  it('preserves duplicate normalized source phases and each activity phase attachment by source phase ID', async () => {
    const { svc, sourcePhases, sourceActivities, created } = makeAtomicProjectInit();
    sourcePhases.push({ id: 'ph2', projectId: 'ambli', name: ' structure ', order: 2, plannedStart: 9, plannedEnd: 14 });
    sourceActivities.push({
      id: 'ACT-32', projectId: 'ambli', name: 'Second source work', zone: 'GF', plannedStart: 9, plannedEnd: 14,
      gateMaterial: 'wait', gateTeam: 'na', gateInspection: 'ok', phaseId: 'ph2', nodeId: 'z1', order: 1,
    });

    await svc.createProject('org1', 'u1', {
      name: 'Duplicate Phase Villa', short: 'Duplicate Phase Villa', descriptor: '', stage: 'Planning', siteCode: '', projStart: '', projEnd: '',
      structureFrom: 'ambli',
    } as never);

    expect(created.phases.map((phase) => phase.name)).toEqual(['Structure', ' structure ']);
    const phaseIds = created.phases.map((phase) => phase.id);
    expect(phaseIds[0]).not.toBe(phaseIds[1]);
    expect(created.activities.map((activity) => activity.phaseId)).toEqual(phaseIds);
  });

  it('coalesces a module phase to the first exact matching source phase definition', async () => {
    const { svc, module, created } = makeAtomicProjectInit();
    module.payload.phases[0] = { name: ' structure ', order: 1, plannedStart: 2, plannedEnd: 8 };
    module.payload.activities[0]!.phaseName = ' structure ';

    await svc.createProject('org1', 'u1', {
      name: 'Coalesced Phase Villa', short: 'Coalesced Phase Villa', descriptor: '', stage: 'Planning', siteCode: '', projStart: '', projEnd: '',
      structureFrom: 'ambli', templateId: 'tpl-house',
    } as never);

    expect(created.phases.map((phase) => phase.name)).toEqual(['Structure']);
    expect(created.activities.map((activity) => activity.phaseId)).toEqual([created.phases[0]!.id, created.phases[0]!.id]);
  });

  it('rejects a module phase when source phases share its normalized name but none match its definition', async () => {
    const { svc, module, created } = makeAtomicProjectInit();
    module.payload.phases[0] = { name: ' structure ', order: 9, plannedStart: 20, plannedEnd: 30 };
    module.payload.activities[0]!.phaseName = ' structure ';

    await expect(svc.createProject('org1', 'u1', {
      name: 'Conflicting Phase Villa', short: 'Conflicting Phase Villa', descriptor: '', stage: 'Planning', siteCode: '', projStart: '', projEnd: '',
      structureFrom: 'ambli', templateId: 'tpl-house',
    } as never)).rejects.toBeInstanceOf(BadRequestException);

    for (const rows of Object.values(created)) expect(rows).toHaveLength(0);
  });

  it('rolls back the project and every initialized collection when a participant throws after a node write', async () => {
    const { svc, created } = makeAtomicProjectInit(true);
    const originalLengths = Object.fromEntries(Object.entries(created).map(([key, rows]) => [key, rows.length]));

    await expect(svc.createProject('org1', 'u1', {
      name: 'Rollback Villa', short: 'Rollback Villa', descriptor: '', stage: 'Planning', siteCode: '', projStart: '', projEnd: '',
      structureFrom: 'ambli', templateId: 'tpl-house',
    } as never)).rejects.toThrow('injected inspection failure');

    for (const [key, rows] of Object.entries(created)) expect(rows).toHaveLength(originalLengths[key]!);
  });
});

describe('OrgsService.updateProject', () => {
  it('lets an org owner edit a project (only provided fields)', async () => {
    const { svc, prisma } = make('owner');
    const res = await svc.updateProject('org1', 'u1', 'villa', { name: 'Villa Renamed', stage: 'Structure' });
    expect(res.name).toBe('Villa Renamed');
    const call = prisma.project.update.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(call.data).toEqual({ name: 'Villa Renamed', stage: 'Structure' });
  });

  it('lets the project PMC edit even if not an org admin', async () => {
    const { svc, prisma } = make(null); // not an org member
    prisma.membership.findUnique.mockResolvedValueOnce({ role: 'pmc', status: 'active' });
    const res = await svc.updateProject('org1', 'pmcUser', 'villa', { stage: 'Finishing' });
    expect(res).toBeDefined();
    expect(prisma.project.update).toHaveBeenCalled();
  });

  it('forbids a non-admin non-PMC from editing', async () => {
    const { svc, prisma } = make('member');
    prisma.membership.findUnique.mockResolvedValueOnce({ role: 'engineer', status: 'active' });
    await expect(svc.updateProject('org1', 'eng', 'villa', { name: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.project.update).not.toHaveBeenCalled();
  });
});

describe('OrgsService.deleteProject (archive)', () => {
  it('archives a project when the caller is an org owner/admin', async () => {
    const { svc, prisma } = make('owner');
    const res = await svc.deleteProject('org1', 'u1', 'villa');
    expect(res).toEqual({ ok: true });
    const call = prisma.project.update.mock.calls[0][0] as { data: { archivedAt: Date } };
    expect(call.data.archivedAt).toBeInstanceOf(Date);
  });

  it('forbids a plain org member from deleting a project', async () => {
    const { svc, prisma } = make('member');
    await expect(svc.deleteProject('org1', 'u2', 'villa')).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.project.update).not.toHaveBeenCalled();
  });

  it('refuses a project that is not in the org', async () => {
    const { svc, prisma } = make('owner');
    prisma.project.findUnique.mockResolvedValueOnce({ orgId: 'other-org' } as never);
    await expect(svc.deleteProject('org1', 'u1', 'villa')).rejects.toThrow();
  });
});

describe('OrgsService.createOrg', () => {
  it('creates an org and makes the caller its owner', async () => {
    const { svc, orgMemberships } = make(null);
    const org = await svc.createOrg('u1', { name: 'Studio Kaza' });
    expect(org.name).toBe('Studio Kaza');
    expect((orgMemberships[0] as { role: string; userId: string })).toMatchObject({ role: 'owner', userId: 'u1' });
  });
});

describe('OrgsService.addOrgMember', () => {
  function makeRoster(callerRole: string | null, existingUser: unknown = null, projects: unknown[] = [{ id: 'ambli' }]) {
    const created: unknown[] = [];
    const orgMemberships: unknown[] = [];
    const prisma = {
      orgMembership: {
        findUnique: vi.fn(async () => (callerRole ? { role: callerRole } : null)),
        upsert: vi.fn(async ({ create, update }: { create: { role: string }; update: { role: string } }) => {
          const row = existingUser ? { ...update, ...create } : create;
          orgMemberships.push(row);
          return row;
        }),
      },
      org: { findUnique: vi.fn(async () => ({ id: 'org1', projects })) },
      user: {
        findUnique: vi.fn(async () => existingUser),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const u = { id: 'newuser', ...data };
          created.push(u);
          return u;
        }),
      },
      membership: { create: vi.fn() }, // must NOT be called by addOrgMember (no phantom project grant)
    };
    return { svc: new OrgsService(prisma as unknown as PrismaService, { today: () => '2026-07-03' }, ...initParticipants()), prisma, created, orgMemberships };
  }

  it('lets an org owner add a new roster member with NO phantom project grant', async () => {
    const { svc, prisma, created } = makeRoster('owner');
    const res = await svc.addOrgMember('org1', 'owner1', { name: 'JP', email: 'jp@vitan.in', phone: '8320303515', role: 'owner' });
    expect(res).toMatchObject({ userId: 'newuser', name: 'JP', email: 'jp@vitan.in', phone: '8320303515', orgRole: 'owner' });
    // New account is homed on the org's first project only to satisfy the FK, with a
    // least-privilege dormant role and NO project membership — access comes from the
    // org role (super-admin reach), never a phantom PMC grant (ORG escalation fix).
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ projectId: 'ambli', role: 'contractor', phone: '8320303515' });
    expect(created[0].role).not.toBe('pmc');
    expect(prisma.membership.create).not.toHaveBeenCalled(); // no project membership minted
    expect(prisma.orgMembership.upsert).toHaveBeenCalled();
  });

  it('reuses an existing account (matched by email) instead of provisioning a new one', async () => {
    const existing = { id: 'u9', name: 'JP', email: 'jp@vitan.in', phone: '8320303515', projectId: 'ambli', role: 'pmc' };
    const { svc, prisma, created } = makeRoster('owner', existing);
    const res = await svc.addOrgMember('org1', 'owner1', { name: 'JP', email: 'jp@vitan.in', role: 'owner' });
    expect(res.userId).toBe('u9');
    expect(created).toHaveLength(0); // no new user
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('forbids a plain member from managing the roster', async () => {
    const { svc, prisma } = makeRoster('member');
    await expect(svc.addOrgMember('org1', 'u2', { name: 'X', email: 'x@vitan.in', role: 'admin' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('forbids an admin from managing the roster (owner is the sole gatekeeper)', async () => {
    const { svc, prisma } = makeRoster('admin');
    await expect(svc.addOrgMember('org1', 'admin1', { name: 'X', email: 'x@vitan.in', role: 'admin' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('refuses to add a member when the org has no active project to home them on', async () => {
    const { svc } = makeRoster('owner', null, []);
    await expect(svc.addOrgMember('org1', 'owner1', { name: 'X', email: 'x@vitan.in', role: 'admin' })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('OrgsService.updateOrgMemberRole / removeOrgMember', () => {
  // rows model the org's memberships; findUnique/count/update/delete key off userId.
  function makeManage(rows: Array<{ userId: string; role: string; name?: string }>) {
    const state = rows.map((r) => ({ ...r, name: r.name ?? r.userId }));
    const prisma = {
      orgMembership: {
        findUnique: vi.fn(async ({ where }: { where: { orgId_userId: { userId: string } } }) => {
          const r = state.find((x) => x.userId === where.orgId_userId.userId);
          return r ? { role: r.role, user: { name: r.name, email: null, phone: null } } : null;
        }),
        count: vi.fn(async () => state.filter((r) => r.role === 'owner').length),
        update: vi.fn(async ({ where, data }: { where: { orgId_userId: { userId: string } }; data: { role: string } }) => {
          const r = state.find((x) => x.userId === where.orgId_userId.userId)!;
          r.role = data.role;
          return { role: r.role };
        }),
        delete: vi.fn(async ({ where }: { where: { orgId_userId: { userId: string } } }) => {
          const i = state.findIndex((x) => x.userId === where.orgId_userId.userId);
          state.splice(i, 1);
          return {};
        }),
      },
    };
    return { svc: new OrgsService(prisma as unknown as PrismaService, { today: () => '2026-07-03' }, ...initParticipants()), prisma, state };
  }

  it('an owner changes an admin down to member', async () => {
    const { svc, state } = makeManage([{ userId: 'owner1', role: 'owner' }, { userId: 'u2', role: 'admin' }]);
    const res = await svc.updateOrgMemberRole('org1', 'owner1', 'u2', { role: 'member' });
    expect(res).toMatchObject({ userId: 'u2', orgRole: 'member' });
    expect(state.find((x) => x.userId === 'u2')!.role).toBe('member');
  });

  it('forbids a non-owner (admin) from changing roles', async () => {
    const { svc } = makeManage([{ userId: 'a1', role: 'admin' }, { userId: 'u2', role: 'member' }]);
    await expect(svc.updateOrgMemberRole('org1', 'a1', 'u2', { role: 'admin' })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses to demote the last owner', async () => {
    const { svc } = makeManage([{ userId: 'owner1', role: 'owner' }]);
    await expect(svc.updateOrgMemberRole('org1', 'owner1', 'owner1', { role: 'admin' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('demoting one of two owners is allowed', async () => {
    const { svc, state } = makeManage([{ userId: 'owner1', role: 'owner' }, { userId: 'owner2', role: 'owner' }]);
    await svc.updateOrgMemberRole('org1', 'owner1', 'owner2', { role: 'admin' });
    expect(state.find((x) => x.userId === 'owner2')!.role).toBe('admin');
  });

  it('404s changing a role for a non-member', async () => {
    const { svc } = makeManage([{ userId: 'owner1', role: 'owner' }]);
    await expect(svc.updateOrgMemberRole('org1', 'owner1', 'ghost', { role: 'admin' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('an owner removes a member', async () => {
    const { svc, state } = makeManage([{ userId: 'owner1', role: 'owner' }, { userId: 'u2', role: 'member' }]);
    const res = await svc.removeOrgMember('org1', 'owner1', 'u2');
    expect(res).toEqual({ ok: true });
    expect(state.some((x) => x.userId === 'u2')).toBe(false);
  });

  it('refuses self-removal', async () => {
    const { svc } = makeManage([{ userId: 'owner1', role: 'owner' }, { userId: 'owner2', role: 'owner' }]);
    await expect(svc.removeOrgMember('org1', 'owner1', 'owner1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('forbids a non-owner from removing anyone', async () => {
    const { svc } = makeManage([{ userId: 'a1', role: 'admin' }, { userId: 'u2', role: 'member' }]);
    await expect(svc.removeOrgMember('org1', 'a1', 'u2')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('OrgsService invitation-email correction', () => {
  function makeEmailCorrection(options: {
    callerRole?: string | null;
    targetExists?: boolean;
    passwordHash?: string | null;
    emailVerifiedAt?: Date | null;
    duplicateEmail?: boolean;
  } = {}) {
    const target = {
      id: 'target1',
      name: 'Site Engineer',
      email: 'wrong@vitan.in',
      phone: null,
      passwordHash: options.passwordHash ?? null,
      emailVerifiedAt: options.emailVerifiedAt ?? null,
    };
    const challenges: Array<{ userId: string; consumedAt: Date | null }> = [
      { userId: target.id, consumedAt: null },
    ];
    const audits: Array<Record<string, unknown>> = [];
    const prisma = {
      orgMembership: {
        findUnique: vi.fn(async ({ where }: { where: { orgId_userId: { userId: string } } }) => {
          if (where.orgId_userId.userId === 'caller1') return { role: options.callerRole ?? 'owner' };
          if (where.orgId_userId.userId === target.id && options.targetExists !== false) {
            return { role: 'member', user: target };
          }
          return null;
        }),
      },
      user: {
        update: vi.fn(async ({ data }: { data: { email: string } }) => {
          if (options.duplicateEmail) throw Object.assign(new Error('unique'), { code: 'P2002' });
          target.email = data.email;
          return target;
        }),
      },
      passwordCredentialChallenge: {
        updateMany: vi.fn(async ({ where, data }: { where: { userId: string; consumedAt: null }; data: { consumedAt: Date } }) => {
          let count = 0;
          for (const challenge of challenges) {
            if (challenge.userId === where.userId && challenge.consumedAt === null) {
              challenge.consumedAt = data.consumedAt;
              count += 1;
            }
          }
          return { count };
        }),
      },
      securityAuditEvent: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { audits.push(data); return data; }),
      },
      $executeRaw: vi.fn(async () => 1),
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    };
    const svc = new OrgsService(prisma as unknown as PrismaService, { today: () => '2026-07-03' }, ...initParticipants());
    return { svc, prisma, target, challenges, audits };
  }

  it.each(['owner', 'admin'])('%s may correct an unverified invitation email and consume old challenges', async (callerRole) => {
    const { svc, target, challenges, audits } = makeEmailCorrection({ callerRole });

    await expect(svc.correctInvitationEmail('org1', 'caller1', 'target1', { email: ' Correct@Vitan.in ' }))
      .resolves.toMatchObject({ email: 'correct@vitan.in', credentialState: 'not_set' });
    expect(target.email).toBe('correct@vitan.in');
    expect(challenges[0].consumedAt).toBeInstanceOf(Date);
    expect(audits).toEqual([expect.objectContaining({
      action: 'auth.invitation_email_changed',
      actorUserId: 'caller1',
      targetUserId: 'target1',
      actorKind: 'administrator',
    })]);
  });

  it('refuses plain members and users outside the org', async () => {
    const member = makeEmailCorrection({ callerRole: 'member' });
    await expect(member.svc.correctInvitationEmail('org1', 'caller1', 'target1', { email: 'new@vitan.in' }))
      .rejects.toBeInstanceOf(ForbiddenException);
    const foreign = makeEmailCorrection({ targetExists: false });
    await expect(foreign.svc.correctInvitationEmail('org1', 'caller1', 'target1', { email: 'new@vitan.in' }))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it.each([
    { passwordHash: 'bcrypt-hash', emailVerifiedAt: null },
    { passwordHash: null, emailVerifiedAt: new Date('2026-07-15T00:00:00Z') },
  ])('refuses correction after credential establishment %#', async (state) => {
    const { svc } = makeEmailCorrection(state);
    await expect(svc.correctInvitationEmail('org1', 'caller1', 'target1', { email: 'new@vitan.in' }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('returns a generic conflict when the corrected email is already used', async () => {
    const { svc } = makeEmailCorrection({ duplicateEmail: true });
    await expect(svc.correctInvitationEmail('org1', 'caller1', 'target1', { email: 'used@vitan.in' }))
      .rejects.toBeInstanceOf(ConflictException);
  });
});

describe('OrgsService.portfolio', () => {
  function makePortfolio(role: string, activityStatuses: string[], adminOrgs: Array<{ orgId: string }> = [], orgProjects: unknown[] = []) {
    const project = { id: 'ambli', name: 'Residence at Ambli', short: 'Ambli', stage: 'Finishing', milestonePct: 72, orgId: 'org1', org: { name: 'Vitan' } };
    const prisma = {
      membership: { findMany: vi.fn(async () => (role ? [{ project, role }] : [])) },
      user: { findUnique: vi.fn(async () => null) },
      orgMembership: { findMany: vi.fn(async () => adminOrgs) },
      project: { findMany: vi.fn(async () => orgProjects) },
      activity: { findMany: vi.fn(async () => activityStatuses.map((status) => ({ status }))) },
      inspection: { count: vi.fn(async () => 1) },
      decision: { count: vi.fn(async () => 3) },
      phase: { count: vi.fn(async () => 3) },
    };
    return { svc: new OrgsService(prisma as unknown as PrismaService, { today: () => '2026-07-03' }, ...initParticipants()), prisma };
  }

  it('rolls up a project the PMC can access, counting activities by status', async () => {
    const { svc } = makePortfolio('pmc', ['done', 'done', 'blocked', 'not_started', 'in_progress', 'not_started']);
    const rows = await svc.portfolio('u1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      projectId: 'ambli', role: 'pmc', orgName: 'Vitan',
      activityTotal: 6, done: 2, inProgress: 1, blocked: 1, notStarted: 2,
      donePct: 33, openReviews: 1, pendingDecisions: 3, phaseCount: 3,
    });
  });

  it('hides pending-decision counts from a contractor (RBAC)', async () => {
    const { svc, prisma } = makePortfolio('contractor', ['done']);
    const rows = await svc.portfolio('u2');
    expect(rows[0].pendingDecisions).toBe(0);
    expect(prisma.decision.count).not.toHaveBeenCalled();
  });

  it('an org owner sees org projects they are not a member of (super-admin reach, as PMC)', async () => {
    // no explicit membership; owner of org1 which owns a "villa" project
    const villa = { id: 'villa', name: 'Villa', short: 'Villa', stage: 'Planning', milestonePct: 0, orgId: 'org1', org: { name: 'Vitan' } };
    const { svc } = makePortfolio('', ['done', 'not_started'], [{ orgId: 'org1' }], [villa]);
    const rows = await svc.portfolio('admin1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ projectId: 'villa', role: 'pmc', activityTotal: 2, done: 1 });
  });

  it('ORG residual: a user with no membership and no org-admin role gets an EMPTY board (no legacy home-project fallback)', async () => {
    // Fake where the legacy `User.projectId`/`User.role` row still exists — before the fix
    // portfolio() fell back to it and leaked a project card (with pending-decision counts
    // when the stale role was pmc/client). Now the board is membership + org-admin only.
    const home = { id: 'ambli', name: 'Residence at Ambli', short: 'Ambli', stage: 'Finishing', milestonePct: 72, orgId: 'org1', org: { name: 'Vitan' } };
    const prisma = {
      membership: { findMany: vi.fn(async () => []) }, // no active memberships
      user: { findUnique: vi.fn(async () => ({ projectId: 'ambli', role: 'pmc', project: home })) }, // stale legacy fields
      orgMembership: { findMany: vi.fn(async () => []) }, // not an org owner/admin
      project: { findMany: vi.fn(async () => []) },
      activity: { findMany: vi.fn(async () => []) },
      inspection: { count: vi.fn(async () => 0) },
      decision: { count: vi.fn(async () => 3) },
      phase: { count: vi.fn(async () => 0) },
    };
    const svc = new OrgsService(prisma as unknown as PrismaService, { today: () => '2026-07-03' }, ...initParticipants());
    expect(await svc.portfolio('u1')).toEqual([]);
    expect(prisma.decision.count).not.toHaveBeenCalled(); // never even reached a project rollup
  });
});

// ── Templates Slice 1 — copy a source project's structure into a new project ──

interface CopyRow { id: string; projectId: string; [k: string]: unknown }

function makeCopy(source: {
  nodes?: CopyRow[];
  phases?: CopyRow[];
  activities?: CopyRow[];
  inspections?: CopyRow[];
  sourceProject?: { orgId: string; archivedAt: Date | null } | null;
}) {
  const created = { nodes: [] as Record<string, unknown>[], phases: [] as Record<string, unknown>[], activities: [] as Record<string, unknown>[], inspections: [] as Record<string, unknown>[] };
  let cuid = 0;
  const tx = {
    $executeRaw: vi.fn(async () => 0),
    projectNode: {
      findMany: vi.fn(async () => source.nodes ?? []),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { const row = { id: `new-n${++cuid}`, ...data }; created.nodes.push(row); return row; }),
    },
    phase: {
      findMany: vi.fn(async () => source.phases ?? []),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { const row = { id: `new-p${++cuid}`, ...data }; created.phases.push(row); return row; }),
    },
    activity: {
      findMany: vi.fn(async ({ where }: { where?: { projectId?: string } } = {}) => where?.projectId ? (source.activities ?? []) : [{ id: 'ACT-31' }, { id: 'ACT-40' }]),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { created.activities.push(data); return data; }),
    },
    inspection: {
      findMany: vi.fn(async ({ where }: { where?: { projectId?: string } } = {}) => where?.projectId ? (source.inspections ?? []) : [{ id: 'INSP-22' }]),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { created.inspections.push(data); return data; }),
    },
    project: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
      findUnique: vi.fn(async () => (source.sourceProject === undefined ? { orgId: 'org1', archivedAt: null } : source.sourceProject)),
      findUniqueOrThrow: vi.fn(async () => ({ orgId: 'org1' })),
    },
    membership: { create: vi.fn(async ({ data }: { data: unknown }) => data) },
    projectEventStream: { update: vi.fn(async () => ({ nextPosition: 1n })) },
    domainEvent: { create: vi.fn(async () => ({ eventId: 'evt-test' })) },
  };
  const prisma = {
    orgMembership: { findUnique: vi.fn(async () => ({ role: 'owner' })) },
    user: { findUnique: vi.fn(async () => ({ name: 'Tester' })) },
    project: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
      findUnique: vi.fn(async () => (source.sourceProject === undefined ? { orgId: 'org1', archivedAt: null } : source.sourceProject)),
      findUniqueOrThrow: vi.fn(async () => ({ timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') })),
    },
    membership: { create: vi.fn(async ({ data }: { data: unknown }) => data) },
    projectNode: { findMany: vi.fn(async () => source.nodes ?? []) },
    phase: { findMany: vi.fn(async () => source.phases ?? []) },
    // 1st call: the source's activities; 2nd call: ALL ids (global display-id sequence)
    activity: { findMany: vi.fn().mockResolvedValueOnce(source.activities ?? []).mockResolvedValueOnce([{ id: 'ACT-31' }, { id: 'ACT-40' }]) },
    inspection: { findMany: vi.fn().mockResolvedValueOnce(source.inspections ?? []).mockResolvedValueOnce([{ id: 'INSP-22' }]) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx)),
  };
  const svc = new OrgsService(prisma as unknown as PrismaService, { today: () => '2026-07-03' }, ...initParticipants());
  return { svc, prisma, created };
}

const CREATE_INPUT = { name: 'SamBunglow', short: 'SamBunglow', descriptor: '', stage: 'Planning', siteCode: '', projStart: '', projEnd: '', structureFrom: 'ambli' };

describe('OrgsService.createProject — structureFrom (Templates Slice 1)', () => {
  it('copies the location tree as DRAFTS with parent links remapped', async () => {
    const { svc, created } = makeCopy({
      nodes: [
        { id: 'z1', projectId: 'ambli', parentId: null, name: 'Ground Floor', kind: 'zone', order: 0 },
        { id: 'r1', projectId: 'ambli', parentId: 'z1', name: 'Living Room', kind: 'room', order: 0 },
        { id: 'e1', projectId: 'ambli', parentId: 'r1', name: 'Main Door', kind: 'element', order: 0 },
      ],
    });
    await svc.createProject('org1', 'u1', CREATE_INPUT);

    expect(created.nodes).toHaveLength(3);
    const zone = created.nodes.find((n) => n.name === 'Ground Floor')!;
    const room = created.nodes.find((n) => n.name === 'Living Room')!;
    const door = created.nodes.find((n) => n.name === 'Main Door')!;
    // every copied node is a private draft authored by the creator
    for (const n of created.nodes) {
      expect(n.publishedAt).toBeNull();
      expect(n.authorId).toBe('u1');
    }
    // the hierarchy is preserved through NEW ids (never the source's)
    expect(zone.parentId).toBeNull();
    expect(room.parentId).toBe(zone.id);
    expect(door.parentId).toBe(room.id);
    expect([zone.id, room.id, door.id]).not.toContain('z1');
  });

  it('copies activities as their planned shape only — actuals stripped, gates de-scored, fresh global ids', async () => {
    const { svc, created } = makeCopy({
      nodes: [{ id: 'r1', projectId: 'ambli', parentId: null, name: 'GF', kind: 'zone', order: 0 }],
      phases: [{ id: 'ph1', projectId: 'ambli', name: 'Finishing', order: 0, plannedStart: 34, plannedEnd: 47 }],
      activities: [
        { id: 'ACT-31', projectId: 'ambli', name: 'Marble laying', zone: 'Living', status: 'in_progress', plannedStart: 28, plannedEnd: 41, actualStart: 29, actualEnd: null, block: 'Material ≠ approved', gateMaterial: 'fail', gateTeam: 'ok', gateInspection: 'na', decisionId: 'DL-014', phaseId: 'ph1', nodeId: 'r1', order: 0 },
      ],
    });
    await svc.createProject('org1', 'u1', CREATE_INPUT);

    const a = created.activities[0];
    expect(a.id).toBe('ACT-041'); // allocated after the global max (ACT-40), not the source id
    expect(a).toMatchObject({ name: 'Marble laying', status: 'not_started', plannedStart: 28, plannedEnd: 41, actualStart: null, actualEnd: null, block: null, decisionId: null });
    // outcomes stripped, structure kept: ok/fail → wait; na stays na
    expect(a.gateMaterial).toBe('wait');
    expect(a.gateTeam).toBe('wait');
    expect(a.gateInspection).toBe('na');
    // phase + place remapped onto the NEW rows
    expect(a.phaseId).toBe(created.phases[0].id);
    expect(a.nodeId).toBe(created.nodes[0].id);
  });

  it('copies checklist definitions reset to unsubmitted with item names only', async () => {
    const { svc, created } = makeCopy({
      inspections: [
        { id: 'INSP-22', projectId: 'ambli', kind: 'checklist', title: 'Waterproofing QA', zone: 'Terrace', by: 'Ramesh', date: '01 Jul 2026', submitted: true, decided: true, nodeId: null, items: [{ name: 'Ponding test', order: 0, state: 'fail', photos: 3, note: 'leak', result: 'FAIL', rejected: true }] },
      ],
    });
    await svc.createProject('org1', 'u1', CREATE_INPUT);

    const i = created.inspections[0];
    expect(i.id).toBe('INSP-023');
    expect(i).toMatchObject({ kind: 'checklist', title: 'Waterproofing QA', submitted: false, decided: false, by: null });
    const items = (i.items as { create: { name: string; order: number; state?: unknown }[] }).create;
    expect(items).toEqual([{ name: 'Ponding test', order: 0 }]); // names only — no state/photos/notes travel
  });

  it('rejects a source outside the org (or archived) BEFORE the project exists — no orphan (review F1)', async () => {
    const { svc, prisma, created } = makeCopy({ sourceProject: { orgId: 'OTHER-org', archivedAt: null } });
    await expect(svc.createProject('org1', 'u1', CREATE_INPUT)).rejects.toBeInstanceOf(NotFoundException);
    expect(created.nodes).toHaveLength(0);
    expect(prisma.project.create).not.toHaveBeenCalled();
  });

  it('without structureFrom, createProject never touches the copy path', async () => {
    const { svc, created } = makeCopy({});
    await svc.createProject('org1', 'u1', { ...CREATE_INPUT, structureFrom: undefined });
    // Task 4 makes the createProject CORE (project + PMC membership + project.created) atomic, so
    // a transaction DOES run now — the copy path is proven untouched by nothing being copied.
    expect(created.nodes).toHaveLength(0);
    expect(created.phases).toHaveLength(0);
    expect(created.activities).toHaveLength(0);
    expect(created.inspections).toHaveLength(0);
  });
});

// ── Templates Slice 2 — the org module menu + composition at create-project ──

function makeModules(opts: {
  orgRole?: string | null;
  modules?: Record<string, unknown>[];
  sourceNodes?: CopyRow[];
  sourceInspections?: CopyRow[];
}) {
  const created = { nodes: [] as Record<string, unknown>[], phases: [] as Record<string, unknown>[], activities: [] as Record<string, unknown>[], inspections: [] as Record<string, unknown>[], modules: [] as Record<string, unknown>[] };
  let cuid = 0;
  const tx = {
    $executeRaw: vi.fn(async () => 0),
    projectNode: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { const row = { id: `new-n${++cuid}`, ...data }; created.nodes.push(row); return row; }),
      findMany: vi.fn(async () => opts.sourceNodes ?? []),
    },
    phase: {
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { const row = { id: `new-p${++cuid}`, ...data }; created.phases.push(row); return row; }),
    },
    activity: {
      findMany: vi.fn(async () => []),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { created.activities.push(data); return data; }),
    },
    inspection: {
      findMany: vi.fn(async ({ where }: { where?: { kind?: string } } = {}) => where?.kind === 'checklist' ? (opts.sourceInspections ?? []) : []),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { created.inspections.push(data); return data; }),
    },
    project: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
      findUnique: vi.fn(async () => ({ orgId: 'org1', archivedAt: null })),
      findUniqueOrThrow: vi.fn(async () => ({ orgId: 'org1' })),
    },
    membership: { create: vi.fn(async ({ data }: { data: unknown }) => data) },
    projectEventStream: { update: vi.fn(async () => ({ nextPosition: 1n })) },
    domainEvent: { create: vi.fn(async () => ({ eventId: 'evt-test' })) },
    templateModule: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (opts.modules ?? []).find((m) => m.id === where.id) ?? null),
      findMany: vi.fn(async () => opts.modules ?? []),
    },
  };
  const prisma = {
    orgMembership: { findUnique: vi.fn(async () => (opts.orgRole === undefined ? { role: 'owner' } : opts.orgRole ? { role: opts.orgRole } : null)) },
    user: { findUnique: vi.fn(async () => ({ name: 'Tester' })) },
    project: {
      create: vi.fn(async ({ data }: { data: Record<unknown, unknown> }) => data),
      findUnique: vi.fn(async () => ({ orgId: 'org1', archivedAt: null })),
      findUniqueOrThrow: vi.fn(async () => ({ timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') })),
    },
    membership: { create: vi.fn(async ({ data }: { data: unknown }) => data) },
    projectNode: { findMany: vi.fn(async () => opts.sourceNodes ?? []) },
    phase: { findMany: vi.fn(async () => []) },
    activity: { findMany: vi.fn(async () => []) },
    inspection: { findMany: vi.fn(async (args: { where?: { kind?: string } } = {}) => (args?.where?.kind === 'checklist' ? (opts.sourceInspections ?? []) : [])) },
    templateModule: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { const row = { id: `mod-${++cuid}`, version: 1, archivedAt: null, ...data }; created.modules.push(row); return row; }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (opts.modules ?? []).find((m) => m.id === where.id) ?? null),
      findMany: vi.fn(async () => opts.modules ?? []),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
    },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<void>) => fn(tx)),
  };
  const svc = new OrgsService(prisma as unknown as PrismaService, { today: () => '2026-07-03' }, ...initParticipants());
  return { svc, prisma, created, tx };
}

const KITCHEN_MODULE = {
  id: 'mod-kitchen',
  orgId: 'org1',
  archivedAt: null,
  name: 'Kitchen',
  category: 'space',
  anchorKind: 'zone', // roots are rooms → grafts under a zone
  version: 1,
  description: '',
  payload: {
    nodes: [
      { key: 'k', parentKey: null, name: 'Kitchen', kind: 'room', order: 0 },
      { key: 'sink', parentKey: 'k', name: 'Sink', kind: 'element', order: 0 },
    ],
    inspections: [{ title: 'Kitchen waterproofing', zone: 'Kitchen', nodeKey: 'k', items: ['Counter slope', 'Sink sealing'] }],
  },
};

describe('OrgsService — module menu (Templates Slice 2)', () => {
  it('createModule with an explicit payload infers the anchor from the root nodes', async () => {
    const { svc, created } = makeModules({});
    const summary = await svc.createModule('org1', 'u1', {
      name: 'Kitchen', category: 'space', description: '',
      payload: { nodes: [{ key: 'k', parentKey: null, name: 'Kitchen', kind: 'room', order: 0 }], phases: [], activities: [], inspections: [] },
    } as never);
    expect(created.modules[0]).toMatchObject({ orgId: 'org1', name: 'Kitchen', anchorKind: 'zone' });
    expect(summary.counts).toMatchObject({ nodes: 1, inspections: 0 });
  });

  it('createModule fromProject + fromNodeId extracts that subtree and its checklists (no phases/activities)', async () => {
    const { svc, created } = makeModules({
      sourceNodes: [
        { id: 'z1', projectId: 'ambli', parentId: null, name: 'GF', kind: 'zone', order: 0 },
        { id: 'r1', projectId: 'ambli', parentId: 'z1', name: 'Kitchen', kind: 'room', order: 2 },
        { id: 'e1', projectId: 'ambli', parentId: 'r1', name: 'Sink', kind: 'element', order: 0 },
        { id: 'r2', projectId: 'ambli', parentId: 'z1', name: 'Living', kind: 'room', order: 0 }, // outside the subtree
      ],
      sourceInspections: [{ id: 'INSP-9', projectId: 'ambli', kind: 'checklist', title: 'Kitchen QA', zone: 'Kitchen', nodeId: 'r1', items: [{ name: 'Slope', order: 0 }] }],
    });
    await svc.createModule('org1', 'u1', { name: 'Kitchen', category: 'space', description: '', fromProject: 'ambli', fromNodeId: 'r1' } as never);
    const payload = created.modules[0].payload as { nodes: { key: string; parentKey: string | null; name: string }[]; inspections: { nodeKey?: string }[]; phases: unknown[]; activities: unknown[] };
    expect(payload.nodes.map((n) => n.name).sort()).toEqual(['Kitchen', 'Sink']); // subtree only
    expect(payload.nodes.find((n) => n.name === 'Kitchen')!.parentKey).toBeNull(); // parent outside the subtree → root
    expect(payload.nodes.find((n) => n.name === 'Sink')!.parentKey).toBe('r1');
    expect(payload.inspections[0].nodeKey).toBe('r1');
    expect(payload.phases).toEqual([]); // spatial module: no schedule shape
    expect(payload.activities).toEqual([]);
    expect(created.modules[0].anchorKind).toBe('zone');
  });

  it('createProject composes modules: ×2 under a zone → suffixed copies grafted onto ONE created draft zone', async () => {
    const { svc, created } = makeModules({ modules: [KITCHEN_MODULE] });
    await svc.createProject('org1', 'u1', { ...CREATE_INPUT, structureFrom: undefined, modules: [{ moduleId: 'mod-kitchen', count: 2, underZone: 'Second Floor' }] } as never);

    const zones = created.nodes.filter((n) => n.kind === 'zone');
    expect(zones).toHaveLength(1); // the underZone was created once and reused for both copies
    expect(zones[0]).toMatchObject({ name: 'Second Floor', publishedAt: null, authorId: 'u1' });

    const rooms = created.nodes.filter((n) => n.kind === 'room');
    expect(rooms.map((r) => r.name).sort()).toEqual(['Kitchen 1', 'Kitchen 2']); // roots suffixed
    for (const r of rooms) expect(r.parentId).toBe(zones[0].id);

    const sinks = created.nodes.filter((n) => n.kind === 'element');
    expect(sinks).toHaveLength(2); // children ride along, unsuffixed, under their own copy
    expect(new Set(sinks.map((s) => s.parentId))).toEqual(new Set(rooms.map((r) => r.id)));

    expect(created.inspections.map((i) => i.title).sort()).toEqual(['Kitchen waterproofing 1', 'Kitchen waterproofing 2']);
    for (const i of created.inspections) expect(i).toMatchObject({ submitted: false, decided: false, kind: 'checklist' });
  });

  it('a plain member can read the menu but not create modules', async () => {
    const { svc } = makeModules({ orgRole: 'member', modules: [KITCHEN_MODULE] });
    await expect(svc.listModules('org1', 'u2')).resolves.toHaveLength(1);
    await expect(svc.createModule('org1', 'u2', { name: 'X', category: 'space', description: '', payload: { nodes: [], phases: [], activities: [], inspections: [] } } as never)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('an element-anchored module is rejected at create-project (needs a room to graft into)', async () => {
    const doorModule = { ...KITCHEN_MODULE, id: 'mod-door', anchorKind: 'room', payload: { nodes: [{ key: 'd', parentKey: null, name: 'Main Door', kind: 'element', order: 0 }] } };
    const { svc } = makeModules({ modules: [doorModule] });
    await expect(
      svc.createProject('org1', 'u1', { ...CREATE_INPUT, structureFrom: undefined, modules: [{ moduleId: 'mod-door', count: 1 }] } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a module from another org (or archived) is rejected BEFORE the project exists (review F1)', async () => {
    const foreign = { ...KITCHEN_MODULE, id: 'mod-x', orgId: 'OTHER' };
    const { svc, prisma } = makeModules({ modules: [foreign] });
    await expect(
      svc.createProject('org1', 'u1', { ...CREATE_INPUT, structureFrom: undefined, modules: [{ moduleId: 'mod-x', count: 1 }] } as never),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.project.create).not.toHaveBeenCalled();
  });
});

// ── Templates Slice 3 — named presets ──

function makeTemplates(opts: {
  orgRole?: string | null;
  modules?: Record<string, unknown>[];
  templates?: Record<string, unknown>[];
  sourceNodes?: CopyRow[];
}) {
  const base = makeModules({ orgRole: opts.orgRole, modules: opts.modules, sourceNodes: opts.sourceNodes });
  const created = { ...((base as unknown as { created: Record<string, Record<string, unknown>[]> }).created ?? {}), templates: [] as Record<string, unknown>[] };
  let seq = 0;
  const projectTemplate = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { const row = { id: `tpl-${++seq}`, version: 1, ...data }; created.templates.push(row); return row; }),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (opts.templates ?? []).find((t) => t.id === where.id) ?? null),
    findMany: vi.fn(async () => opts.templates ?? []),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
  };
  (base.prisma as unknown as Record<string, unknown>).projectTemplate = projectTemplate;
  // the fromProject capture runs in a $transaction — its tx needs the same delegates
  Object.assign(base.tx as unknown as Record<string, unknown>, {
    templateModule: (base.prisma as unknown as Record<string, unknown>).templateModule,
    projectTemplate,
  });
  return { svc: base.svc, prisma: base.prisma, created, modCreated: base.created };
}

describe('OrgsService — named presets (Templates Slice 3)', () => {
  it('createTemplate with explicit items validates every module is the org’s own', async () => {
    const { svc, created } = makeTemplates({ modules: [KITCHEN_MODULE] });
    const res = await svc.createTemplate('org1', 'u1', { name: 'G+2 Residence', description: '', items: [{ moduleId: 'mod-kitchen', count: 2, underZone: 'GF' }] } as never);
    expect(created.templates[0]).toMatchObject({ orgId: 'org1', name: 'G+2 Residence' });
    expect(res.items).toEqual([{ moduleId: 'mod-kitchen', count: 2, underZone: 'GF' }]);
    expect(res.moduleNames).toEqual(['Kitchen ×2']); // the response is picker-ready (review F6)

    // a foreign module is refused before anything is stored
    const foreign = makeTemplates({ modules: [{ ...KITCHEN_MODULE, id: 'mod-x', orgId: 'OTHER' }] });
    await expect(foreign.svc.createTemplate('org1', 'u1', { name: 'X', description: '', items: [{ moduleId: 'mod-x', count: 1 }] } as never)).rejects.toBeInstanceOf(NotFoundException);
    expect(foreign.created.templates).toHaveLength(0);
  });

  it('createTemplate fromProject captures the whole structure as ONE module wrapped in the preset', async () => {
    const { svc, created, modCreated } = makeTemplates({
      sourceNodes: [
        { id: 'z1', projectId: 'ambli', parentId: null, name: 'GF', kind: 'zone', order: 0 },
        { id: 'r1', projectId: 'ambli', parentId: 'z1', name: 'Living', kind: 'room', order: 0 },
      ],
    });
    const res = await svc.createTemplate('org1', 'u1', { name: 'G+2 Residence', description: '', fromProject: 'ambli' } as never);

    expect(modCreated.modules).toHaveLength(1); // the captured full-structure module
    expect(modCreated.modules[0]).toMatchObject({ name: 'G+2 Residence — full structure', category: 'zone', anchorKind: null });
    const payload = modCreated.modules[0].payload as { nodes: { name: string }[] };
    expect(payload.nodes.map((n) => n.name).sort()).toEqual(['GF', 'Living']);
    // the preset wraps exactly that module, once — and the response is picker-ready (review F6)
    expect(res.items).toEqual([{ moduleId: modCreated.modules[0].id, count: 1 }]);
    expect(res.moduleNames).toEqual(['G+2 Residence — full structure']);
    expect(created.templates).toHaveLength(1);
  });

  it('createTemplate refuses a room-anchored (element-root) module — a preset must stay usable (review F3)', async () => {
    const doorModule = { ...KITCHEN_MODULE, id: 'mod-door', anchorKind: 'room', name: 'Main Door' };
    const { svc, created } = makeTemplates({ modules: [doorModule] });
    await expect(
      svc.createTemplate('org1', 'u1', { name: 'X', description: '', items: [{ moduleId: 'mod-door', count: 1 }] } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(created.templates).toHaveLength(0);
  });

  it('archiveModule refuses while a live preset references the module (review F2)', async () => {
    const { svc } = makeTemplates({
      modules: [KITCHEN_MODULE],
      templates: [{ id: 'tpl-g2', orgId: 'org1', archivedAt: null, name: 'G+2 Residence', items: [{ moduleId: 'mod-kitchen', count: 1 }] }],
    });
    await expect(svc.archiveModule('org1', 'u1', 'mod-kitchen')).rejects.toBeInstanceOf(BadRequestException);

    // with no live preset referencing it, archiving goes through
    const free = makeTemplates({ modules: [KITCHEN_MODULE], templates: [] });
    await expect(free.svc.archiveModule('org1', 'u1', 'mod-kitchen')).resolves.toEqual({ ok: true });
  });

  it('createProject with templateId expands the preset through the module instantiation path', async () => {
    const { svc, modCreated } = makeTemplates({
      modules: [KITCHEN_MODULE],
      templates: [{ id: 'tpl-g2', orgId: 'org1', archivedAt: null, items: [{ moduleId: 'mod-kitchen', count: 2, underZone: 'Second Floor' }] }],
    });
    await svc.createProject('org1', 'u1', { ...CREATE_INPUT, structureFrom: undefined, templateId: 'tpl-g2' } as never);

    const rooms = modCreated.nodes.filter((n) => n.kind === 'room');
    expect(rooms.map((r) => r.name).sort()).toEqual(['Kitchen 1', 'Kitchen 2']); // the preset's ×2 ran
    expect(modCreated.nodes.filter((n) => n.kind === 'zone')).toHaveLength(1); // one Second Floor
  });

  it('a foreign or archived template is rejected BEFORE the project exists — no orphan (review F1)', async () => {
    const { svc, prisma } = makeTemplates({ templates: [{ id: 'tpl-x', orgId: 'OTHER', archivedAt: null, items: [] }] });
    await expect(svc.createProject('org1', 'u1', { ...CREATE_INPUT, structureFrom: undefined, templateId: 'tpl-x' } as never)).rejects.toBeInstanceOf(NotFoundException);
    expect((prisma as unknown as { project: { create: ReturnType<typeof vi.fn> } }).project.create).not.toHaveBeenCalled();
    expect((prisma as unknown as { membership: { create: ReturnType<typeof vi.fn> } }).membership.create).not.toHaveBeenCalled();
  });

  it('a plain member can read the preset list but not create one', async () => {
    const { svc } = makeTemplates({ orgRole: 'member', templates: [{ id: 't1', orgId: 'org1', archivedAt: null, items: [], name: 'X', description: '', version: 1 }] });
    await expect(svc.listTemplates('org1', 'u2')).resolves.toHaveLength(1);
    await expect(svc.createTemplate('org1', 'u2', { name: 'X', description: '', items: [{ moduleId: 'm', count: 1 }] } as never)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
