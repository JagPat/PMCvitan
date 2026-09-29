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

const VALID_ROLES: readonly PushRole[] = ['pmc', 'client', 'contractor', 'engineer', 'consultant', 'architect'];
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
            // Phase 6 task 4b — the family declaration joins the sealed preimage: a family
            // change alters claim-time delivery semantics, so it must move the version.
            // `pushOptional` was a sixth element here from round 5 (finding 4) until round 18
            // deleted the flag: the obligation belongs to a BRANCH, so a branch that says nothing
            // has its own `push: null` key and there is no per-key qualifier left to hash. This
            // replica exists to prove the real formula is order-independent, so it has to carry
            // the same fields; when it drifts from `canonicalCatalog()` this arm fails, which is
            // how the round-5 omission was caught here in the first place.
            // Phase 6 unit 4d-i-b — `pairingRequired` is the SIXTH element: it decides the sealed
            // catalog column the kernel's pairing seal reads, so it moves the version too.
            // Phase 6 unit 4d-ii-a / A7d — `frozenAudience` and `pushBody` are the SEVENTH and
            // EIGHTH: both are sealed catalog columns the seals read.
            const d = EXTERNAL_EFFECTS[k] as (typeof EXTERNAL_EFFECTS)[ExternalEffectKey]
              & { pushFamily?: string; pairingRequired?: true; frozenAudience?: true; pushBody?: string };
            return [k, d.eventType, d.invalidate, d.push === null ? null : [...d.push].slice().sort(),
              d.pushFamily ?? null, d.pairingRequired === true, d.frozenAudience === true, d.pushBody ?? null];
          }),
      );
    const reversed = createHash('sha256').update(preimage([...keys].reverse())).digest('hex');
    expect(reversed).toBe(effectCoverageVersion());
  });

  describe('buildDispatchIntent', () => {
    it('derives invalidate + roles from the catalog and stamps the coverage version', () => {
      // Phase 6 task 4b — with no caller narrowing, the persisted roles are the catalog CEILING
      // (the decider dispatch site narrows to the actual decider; the claim re-judges at send).
      const intent = buildDispatchIntent('decision.published', 'decision.published', { push: { body: 'hi' } });
      expect(intent).toEqual({
        effectKey: 'decision.published',
        coverageVersion: effectCoverageVersion(),
        invalidate: true,
        push: { body: 'hi', roles: ['client', 'pmc', 'contractor', 'engineer', 'consultant', 'architect'] },
      });
    });

    describe('4d-ii-a / A7d — the frozen-audience families and `targetUserIds`', () => {
      it('a frozen family carries its recipients as the canonical (sorted, distinct) set and the catalog body', () => {
        const intent = buildDispatchIntent('decision.awaiting_countersign', 'decision.awaiting_countersign', {
          push: { body: 'A decision awaits your countersign', targetUserIds: ['u-b', 'u-a', 'u-b'] },
        });
        expect(intent.push).toEqual({ body: 'A decision awaits your countersign', roles: ['architect'], targetUserIds: ['u-a', 'u-b'] });
        expect(EXTERNAL_EFFECTS['decision.forwarded'].frozenAudience).toBe(true);
        expect(EXTERNAL_EFFECTS['decision.awaiting_countersign'].frozenAudience).toBe(true);
      });
      it('the set is refused on every non-frozen family, and a frozen family refuses an empty, blank, scalar-targeted or re-worded push', () => {
        expect(() => buildDispatchIntent('decision.published', 'decision.published', { push: { body: 'hi', targetUserIds: ['u-a'] } }))
          .toThrow(/not a frozen-audience family/);
        expect(() => buildDispatchIntent('decision.consultation_requested', 'decision.consultation_requested', { push: { body: 'hi', targetUserId: 'u-a', targetUserIds: ['u-a'] } }))
          .toThrow(/not a frozen-audience family/);
        expect(() => buildDispatchIntent('decision.forwarded', 'decision.forwarded', { push: { body: 'A decision has been forwarded to you', targetUserIds: [] } }))
          .toThrow(/at least one user/);
        expect(() => buildDispatchIntent('decision.forwarded', 'decision.forwarded', { push: { body: 'A decision has been forwarded to you', targetUserIds: ['u-a', ' '] } }))
          .toThrow(/at least one user, each a nonblank id/);
        expect(() => buildDispatchIntent('decision.forwarded', 'decision.forwarded', { push: { body: 'A decision has been forwarded to you', targetUserId: 'u-a', targetUserIds: ['u-a'] } }))
          .toThrow(/never a scalar targetUserId/);
        expect(() => buildDispatchIntent('decision.forwarded', 'decision.forwarded', { push: { body: 'A decision has been forwarded to you' } }))
          .toThrow(/freezes its recipients/);
        expect(() => buildDispatchIntent('decision.forwarded', 'decision.forwarded', { push: { body: 'Please look', targetUserIds: ['u-a'] } }))
          .toThrow(/announces its catalog body/);
      });
      it('every frozen family declares a constant body, no other key does, and both are pairing-required', () => {
        for (const k of keys) {
          const d = EXTERNAL_EFFECTS[k] as { frozenAudience?: true; pushBody?: string; pairingRequired?: true; push: unknown };
          expect(d.frozenAudience === true, `${k} frozenAudience ⇔ pushBody`).toBe(typeof d.pushBody === 'string');
          if (d.frozenAudience) {
            expect(d.push, `${k} a frozen family pushes`).not.toBeNull();
            expect(d.pairingRequired, `${k} a frozen family is claimed by its fact`).toBe(true);
          }
        }
        expect(keys.filter((k) => (EXTERNAL_EFFECTS[k] as { frozenAudience?: true }).frozenAudience).sort())
          .toEqual(['decision.awaiting_countersign', 'decision.forwarded']);
      });
      it('the three A7d types are compiled, pairing-required, and `membership.standing_changed` invalidates without a push', () => {
        expect(EXTERNAL_EFFECTS['membership.standing_changed']).toEqual({ eventType: 'membership.standing_changed', invalidate: true, push: null, pairingRequired: true });
        expect(EXTERNAL_EFFECTS['decision.consultation_responded'].push).toEqual(['pmc', 'architect']);
        expect(EXTERNAL_EFFECTS['decision.consultation_requested'].push).toContain('architect');
      });
    });

    it('Phase 6 task 4b — a dispatch may NARROW the audience to the decider; a role outside the ceiling refuses', () => {
      const narrowed = buildDispatchIntent('decision.published', 'decision.published', {
        push: { body: 'hi', roles: ['engineer'], targetUserId: 'U1' },
      });
      expect(narrowed.push).toEqual({ body: 'hi', roles: ['engineer'], targetUserId: 'U1' });
      expect(() =>
        buildDispatchIntent('decision.approved', 'decision.approved', { push: { body: 'hi', roles: ['client'] } }),
      ).toThrow(/ceiling does not admit push role/);
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
