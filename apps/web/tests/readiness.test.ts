import { describe, it, expect } from 'vitest';
import {
  deriveInspectionGate,
  deriveDrawingGate,
  deriveReadiness,
  readinessReady,
  type ReadinessInspection,
  type ReadinessDrawing,
  type ReadinessInput,
} from '@vitan/shared';

/**
 * Phase 1 Task 6 — the readiness truth tables, row by row, run against the
 * SHARED derivation (packages/shared/src/domain/readiness.ts). The API runs the
 * SAME rows against its pinned copy (apps/api/src/domain/readiness.test.ts) —
 * the two suites pin the copies together. Every numbered row of the plan's two tables is one case,
 * plus the four disambiguation cases the tables were corrected for:
 *   - an open reinspection child reads FAIL, not wait (row-2-over-row-3);
 *   - two linked drawings aggregate worst-wins (acked construction + review-only → fail);
 *   - a newly issued revision that froze ZERO recipients reads wait (row 3),
 *     while a LEGACY revision (recipientsFrozenAt null) follows the legacy rule
 *     (row 2) — distinguished ONLY by recipientsFrozenAt;
 *   - an unrelated inspection sharing only the room is INVISIBLE to the gate.
 * Rules are FIRST MATCH WINS — no outcome may depend on unstated ordering.
 */

const A = 'ACT-1';

// ---- inspection-gate fixtures ----

let seq = 0;
const insp = (over: Partial<ReadinessInspection> = {}): ReadinessInspection => ({
  id: `INSP-${++seq}`,
  activityId: A,
  closing: false,
  submitted: false,
  decided: false,
  reinspectionOfId: null,
  items: [],
  ...over,
});
const approved = (over: Partial<ReadinessInspection> = {}) =>
  insp({ submitted: true, decided: true, items: [{ rejected: false, result: 'PASS' }], ...over });
const rejected = (over: Partial<ReadinessInspection> = {}) =>
  insp({ submitted: true, decided: true, items: [{ rejected: true, result: 'FAIL' }], ...over });

describe('inspection gate truth table (first match wins)', () => {
  it('row 1: R empty → na — and co-located inspections with a DIFFERENT or NULL activityId are invisible', () => {
    expect(deriveInspectionGate(A, []).v).toBe('na');
    // the unrelated-same-node probe: these share only the room, never the requirement
    const unrelated = [insp({ activityId: 'ACT-OTHER' }), insp({ activityId: null }), rejected({ activityId: 'ACT-OTHER' })];
    expect(deriveInspectionGate(A, unrelated).v).toBe('na');
  });

  it('closing inspections are NOT members of R (they sign off completion, they do not gate readiness)', () => {
    expect(deriveInspectionGate(A, [insp({ closing: true, submitted: true })]).v).toBe('na');
  });

  it('row 2: a decided-rejected inspection with NO child yet is an OPEN chain → fail', () => {
    expect(deriveInspectionGate(A, [rejected()]).v).toBe('fail');
  });

  it('row 2 over row 3: an OPEN reinspection child reads FAIL, never a plain wait', () => {
    const root = rejected({ id: 'INSP-R' });
    const child = insp({ id: 'INSP-C', reinspectionOfId: 'INSP-R' }); // fresh, unsubmitted
    expect(deriveInspectionGate(A, [root, child]).v).toBe('fail');
    // submitted but undecided child — the chain is still open
    const child2 = insp({ id: 'INSP-C', reinspectionOfId: 'INSP-R', submitted: true });
    expect(deriveInspectionGate(A, [root, child2]).v).toBe('fail');
    // the child itself rejected without a grandchild — still open
    const child3 = rejected({ id: 'INSP-C', reinspectionOfId: 'INSP-R' });
    expect(deriveInspectionGate(A, [root, child3]).v).toBe('fail');
  });

  it('row 2 precedes row 3 even when an unrelated member is merely waiting', () => {
    const gates = deriveInspectionGate(A, [rejected({ id: 'INSP-R' }), insp({ id: 'INSP-W' })]);
    expect(gates.v).toBe('fail');
  });

  it('row 3: an open requirement OUTSIDE any open chain → wait (unsubmitted or undecided)', () => {
    expect(deriveInspectionGate(A, [insp()]).v).toBe('wait');
    expect(deriveInspectionGate(A, [insp({ submitted: true })]).v).toBe('wait');
    // a CLOSED chain (root rejected → child approved) plus one fresh member → wait, not fail
    const root = rejected({ id: 'INSP-R' });
    const fix = approved({ id: 'INSP-C', reinspectionOfId: 'INSP-R' });
    expect(deriveInspectionGate(A, [root, fix, insp({ id: 'INSP-NEW' })]).v).toBe('wait');
  });

  it('row 4: every chain closed by an approved reinspection and every other member approved → ok', () => {
    const root = rejected({ id: 'INSP-R' });
    const fix = approved({ id: 'INSP-C', reinspectionOfId: 'INSP-R' });
    expect(deriveInspectionGate(A, [root, fix, approved()]).v).toBe('ok');
    expect(deriveInspectionGate(A, [approved()]).v).toBe('ok');
  });

  it('a multi-hop chain follows the MOST RECENT child: rejected → rejected → approved is closed', () => {
    const root = rejected({ id: 'INSP-R' });
    const mid = rejected({ id: 'INSP-M', reinspectionOfId: 'INSP-R' });
    const leaf = approved({ id: 'INSP-L', reinspectionOfId: 'INSP-M' });
    expect(deriveInspectionGate(A, [root, mid, leaf]).v).toBe('ok');
    // …and open again if the leaf is itself rejected without a child
    const leafR = rejected({ id: 'INSP-L', reinspectionOfId: 'INSP-M' });
    expect(deriveInspectionGate(A, [root, mid, leafR]).v).toBe('fail');
  });
});

// ---- drawing-gate fixtures ----

const rev = (over: Partial<ReadinessDrawing['revisions'][number]> = {}) => ({
  status: 'for_construction',
  recipientsFrozenAt: new Date('2026-07-01T00:00:00Z') as Date | string | null,
  recipientIds: ['u-eng', 'u-con'],
  ackedIds: [] as string[],
  ...over,
});
const dwg = (over: Partial<ReadinessDrawing> = {}): ReadinessDrawing => ({
  number: 'A-310',
  activityId: A,
  draft: false,
  revisions: [rev()],
  ...over,
});
const ACTIVE = ['u-eng', 'u-con', 'u-pmc'];

describe('drawing gate truth table (per drawing, first match wins; worst-wins aggregation)', () => {
  it('no linked drawing → na; a DRAFT (unpublished) drawing is invisible', () => {
    expect(deriveDrawingGate(A, [], ACTIVE).v).toBe('na');
    expect(deriveDrawingGate(A, [dwg({ activityId: 'ACT-OTHER' })], ACTIVE).v).toBe('na');
    expect(deriveDrawingGate(A, [dwg({ draft: true })], ACTIVE).v).toBe('na');
  });

  it('row 1: no governing for_construction revision (review-only or superseded-out) → fail', () => {
    expect(deriveDrawingGate(A, [dwg({ revisions: [rev({ status: 'for_review' })] })], ACTIVE).v).toBe('fail');
    expect(deriveDrawingGate(A, [dwg({ revisions: [rev({ status: 'superseded' })] })], ACTIVE).v).toBe('fail');
  });

  it('row 2: LEGACY revision (recipientsFrozenAt null) → ok with ≥1 ack, wait with none — the migration never invents recipients', () => {
    const legacyAcked = dwg({ revisions: [rev({ recipientsFrozenAt: null, recipientIds: [], ackedIds: ['u-eng'] })] });
    expect(deriveDrawingGate(A, [legacyAcked], ACTIVE).v).toBe('ok');
    const legacyBare = dwg({ revisions: [rev({ recipientsFrozenAt: null, recipientIds: [], ackedIds: [] })] });
    expect(deriveDrawingGate(A, [legacyBare], ACTIVE).v).toBe('wait');
  });

  it('row 3 vs row 2 DISCRIMINATOR: a snapshot that froze ZERO recipients reads wait even WITH an ack — only recipientsFrozenAt separates the two shapes', () => {
    const frozenEmpty = dwg({ revisions: [rev({ recipientIds: [], ackedIds: ['u-eng'] })] }); // frozenAt SET
    expect(deriveDrawingGate(A, [frozenEmpty], ACTIVE).v).toBe('wait'); // nobody on the project confirmed the governing set
  });

  it('row 3: every frozen recipient has since left the project → wait', () => {
    const allGone = dwg({ revisions: [rev({ recipientIds: ['u-gone'], ackedIds: ['u-gone'] })] });
    expect(deriveDrawingGate(A, [allGone], ACTIVE).v).toBe('wait');
  });

  it('row 4: some ACTIVE recipient has not acknowledged (incl. partial) → wait', () => {
    expect(deriveDrawingGate(A, [dwg()], ACTIVE).v).toBe('wait'); // nobody acked
    const partial = dwg({ revisions: [rev({ ackedIds: ['u-eng'] })] });
    expect(deriveDrawingGate(A, [partial], ACTIVE).v).toBe('wait'); // 1 of 2
  });

  it('row 5: every member of active(P) has acknowledged → ok', () => {
    const full = dwg({ revisions: [rev({ ackedIds: ['u-eng', 'u-con'] })] });
    expect(deriveDrawingGate(A, [full], ACTIVE).v).toBe('ok');
  });

  it('churn: a recipient REMOVED after issue drops out of active(P) and cannot block', () => {
    const partial = dwg({ revisions: [rev({ ackedIds: ['u-eng'] })] }); // u-con never acked…
    expect(deriveDrawingGate(A, [partial], ['u-eng', 'u-pmc']).v).toBe('ok'); // …but is no longer active
  });

  it('churn: a member ADDED after issue is not in P and is not required until the next freeze', () => {
    const full = dwg({ revisions: [rev({ ackedIds: ['u-eng', 'u-con'] })] });
    expect(deriveDrawingGate(A, [full], [...ACTIVE, 'u-new']).v).toBe('ok');
  });

  it('supersession: a fresh for_construction issue replaces G and P — unacked new set → wait', () => {
    const superseded = dwg({
      revisions: [
        rev({ status: 'superseded', ackedIds: ['u-eng', 'u-con'] }), // the OLD, fully-acked set
        rev({ recipientIds: ['u-eng'], ackedIds: [] }), // the new governing set, unacked
      ],
    });
    expect(deriveDrawingGate(A, [superseded], ACTIVE).v).toBe('wait');
  });

  it('AGGREGATION worst-wins: fully-acked construction (ok) + review-only (fail) → fail; ok + unacked (wait) → wait', () => {
    const okD = dwg({ number: 'A-1', revisions: [rev({ ackedIds: ['u-eng', 'u-con'] })] });
    const reviewOnly = dwg({ number: 'A-2', revisions: [rev({ status: 'for_review' })] });
    const unacked = dwg({ number: 'A-3' });
    expect(deriveDrawingGate(A, [okD, reviewOnly], ACTIVE).v).toBe('fail');
    expect(deriveDrawingGate(A, [okD, unacked], ACTIVE).v).toBe('wait');
    expect(deriveDrawingGate(A, [okD], ACTIVE).v).toBe('ok');
  });
});

// ---- full readiness + overrides + the start predicate ----

const baseInput = (over: Partial<ReadinessInput> = {}): ReadinessInput => ({
  decisionStatus: null,
  gateMaterial: 'na',
  gateTeam: 'na',
  inspections: [],
  drawings: [],
  activeMemberIds: ACTIVE,
  overrides: [],
  now: new Date('2026-07-13T12:00:00Z'),
  ...over,
});

describe('deriveReadiness — five gates with named sources', () => {
  it('decision derives live (change reverts readiness); material/team are STORED flags and say so', () => {
    const r = deriveReadiness(A, baseInput({ decisionStatus: 'change', gateMaterial: 'fail', gateTeam: 'ok' }));
    expect(r.decision).toMatchObject({ v: 'wait', source: 'derived' });
    expect(r.material).toMatchObject({ v: 'fail', source: 'stored' });
    expect(r.team).toMatchObject({ v: 'ok', source: 'stored' });
    expect(deriveReadiness(A, baseInput({ decisionStatus: 'approved' })).decision.v).toBe('ok');
    expect(deriveReadiness(A, baseInput()).decision.v).toBe('na');
  });

  it('every reading carries a human-readable reason', () => {
    const r = deriveReadiness(A, baseInput({ inspections: [rejected()] }));
    expect(r.inspection.v).toBe('fail');
    expect(r.inspection.reason.length).toBeGreaterThan(0);
    expect(r.drawing.reason.length).toBeGreaterThan(0);
  });

  it('an UNEXPIRED override supersedes the derivation for ITS gate only, names its source, and keeps its reason', () => {
    const r = deriveReadiness(A, baseInput({
      inspections: [rejected()], // derived fail…
      overrides: [{ gate: 'inspection', state: 'ok', reason: 'Approved on site by RCC consultant', expiresAt: new Date('2026-07-20T00:00:00Z') }],
    }));
    expect(r.inspection).toMatchObject({ v: 'ok', source: 'override', reason: 'Approved on site by RCC consultant' });
    expect(r.drawing.source).toBe('derived'); // other gates untouched
  });

  it('an EXPIRED override restores the derived value', () => {
    const r = deriveReadiness(A, baseInput({
      inspections: [rejected()],
      overrides: [{ gate: 'inspection', state: 'ok', reason: 'lapsed', expiresAt: new Date('2026-07-01T00:00:00Z') }],
    }));
    expect(r.inspection).toMatchObject({ v: 'fail', source: 'derived' });
  });

  it('with several unexpired overrides on one gate, the LATEST in row order wins', () => {
    const r = deriveReadiness(A, baseInput({
      overrides: [
        { gate: 'material', state: 'ok', reason: 'first', expiresAt: new Date('2026-08-01T00:00:00Z') },
        { gate: 'material', state: 'fail', reason: 'second', expiresAt: new Date('2026-08-01T00:00:00Z') },
      ],
    }));
    expect(r.material).toMatchObject({ v: 'fail', reason: 'second' });
  });
});

describe('readinessReady — the start guard over five gates, overrides considered', () => {
  it('all ok/na → ready; any wait or fail → not ready', () => {
    expect(readinessReady(deriveReadiness(A, baseInput()))).toBe(true); // all na
    expect(readinessReady(deriveReadiness(A, baseInput({ decisionStatus: 'pending' })))).toBe(false);
    expect(readinessReady(deriveReadiness(A, baseInput({ drawings: [dwg()] })))).toBe(false); // unacked governing set
    expect(readinessReady(deriveReadiness(A, baseInput({ gateMaterial: 'fail' })))).toBe(false);
  });

  it('an override can admit a start that the derivation blocks — and its expiry re-blocks it', () => {
    const blocked = baseInput({ drawings: [dwg()] });
    expect(readinessReady(deriveReadiness(A, blocked))).toBe(false);
    const lifted = { ...blocked, overrides: [{ gate: 'drawing' as const, state: 'ok' as const, reason: 'PMC carries paper copy', expiresAt: new Date('2026-07-20T00:00:00Z') }] };
    expect(readinessReady(deriveReadiness(A, lifted))).toBe(true);
    const lapsed = { ...lifted, now: new Date('2026-07-21T00:00:00Z') };
    expect(readinessReady(deriveReadiness(A, lapsed))).toBe(false);
  });
});
