import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { OrgsService } from '../../src/orgs/orgs.service';

import { sanctionedReset } from '../../prisma/sanctioned-reset';
/**
 * Phase 6 task 2 — nested locations, the SECOND write path (§A.3) probes:
 * P4, P5, P11, P16, P18.
 *
 * `NodesService` is not the only thing that creates a `ProjectNode` — project
 * initialization (copy + module instantiation) writes through its own validator, so
 * the same parent rule and the same depth arithmetic must hold there, in BOTH
 * directions: refusal (P4 — a graft that would exceed 5 levels; P5 — an illegal
 * parent chain) AND acceptance (P11 — an element-root module placeable under a zone
 * and under a room THROUGH THE PUBLIC create-project selector; P16 — a nested-room
 * module; P18 — the same room-targeted module saved into a named preset and expanded).
 *
 * REPRODUCE-FIRST: at the stage-2 head the acceptance probes are RED for the exact
 * blockers §A names — `assertPlaceable`/`createTemplate` refuse every room-anchored
 * module outright, `loadModuleCopies` grafts only zone anchors, and the init
 * validator's fixed parent map rejects room-under-room — and the refusal probes are
 * RED because no depth arithmetic exists on this path at all.
 */

describe('phase-6-task-2 — nested locations through project initialization (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let orgs: OrgsService;
  let seq = 0;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    orgs = t.app.get(OrgsService);
  });
  afterAll(async () => {
    await sanctionedReset(t?.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor'], { cascade: true });
    // projects created by these probes (unique short prefix) — nodes/memberships cascade
    const created = await t.prisma.project.findMany({ where: { name: { startsWith: 'P6T2M ' } }, select: { id: true } });
    for (const p of created) {
      await t.prisma.auditLog.deleteMany({ where: { projectId: p.id } });
      await t.prisma.notification.deleteMany({ where: { projectId: p.id } });
      await t.prisma.inspection.deleteMany({ where: { projectId: p.id } });
      await t.prisma.activity.deleteMany({ where: { projectId: p.id } });
      await t.prisma.phase.deleteMany({ where: { projectId: p.id } });
      await t.prisma.membership.deleteMany({ where: { projectId: p.id } });
      await t.prisma.projectNode.deleteMany({ where: { projectId: p.id } });
      await t.prisma.project.delete({ where: { id: p.id } });
    }
    await f?.cleanup();
    await t?.close();
  });

  const owner = () => f.ownerUser.id;
  const orgId = () => f.orgA.id;

  const projectInput = (modules: object[], extra: object = {}) => ({
    name: `P6T2M ${seq}`,
    short: `p6t2m-${seq++}`,
    descriptor: '',
    stage: 'Planning',
    siteCode: '',
    location: '',
    projStart: '',
    projEnd: '',
    modules,
    ...extra,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  const refusal = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
    } catch (e) {
      return String((e as { message?: string }).message ?? e);
    }
    throw new Error('expected the call to be REFUSED, and it was accepted');
  };

  /** An element-root module ("Main Door") — `anchorKindOf` derives anchor 'room'. */
  const doorModule = async (): Promise<string> => {
    const m = await orgs.createModule(orgId(), owner(), {
      name: `Main Door ${seq++}`,
      category: 'element',
      description: '',
      payload: {
        nodes: [{ key: 'door', parentKey: null, name: 'Main Door', kind: 'element', order: 0 }],
        phases: [], activities: [], inspections: [],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    return m.id;
  };

  /** A zone-root module whose payload nests rooms `depth` levels below the zone. */
  const nestedZoneModule = async (roomChain: string[]): Promise<string> => {
    const nodes = [{ key: 'z', parentKey: null as string | null, name: `Zone ${seq}`, kind: 'zone' as const, order: 0 }];
    let parent = 'z';
    for (const [i, name] of roomChain.entries()) {
      nodes.push({ key: `r${i}`, parentKey: parent, name, kind: 'room' as never, order: i + 1 });
      parent = `r${i}`;
    }
    const m = await orgs.createModule(orgId(), owner(), {
      name: `Structure ${seq++}`,
      category: 'zone',
      description: '',
      payload: { nodes, phases: [], activities: [], inspections: [] },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    return m.id;
  };

  const treeOf = async (projectId: string) => {
    const rows = await t.prisma.projectNode.findMany({ where: { projectId } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    return { rows, parentOf: (name: string) => byId.get(rows.find((r) => r.name === name)?.parentId ?? '') };
  };

  // ── P11 — the element-root module, through the PUBLIC selector, at BOTH anchors ────────────

  it('P11 — an element-root module instantiates directly under a zone (underZone)', async () => {
    const moduleId = await doorModule();
    const p = await orgs.createProject(orgId(), owner(), projectInput([{ moduleId, count: 1, underZone: 'Entrance' }]));
    const { rows, parentOf } = await treeOf(p.id);
    const door = rows.find((r) => r.name === 'Main Door');
    expect(door?.kind).toBe('element');
    expect(parentOf('Main Door')?.name).toBe('Entrance');
    expect(parentOf('Main Door')?.kind).toBe('zone');
  });

  it('P11 — the SAME element-root module instantiates under a chosen room (underRoom) — the existing room-level shape survives', async () => {
    const structure = await nestedZoneModule(['Master Bedroom']);
    const moduleId = await doorModule();
    const p = await orgs.createProject(orgId(), owner(), projectInput([
      { moduleId: structure, count: 1 },
      { moduleId, count: 1, underRoom: 'Master Bedroom' },
    ]));
    const { rows, parentOf } = await treeOf(p.id);
    const door = rows.find((r) => r.name === 'Main Door');
    expect(door?.kind).toBe('element');
    expect(parentOf('Main Door')?.name).toBe('Master Bedroom');
    expect(parentOf('Main Door')?.kind).toBe('room');
  });

  it('P11 — an element module with NO explicit target is refused (never a silently invented container)', async () => {
    const moduleId = await doorModule();
    const message = await refusal(orgs.createProject(orgId(), owner(), projectInput([{ moduleId, count: 1 }])));
    expect(message).toMatch(/exactly one graft target|underRoom|underZone/i);
  });

  it('underRoom on a zone-anchored module is refused, not ignored', async () => {
    const structure = await nestedZoneModule(['Wing']);
    const message = await refusal(
      orgs.createProject(orgId(), owner(), projectInput([{ moduleId: structure, count: 1, underRoom: 'Wing' }])),
    );
    expect(message).toMatch(/does not anchor to a room/i);
  });

  // ── P16 — the nested-room module: init PRODUCES the new legal shape ─────────────────────────

  it('P16 — a module containing Zone > Room > Room instantiates the nested chain through init', async () => {
    const structure = await nestedZoneModule(['Wing', 'Pour Segment']);
    const p = await orgs.createProject(orgId(), owner(), projectInput([{ moduleId: structure, count: 1 }]));
    const { parentOf } = await treeOf(p.id);
    expect(parentOf('Pour Segment')?.name).toBe('Wing');
    expect(parentOf('Pour Segment')?.kind).toBe('room');
    expect(parentOf('Wing')?.kind).toBe('zone');
  });

  // ── P4 — a graft that would exceed 5 levels is refused, at the ACTUAL graft depth ───────────

  it('P4 — an element module grafted under a level-5 room is refused with the level stated', async () => {
    // Zone(1) > R0(2) > R1(3) > R2(4) > Deepest(5); the element would land at 6.
    const structure = await nestedZoneModule(['R0', 'R1', 'R2', 'Deepest']);
    const moduleId = await doorModule();
    const message = await refusal(orgs.createProject(orgId(), owner(), projectInput([
      { moduleId: structure, count: 1 },
      { moduleId, count: 1, underRoom: 'Deepest' },
    ])));
    expect(message).toMatch(/level 6|nest to 5 levels/i);
  });

  it('P4 — a payload whose OWN chain exceeds 5 levels is refused statically', async () => {
    const message = await refusal(nestedZoneModule(['A', 'B', 'C', 'D', 'E']).then((moduleId) =>
      orgs.createProject(orgId(), owner(), projectInput([{ moduleId, count: 1 }]))));
    expect(message).toMatch(/level 6|nest to 5 levels/i);
  });

  // ── P5 — an illegal parent chain is refused by the init validator ───────────────────────────

  it('P5 — a module whose element carries a CHILD (element under element) is refused', async () => {
    const m = await orgs.createModule(orgId(), owner(), {
      name: `Bad Chain ${seq++}`,
      category: 'element',
      description: '',
      payload: {
        nodes: [
          { key: 'door', parentKey: null, name: 'Main Door', kind: 'element', order: 0 },
          { key: 'lock', parentKey: 'door', name: 'Lock', kind: 'element', order: 1 },
        ],
        phases: [], activities: [], inspections: [],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const message = await refusal(
      orgs.createProject(orgId(), owner(), projectInput([{ moduleId: m.id, count: 1, underZone: 'Entrance' }])),
    );
    expect(message).toMatch(/invalid parent .*kind|invalid .* kind for element/i);
  });

  // ── P18 — the room-targeted module SAVED as a preset and EXPANDED at create-project ─────────

  it('P18 — a preset carrying a room-targeted element module saves AND expands under the chosen room', async () => {
    const structure = await nestedZoneModule(['Master Bedroom']);
    const moduleId = await doorModule();
    const preset = await orgs.createTemplate(orgId(), owner(), {
      name: `Door preset ${seq++}`,
      description: '',
      items: [
        { moduleId: structure, count: 1 },
        { moduleId, count: 1, underRoom: 'Master Bedroom' },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const p = await orgs.createProject(orgId(), owner(), projectInput([], { templateId: preset.id }));
    const { rows, parentOf } = await treeOf(p.id);
    const door = rows.find((r) => r.name === 'Main Door');
    expect(door?.kind).toBe('element');
    expect(parentOf('Main Door')?.name).toBe('Master Bedroom');
    expect(parentOf('Main Door')?.kind).toBe('room');
  });

  it('P18 — saving a preset whose element module names NO target is refused at save time, not expansion', async () => {
    const moduleId = await doorModule();
    const message = await refusal(orgs.createTemplate(orgId(), owner(), {
      name: `Unusable preset ${seq++}`,
      description: '',
      items: [{ moduleId, count: 1 }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any));
    expect(message).toMatch(/exactly one graft target|underRoom|underZone/i);
  });
});
