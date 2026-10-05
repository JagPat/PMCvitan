import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreateProjectInput } from '../../src/contracts';
import { CREATE_PROJECT_COMMAND, OrgsService } from '../../src/orgs/orgs.service';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { createTestApp, type TestApp } from './test-app';

import { sanctionedReset } from '../../prisma/sanctioned-reset';
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
      // element-under-ELEMENT: an element is a leaf. (The previous fixture — element
      // directly under a zone — is a legal shape since nested locations, phase-6-task-2.)
      nodes: [
        { key: 'zone', parentKey: null, name: 'Zone', kind: 'zone', order: 0 },
        { key: 'element', parentKey: 'zone', name: 'Element', kind: 'element', order: 0 },
        { key: 'sub', parentKey: 'element', name: 'Sub Element', kind: 'element', order: 0 },
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
        await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor'], { cascade: true });
        // the idempotent creates' org-scoped receipts (replaces #710)
        await t.prisma.commandExecution.deleteMany({ where: { scopeKind: 'org', organizationId: f.orgA.id, commandType: CREATE_PROJECT_COMMAND } });
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

  it('refuses a legacy source holding one name as two kinds under a parent, rolls everything back and leaves the source untouched', async () => {
    // Legacy data from before #705's sibling-name rule: a "Ground Floor" zone holding a "Lobby" room
    // AND a normalized-equal " lobby " element. Written directly, as the old server allowed; the
    // service would refuse to create it today. Copying it is refused (the cross-kind rule is
    // intentional), with the server's rename advice, and nothing of the new project survives.
    const source = await service.createProject(f.orgA.id, f.ownerUser.id, inputFor('legacy-source'));
    const ground = await t.prisma.projectNode.create({
      data: { projectId: source.id, name: 'Ground Floor', kind: 'zone', order: 0, authorId: f.ownerUser.id },
    });
    const lobbyRoom = await t.prisma.projectNode.create({
      data: { projectId: source.id, parentId: ground.id, name: 'Lobby', kind: 'room', order: 0, authorId: f.ownerUser.id },
    });
    const lobbyElement = await t.prisma.projectNode.create({
      data: { projectId: source.id, parentId: ground.id, name: ' lobby ', kind: 'element', order: 1, authorId: f.ownerUser.id },
    });
    const sourceNodesBefore = await t.prisma.projectNode.findMany({ where: { projectId: source.id }, orderBy: { id: 'asc' } });

    const before = await countInitializationRows();
    let rejection: unknown;
    try {
      await service.createProject(f.orgA.id, f.ownerUser.id, inputFor('legacy-copy', { structureFrom: source.id }));
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(BadRequestException);
    expect((rejection as BadRequestException).getStatus()).toBe(400);
    // the advice the client now shows verbatim: which name, and what to do about it
    expect((rejection as BadRequestException).message).toMatch(/holds "Lobby" twice under one parent as different kinds — rename one before copying it/);
    // the whole initialization rolled back: no project, membership, event, node, phase, activity or checklist
    expect(await countInitializationRows()).toEqual(before);
    expect(await t.prisma.project.count({ where: { orgId: f.orgA.id, name: nameFor('legacy-copy') } })).toBe(0);
    // and the source is exactly as it was — never renamed or migrated to make the copy pass
    expect(await t.prisma.projectNode.findMany({ where: { projectId: source.id }, orderBy: { id: 'asc' } })).toEqual(sourceNodesBefore);
    expect(sourceNodesBefore.map((n) => n.id)).toEqual(expect.arrayContaining([ground.id, lobbyRoom.id, lobbyElement.id]));

    // once the owner renames one of them in the source, the same create succeeds — a retry is safe
    await t.prisma.projectNode.update({ where: { id: lobbyElement.id }, data: { name: 'Lobby Console' } });
    const copied = await service.createProject(f.orgA.id, f.ownerUser.id, inputFor('legacy-copy', { structureFrom: source.id }));
    const copiedNames = (await t.prisma.projectNode.findMany({ where: { projectId: copied.id }, select: { name: true } })).map((n) => n.name);
    expect(copiedNames.sort()).toEqual(['Ground Floor', 'Lobby', 'Lobby Console']);
    expect(await t.prisma.project.count({ where: { orgId: f.orgA.id, name: nameFor('legacy-copy') } })).toBe(1);
  });

  it('a create under an Idempotency-Key happens ONCE: a retry with the same key replays the first project (replaces #710)', async () => {
    const key = `it-create-${Date.now()}`;
    const before = await countInitializationRows();
    const first = await service.createProject(f.orgA.id, f.ownerUser.id, inputFor('keyed'), key);
    const afterFirst = await countInitializationRows();
    // the reply was "lost": the client retries the SAME request under the SAME key
    const again = await service.createProject(f.orgA.id, f.ownerUser.id, inputFor('keyed'), key);
    expect(again).toEqual(first);
    expect(await countInitializationRows()).toEqual(afterFirst); // nothing more was written
    expect(afterFirst.project).toBe(before.project + 1);
    expect(await t.prisma.project.count({ where: { orgId: f.orgA.id, name: nameFor('keyed') } })).toBe(1);
    const receipt = await t.prisma.commandExecution.findFirstOrThrow({
      where: { scopeKind: 'org', organizationId: f.orgA.id, actorId: f.ownerUser.id, commandType: CREATE_PROJECT_COMMAND, idempotencyKey: key },
    });
    expect(receipt).toMatchObject({ status: 'succeeded', resultRef: first.id, projectId: null });
  });

  it('the same key for a DIFFERENT request is a 409, and creates nothing', async () => {
    const key = `it-create-diff-${Date.now()}`;
    await service.createProject(f.orgA.id, f.ownerUser.id, inputFor('keyed-a'), key);
    const before = await countInitializationRows();
    await expect(service.createProject(f.orgA.id, f.ownerUser.id, inputFor('keyed-b'), key)).rejects.toBeInstanceOf(ConflictException);
    expect(await countInitializationRows()).toEqual(before);
  });

  it('two CONCURRENT creates under one key CONTEND at the receipt reservation: one project, both answer with it', async () => {
    const key = `it-create-race-${Date.now()}`;
    const before = await countInitializationRows();
    // An explicit barrier at the reservation (Codex 4188491728, POLICY: no sleep-only synchronization). A
    // SHARE lock on the receipt table admits both callers' fast-path receipt read (it finds nothing) and
    // blocks both reservation INSERTs. The barrier opens only once BOTH inserts are observed waiting in
    // pg_locks, so neither can complete before the other reaches the reservation: they meet at the unique
    // index, and the loser must take the P2002 replay (or a serialization retry that ends in it).
    const waitingInserts = async () => (await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*) AS n FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
        WHERE c.relname = 'CommandExecution' AND l.mode = 'RowExclusiveLock' AND NOT l.granted`,
    ))[0]!.n;
    let a!: Promise<Awaited<ReturnType<typeof service.createProject>>>;
    let b!: Promise<Awaited<ReturnType<typeof service.createProject>>>;
    await t.prisma.$transaction(async (gate) => {
      await gate.$executeRawUnsafe('LOCK TABLE "CommandExecution" IN SHARE MODE');
      a = service.createProject(f.orgA.id, f.ownerUser.id, inputFor('keyed-race'), key);
      b = service.createProject(f.orgA.id, f.ownerUser.id, inputFor('keyed-race'), key);
      a.catch(() => undefined);
      b.catch(() => undefined);
      const deadline = Date.now() + 20_000;
      while ((await waitingInserts()) < 2n) {
        if (Date.now() > deadline) throw new Error('barrier: both reservations never reached the receipt insert');
        await new Promise((r) => setTimeout(r, 20));
      }
    }, { timeout: 30_000 }); // committing the gate releases both reservations at once
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.id).toBe(rb.id);
    expect(ra).toEqual(rb);
    expect((await countInitializationRows()).project).toBe(before.project + 1);
    expect(await t.prisma.commandExecution.count({
      where: { scopeKind: 'org', organizationId: f.orgA.id, actorId: f.ownerUser.id, commandType: CREATE_PROJECT_COMMAND, idempotencyKey: key },
    })).toBe(1);
  });

  it('a REFUSED keyed create leaves no receipt, so the corrected retry under the same key goes through', async () => {
    const key = `it-create-refused-${Date.now()}`;
    const source = await service.createProject(f.orgA.id, f.ownerUser.id, inputFor('keyed-legacy-source'));
    const ground = await t.prisma.projectNode.create({ data: { projectId: source.id, name: 'Ground Floor', kind: 'zone', order: 0, authorId: f.ownerUser.id } });
    await t.prisma.projectNode.create({ data: { projectId: source.id, parentId: ground.id, name: 'Lobby', kind: 'room', order: 0, authorId: f.ownerUser.id } });
    const element = await t.prisma.projectNode.create({ data: { projectId: source.id, parentId: ground.id, name: ' lobby ', kind: 'element', order: 1, authorId: f.ownerUser.id } });
    const input = inputFor('keyed-legacy-copy', { structureFrom: source.id });
    await expect(service.createProject(f.orgA.id, f.ownerUser.id, input, key)).rejects.toBeInstanceOf(BadRequestException);
    expect(await t.prisma.commandExecution.count({ where: { scopeKind: 'org', organizationId: f.orgA.id, idempotencyKey: key } })).toBe(0);
    await t.prisma.projectNode.update({ where: { id: element.id }, data: { name: 'Lobby Console' } });
    const made = await service.createProject(f.orgA.id, f.ownerUser.id, input, key);
    expect(await t.prisma.project.count({ where: { orgId: f.orgA.id, name: nameFor('keyed-legacy-copy') } })).toBe(1);
    expect((await t.prisma.commandExecution.findFirstOrThrow({ where: { scopeKind: 'org', organizationId: f.orgA.id, idempotencyKey: key } })).resultRef).toBe(made.id);
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
        // Task 10 (Modules 3+4) — init now emits FOUR events: `project.created`, the
        // `inspection.created` the inspections participant appends for the one starting checklist,
        // and the `phase.created` + `activity.created` the activities participant appends for the one
        // starting phase/activity (so BOTH module projections MATERIALIZE from init events, not the
        // live fallback).
        event: 4,
        // PR B totality: every registered consumer gets one delivery per event. There are TEN
        // consumers (socket `dispatch` + push + decisions.inbox + daily-log.inbox + drawings.inbox +
        // inspections.inbox + activities.schedule + activities.material-readiness + labour.readiness
        // + commercial.cash-forecast — the Phase 5 Task 7A §J money projection), so four events
        // yield 4 × 10 = 40 deliveries. Each projection consumer dispatches only its own module's
        // events (its deliveries for the others are `noop`s that still advance the ordered cursor).
        delivery: 40,
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
