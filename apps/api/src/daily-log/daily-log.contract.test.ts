import { describe, it, expect } from 'vitest';
import {
  DAILY_LOG_COMMANDS,
  DAILY_LOG_QUERIES,
  type AddMaterialInput as SharedAddMaterialInput,
  type FlagMismatchInput as SharedFlagMismatchInput,
  type SubmitDailyLogInput as SharedSubmitDailyLogInput,
  type DailyLogCoreView,
  type DailyLogSnapshotResult,
} from '@vitan/shared';
import { dailyLogManifest } from './daily-log.manifest';
import { DailyLogQueryService, type DailyLogCore } from './daily-log.query';
import type { AddMaterialInput, FlagMismatchInput, SubmitDailyLogInput } from '../contracts';

/**
 * Phase 2 Task 10 — the daily-log module is reachable ONLY through its shared contract (commands +
 * queries) + its events. This test pins that contract against the implementation: the manifest's
 * command/query lists equal the shared contract's, the API's request DTOs match the shared command
 * inputs, the query results match the shared views, and the query service implements every declared
 * query. Unlike decisions, daily-log commands do NOT carry a Task-5 idempotency key (their POST
 * handlers take no key), so this test pins only what the module actually implements.
 */
describe('Task 10 — the daily-log module implements its shared command/query contract', () => {
  it('the manifest commands EQUAL the shared command contract', () => {
    expect(dailyLogManifest.commands).toEqual([...DAILY_LOG_COMMANDS]);
  });

  it('the manifest queries EQUAL the shared query contract', () => {
    expect(dailyLogManifest.queries).toEqual([...DAILY_LOG_QUERIES]);
  });

  it('the module read-encapsulates every model it owns (fully extracted)', () => {
    expect(dailyLogManifest.readEncapsulated).toEqual(dailyLogManifest.ownsModels);
  });

  it('the manifest publishes exactly the daily-log lifecycle events', () => {
    expect([...dailyLogManifest.producesEvents].sort()).toEqual(
      ['dailylog.started', 'dailylog.submitted', 'material.added', 'material.mismatch_flagged'].sort(),
    );
    // the module reads decisions through the decisions query contract; the material-mismatch flag is a
    // WORKFLOW participation with activities (edge 4), NOT a persistence dependency.
    expect(dailyLogManifest.dependsOn).toEqual(['decisions']);
    expect(dailyLogManifest.workflowParticipants).toContain('activities');
  });

  it('the query service implements every declared query (reachable read surface)', () => {
    for (const method of ['snapshotSlice', 'existsInProject', 'resolveRefInProject'] as const) {
      expect(typeof DailyLogQueryService.prototype[method]).toBe('function');
    }
  });

  // ── Compile-time contract conformance (these only type-check if the shapes line up) ──
  it('the API request DTOs conform to the shared command inputs, and the query results match', () => {
    // the API's validated request bodies are valid shared command inputs
    const _add: SharedAddMaterialInput = {} as AddMaterialInput;
    const _flag: SharedFlagMismatchInput = {} as FlagMismatchInput;
    const _submit: SharedSubmitDailyLogInput = {} as SubmitDailyLogInput;
    // the query results (the photo-less daily-log core + the snapshot slice) are the shared views
    const _core: DailyLogCoreView = {} as DailyLogCore;
    const _slice: DailyLogSnapshotResult = {} as Awaited<ReturnType<DailyLogQueryService['snapshotSlice']>>;
    void [_add, _flag, _submit, _core, _slice];
    expect(true).toBe(true);
  });
});
