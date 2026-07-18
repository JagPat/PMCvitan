import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreateProjectInput } from '../../src/contracts';
import { OrgsService } from '../../src/orgs/orgs.service';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { createTestApp, type TestApp } from './test-app';

type ModulePayloadJson = {
  nodes: Array<{ key: string; parentKey: string | null; name: string; kind: 'zone' | 'room' | 'element'; order: number }>;
  phases: Array<{ name: string; order: number; plannedStart: number; plannedEnd: number }>;
  activities: Array<{ name: string; zone: string; plannedStart: number; plannedEnd: number; nodeKey?: string; phaseName?: string; order: number }>;
  inspections: Array<{ title: string; zone: string; nodeKey?: string; items: string[] }>;
};

const emptyPayload = (): ModulePayloadJson => ({ nodes: [], phases: [], activities: [], inspections: [] });

const invalidModules: Array<{ label: string; payload: ModulePayloadJson }> = [
  {
    label: 'orphan-parent',
    payload: {
      ...emptyPayload(),
      nodes: [{ key: 'orphan-room', parentKey: 'missing-zone', name: 'Orphan Room', kind: 'room', order: 0 }],
    },
  },
  {
    label: 'parent-cycle',
    payload: {
      ...emptyPayload(),
      nodes: [
        { key: 'room-a', parentKey: 'room-b', name: 'Room A', kind: 'room', order: 0 },
        { key: 'room-b', parentKey: 'room-a', name: 'Room B', kind: 'room', order: 1 },
      ],
    },
  },
  {
    label: 'duplicate-node-key',
    payload: {
      ...emptyPayload(),
      nodes: [
        { key: 'duplicate', parentKey: null, name: 'Zone A', kind: 'zone', order: 0 },
        { key: 'duplicate', parentKey: null, name: 'Zone B', kind: 'zone', order: 1 },
      ],
    },
  },
  {
    label: 'invalid-kind-edge',
    payload: {
      ...emptyPayload(),
      nodes: [
        { key: 'zone', parentKey: null, name: 'Zone', kind: 'zone', order: 0 },
        { key: 'element', parentKey: 'zone', name: 'Element', kind: 'element', order: 0 },
      ],
    },
  },
  {
    label: 'missing-activity-node',
    payload: {
      ...emptyPayload(),
      nodes: [{ key: 'zone', parentKey: null, name: 'Zone', kind: 'zone', order: 0 }],
      activities: [{ name: 'Unplaced Activity', zone: 'Zone', plannedStart: 0, plannedEnd: 1, nodeKey: 'missing-node', order: 0 }],
    },
  },
  {
    label: 'missing-inspection-node',
    payload: {
      ...emptyPayload(),
      nodes: [{ key: 'zone', parentKey: null, name: 'Zone', kind: 'zone', order: 0 }],
      inspections: [{ title: 'Unplaced Checklist', zone: 'Zone', nodeKey: 'missing-node', items: ['Check'] }],
    },
  },
  {
    label: 'missing-activity-phase',
    payload: {
      ...emptyPayload(),
      activities: [{ name: 'Unphased Activity', zone: '', plannedStart: 0, plannedEnd: 1, phaseName: 'Missing Phase', order: 0 }],
    },
  },
];

describe('project initialization atomicity (live PostgreSQL)', () => {
  const run = randomUUID().replace(/-/g, '').slice(0, 12);
  const triggerName = `test_project_init_fault_${run}`;
  const functionName = `test_project_init_fault_fn_${run}`;
  let displaySequence = Date.now() * 100;
  let t: TestApp;
  let f: TwoProjectFixture;
  let service: OrgsService;

  const nameFor = (label: string): string => `Project init ${label} ${run}`;
  const inputFor = (label: string, extra: Partial<CreateProjectInput> = {}): CreateProjectInput => ({
    name: nameFor(label),
    short: `init-${label}-${run}`,
    descriptor: '',
    stage: 'Planning',
    siteCode: '',
    location: '',
    projStart: '',
    projEnd: '',
    scheduleStartDate: '2026-07-16',
    timeZone: 'Asia/Kolkata',
    ...extra,
  });
  const nextDisplayId = (prefix: 'ACT-' | 'INSP-'): string => `${prefix}${displaySequence++}`;

  const dropFaultProbe = async (): Promise<void> => {
    if (!t) return;
    await t.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "Inspection"`);
    await t.prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`);
  };

  const countInitializationRows = async () => {
    const [project, membership, projectEventStream, domainEvent, outboxDelivery, projectNode, phase, activity, inspection] = await Promise.all([
      t.prisma.project.count(),
      t.prisma.membership.count(),
      t.prisma.projectEventStream.count(),
      t.prisma.domainEvent.count(),
      t.prisma.outboxDelivery.count(),
      t.prisma.projectNode.count(),
      t.prisma.phase.count(),
      t.prisma.activity.count(),
      t.prisma.inspection.count(),
    ]);
    return { project, membership, projectEventStream, domainEvent, outboxDelivery, projectNode, phase, activity, inspection };
  };

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    service = t.app.get(OrgsService);
  });

  afterAll(async () => {
    try {
      await dropFaultProbe();
      if (f) {
        await t.prisma.$executeRawUnsafe('TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor"');
        const projects = await t.prisma.project.findMany({ where: { orgId: f.orgA.id }, select: { id: true } });
        const projectIds = projects.map((project) => project.id);
        const inspections = await t.prisma.inspection.findMany({ where: { projectId: { in: projectIds } }, select: { id: true } });
        await t.prisma.inspectionItem.deleteMany({ where: { inspectionId: { in: inspections.map((inspection) => inspection.id) } } });
        await t.prisma.inspection.deleteMany({ where: { projectId: { in: projectIds } } });
        await t.prisma.activity.deleteMany({ where: { projectId: { in: projectIds } } });
        await t.prisma.phase.deleteMany({ where: { projectId: { in: projectIds } } });
        await t.prisma.projectNode.deleteMany({ where: { projectId: { in: projectIds } } });
        await t.prisma.membership.deleteMany({ where: { projectId: { in: projectIds } } });
        await t.prisma.project.deleteMany({ where: { orgId: f.orgA.id, id: { not: f.projectA.id } } });
        await t.prisma.projectTemplate.deleteMany({ where: { orgId: f.orgA.id } });
        await t.prisma.templateModule.deleteMany({ where: { orgId: f.orgA.id } });
        await f.cleanup();
      }
    } finally {
      await t?.close();
    }
  });

  it('rolls back every project artifact when an inspection participant fails after earlier writes', async () => {
    const inspectionTitle = `Atomic fault checklist ${run}`;
    const phaseName = `Atomic fault phase ${run}`;
    const module = await t.prisma.templateModule.create({
      data: {
        orgId: f.orgA.id,
        name: `Atomic fault module ${run}`,
        category: 'zone',
        anchorKind: null,
        payload: {
          nodes: [{ key: 'fault-zone', parentKey: null, name: `Fault Zone ${run}`, kind: 'zone', order: 0 }],
          phases: [{ name: phaseName, order: 0, plannedStart: 0, plannedEnd: 3 }],
          activities: [{ name: `Fault Activity ${run}`, zone: 'Fault Zone', plannedStart: 0, plannedEnd: 3, nodeKey: 'fault-zone', phaseName, order: 0 }],
          inspections: [{ title: inspectionTitle, zone: 'Fault Zone', nodeKey: 'fault-zone', items: ['Fault item'] }],
        },
      },
    });

    await dropFaultProbe();
    await t.prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."title" = '${inspectionTitle}' THEN
          RAISE EXCEPTION 'project initialization inspection fault';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await t.prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}"
      BEFORE INSERT ON "Inspection"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
    `);

    const before = await countInitializationRows();
    try {
      await expect(
        service.createProject(f.orgA.id, f.ownerUser.id, inputFor('after-write-fault', { modules: [{ moduleId: module.id, count: 1 }] })),
      ).rejects.toThrow('project initialization inspection fault');
      expect(await countInitializationRows()).toEqual(before);
      expect(await t.prisma.project.count({ where: { orgId: f.orgA.id, name: nameFor('after-write-fault') } })).toBe(0);
    } finally {
      await dropFaultProbe();
    }
  });

  it.each(invalidModules)('rejects $label module JSON with HTTP 400 semantics before creating a project', async ({ label, payload }) => {
    const module = await t.prisma.templateModule.create({
      data: {
        orgId: f.orgA.id,
        name: `Invalid ${label} ${run}`,
        category: 'zone',
        anchorKind: null,
        payload,
      },
    });

    let rejection: unknown;
    try {
      await service.createProject(f.orgA.id, f.ownerUser.id, inputFor(label, { modules: [{ moduleId: module.id, count: 1 }] }));
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(BadRequestException);
    expect((rejection as BadRequestException).getStatus()).toBe(400);
    expect(await t.prisma.project.count({ where: { orgId: f.orgA.id, name: nameFor(label) } })).toBe(0);
  });

  it('commits the complete source, template, and explicit-module union exactly once', async () => {
    const sharedPhase = `Shared Phase ${run}`;
    const explicitPhase = `Explicit Phase ${run}`;
    const source = await service.createProject(f.orgA.id, f.ownerUser.id, inputFor('union-source'));
    const sourceZone = await t.prisma.projectNode.create({
      data: { projectId: source.id, name: `Source Zone ${run}`, kind: 'zone', order: 0, authorId: f.ownerUser.id },
    });
    const sourceRoom = await t.prisma.projectNode.create({
      data: { projectId: source.id, parentId: sourceZone.id, name: `Source Room ${run}`, kind: 'room', order: 0, authorId: f.ownerUser.id },
    });
    const sourcePhase = await t.prisma.phase.create({
      data: { projectId: source.id, name: sharedPhase, order: 1, plannedStart: 0, plannedEnd: 5 },
    });
    const sourceActivity = await t.prisma.activity.create({
      data: {
        id: nextDisplayId('ACT-'),
        projectId: source.id,
        name: `Source Activity ${run}`,
        zone: `Source Zone ${run}`,
        plannedStart: 0,
        plannedEnd: 5,
        phaseId: sourcePhase.id,
        nodeId: sourceRoom.id,
      },
    });
    const sourceInspection = await t.prisma.inspection.create({
      data: {
        id: nextDisplayId('INSP-'),
        projectId: source.id,
        kind: 'checklist',
        title: `Source Checklist ${run}`,
        zone: `Source Zone ${run}`,
        date: '16 Jul 2026',
        submitted: false,
        decided: false,
        nodeId: sourceRoom.id,
        items: { create: [{ name: `Source Item ${run}`, order: 0 }] },
      },
    });

    const templateModule = await t.prisma.templateModule.create({
      data: {
        orgId: f.orgA.id,
        name: `Template module ${run}`,
        category: 'zone',
        anchorKind: null,
        payload: {
          nodes: [
            { key: 'template-zone', parentKey: null, name: `Template Zone ${run}`, kind: 'zone', order: 0 },
            { key: 'template-room', parentKey: 'template-zone', name: `Template Room ${run}`, kind: 'room', order: 0 },
          ],
          phases: [{ name: sharedPhase, order: 1, plannedStart: 0, plannedEnd: 5 }],
          activities: [{ name: `Template Activity ${run}`, zone: `Template Zone ${run}`, plannedStart: 1, plannedEnd: 4, nodeKey: 'template-room', phaseName: sharedPhase, order: 0 }],
          inspections: [{ title: `Template Checklist ${run}`, zone: `Template Zone ${run}`, nodeKey: 'template-room', items: [`Template Item ${run}`] }],
        },
      },
    });
    const template = await t.prisma.projectTemplate.create({
      data: {
        orgId: f.orgA.id,
        name: `Union template ${run}`,
        items: [{ moduleId: templateModule.id, count: 1 }],
      },
    });
    const explicitModule = await t.prisma.templateModule.create({
      data: {
        orgId: f.orgA.id,
        name: `Explicit module ${run}`,
        category: 'zone',
        anchorKind: null,
        payload: {
          nodes: [{ key: 'explicit-zone', parentKey: null, name: `Explicit Zone ${run}`, kind: 'zone', order: 0 }],
          phases: [{ name: explicitPhase, order: 2, plannedStart: 5, plannedEnd: 9 }],
          activities: [{ name: `Explicit Activity ${run}`, zone: `Explicit Zone ${run}`, plannedStart: 5, plannedEnd: 9, nodeKey: 'explicit-zone', phaseName: explicitPhase, order: 0 }],
          inspections: [{ title: `Explicit Checklist ${run}`, zone: `Explicit Zone ${run}`, nodeKey: 'explicit-zone', items: [`Explicit Item ${run}`] }],
        },
      },
    });

    const target = await service.createProject(
      f.orgA.id,
      f.ownerUser.id,
      inputFor('union-target', {
        structureFrom: source.id,
        templateId: template.id,
        modules: [{ moduleId: explicitModule.id, count: 1 }],
      }),
    );
    const [nodes, phases, activities, inspections] = await Promise.all([
      t.prisma.projectNode.findMany({ where: { projectId: target.id }, orderBy: { name: 'asc' } }),
      t.prisma.phase.findMany({ where: { projectId: target.id }, orderBy: { name: 'asc' } }),
      t.prisma.activity.findMany({ where: { projectId: target.id }, include: { node: true, phase: true }, orderBy: { name: 'asc' } }),
      t.prisma.inspection.findMany({ where: { projectId: target.id }, include: { node: true, items: { orderBy: { order: 'asc' } } }, orderBy: { title: 'asc' } }),
    ]);

    expect(nodes.map((node) => node.name).sort()).toEqual([
      `Explicit Zone ${run}`,
      `Source Room ${run}`,
      `Source Zone ${run}`,
      `Template Room ${run}`,
      `Template Zone ${run}`,
    ].sort());
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const nodeByName = new Map(nodes.map((node) => [node.name, node]));
    expect(nodeById.get(nodeByName.get(`Source Room ${run}`)!.parentId!)?.name).toBe(`Source Zone ${run}`);
    expect(nodeById.get(nodeByName.get(`Template Room ${run}`)!.parentId!)?.name).toBe(`Template Zone ${run}`);
    expect(nodeByName.get(`Source Zone ${run}`)?.parentId).toBeNull();
    expect(nodeByName.get(`Template Zone ${run}`)?.parentId).toBeNull();
    expect(nodeByName.get(`Explicit Zone ${run}`)?.parentId).toBeNull();

    expect(phases.map((phase) => ({ name: phase.name, order: phase.order, start: phase.plannedStart, end: phase.plannedEnd }))).toEqual([
      { name: explicitPhase, order: 2, start: 5, end: 9 },
      { name: sharedPhase, order: 1, start: 0, end: 5 },
    ]);
    expect(activities.map((activity) => ({ name: activity.name, node: activity.node?.name, phase: activity.phase?.name }))).toEqual([
      { name: `Explicit Activity ${run}`, node: `Explicit Zone ${run}`, phase: explicitPhase },
      { name: `Source Activity ${run}`, node: `Source Room ${run}`, phase: sharedPhase },
      { name: `Template Activity ${run}`, node: `Template Room ${run}`, phase: sharedPhase },
    ]);
    expect(inspections.map((inspection) => ({ title: inspection.title, node: inspection.node?.name, items: inspection.items.map((item) => item.name) }))).toEqual([
      { title: `Explicit Checklist ${run}`, node: `Explicit Zone ${run}`, items: [`Explicit Item ${run}`] },
      { title: `Source Checklist ${run}`, node: `Source Room ${run}`, items: [`Source Item ${run}`] },
      { title: `Template Checklist ${run}`, node: `Template Room ${run}`, items: [`Template Item ${run}`] },
    ]);

    const allCopiedIds = [
      ...nodes.map((node) => node.id),
      ...phases.map((phase) => phase.id),
      ...activities.map((activity) => activity.id),
      ...inspections.map((inspection) => inspection.id),
    ];
    expect(new Set(allCopiedIds).size).toBe(allCopiedIds.length);
    expect(allCopiedIds).not.toContain(sourceZone.id);
    expect(allCopiedIds).not.toContain(sourceRoom.id);
    expect(allCopiedIds).not.toContain(sourcePhase.id);
    expect(allCopiedIds).not.toContain(sourceActivity.id);
    expect(allCopiedIds).not.toContain(sourceInspection.id);
  });

  it('initializes two activity/checklist projects concurrently without duplicate display IDs or partial projects', async () => {
    const phaseName = `Concurrent Phase ${run}`;
    const module = await t.prisma.templateModule.create({
      data: {
        orgId: f.orgA.id,
        name: `Concurrent module ${run}`,
        category: 'zone',
        anchorKind: null,
        payload: {
          nodes: [{ key: 'concurrent-zone', parentKey: null, name: `Concurrent Zone ${run}`, kind: 'zone', order: 0 }],
          phases: [{ name: phaseName, order: 0, plannedStart: 0, plannedEnd: 2 }],
          activities: [{ name: `Concurrent Activity ${run}`, zone: `Concurrent Zone ${run}`, plannedStart: 0, plannedEnd: 2, nodeKey: 'concurrent-zone', phaseName, order: 0 }],
          inspections: [{ title: `Concurrent Checklist ${run}`, zone: `Concurrent Zone ${run}`, nodeKey: 'concurrent-zone', items: [`Concurrent Item ${run}`] }],
        },
      },
    });
    const labels = ['concurrent-a', 'concurrent-b'] as const;
    let releaseStart!: () => void;
    const start = new Promise<void>((resolve) => { releaseStart = resolve; });
    const calls = labels.map(async (label) => {
      await start;
      return service.createProject(f.orgA.id, f.ownerUser.id, inputFor(label, { modules: [{ moduleId: module.id, count: 1 }] }));
    });
    releaseStart();
    const results = await Promise.allSettled(calls);
    const fulfilled = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<OrgsService['createProject']>>> => result.status === 'fulfilled');
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');

    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    expect(rejected.length).toBeLessThanOrEqual(1);
    for (const result of rejected) {
      const reason = result.reason as { code?: string; getStatus?: () => number };
      expect(reason.getStatus?.() === 409 || reason.code === 'P2034' || reason.code === 'P2002').toBe(true);
    }

    for (const [index, label] of labels.entries()) {
      const project = await t.prisma.project.findFirst({ where: { orgId: f.orgA.id, name: nameFor(label) } });
      const result = results[index]!;
      if (result.status === 'rejected') {
        expect(project).toBeNull();
        continue;
      }
      expect(project?.id).toBe(result.value.id);
      const projectId = result.value.id;
      const [membership, stream, event, delivery, nodes, phases, activities, inspections, items] = await Promise.all([
        t.prisma.membership.count({ where: { projectId } }),
        t.prisma.projectEventStream.count({ where: { projectId } }),
        t.prisma.domainEvent.count({ where: { projectId } }),
        t.prisma.outboxDelivery.count({ where: { projectId } }),
        t.prisma.projectNode.count({ where: { projectId } }),
        t.prisma.phase.count({ where: { projectId } }),
        t.prisma.activity.count({ where: { projectId } }),
        t.prisma.inspection.count({ where: { projectId } }),
        t.prisma.inspectionItem.count({ where: { inspection: { projectId } } }),
      ]);
      expect({ membership, stream, event, delivery, nodes, phases, activities, inspections, items }).toEqual({
        membership: 1,
        stream: 1,
        event: 1,
        // PR B totality: every registered consumer gets one delivery per event — the one
        // `project.created` event yields a socket `dispatch` row + a push `noop` row (no push intent)
        // + (Task 9) a `decisions.inbox` projection `noop` row + (Task 10) a `daily-log.inbox`
        // projection `noop` row + (Task 10 Module 2) a `drawings.inbox` projection `noop` row
        // + (Task 10 Module 3) an `inspections.inbox` projection `noop` row (project.created is
        // neither a decision, a daily-log, a drawing, nor an inspection event).
        delivery: 6,
        nodes: 1,
        phases: 1,
        activities: 1,
        inspections: 1,
        items: 1,
      });
    }

    const successfulIds = fulfilled.map((result) => result.value.id);
    const [activities, inspections, duplicateActivities, duplicateInspections] = await Promise.all([
      t.prisma.activity.findMany({ where: { projectId: { in: successfulIds } }, select: { id: true } }),
      t.prisma.inspection.findMany({ where: { projectId: { in: successfulIds } }, select: { id: true } }),
      t.prisma.$queryRaw<Array<{ id: string; count: bigint }>>`
        SELECT "id", COUNT(*)::bigint AS "count"
        FROM "Activity"
        WHERE "id" LIKE 'ACT-%'
        GROUP BY "id"
        HAVING COUNT(*) > 1
      `,
      t.prisma.$queryRaw<Array<{ id: string; count: bigint }>>`
        SELECT "id", COUNT(*)::bigint AS "count"
        FROM "Inspection"
        WHERE "id" LIKE 'INSP-%'
        GROUP BY "id"
        HAVING COUNT(*) > 1
      `,
    ]);
    expect(activities.every((activity) => /^ACT-\d+$/.test(activity.id))).toBe(true);
    expect(inspections.every((inspection) => /^INSP-\d+$/.test(inspection.id))).toBe(true);
    expect(new Set(activities.map((activity) => activity.id)).size).toBe(activities.length);
    expect(new Set(inspections.map((inspection) => inspection.id)).size).toBe(inspections.length);
    expect(duplicateActivities).toEqual([]);
    expect(duplicateInspections).toEqual([]);
  });
});
