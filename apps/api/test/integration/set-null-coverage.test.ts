import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DOMAIN_EVENT_TYPES } from '@vitan/shared';
import { PrismaService } from '../../src/prisma.service';
import { MANIFEST_BY_ID } from '../../src/platform/module-registry/registry';

/**
 * Module-4 correction — the ON DELETE SET NULL coverage table (live PG).
 *
 * A SET NULL FK action mutates a canonical column with NO command and NO event: the deleting
 * command's own event is foreign to the column's owner, so if the column is serialized into a
 * module projection base, the owning consumer records a noop, the ordered cursor advances, and
 * the generation claims CURRENT while serving the stale reference. Every column the database
 * can null this way must therefore be CLASSIFIED here: either an owner-aligned signal event is
 * appended by the owning module's participant on the deleting transaction (the correction), or
 * the column is provably not serialized into any module projection (exempt, with the reason).
 *
 * This test discovers the real constraint surface from pg_constraint (confdeltype = 'n'),
 * respecting PostgreSQL 15+ column-list actions (`ON DELETE SET NULL (col)` — confdelsetcols),
 * so a NEW SET NULL FK — or widening an existing one — fails the exact-equality tripwire until
 * a reviewer classifies it.
 */

type Classification =
  | { signal: string; participant: string; ownerModule: string }
  | { exempt: string };

/** (table.column) → how the silent null reaches (or provably cannot reach) a projection. */
const COVERAGE: Record<string, Classification> = {
  // ── nodes.remove (the location-spine delete; subtree collected in the same tx) ──────────────
  'Activity.nodeId': {
    signal: 'activity.unfiled',
    participant: 'ActivityParticipant.unfileForDeletedNodes',
    ownerModule: 'activities',
  },
  'Inspection.nodeId': {
    signal: 'inspection.unfiled',
    participant: 'InspectionParticipant.unfileForDeletedNodes',
    ownerModule: 'inspections',
  },
  'Drawing.nodeId': {
    signal: 'drawing.unfiled',
    participant: 'DrawingParticipant.unfileForDeletedNodes',
    ownerModule: 'drawings',
  },
  'SiteMaterial.nodeId': {
    signal: 'material.unfiled',
    participant: 'DailyLogParticipant.unfileMaterialsForDeletedNodes',
    ownerModule: 'daily-log',
  },
  'Media.nodeId': {
    exempt:
      'no module projection serializes Media.nodeId — the snapshot photo layer is a LIVE read ' +
      '(SnapshotService attaches placed photos per request), so a silent null can never be served stale',
  },
  // ── activities.remove ───────────────────────────────────────────────────────────────────────
  'Drawing.activityId': {
    signal: 'drawing.activity_unlinked',
    participant: 'DrawingParticipant.unlinkFromDeletedActivity',
    ownerModule: 'drawings',
  },
  // ── account lifecycle (outside project command flow) ────────────────────────────────────────
  'SecurityAuditEvent.actorUserId': {
    exempt:
      'nulled when a User account is deleted; SecurityAuditEvent is the global append-only security ' +
      'log (auth module), not project-scoped and never serialized into any module projection — it is ' +
      'read live, so an anonymized actor can never be served stale',
  },
  // ── phases.remove (same module as the projected column) ─────────────────────────────────────
  'Activity.phaseId': {
    exempt:
      'covered by the OWNING module\'s existing `phase.removed` event: Phase and Activity share the ' +
      'activities module, its schedule consumer dispatches on the phase.* prefix and refreshes the ' +
      'WHOLE per-project base, so the nulled phaseId is re-serialized before the cursor advances',
  },
};

describe('Module-4 correction — ON DELETE SET NULL coverage table (live PG)', () => {
  let prisma: PrismaService;
  let nulledColumns: string[];

  beforeAll(async () => {
    prisma = new PrismaService();
    // Every (table, column) pair a delete can silently null: for a column-list action
    // (confdelsetcols non-empty) only those columns are nulled; otherwise ALL constrained columns.
    const rows = await prisma.$queryRaw<{ tbl: string; col: string }[]>`
      SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
      FROM pg_constraint c
      JOIN pg_attribute a
        ON a.attrelid = c.conrelid
       AND a.attnum = ANY (CASE WHEN cardinality(c.confdelsetcols) > 0 THEN c.confdelsetcols ELSE c.conkey END)
      WHERE c.contype = 'f' AND c.confdeltype = 'n' AND c.connamespace = 'public'::regnamespace
      ORDER BY 1, 2`;
    nulledColumns = rows.map((r) => `${r.tbl.replace(/"/g, '')}.${r.col}`);
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('every column a SET NULL delete action can silently null is classified (exact equality)', () => {
    expect([...new Set(nulledColumns)].sort()).toEqual(Object.keys(COVERAGE).sort());
  });

  it('no SET NULL action nulls a tenant column (a column-list action protects projectId)', () => {
    for (const pair of nulledColumns) expect(pair.endsWith('.projectId'), `${pair} must never be nulled`).toBe(false);
  });

  it('every signal classification names a real catalog event produced by the owning module', () => {
    for (const [pair, c] of Object.entries(COVERAGE)) {
      if (!('signal' in c)) continue;
      expect(DOMAIN_EVENT_TYPES as readonly string[], `${pair} signal is a catalog member`).toContain(c.signal);
      const manifest = MANIFEST_BY_ID.get(c.ownerModule);
      expect(manifest, `${pair} owner module ${c.ownerModule} exists`).toBeDefined();
      expect(manifest!.producesEvents, `${pair} signal is declared by ${c.ownerModule}`).toContain(c.signal);
    }
  });
});
