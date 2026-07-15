import { describe, it, expect } from 'vitest';
import * as apiSeed from './seed-data';
import * as shared from '@vitan/shared';
import { SEED_NODES, SEED_DECISIONS, SEED_ACTIVITIES, SEED_INSPECTIONS, SEED_LOG_MATERIALS, STARTER_MODULES, STARTER_TEMPLATE } from './seed-data';
import { modulePayloadSchema } from '../contracts';

/**
 * Phase 2 Task 2 — the location-tree SEED MIRROR IS RETIRED. The API no longer keeps
 * its own copy of the demo tree; `SEED_NODES` is re-exported from the built
 * `@vitan/shared` runtime package, so the imported-identity assertion below proves the
 * API seeds from the SAME tree object the web uses. The remaining tests then guard that
 * the API's DB-seed shapes (decisions/activities/inspections/materials — a distinct
 * Prisma-create representation, NOT a shared mirror) file only onto nodes of that one
 * shared tree, so a spine change still fails here.
 */

// Derived from the ONE shared tree — no hand-mirrored EXPECTED_TREE literal anymore.
const EXPECTED_TREE: Record<string, string> = Object.fromEntries(shared.SEED_NODES.map((n) => [n.id, n.kind]));

describe('API seed ↔ demo spine alignment', () => {
  it('the API re-exports the SAME SEED_NODES tree object as @vitan/shared (mirror retired)', () => {
    expect(apiSeed.SEED_NODES).toBe(shared.SEED_NODES);
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
