import { describe, it, expect } from 'vitest';
import { SEED_NODES, SEED_DECISIONS, SEED_ACTIVITIES, SEED_INSPECTIONS, SEED_LOG_MATERIALS, STARTER_MODULES, STARTER_TEMPLATE } from './seed-data';
import { modulePayloadSchema } from '../contracts';

/**
 * Seed-alignment drift guard (data-flow audit finding #1). The API seed is a hand-mirror
 * of `packages/shared/src/domain/seed.ts` (source-only — not importable here), so this
 * test pins the spine the same way route-policy.test.ts pins ROLE_POLICY: change the
 * demo's tree/attachments and this fails until the API seed is updated in lockstep.
 */

// MUST stay identical to shared SEED_NODES (id → kind), incl. the draft Basement branch.
const EXPECTED_TREE: Record<string, 'zone' | 'room' | 'element'> = {
  'z-gf': 'zone',
  'r-living': 'room',
  'r-entrance': 'room',
  'e-maindoor': 'element',
  'r-kitchen': 'room',
  'z-sf': 'zone',
  'r-mbath': 'room',
  'z-terrace': 'zone',
  'z-basement': 'zone',
  'r-cellar': 'room',
};

describe('API seed ↔ demo spine alignment', () => {
  it('the seeded tree mirrors the demo tree exactly (ids + kinds)', () => {
    const got = Object.fromEntries(SEED_NODES.map((n) => [n.id, n.kind]));
    expect(got).toEqual(EXPECTED_TREE);
  });

  it('the tree obeys the spine kind rules (zone→null, room→zone, element→room)', () => {
    const byId = new Map(SEED_NODES.map((n) => [n.id, n]));
    for (const n of SEED_NODES) {
      const parent = n.parentId ? byId.get(n.parentId) : undefined;
      if (n.kind === 'zone') expect(n.parentId).toBeNull();
      if (n.kind === 'room') expect(parent?.kind).toBe('zone');
      if (n.kind === 'element') expect(parent?.kind).toBe('room');
    }
  });

  it('every seeded record files onto a node that exists (no dangling nodeId)', () => {
    const ids = new Set(SEED_NODES.map((n) => n.id));
    for (const d of SEED_DECISIONS) if (d.nodeId) expect(ids.has(d.nodeId), `decision ${d.id} → ${d.nodeId}`).toBe(true);
    for (const a of SEED_ACTIVITIES) if (a.nodeId) expect(ids.has(a.nodeId), `activity ${a.id} → ${a.nodeId}`).toBe(true);
    for (const i of SEED_INSPECTIONS) if (i.nodeId) expect(ids.has(i.nodeId), `inspection ${i.id} → ${i.nodeId}`).toBe(true);
    for (const m of SEED_LOG_MATERIALS) if (m.nodeId) expect(ids.has(m.nodeId), `material ${m.name} → ${m.nodeId}`).toBe(true);
  });

  it('nothing published files onto a draft node (the spine invariant)', () => {
    const draftIds = new Set(SEED_NODES.filter((n) => n.draft).map((n) => n.id));
    for (const d of SEED_DECISIONS.filter((x) => !x.draft)) if (d.nodeId) expect(draftIds.has(d.nodeId)).toBe(false);
    for (const a of SEED_ACTIVITIES) if (a.nodeId) expect(draftIds.has(a.nodeId)).toBe(false);
    for (const i of SEED_INSPECTIONS) if (i.nodeId) expect(draftIds.has(i.nodeId)).toBe(false);
  });

  it('exactly the demo drafts: decision DL-015 and the Basement branch', () => {
    expect(SEED_DECISIONS.filter((d) => d.draft).map((d) => d.id)).toEqual(['DL-015']);
    expect(SEED_NODES.filter((n) => n.draft).map((n) => n.id).sort()).toEqual(['r-cellar', 'z-basement']);
  });

  it('the demo cross-links hold: DL-014 ↔ ACT-31 on the Living Room, ponding review on the Terrace', () => {
    expect(SEED_DECISIONS.find((d) => d.id === 'DL-014')?.nodeId).toBe('r-living');
    const act31 = SEED_ACTIVITIES.find((a) => a.id === 'ACT-31');
    expect(act31?.decisionId).toBe('DL-014');
    expect(act31?.nodeId).toBe('r-living');
    expect(SEED_INSPECTIONS.find((i) => i.id === 'INSP-21')?.nodeId).toBe('z-terrace');
  });
});

describe('Vitan starter template library', () => {
  it('every starter module payload satisfies the module contract', () => {
    for (const m of STARTER_MODULES) {
      const parsed = modulePayloadSchema.safeParse(m.payload);
      expect(parsed.success, `${m.name}: ${parsed.success ? '' : parsed.error.message}`).toBe(true);
    }
  });

  it('declared anchors match the payload roots — and every module is placeable at create', () => {
    for (const m of STARTER_MODULES) {
      const keys = new Set(m.payload.nodes.map((n) => n.key));
      const roots = m.payload.nodes.filter((n) => !n.parentKey || !keys.has(n.parentKey));
      const expected = roots.some((r) => r.kind === 'element') ? 'room' : roots.some((r) => r.kind === 'room') ? 'zone' : null;
      expect(m.anchorKind, m.name).toBe(expected);
      // an anchorKind 'room' module can't be placed at create-project (Slice 2 limitation) —
      // the starter menu must never ship one
      expect(m.anchorKind, m.name).not.toBe('room');
    }
  });

  it('module payloads are internally consistent (node/phase references resolve)', () => {
    for (const m of STARTER_MODULES) {
      const keys = new Set(m.payload.nodes.map((n) => n.key));
      const phaseNames = new Set(m.payload.phases.map((p) => p.name));
      for (const n of m.payload.nodes) if (n.parentKey) expect(keys.has(n.parentKey), `${m.name}: node ${n.key}`).toBe(true);
      for (const a of m.payload.activities) {
        if (a.nodeKey) expect(keys.has(a.nodeKey), `${m.name}: activity ${a.name}`).toBe(true);
        if (a.phaseName) expect(phaseNames.has(a.phaseName), `${m.name}: activity ${a.name}`).toBe(true);
      }
      for (const i of m.payload.inspections) if (i.nodeKey) expect(keys.has(i.nodeKey), `${m.name}: inspection ${i.title}`).toBe(true);
    }
  });

  it('the G+2 Residence preset references only defined, unique starter modules', () => {
    const names = STARTER_MODULES.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length); // names are the join key — must be unique
    for (const item of STARTER_TEMPLATE.items) {
      expect(names, item.moduleName).toContain(item.moduleName);
      expect(item.count).toBeGreaterThanOrEqual(1);
    }
  });
});
