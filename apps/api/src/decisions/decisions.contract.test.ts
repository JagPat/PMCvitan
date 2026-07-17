import { describe, it, expect } from 'vitest';
import {
  DECISION_COMMANDS,
  DECISION_QUERIES,
  type CreateDecisionInput as SharedCreateDecisionInput,
  type ApproveDecisionInput as SharedApproveDecisionInput,
  type RequestDecisionChangeInput as SharedChangeInput,
  type DecisionView,
} from '@vitan/shared';
import { decisionsManifest } from './decisions.manifest';
import { DecisionsService } from './decisions.service';
import { DecisionsQueryService } from './decisions.query';
import type { CreateDecisionInput, ApproveInput, ChangeInput } from '../contracts';
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
      ].sort(),
    );
    // an extracted module reaches no other module's persistence — it depends on nothing
    expect(decisionsManifest.dependsOn).toEqual([]);
  });

  it('the query service implements every declared query (reachable read surface)', () => {
    for (const method of ['snapshotSlice', 'existsInProject', 'resolveRefInProject', 'countByNodeIds', 'countPending'] as const) {
      expect(typeof DecisionsQueryService.prototype[method]).toBe('function');
    }
  });

  // ── Compile-time contract conformance (these only type-check if the shapes line up) ──
  it('the API request DTOs conform to the shared command inputs, and the query view matches', () => {
    // the API's validated request bodies are valid shared command inputs
    const _create: SharedCreateDecisionInput = {} as CreateDecisionInput;
    const _approve: SharedApproveDecisionInput = {} as ApproveInput;
    const _change: SharedChangeInput = {} as ChangeInput;
    // the query response (the snapshot's DecisionDto) is the shared decision view
    const _view: DecisionView = {} as DecisionDto;
    // every command carries the Task-5 idempotency key (the 4th/5th positional arg)
    const _createKey: Parameters<DecisionsService['create']>[3] = 'k' as string | undefined;
    const _approveKey: Parameters<DecisionsService['approve']>[4] = 'k' as string | undefined;
    const _changeKey: Parameters<DecisionsService['requestChange']>[4] = 'k' as string | undefined;
    const _publishKey: Parameters<DecisionsService['publish']>[3] = 'k' as string | undefined;
    const _withdrawKey: Parameters<DecisionsService['withdrawChange']>[3] = 'k' as string | undefined;
    void [_create, _approve, _change, _view, _createKey, _approveKey, _changeKey, _publishKey, _withdrawKey];
    expect(true).toBe(true);
  });
});
