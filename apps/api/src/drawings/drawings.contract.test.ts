import { describe, it, expect } from 'vitest';
import { DRAWINGS_COMMANDS, DRAWINGS_QUERIES, type DrawingsModuleResult } from '@vitan/shared';
import { drawingsManifest } from './drawings.manifest';
import { DrawingsQueryService } from './drawings.query';

/**
 * Phase 2 Task 10 — the drawings module is reachable ONLY through its shared contract (commands +
 * queries) + its `drawing.*` events. This test pins that contract against the implementation: the
 * manifest's command/query lists equal the shared contract's, the module read-encapsulates every model
 * it owns, and the query service implements every declared query plus the module-owned HTTP read whose
 * return conforms to the ONE shared {@link DrawingsModuleResult}.
 */
describe('Task 10 — the drawings module implements its shared command/query contract', () => {
  it('the manifest commands EQUAL the shared command contract', () => {
    expect(drawingsManifest.commands).toEqual([...DRAWINGS_COMMANDS]);
  });

  it('the manifest queries EQUAL the shared query contract', () => {
    expect(drawingsManifest.queries).toEqual([...DRAWINGS_QUERIES]);
  });

  it('the module read-encapsulates every model it owns (fully extracted)', () => {
    expect(drawingsManifest.readEncapsulated).toEqual(drawingsManifest.ownsModels);
    // the rebuildable projection table is owned + encapsulated alongside the canonical models
    expect(drawingsManifest.ownsModels).toContain('drawingsProjection');
  });

  it('the manifest publishes exactly the controlled-drawing lifecycle events', () => {
    expect([...drawingsManifest.producesEvents].sort()).toEqual(
      [
        'drawing.acknowledged',
        'drawing.issued',
        'drawing.published',
        'drawing.recipients_frozen',
        'drawing.refiled',
        'drawing.removed',
        'drawing.revised',
      ].sort(),
    );
    // the module reads decisions through the decisions query contract (a linked decisionId is validated).
    expect(drawingsManifest.dependsOn).toEqual(['decisions']);
  });

  it('the query service implements every declared query + the readiness input (reachable read surface)', () => {
    for (const method of ['snapshotSlice', 'projectionSlice', 'moduleDrawings', 'readinessSlice', 'existsInProject', 'resolveRefInProject'] as const) {
      expect(typeof DrawingsQueryService.prototype[method]).toBe('function');
    }
  });

  // ── Compile-time contract conformance (only type-checks if the shapes line up) ──
  it('the module HTTP result is the ONE shared type; the API moduleDrawings return conforms to it', () => {
    // finding 5 (daily-log) parity — the API's moduleDrawings return conforms to the shared type the web
    // gateway also imports, so the two cannot drift.
    const _mod: DrawingsModuleResult = {} as Awaited<ReturnType<DrawingsQueryService['moduleDrawings']>>;
    void _mod;
    expect(true).toBe(true);
  });
});
