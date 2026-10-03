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
 * - a SCAN finds each status-keyed object literal in shared, API and web, reading its top-level keys
 *   whatever its entries hold (#652's review, finding 4118033111), and each must be registered — so a
 *   map added later has to be registered too;
 * - a second SCAN finds each web status SET that is not an object map (a status list, a per-status
 *   rollup), and each must be registered too (#652's review, finding 4117568488);
 * - a third SCAN finds every status PREDICATE in shared, API and web, one registration per
 *   occurrence, each with a verdict the predicate itself must bear out: it names the value, it
 *   rightly excludes it, it is owed by a named unit, or it reads another entity's status (#652's
 *   review, findings 4117700813 and 4117700814).
 *
 * What does not yet answer `awaiting_countersign` is registered as OWED, by the unit that owns the
 * arm (A5, A7, A8a, and 4d-ii-b for every web reader), which records its verdict as it lands. The web
 * readers recorded theirs with 4d-ii-b / B3 and B4.
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
    'packages/shared/src/tokens/colors.ts decisionChip': 'answered',
    'packages/shared/src/tokens/colors.ts decisionChipLabel': 'answered',
    'packages/shared/src/tokens/colors.ts decisionRail': 'answered',
    'apps/web/src/lib/locationTree.ts counts': 'answered',
    'apps/web/src/lib/locationTree.ts STATUS_LABEL': 'answered',
    'apps/web/src/lib/locationTree.ts rank': 'answered',
  };

  /** The TOP-LEVEL text of the object literal opening at `open` (a `{`), nested braces emptied, so an
   *  outer map's keys are read whatever its entries hold (#652's review, finding 4118033111:
   *  `decisionChip`'s entries are objects). `null` past `limit` characters. */
  const topLevel = (src: string, open: number, limit = 6000): string | null => {
    let depth = 0;
    let out = '';
    for (let i = open; i < Math.min(src.length, open + limit); i++) {
      const c = src[i]!;
      if (c === '{') { depth++; if (depth === 1) continue; }
      if (c === '}') { depth--; if (depth === 0) return out; }
      if (depth === 1) out += c;
      else if (depth === 2 && c === '{') out += '{';
    }
    return null;
  };

  it('every status-keyed object literal in shared, API and web is registered, and each ANSWERED one answers every status', () => {
    const found: Array<{ id: string; keys: Set<string> }> = [];
    for (const { file, src } of sources(['packages/shared/src', 'apps/api/src', 'apps/web/src'])) {
      // a declaration (`name[: type] = {`) or a property (`name: {`), whatever its entries' values
      for (const m of src.matchAll(/(\w+)\s*(?::[^=\n]*?)?=\s*\{|(\w+)\s*:\s*\{/g)) {
        const body = topLevel(src, m.index! + m[0].length - 1);
        if (body === null) continue;
        const keys = new Set([...body.matchAll(/(?:^|[\s,])'?(\w+)'?\s*:/g)].map((k) => k[1]!));
        if (['pending', 'approved', 'withdrawn'].every((k) => keys.has(k))) {
          found.push({ id: `${file} ${m[1] ?? m[2]}`, keys });
        }
      }
    }

    expect(found.map((f) => f.id).filter((id) => !(id in REGISTERED)), 'register every status-keyed map here').toEqual([]);
    for (const f of found.filter((x) => REGISTERED[x.id] === 'answered')) {
      expect(DECISION_STATUSES.filter((s) => !f.keys.has(s)), f.id).toEqual([]);
    }
    // and no registration outlives its literal
    expect(Object.keys(REGISTERED).filter((id) => !found.some((f) => f.id === id))).toEqual([]);
  });

  /** Source with its comments blanked (line numbers kept), so a predicate QUOTED in a comment is
   *  not taken for code. A `//` counts only after whitespace or a line start (never inside a URL). */
  const code = (src: string) => src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|\s)\/\/.*$/gm, (m, lead: string) => lead + ' '.repeat(m.length - lead.length));

  /** Every non-test source file under `roots`, repo-relative, with its comment-blanked code. */
  const sources = (roots: string[]) => {
    const out: Array<{ file: string; src: string }> = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === 'dist') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
          out.push({ file: relative(REPO, full).split('\\').join('/'), src: code(readFileSync(full, 'utf8')) });
        }
      }
    };
    for (const root of roots) walk(join(REPO, root));
    return out;
  };
  const ALT = DECISION_STATUSES.join('|');

  /**
   * Web status SETS that are not flat maps, which the flat-map scan cannot see (#652's review,
   * finding 4117568488): a status LIST, an array literal whose entries are keyed `key: '<status>'`
   * (the Decision Log's filter chips), and a per-status ROLLUP reading `counts.<status>` (its group
   * chips). ANSWERED means it keys every status. Both were owed by 4d-ii-b (the plan's §A.2 web arms) and
   * answered by its unit B3.
   */
  const WEB_STATUS_SETS: Record<string, 'answered' | 'owed by 4d-ii-b'> = {
    'apps/web/src/screens/DecisionLogScreen.tsx STATUS_FILTERS': 'answered',
    'apps/web/src/screens/DecisionLogScreen.tsx counts.*': 'answered',
  };

  it('every web status list and rollup is registered, and each ANSWERED one keys every status', () => {
    const found: Array<{ id: string; statuses: Set<string> }> = [];
    for (const { file, src } of sources(['apps/web/src'])) {
      for (const m of src.matchAll(/(\w+)\s*(?::[^=]*?)?=\s*\[([^\]]{0,800})\]/g)) {
        const keys = new Set([...m[2]!.matchAll(new RegExp(`\\bkey:\\s*'(${ALT})'`, 'g'))].map((k) => k[1]!));
        if (keys.size >= 2) found.push({ id: `${file} ${m[1]}`, statuses: keys });
      }
      const rollup = new Set([...src.matchAll(new RegExp(`\\bcounts\\.(${ALT})\\b`, 'g'))].map((k) => k[1]!));
      if (rollup.size >= 2) found.push({ id: `${file} counts.*`, statuses: rollup });
    }
    expect(found.map((f) => f.id).filter((id) => !(id in WEB_STATUS_SETS)), 'register every web status set here').toEqual([]);
    for (const f of found.filter((x) => WEB_STATUS_SETS[x.id] === 'answered')) {
      expect(DECISION_STATUSES.filter((st) => !f.statuses.has(st)), f.id).toEqual([]);
    }
    expect(Object.keys(WEB_STATUS_SETS).filter((id) => !found.some((f) => f.id === id))).toEqual([]);
  });

  /**
   * Every status PREDICATE in shared, API and web, one registration per occurrence (#652's review,
   * findings 4117700813 and 4117700814). A predicate is a comparison of a status with a status
   * literal (`d.status !== 'pending' && d.status !== 'change'` is ONE predicate, the whole chain), an
   * array literal made only of statuses (an open set, a Prisma `in`), or a Prisma filter in object
   * form, `status: '<status>'` (or `{ not | equals: … }`) inside a `where` or a `…WhereInput` object
   * (finding 4117838732: `countPending`'s filter), or a raw-SQL filter on a quoted `"status"` column
   * (`= '<status>'`, `IN (…)`), or a `switch` over a status with status cases; a `data:` write and a
   * seed row are not predicates. Its id is
   * `<file> :: <the predicate, whitespace-normalised>`, suffixed `#n` for the n-th identical one in
   * the file, so a predicate that is added, or whose statuses change, must be registered again.
   *
   * Each carries a verdict, and the verdict is checked against the predicate itself:
   * - `answered`: it names `awaiting_countersign`;
   * - `excludes: <why>`: it leaves the value out, and that is right for an approval the architect
   *   has yet to countersign; it must NOT name the value;
   * - `owed by <unit>: <what>`: the unit that owns the arm (A5, A7, A8a, 4d-ii-b), which records its
   *   verdict when it lands;
   * - `not a decision status: <what>`: the literal is another entity's status.
   */
  type Verdict = 'answered' | `excludes: ${string}` | `owed by ${string}` | `not a decision status: ${string}`;
  const STATUS_PREDICATES: Record<string, Verdict> = {
    // shared
    "packages/shared/src/domain/types.ts :: ['pending', 'approved', 'change', 'withdrawn', 'recorded', 'awaiting_countersign']": 'answered',
    "packages/shared/src/domain/readiness.ts :: decisionStatus === 'recorded'": 'excludes: a record, not an approval',
    "apps/api/src/common/countersign-compat.interceptor.ts :: d.status === 'awaiting_countersign'": 'answered',
    "packages/shared/src/domain/readiness.ts :: decisionStatus === 'approved'": 'excludes: the gate reads ok only on a FINAL approval; an uncountersigned one waits',
    "packages/shared/src/domain/readiness.ts :: decisionStatus === 'approved' #2": 'excludes: the reading’s approved arm; the awaiting arm is its own (below)',
    "packages/shared/src/domain/readiness.ts :: decisionStatus === 'change'": 'excludes: the reopened arm',
    "packages/shared/src/domain/readiness.ts :: decisionStatus === 'awaiting_countersign'": 'answered',
    "packages/shared/src/domain/readiness.ts :: decisionStatus === 'withdrawn'": 'excludes: the withdrawn arm',
    // API
    "apps/api/src/domain/transitions.ts :: decisionStatus === 'approved'": 'excludes: the legacy gate reads ok only on a FINAL approval; an uncountersigned one waits',
    "apps/api/src/common/recorded-compat.interceptor.ts :: d?.status !== 'recorded'": 'excludes: the recorded-compat strip; an awaiting row is the countersign-v1 interceptor’s to strip (A5)',
    "apps/api/src/decisions/consultation-open.ts :: ['pending', 'change', 'awaiting_countersign']": 'answered',
    "apps/api/src/decisions/decision-notice.ts :: decision.status === 'withdrawn'": 'excludes: the withdrawn suppression',
    "apps/api/src/decisions/decision-serialize.ts :: d.status === 'change'": 'excludes: the open change request, shown only while reopened',
    "apps/api/src/decisions/decision-serialize.ts :: d.status === 'withdrawn'": 'excludes: the withdrawal reason',
    "apps/api/src/decisions/decision-serialize.ts :: d.status === 'withdrawn' #2": 'excludes: the withdrawn audience (pmc-only)',
    // 4d-ii-a / A8a — the awaiting audience: the pending demand's (pmc, the decider, a standing consultee)
    // plus the architect whose action item it is; an architect sees every pending decision too
    "apps/api/src/decisions/decision-serialize.ts :: d.status === 'pending' || d.status === 'awaiting_countersign'": 'answered',
    "apps/api/src/decisions/decisions.participant.ts :: ['pending', 'change']": 'excludes: the delivered open set; a decision awaiting countersign is answered by its own set (`namedAwaiting`/`awaitingRoles`), which carries the last architect’s exemption',
    // 4d-ii-a / A7d — the decider and forward push targets: the demand stands only while the decision
    // awaits its DECIDER; an awaiting decision demands a countersign through its own family
    "apps/api/src/decisions/decisions.query.ts :: d.status !== 'pending' && d.status !== 'change'": 'excludes: the decider push (an awaiting decision’s demand is the countersign family’s, `countersignPushTarget`)',
    "apps/api/src/decisions/decisions.query.ts :: d.status !== 'pending' && d.status !== 'change' #2": 'excludes: the forward push (a hand-off announces an OPEN decision; one parked for a countersign is the architect’s)',
    "apps/api/src/decisions/decisions.query.ts :: d.status !== 'awaiting_countersign'": 'answered',
    "apps/api/src/decisions/decisions.effects.ts :: rows[0]?.status !== 'awaiting_countersign'": 'answered',
    "apps/api/src/decisions/decisions.effects.ts :: status: 'awaiting_countersign'": 'answered',
    // 4d-ii-a / A7b — the responded push family's withdrawn-audience arm (pmc-only once withdrawn)
    "apps/api/src/decisions/decisions.query.ts :: d.status === 'withdrawn'": 'excludes: the withdrawn audience of the response push (pmc-only)',
    "apps/api/src/decisions/decisions.query.ts :: rows[0]!.status === 'withdrawn'": 'excludes: the linkability of a withdrawn decision',
    "apps/api/src/decisions/decisions.query.ts :: row.status as string) === 'withdrawn'": 'excludes: the linkability of a withdrawn decision',
    "apps/api/src/decisions/decisions.query.ts :: d.status !== 'approved'": 'excludes: only a FINAL approval anchors requirement provenance (A4b refuses a provisional head too)',
    "apps/api/src/decisions/decisions.service.ts :: d.status === 'approved'": 'excludes: approve’s already-locked refusal; an awaiting decision is refused by the open-question arm below',
    "apps/api/src/decisions/decisions.service.ts :: d.status === 'recorded'": 'excludes: a record has nothing to approve',
    // 4d-ii-a / A8a — approve's and forward's own awaiting refusals, each with its answer
    "apps/api/src/decisions/decisions.service.ts :: d.status === 'awaiting_countersign'": 'answered',
    "apps/api/src/decisions/decisions.service.ts :: d.status !== 'pending' && d.status !== 'change'": 'excludes: approve acts on an open question; an awaiting approval is refused by its own arm above',
    "apps/api/src/decisions/decisions.service.ts :: d.status === 'awaiting_countersign' #2": 'answered',
    "apps/api/src/decisions/decisions.service.ts :: d.status !== 'pending' && d.status !== 'change' #2": 'excludes: forward hands over an OPEN decision; an awaiting one is refused by its own arm above',
    "apps/api/src/decisions/decisions.service.ts :: cur.status !== 'pending' && cur.status !== 'change'": 'excludes: the forward’s re-judge under the decision lock; an awaiting decision is the architect’s',
    // 4d-ii-a / A8b — the countersign, the disagreement and the stranded resolution act ONLY on an awaiting
    // decision: each pre-read refuses any other status with its answer, the row lock re-judges it, and the
    // two compare-and-sets (the finalization's `→ approved`, the rejection's `→ change`) move only from it
    "apps/api/src/decisions/decisions.service.ts :: cur.status !== 'awaiting_countersign'": 'answered',
    "apps/api/src/decisions/decisions.service.ts :: d.status !== 'awaiting_countersign'": 'answered',
    "apps/api/src/decisions/decisions.service.ts :: d.status !== 'awaiting_countersign' #2": 'answered',
    "apps/api/src/decisions/decisions.service.ts :: d.status !== 'awaiting_countersign' #3": 'answered',
    "apps/api/src/decisions/decisions.service.ts :: status: 'awaiting_countersign'": 'answered',
    "apps/api/src/decisions/decisions.service.ts :: status: 'awaiting_countersign' #2": 'answered',
    "apps/api/src/decisions/decisions.service.ts :: prior === 'change'": 'excludes: approved vs reapproved, from the status approve admitted',
    "apps/api/src/decisions/decisions.service.ts :: prior === 'change' #2": 'excludes: approved vs reapproved, from the status approve admitted',
    "apps/api/src/decisions/decisions.service.ts :: prior === 'change' #3": 'excludes: approved vs reapproved, from the status approve admitted',
    "apps/api/src/decisions/decisions.service.ts :: prior === 'change' #4": 'excludes: approved vs reapproved, from the status approve admitted',
    // 4d-ii-a / A7a — the kinded notice's `kind` is the event's type, chosen by the same arm
    "apps/api/src/decisions/decisions.service.ts :: prior === 'change' #5": 'excludes: approved vs reapproved, from the status approve admitted',
    "apps/api/src/decisions/decisions.service.ts :: d.status !== 'approved'": 'excludes: a change request reopens a FINAL approval; an awaiting one is reopened only by the architect’s disagreement (A8b)',
    "apps/api/src/decisions/decisions.service.ts :: d.status !== 'change'": 'excludes: only an open change request can be withdrawn',
    "apps/api/src/decisions/decisions.service.ts :: cur.status === 'recorded'": 'excludes: a draft’s record/pending flip; a draft is never awaiting',
    "apps/api/src/decisions/decisions.service.ts :: d.status === 'approved' || d.status === 'change' || d.status === 'awaiting_countersign'": 'answered',
    "apps/api/src/decisions/decisions.service.ts :: d.status === 'withdrawn'": 'excludes: already withdrawn',
    "apps/api/src/decisions/decisions.query.ts :: ['pending', 'change']": 'excludes: the PMC brief\u2019s "waiting on the client" (U3a): the client-held decisions open for their decision, new or reopened; an awaiting-countersign row waits on the architect, not the client',
    "apps/api/src/decisions/decisions.query.ts :: status: 'pending'": 'excludes: `countPending`’s pending count; the countersign obligations are counted by their own filter',
    "apps/api/src/decisions/decisions.query.ts :: status: 'awaiting_countersign'": 'answered',
    "apps/api/src/decisions/decisions.service.ts :: status: 'approved'": 'excludes: the change request’s compare-and-set from a FINAL approval',
    "apps/api/src/decisions/decisions.service.ts :: status: 'change'": 'excludes: the change withdrawal’s compare-and-set from an open change request',
    "apps/api/src/decisions/decisions.service.ts :: status: 'pending'": 'excludes: the withdraw’s compare-and-set, only from a never-approved pending decision',
    "apps/api/src/decisions/decisions.service.ts :: status: 'pending' #2": 'excludes: the withdraw’s legacy-text ambiguity guard counts siblings still awaiting APPROVAL; a sibling awaiting its countersign has been approved (provisionally) and, like an approved sibling, no longer carries a live pending demand (A8a)',
    "apps/api/src/labour/labour-procurement.service.ts :: status: 'approved'": 'not a decision status: a labour requisition',
    "apps/api/src/labour/labour-procurement.service.ts :: status: 'recorded'": 'not a decision status: a labour quote',
    "apps/api/src/labour/labour-procurement.service.ts :: status: 'recorded' #2": 'not a decision status: a labour quote',
    "apps/api/src/labour/labour-procurement.service.ts :: status: 'recorded' #3": 'not a decision status: a labour quote',
    "apps/api/src/procurement/procurement.service.ts :: status: 'approved'": 'not a decision status: a material requisition',
    "apps/api/src/procurement/procurement.service.ts :: status: 'recorded'": 'not a decision status: a vendor quote',
    "apps/api/src/procurement/procurement.service.ts :: status: 'recorded' #2": 'not a decision status: a vendor quote',
    "apps/api/src/procurement/procurement.service.ts :: status: 'recorded' #3": 'not a decision status: a vendor quote',
    "apps/api/src/platform/outbox/cancellation.ts :: status: 'pending'": 'not a decision status: an outbox delivery',
    "apps/api/src/platform/outbox/external-effect-dispatcher.ts :: status: 'pending'": 'not a decision status: an outbox delivery',
    "apps/api/src/platform/outbox/external-effect-dispatcher.ts :: status: 'pending' #2": 'not a decision status: an outbox delivery',
    "apps/api/src/platform/outbox/outbox-operations.service.ts :: status: 'pending'": 'not a decision status: an outbox delivery',
    "apps/api/src/platform/outbox/relay.service.ts :: status: 'pending'": 'not a decision status: an outbox delivery',
    'apps/api/src/platform/outbox/relay.service.ts :: "status" = \'pending\'': 'not a decision status: an outbox delivery',
    'apps/api/src/platform/outbox/relay.service.ts :: "status" = \'pending\' #2': 'not a decision status: an outbox delivery',
    'apps/api/src/platform/outbox/relay.service.ts :: "status" = \'pending\' #3': 'not a decision status: an outbox delivery',
    'apps/api/src/platform/outbox/outbox-operations.service.ts :: "status" IN (\'pending\', \'leased\')': 'not a decision status: an outbox delivery',
    "apps/api/src/labour/labour-procurement.service.ts :: req.status !== 'approved'": 'not a decision status: a labour requisition',
    "apps/api/src/labour/labour-procurement.service.ts :: req.status !== 'approved' #2": 'not a decision status: a labour requisition',
    "apps/api/src/labour/labour-procurement.service.ts :: comparison.status !== 'approved'": 'not a decision status: a labour quote comparison',
    "apps/api/src/procurement/procurement.service.ts :: req.status !== 'approved'": 'not a decision status: a material requisition',
    "apps/api/src/procurement/purchase-orders.service.ts :: req.status !== 'approved'": 'not a decision status: a material requisition',
    "apps/api/src/procurement/purchase-orders.service.ts :: comparison.status !== 'approved'": 'not a decision status: a material quote comparison',
    // web
    "apps/web/src/data/apiGateway.ts :: entry.status !== 'pending'": 'not a decision status: an evidence upload entry',
    "apps/web/src/store/store.ts :: e.status === 'pending'": 'not a decision status: an evidence upload entry',
    // 4d-ii-b / B3 — the web readers, each with its verdict (the plan's §A.2 web arms; the record's B3);
    // B4 — the consultation surface's open set (the server's `CONSULTATION_OPEN_STATUSES`) and the approval's
    // success copy read from the returned snapshot.
    "apps/web/src/components/ConsultationThread.tsx :: decision.status === 'pending' || decision.status === 'change' || decision.status === 'awaiting_countersign'": 'answered',
    // 4d-ii-b / B5b — the chain's controls: Forward hands over an OPEN decision (an awaiting one is the architect's,
    // handed on through `disagree` / `forward_on`); the architect's countersign controls sit on the awaiting row
    "apps/web/src/components/CountersignControls.tsx :: d.status === 'pending' || d.status === 'change'": 'excludes: the Forward affordance offers an OPEN decision; an awaiting one is forwarded on by the architect’s disagreement (its own arm below)',
    "apps/web/src/components/CountersignControls.tsx :: d.status === 'awaiting_countersign'": 'answered',
    // the approval route opens on ACTIONABLE states only: an awaiting decision is not one its decider can
    // approve, and admitting it would deep-link a named non-client decider to an empty approval screen
    // (#677 review, finding 4145060024); awaiting rows are read on the Decision Log and acted on through B5b
    "apps/web/src/layout/RouteBridge.tsx :: d.status === 'pending' || d.status === 'change'": 'excludes: the approval route opens on actionable states only; an awaiting row is the Decision Log’s (#677 review, finding 4145060024)',
    "apps/web/src/screens/ClientDecisionsScreen.tsx :: d.status === 'change'": 'excludes: the open change request’s panel, shown only while reopened',
    "apps/web/src/screens/DecisionLogScreen.tsx :: d.status === 'pending'": 'excludes: withdrawing the DECISION is refused after any approval act; a provisional approval is one (the phase6_t4a seal)',
    "apps/web/src/screens/DecisionLogScreen.tsx :: d.status === 'approved'": 'excludes: the lock icon marks a FINAL approval; an uncountersigned one is provisional',
    "apps/web/src/screens/DecisionLogScreen.tsx :: d.status === 'recorded'": 'excludes: the record branch',
    "apps/web/src/screens/DecisionLogScreen.tsx :: d.status === 'awaiting_countersign'": 'answered',
    "apps/web/src/screens/DecisionLogScreen.tsx :: d.status === 'pending' || d.status === 'withdrawn'": 'excludes: the never-approved rows render their options; an awaiting row carries a provisional approval and renders it (its own arm above)',
    "apps/web/src/screens/DecisionLogScreen.tsx :: d.status === 'withdrawn'": 'excludes: the withdrawn attribution',
    "apps/web/src/screens/DecisionLogScreen.tsx :: d.status === 'withdrawn' #2": 'excludes: the withdrawal reason',
    "apps/web/src/screens/DecisionLogScreen.tsx :: d.status === 'change'": 'excludes: the open change request’s panel, shown only while reopened',
    "apps/web/src/screens/DecisionLogScreen.tsx :: d.status === 'change' #2": 'excludes: the change-request affordances, only on a reopened row',
    "apps/web/src/screens/PortfolioScreen.tsx :: d.status === 'pending'": 'excludes: the DEMO-mode tile’s pending count (the live tile is the server’s countPending); the countersign arms are the Decision Log badge’s (selectCountersignObligations)',
    "apps/web/src/screens/ScheduleScreen.tsx :: d.status !== 'withdrawn'": 'excludes: the withdrawn arm of the schedule’s decision list',
    "apps/web/src/screens/TeamAccessScreen.tsx :: d.status === 'approved'": 'excludes: the welcome sample of FINAL approvals',
    "apps/web/src/screens/modals/AddMaterialModal.tsx :: d.status !== 'withdrawn'": 'excludes: the withdrawn arm of the provenance picker (the server refuses a provisional head anyway, A4b)',
    "apps/web/src/store/selectors.ts :: d.status === 'pending'": 'excludes: selectPending — the decisions awaiting their DECIDER; an awaiting row has its decider’s approval (selectAwaitingCountersign below)',
    "apps/web/src/store/selectors.ts :: d.status === 'change'": 'excludes: selectReapproval — the reopened rows',
    "apps/web/src/store/selectors.ts :: d.status === 'awaiting_countersign'": 'answered',
    "apps/web/src/store/selectors.ts :: d.status === 'awaiting_countersign' #2": 'answered',
    "apps/web/src/store/selectors.ts :: d.status !== 'withdrawn'": 'excludes: the log’s withdrawn arm (pmc-only)',
    "apps/web/src/store/selectors.ts :: d.status !== 'pending' && d.status !== 'awaiting_countersign'": 'answered',
    "apps/web/src/store/selectors.ts :: d.status !== 'withdrawn' #2": 'excludes: the visible-rows withdrawn arm (pmc-only)',
    "apps/web/src/store/selectors.ts :: d.status === 'approved'": 'excludes: selectApproved — the FINAL approvals the shared surfaces count',
    "apps/web/src/store/selectors.ts :: d.status === 'pending' #2": 'excludes: the Inbox’s pending demand; the awaiting branch is its own (selectAwaitingCountersign)',
    "apps/web/src/store/selectors.ts :: d.status === 'change' #2": 'excludes: the Inbox’s reopened rows',
    "apps/web/src/store/store.ts :: ?.status === 'awaiting_countersign'": 'answered',
    "apps/web/src/store/store.ts :: d.status === 'change'": 'excludes: the demo change-withdrawal’s compare-and-set from an open change request',
    "apps/web/src/store/store.ts :: d.status === 'pending'": 'excludes: the demo withdraw’s compare-and-set, only from a never-approved pending decision',
    "apps/web/src/store/store.ts :: o.status === 'pending'": 'excludes: the demo withdraw’s legacy-text ambiguity guard, mirroring the service’s (a sibling awaiting its countersign no longer carries a live pending demand)',
  };

  /** Whether the object literal around `idx`, or one enclosing it, is a Prisma filter: the value of
   *  a `where:` key, or a variable typed `…WhereInput`. */
  const inWhere = (src: string, idx: number): boolean => {
    let depth = 0;
    for (let i = idx - 1, opened = 0; i >= 0 && opened < 8; i--) {
      if (src[i] === '}') depth++;
      else if (src[i] === '{') {
        if (depth > 0) { depth--; continue; }
        opened++;
        const key = src.slice(Math.max(0, i - 80), i).match(/(\w+)\s*[:=]\s*$/)?.[1] ?? '';
        if (key === 'where' || /WhereInput$/.test(key)) return true;
      }
    }
    return false;
  };

  it('every status predicate in shared, API and web is registered with a verdict the predicate bears out', () => {
    const one = `[\\w.!?\\[\\]]*(?:status|Status|\\bprior)\\b(?:\\s+as\\s+\\w+\\))?\\s*[!=]==?\\s*'(?:${ALT})'`;
    const chain = new RegExp(`${one}(?:\\s*(?:&&|\\|\\|)\\s*${one})*`, 'g');
    const found: string[] = [];
    for (const { file, src } of sources(['packages/shared/src', 'apps/api/src', 'apps/web/src'])) {
      const seen = new Map<string, number>();
      const add = (expr: string) => {
        const norm = expr.replace(/\s+/g, ' ').trim();
        const n = (seen.get(norm) ?? 0) + 1;
        seen.set(norm, n);
        found.push(`${file} :: ${norm}${n > 1 ? ` #${n}` : ''}`);
      };
      for (const m of src.matchAll(chain)) add(m[0]);
      for (const m of src.matchAll(new RegExp(`\\bstatus:\\s*(?:\\{\\s*(?:not|equals):\\s*)?'(?:${ALT})'`, 'g'))) {
        if (inWhere(src, m.index!)) add(m[0]);
      }
      // a `switch` over a status: the discriminant and the status cases it names, as one predicate
      for (const m of src.matchAll(/switch\s*\(([^)]*(?:status|Status)[^)]*)\)\s*\{/g)) {
        const body = topLevel(src, m.index! + m[0].length - 1) ?? '';
        const cases = [...body.matchAll(new RegExp(`case\\s+'(${ALT})'`, 'g'))].map((c) => c[1]!).sort();
        if (cases.length) add(`switch (${m[1]!.trim()}) cases ${cases.join(', ')}`);
      }
      for (const m of src.matchAll(new RegExp(`"status"(?:::text)?\\s*(?:(?:=|<>|!=)\\s*'(?:${ALT})'|(?:NOT\\s+)?IN\\s*\\([^)]*'(?:${ALT})'[^)]*\\))`, 'g'))) add(m[0]);
      for (const m of src.matchAll(/\[([^[\]]*)\]/g)) {
        const items = m[1]!.replace(/\s+as\s+[^,\]]+/g, '').split(',').map((x) => x.trim()).filter(Boolean);
        if (items.length >= 2 && items.every((x) => /^'[^']*'$/.test(x) && (DECISION_STATUSES as readonly string[]).includes(x.slice(1, -1)))) add(m[0]);
      }
    }

    expect(found.filter((id) => !(id in STATUS_PREDICATES)), 'register every status predicate here, with its verdict').toEqual([]);
    for (const id of found) {
      const verdict = STATUS_PREDICATES[id]!;
      const names = id.split(' :: ')[1]!.includes("'awaiting_countersign'");
      if (verdict === 'answered') expect(names, `${id} is ANSWERED only if it names the value`).toBe(true);
      if (verdict.startsWith('excludes:')) expect(names, `${id} EXCLUDES the value, so it must not name it`).toBe(false);
    }
    // and no registration outlives its predicate
    expect(Object.keys(STATUS_PREDICATES).filter((id) => !found.includes(id))).toEqual([]);
  });
});
