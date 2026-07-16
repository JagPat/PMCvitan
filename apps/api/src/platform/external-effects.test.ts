import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { DOMAIN_EVENT_TYPES } from '@vitan/shared';
import {
  EXTERNAL_EFFECTS,
  effectCoverageVersion,
  buildDispatchIntent,
  type ExternalEffectKey,
  type PushRole,
} from './external-effects';

/**
 * PR C Task 1 — the external-effect catalog contract. Keys are unique, every event type is a real
 * shared-catalog type, push roles are valid, the coverage version is a stable order-independent
 * SHA-256, and a dispatch that contradicts its catalog entry is rejected before any event is written.
 */

const VALID_ROLES: readonly PushRole[] = ['pmc', 'client', 'contractor', 'engineer', 'consultant'];
const EVENT_TYPES = new Set<string>(DOMAIN_EVENT_TYPES);
const keys = Object.keys(EXTERNAL_EFFECTS) as ExternalEffectKey[];

describe('PR C — external-effect catalog', () => {
  it('has unique keys', () => {
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every effect maps to a real shared DomainEvent type', () => {
    for (const k of keys) expect(EVENT_TYPES.has(EXTERNAL_EFFECTS[k].eventType), `${k} → ${EXTERNAL_EFFECTS[k].eventType}`).toBe(true);
  });

  it('every push role set is valid, non-empty when present, and null for no-push keys', () => {
    for (const k of keys) {
      const push = EXTERNAL_EFFECTS[k].push;
      if (push === null) continue;
      expect(push.length, `${k} push roles non-empty`).toBeGreaterThan(0);
      for (const r of push) expect(VALID_ROLES.includes(r), `${k} role ${r}`).toBe(true);
    }
  });

  it('a no-invalidation key never carries a push (drafts/internal are fully weightless)', () => {
    for (const k of keys) {
      if (!EXTERNAL_EFFECTS[k].invalidate) expect(EXTERNAL_EFFECTS[k].push, `${k} is weightless`).toBeNull();
    }
  });

  it('effectCoverageVersion is a deterministic 64-hex SHA-256', () => {
    const v = effectCoverageVersion();
    expect(v).toMatch(/^[0-9a-f]{64}$/);
    expect(effectCoverageVersion()).toBe(v); // stable across calls
  });

  it('the coverage version is ORDER-INDEPENDENT (canonical sort)', () => {
    // recompute the hash from a REVERSED key order using the same canonical formula; a stable version
    // must be identical regardless of declaration order.
    const preimage = (order: ExternalEffectKey[]) =>
      JSON.stringify(
        order
          .slice()
          .sort()
          .map((k) => {
            const d = EXTERNAL_EFFECTS[k];
            return [k, d.eventType, d.invalidate, d.push === null ? null : [...d.push].slice().sort()];
          }),
      );
    const reversed = createHash('sha256').update(preimage([...keys].reverse())).digest('hex');
    expect(reversed).toBe(effectCoverageVersion());
  });

  describe('buildDispatchIntent', () => {
    it('derives invalidate + roles from the catalog and stamps the coverage version', () => {
      const intent = buildDispatchIntent('decision.published', 'decision.published', { push: { body: 'hi' } });
      expect(intent).toEqual({
        effectKey: 'decision.published',
        coverageVersion: effectCoverageVersion(),
        invalidate: true,
        push: { body: 'hi', roles: ['client'] },
      });
    });

    it('a no-push key with no push body yields an intent with no push', () => {
      const intent = buildDispatchIntent('activity.updated', 'activity.updated', {});
      expect(intent.push).toBeUndefined();
      expect(intent.invalidate).toBe(true);
    });

    it('rejects an unknown key', () => {
      expect(() => buildDispatchIntent('nope.nope' as ExternalEffectKey, 'decision.published', {})).toThrow(/unknown external-effect key/);
    });

    it('rejects an eventType that disagrees with the catalog', () => {
      expect(() => buildDispatchIntent('decision.published', 'decision.drafted', {})).toThrow(/is declared for event/);
    });

    it('rejects a push body on a key that may not push', () => {
      expect(() => buildDispatchIntent('activity.updated', 'activity.updated', { push: { body: 'nope' } })).toThrow(/may not push/);
    });

    it('a weightless draft key produces no invalidation and no push', () => {
      const intent = buildDispatchIntent('decision.drafted', 'decision.drafted', {});
      expect(intent.invalidate).toBe(false);
      expect(intent.push).toBeUndefined();
    });
  });
});
