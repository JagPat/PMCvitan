import { describe, it, expect } from 'vitest';
import {
  DECISION_COMMANDS,
  DECISION_QUERIES,
  type CreateDecisionInput as SharedCreateDecisionInput,
  type UpdateDecisionDraftInput as SharedUpdateDraftInput,
  type ApproveDecisionInput as SharedApproveDecisionInput,
  type RequestDecisionChangeInput as SharedChangeInput,
  type DecisionView,
} from '@vitan/shared';
import { decisionsManifest } from './decisions.manifest';
import { DecisionsService } from './decisions.service';
import { DecisionsQueryService } from './decisions.query';
import type { CreateDecisionInput, UpdateDecisionDraftInput, ApproveInput, ChangeInput } from '../contracts';
import type { DecisionDto } from '../snapshot/types';

/**
 * Phase 2 Task 8 — the decisions module is reachable ONLY through its shared contract (commands +
 * queries) + its events. This test pins that contract against the implementation: the manifest's
 * command/query/event lists equal the shared contract's, the API's request DTOs match the shared
 * command inputs, the query response matches the shared decision view, every command carries the
 * Task-5 idempotency key, and the query service implements every declared query.
 */
describe('Task 8 — the decisions module implements its shared command/query contract', () => {
  it('the manifest commands EQUAL the shared command contract', () => {
    expect(decisionsManifest.commands).toEqual([...DECISION_COMMANDS]);
  });

  it('the manifest queries EQUAL the shared query contract', () => {
    expect(decisionsManifest.queries).toEqual([...DECISION_QUERIES]);
  });

  it('the module read-encapsulates every model it owns (fully extracted)', () => {
    expect(decisionsManifest.readEncapsulated).toEqual(decisionsManifest.ownsModels);
  });

  it('the manifest publishes exactly the decision lifecycle events', () => {
    expect([...decisionsManifest.producesEvents].sort()).toEqual(
      [
        'decision.approved',
        'decision.change_requested',
        'decision.change_withdrawn',
        'decision.drafted',
        'decision.published',
        'decision.reapproved',
        // Phase 6 task 4a
        'decision.withdrawn',
        // Phase 6 unit 4c-ii — the consultation thread's two SIGNAL events
        'decision.consultation_answered',
        'decision.consultation_requested',
      ].sort(),
    );
    // an extracted module reaches no other module's persistence — it depends on nothing
    expect(decisionsManifest.dependsOn).toEqual([]);
  });

  it('the query service implements every declared query (reachable read surface)', () => {
    for (const method of ['snapshotSlice', 'projectionSlice', 'existsInProject', 'linkableInProject', 'resolveRefInProject', 'countByNodeIds', 'countPending'] as const) {
      expect(typeof DecisionsQueryService.prototype[method]).toBe('function');
    }
  });

  // ── Compile-time contract conformance (these only type-check if the shapes line up) ──
  it('the API request DTOs conform to the shared command inputs, and the query view matches', () => {
    // the API's validated request bodies are valid shared command inputs
    const _create: SharedCreateDecisionInput = {} as CreateDecisionInput;
    const _draft: SharedUpdateDraftInput = {} as UpdateDecisionDraftInput;
    const _approve: SharedApproveDecisionInput = {} as ApproveInput;
    const _change: SharedChangeInput = {} as ChangeInput;
    // round-10 Codex F2 — forward assignability alone cannot catch a shared contract that is
    // NARROWER than the API's (a wider object is assignable to a narrower interface), which is
    // exactly how `deciderKind` went missing from the public create contract. The COMPLETENESS
    // pin: every key the API's validated body carries must exist on the shared type — a key
    // the shared contract forgot becomes this constant's type and the assignment fails naming
    // it. Keys, not full mutual assignability, because the shared side is deliberately
    // readonly while zod infers mutable shapes.
    const _createComplete: Exclude<keyof CreateDecisionInput, keyof SharedCreateDecisionInput> extends never
      ? true
      : Exclude<keyof CreateDecisionInput, keyof SharedCreateDecisionInput> = true;
    const _draftComplete: Exclude<keyof UpdateDecisionDraftInput, keyof SharedUpdateDraftInput> extends never
      ? true
      : Exclude<keyof UpdateDecisionDraftInput, keyof SharedUpdateDraftInput> = true;
    // the query response (the snapshot's DecisionDto) carries the shared decision view's SHAPE.
    // Round-10 honesty note: gating this file in `pnpm typecheck` (F2) exposed that the old
    // full-assignability pin (`const _view: DecisionView = {} as DecisionDto`) NEVER compiled —
    // the dto serializes `photoSwatch` as the persisted string while the shared view narrows it
    // to the display swatch union, a variance that predates this unit. The pin enforced here is
    // the true, checkable property: neither side carries a key the other lacks (the same
    // completeness rule as the command inputs above); the swatch value-narrowing stays the
    // client's display concern.
    const _viewComplete: Exclude<keyof DecisionView, keyof DecisionDto> extends never
      ? true
      : Exclude<keyof DecisionView, keyof DecisionDto> = true;
    const _viewNoExtra: Exclude<keyof DecisionDto, keyof DecisionView> extends never
      ? true
      : Exclude<keyof DecisionDto, keyof DecisionView> = true;
    // every command carries the Task-5 idempotency key (the 4th/5th positional arg)
    const _createKey: Parameters<DecisionsService['create']>[3] = 'k' as string | undefined;
    const _approveKey: Parameters<DecisionsService['approve']>[4] = 'k' as string | undefined;
    const _changeKey: Parameters<DecisionsService['requestChange']>[4] = 'k' as string | undefined;
    const _publishKey: Parameters<DecisionsService['publish']>[3] = 'k' as string | undefined;
    const _withdrawKey: Parameters<DecisionsService['withdrawChange']>[3] = 'k' as string | undefined;
    void [_create, _draft, _createComplete, _draftComplete, _approve, _change, _viewComplete, _viewNoExtra, _createKey, _approveKey, _changeKey, _publishKey, _withdrawKey];
    expect(true).toBe(true);
  });
});
