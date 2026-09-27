import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DecisionStatus as PrismaDecisionStatus } from '@prisma/client';
import {
  DECISION_STATUSES, awaitingCountersignReason, decisionChip, decisionChipLabel, decisionRail, deriveDecisionReading,
} from '@vitan/shared';
import { deriveDecisionGate } from './transitions';

/**
 * Phase 6 task 4d unit 4d-ii-a / A4d — the shared STATUS TRIPWIRE (§A.2's reader enumeration).
 *
 * A status value added to the enum is caught by the compiler only where a switch is exhaustive; a
 * map read through `Record<string, …>` falls back silently (`StatusChip` renders an unknown status in
 * the withdrawn styling) and a predicate's catch-all describes it as something it is not
 * (`deriveDecisionReading` read an unknown status as "awaiting the decider's approval"). So every
 * status-keyed map and predicate is REGISTERED here and walked against every value:
 *
 * - the runtime list of values equals the shared type (compile-time) and the database enum (below);
 * - every registered map in shared and the API answers every value with its own key;
 * - every registered predicate answers every value with its own arm;
 * - a SCAN finds each flat status-keyed object literal in shared, API and web, and each must be
 *   registered — so a map added later has to be registered too.
 *
 * The web maps that do not yet answer `awaiting_countersign` are registered as OWED: their arms are
 * the client unit's (4d-ii-b), which moves each to ANSWERED as it lands.
 */
const REPO = join(__dirname, '..', '..', '..', '..');

describe('the decision status tripwire (4d-ii-a / A4d)', () => {
  it('the runtime status list is the database enum', () => {
    expect([...DECISION_STATUSES].sort()).toEqual(Object.values(PrismaDecisionStatus).sort());
  });

  it('every registered shared map answers every status with its own key', () => {
    for (const [name, map] of Object.entries({ decisionChip, decisionChipLabel, decisionRail })) {
      for (const status of DECISION_STATUSES) {
        expect(Object.prototype.hasOwnProperty.call(map, status), `${name}.${status}`).toBe(true);
      }
    }
  });

  it('every registered predicate answers every status with its own arm', () => {
    // the decision gate's reading: only a PENDING decision is "awaiting the decider's approval"
    const catchAll = deriveDecisionReading('pending').reason;
    for (const status of DECISION_STATUSES) {
      if (status === 'pending') continue;
      expect(deriveDecisionReading(status).reason, status).not.toBe(catchAll);
    }
    expect(deriveDecisionReading('awaiting_countersign', false, false, 'client'))
      .toEqual({ v: 'wait', source: 'derived', reason: awaitingCountersignReason('client') });
    expect(awaitingCountersignReason('member')).toBe('Approved by the named decider — awaiting the architect’s countersign');
    // the legacy four-gate helper: work waits for anything but a final approval
    expect(deriveDecisionGate('awaiting_countersign')).toBe('wait');
    expect(deriveDecisionGate('approved')).toBe('ok');
  });

  /** file (repo-relative) + the literal's name → whether it answers every status now. */
  const REGISTERED: Record<string, 'answered' | 'owed by 4d-ii-b'> = {
    'packages/shared/src/tokens/colors.ts decisionChipLabel': 'answered',
    'packages/shared/src/tokens/colors.ts decisionRail': 'answered',
    'apps/web/src/lib/locationTree.ts counts': 'answered',
    'apps/web/src/lib/locationTree.ts STATUS_LABEL': 'owed by 4d-ii-b',
    'apps/web/src/lib/locationTree.ts rank': 'owed by 4d-ii-b',
  };

  it('every flat status-keyed literal in shared, API and web is registered, and each ANSWERED one answers every status', () => {
    const found: Array<{ id: string; keys: Set<string> }> = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === 'dist') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
          const src = readFileSync(full, 'utf8');
          for (const m of src.matchAll(/(\w+)\s*(?::\s*[^={};]*)?[=:]\s*\{([^{}]{0,600})\}/g)) {
            const keys = new Set([...m[2]!.matchAll(/(?:^|[\s,{])'?(\w+)'?\s*:/g)].map((k) => k[1]!));
            if (['pending', 'approved', 'withdrawn'].every((k) => keys.has(k))) {
              found.push({ id: `${relative(REPO, full).split('\\').join('/')} ${m[1]}`, keys });
            }
          }
        }
      }
    };
    for (const root of ['packages/shared/src', 'apps/api/src', 'apps/web/src']) walk(join(REPO, root));

    expect(found.map((f) => f.id).filter((id) => !(id in REGISTERED)), 'register every status-keyed map here').toEqual([]);
    for (const f of found.filter((x) => REGISTERED[x.id] === 'answered')) {
      expect(DECISION_STATUSES.filter((s) => !f.keys.has(s)), f.id).toEqual([]);
    }
    // and no registration outlives its literal
    expect(Object.keys(REGISTERED).filter((id) => !found.some((f) => f.id === id))).toEqual([]);
  });
});
