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
 * - the runtime list of values equals the shared type (compile-time) and the Prisma schema's enum
 *   (below); the LIVE database enum is read from `pg_enum` by the integration arm
 *   `test/integration/phase6-t4d-ii-a4d-status-enum.test.ts` (#652's review, finding 4117568496);
 * - every registered map in shared and the API answers every value with its own key;
 * - every registered predicate answers every value with its own arm;
 * - a SCAN finds each flat status-keyed object literal in shared, API and web, and each must be
 *   registered — so a map added later has to be registered too;
 * - a second SCAN finds each web status READER that is not a flat map (a status list, a per-status
 *   rollup, a file of status predicates), and each must be registered too (#652's review, finding
 *   4117568488).
 *
 * The web readers that do not yet answer `awaiting_countersign` are registered as OWED: their arms
 * are the client unit's (4d-ii-b), which moves each to ANSWERED as it lands.
 */
const REPO = join(__dirname, '..', '..', '..', '..');

describe('the decision status tripwire (4d-ii-a / A4d)', () => {
  it('the runtime status list is the Prisma schema enum (the live enum: the integration arm)', () => {
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

  /**
   * Web status READERS that are not flat maps, which the scan above cannot see (#652's review,
   * finding 4117568488). Three shapes, each found by the scan below and each registered here:
   *
   * - `<file> <name>`: a status LIST, an array literal whose entries are keyed `key: '<status>'`
   *   (the Decision Log's filter chips). ANSWERED means it keys every status.
   * - `<file> counts.*`: a per-status ROLLUP reading `counts.<status>` (the Decision Log's group
   *   chips). ANSWERED means it reads every status.
   * - `<file> status predicates`: a file comparing a decision's status with a status literal (the
   *   selectors, the Schedule's and material picker's filters, the consultation thread's open set).
   *   A predicate names the statuses it means, so no key set can be checked; ANSWERED means the file
   *   names `awaiting_countersign`, which 4d-ii-b records after deciding each predicate.
   *
   * All are OWED by 4d-ii-b (the plan's §A.2 web arms): no row can carry the value until 4d-iii.
   */
  const WEB_READERS: Record<string, 'answered' | 'owed by 4d-ii-b'> = {
    'apps/web/src/screens/DecisionLogScreen.tsx STATUS_FILTERS': 'owed by 4d-ii-b',
    'apps/web/src/screens/DecisionLogScreen.tsx counts.*': 'owed by 4d-ii-b',
    'apps/web/src/screens/DecisionLogScreen.tsx status predicates': 'owed by 4d-ii-b',
    'apps/web/src/components/ConsultationThread.tsx status predicates': 'owed by 4d-ii-b',
    'apps/web/src/layout/RouteBridge.tsx status predicates': 'owed by 4d-ii-b',
    'apps/web/src/screens/ClientDecisionsScreen.tsx status predicates': 'owed by 4d-ii-b',
    'apps/web/src/screens/PortfolioScreen.tsx status predicates': 'owed by 4d-ii-b',
    'apps/web/src/screens/ScheduleScreen.tsx status predicates': 'owed by 4d-ii-b',
    'apps/web/src/screens/TeamAccessScreen.tsx status predicates': 'owed by 4d-ii-b',
    'apps/web/src/screens/modals/AddMaterialModal.tsx status predicates': 'owed by 4d-ii-b',
    'apps/web/src/store/selectors.ts status predicates': 'owed by 4d-ii-b',
    'apps/web/src/store/store.ts status predicates': 'owed by 4d-ii-b',
  };

  it('every web status list, rollup and predicate file is registered, and each ANSWERED one answers every status', () => {
    const alt = DECISION_STATUSES.join('|');
    const found: Array<{ id: string; statuses: Set<string> | null; src: string }> = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === 'dist') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
          const src = readFileSync(full, 'utf8');
          const file = relative(REPO, full).split('\\').join('/');
          for (const m of src.matchAll(/(\w+)\s*(?::[^=]*?)?=\s*\[([^\]]{0,800})\]/g)) {
            const keys = new Set([...m[2]!.matchAll(new RegExp(`\\bkey:\\s*'(${alt})'`, 'g'))].map((k) => k[1]!));
            if (keys.size >= 2) found.push({ id: `${file} ${m[1]}`, statuses: keys, src });
          }
          const rollup = new Set([...src.matchAll(new RegExp(`\\bcounts\\.(${alt})\\b`, 'g'))].map((k) => k[1]!));
          if (rollup.size >= 2) found.push({ id: `${file} counts.*`, statuses: rollup, src });
          if (new RegExp(`\\b(?:d|o|decision)\\.status\\s*[!=]==?\\s*'(${alt})'`).test(src)) {
            found.push({ id: `${file} status predicates`, statuses: null, src });
          }
        }
      }
    };
    walk(join(REPO, 'apps/web/src'));

    expect(found.map((f) => f.id).filter((id) => !(id in WEB_READERS)), 'register every web status reader here').toEqual([]);
    for (const f of found.filter((x) => WEB_READERS[x.id] === 'answered')) {
      if (f.statuses) expect(DECISION_STATUSES.filter((s) => !f.statuses!.has(s)), f.id).toEqual([]);
      else expect(f.src.includes("'awaiting_countersign'"), f.id).toBe(true);
    }
    // and no registration outlives its reader
    expect(Object.keys(WEB_READERS).filter((id) => !found.some((f) => f.id === id))).toEqual([]);
  });
});
