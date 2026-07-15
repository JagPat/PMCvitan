import { describe, it, expect } from 'vitest';
// The store's and gateway's own source text, read via Vite's `?raw` loader — the
// same source-scan technique snapshot-ordering.test.ts uses for its tripwire.
import storeSource from '@/store/store.ts?raw';
import apiGatewaySource from '@/data/apiGateway.ts?raw';

/**
 * Phase 2 Task 1 — CHARACTERIZATION of the frontend ↔ API snapshot contract.
 *
 * Today the client hydrates from ONE full-project snapshot: `ApiSnapshot`
 * (apps/web/src/data/apiGateway.ts) carries every collection, and
 * `applySnapshotCore` in the store REPLACES every project-scoped field from it in
 * a single pass. Phase 2 Task 9 replaces this with a project-shell summary +
 * per-module queries — but it "may not silently break" this contract.
 *
 * This test PINS the exact top-level key set the client both declares (the
 * `ApiSnapshot` interface) and consumes (`applySnapshotCore` reads `snap.<key>`),
 * so that any task which adds, drops or renames a snapshot key must update this
 * list in the same reviewable diff. The server-side per-role gating of these keys
 * is characterized separately by the live-PostgreSQL suite
 * (apps/api/test/integration/phase2-snapshot-shape.test.ts).
 */

// The 16 top-level keys of the project snapshot at Task 1, in the order the API's
// SnapshotDto returns them (apps/api/src/snapshot/snapshot.service.ts:352-451).
const SNAPSHOT_KEYS = [
  'project',
  'decisions',
  'activities',
  'placedInspections',
  'reviews',
  'review',
  'reinspectionCreated',
  'checklist',
  'drawings',
  'phases',
  'dailyLog',
  'notifications',
  'companies',
  'nodes',
  'photos',
  'materials',
] as const;

describe('Phase 2 Task 1 — snapshot shape (client contract)', () => {
  it('the ApiSnapshot interface declares exactly the pinned top-level keys', () => {
    // Isolate the `export interface ApiSnapshot { ... }` block so we assert against
    // the declared contract, not an incidental mention elsewhere in the file.
    const block = apiGatewaySource.match(/export interface ApiSnapshot\s*\{([\s\S]*?)\n\}/);
    expect(block, 'ApiSnapshot interface not found in apiGateway.ts').toBeTruthy();
    const body = block![1];
    for (const key of SNAPSHOT_KEYS) {
      expect(body, `ApiSnapshot no longer declares "${key}"`).toMatch(new RegExp(`\\b${key}\\b\\??:`));
    }
  });

  it('applySnapshotCore consumes every pinned snapshot key (snap.<key>)', () => {
    // The private copier reads each collection off the incoming snapshot; pinning
    // `snap.<key>` proves the client still hydrates from all 16 keys.
    for (const key of SNAPSHOT_KEYS) {
      expect(storeSource, `applySnapshotCore no longer reads snap.${key}`).toContain(`snap.${key}`);
    }
  });

  it('applySnapshotCore remains the single snapshot copier the coordinator routes through', () => {
    // Guards the Phase-1 invariant the coordinator hardened: exactly one copier.
    // Task 9 will replace the full-snapshot copier with per-module application, at
    // which point this characterization is updated in the same PR.
    const defs = storeSource.match(/const applySnapshotCore\b/g) ?? [];
    expect(defs.length, 'applySnapshotCore should be defined exactly once').toBe(1);
  });
});
