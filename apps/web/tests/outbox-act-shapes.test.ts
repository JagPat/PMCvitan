import { describe, it, expect, afterEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, OutboxOp } from '@/data/apiGateway';
import { isKnownOutboxOp } from '@/data/storedActs';

/**
 * #1051 r1, Codex 4336713248: a stored act was taken as loadable when it named a known kind, whatever its fields held.
 * `[{"t":"approve"}]` loaded, its replay sent `undefined`, the 4xx dropped it, and the key was written over: the
 * stored bytes were lost with no Set aside offered. Each known kind is now read through the fields its replay reads,
 * and a key holding any entry that fails them is unreadable as a whole. The per-kind store tests fail before the fix.
 */

type Act<K extends OutboxOp['t']> = Extract<OutboxOp, { t: K }>;
const k = 'k-1';
const c = 'c-1';
const line = { poLineId: 'p', quantity: '1', rate: '10' };

/** one act of every kind, holding only the fields its type requires */
const MIN: { [K in OutboxOp['t']]: Act<K> } = {
  siteVisitStart: { t: 'siteVisitStart', body: { id: 'v-1', claimedAt: '2026-10-21T05:30:00.000Z' }, visitor: { name: 'n', role: 'pmc', placeName: null }, idempotencyKey: k },
  siteVisitEnd: { t: 'siteVisitEnd', visitId: 'v-1', claimedAt: '2026-10-21T05:30:00.000Z', idempotencyKey: k },
  siteVisitClose: { t: 'siteVisitClose', visitId: 'v-1', reason: 'r', idempotencyKey: k },
  siteVisitAddPlace: { t: 'siteVisitAddPlace', visitId: 'v-1', body: { id: 'p-1', nodeId: 'n-1', claimedAt: '2026-10-21T05:30:00.000Z' }, name: 'n', idempotencyKey: k },
  siteVisitRetirePlace: { t: 'siteVisitRetirePlace', visitId: 'v-1', placeId: 'p-1', idempotencyKey: k },
  siteVisitAddAttendee: { t: 'siteVisitAddAttendee', visitId: 'v-1', body: { id: 'a-1', userId: 'u-1', role: 'client' }, name: 'n', idempotencyKey: k },
  siteVisitRetireAttendee: { t: 'siteVisitRetireAttendee', visitId: 'v-1', attendeeId: 'a-1', idempotencyKey: k },
  siteVisitAddFile: { t: 'siteVisitAddFile', visitId: 'v-1', scope: 's', file: { id: 'f-1', mime: 'image/png' }, by: { name: 'n', role: 'pmc' }, placeName: null, idempotencyKey: k },
  approve: { t: 'approve', decisionId: 'd-1', optionIndex: 0, idempotencyKey: k },
  forwardDecision: { t: 'forwardDecision', decisionId: 'd-1', input: { toDesignationKind: 'pmc', reason: 'r' }, idempotencyKey: k },
  countersignDecision: { t: 'countersignDecision', decisionId: 'd-1', idempotencyKey: k },
  disagreeDecision: { t: 'disagreeDecision', decisionId: 'd-1', input: { path: 'reject_back', reason: 'r' }, idempotencyKey: k },
  resolveStrandedCountersign: { t: 'resolveStrandedCountersign', decisionId: 'd-1', input: { outcome: 'completed', reason: 'r' }, idempotencyKey: k },
  change: { t: 'change', decisionId: 'd-1', reason: 'r', costImpact: 0, timeImpactDays: 0, idempotencyKey: k },
  changeWithdraw: { t: 'changeWithdraw', decisionId: 'd-1', idempotencyKey: k },
  withdraw: { t: 'withdraw', decisionId: 'd-1', reason: 'r', idempotencyKey: k },
  consultationRequest: { t: 'consultationRequest', decisionId: 'd-1', consulteeMembershipId: 'm-1', question: 'q', idempotencyKey: k },
  consultationRespond: { t: 'consultationRespond', decisionId: 'd-1', consultationId: 'c-1', response: 'r', idempotencyKey: k },
  ackDrawing: { t: 'ackDrawing', revisionId: 'r-1', idempotencyKey: k },
  publishDrawing: { t: 'publishDrawing', drawingId: 'dr-1', idempotencyKey: k },
  setDrawingNode: { t: 'setDrawingNode', drawingId: 'dr-1', nodeId: null, idempotencyKey: k },
  submitInspection: { t: 'submitInspection', inspectionId: 'i-1', items: [{ name: 'n', state: null, photos: 0, note: '' }] },
  decideReview: { t: 'decideReview', inspectionId: 'i-1', approve: false, rejectedItemIds: ['x'] },
  startActivity: { t: 'startActivity', activityId: 'a-1' },
  completeActivity: { t: 'completeActivity', activityId: 'a-1' },
  startDailyLog: { t: 'startDailyLog', idempotencyKey: k },
  addSiteMaterial: { t: 'addSiteMaterial', input: { name: 'n', qty: '1' }, idempotencyKey: k },
  flagMismatch: { t: 'flagMismatch', decisionId: 'd-1', idempotencyKey: k },
  submitDailyLog: { t: 'submitDailyLog', log: { checkedIn: true, checkinTime: null, progress: 0, crew: [{ trade: 't', count: 1 }] }, idempotencyKey: k },
  reserveStock: { t: 'reserveStock', input: { lotId: 'l', storeLocation: 's', activityId: 'a', qty: '1' }, idempotencyKey: k, coalesceKey: c },
  issueStock: { t: 'issueStock', input: { lotId: 'l', storeLocation: 's', activityId: 'a', qty: '1' }, idempotencyKey: k, coalesceKey: c },
  consumeStock: { t: 'consumeStock', input: { issueId: 'i', qty: '1' }, idempotencyKey: k, coalesceKey: c },
  createRequisition: { t: 'createRequisition', input: { title: 't', lines: [{ requirementId: 'r', revision: 1, qty: '1' }] }, idempotencyKey: k, coalesceKey: c },
  allocateLabour: { t: 'allocateLabour', input: { activityId: 'a', requirementId: 'r', civilDate: '2026-10-21', workerId: 'w' }, idempotencyKey: k, coalesceKey: c },
  recordAttendance: { t: 'recordAttendance', input: { workerId: 'w', civilDate: '2026-10-21', shift: 'day', deviceId: 'd' }, idempotencyKey: k, coalesceKey: c },
  recordLabourWork: { t: 'recordLabourWork', input: { allocationId: 'a', workedMinutes: 60 }, idempotencyKey: k, coalesceKey: c },
  createLabourRequisition: { t: 'createLabourRequisition', input: { title: 't', lines: [{ requirementId: 'r', revision: 1, civilDate: '2026-10-21', personShiftQty: 1 }] }, idempotencyKey: k, coalesceKey: c },
  releaseLabourAllocation: { t: 'releaseLabourAllocation', allocationId: 'a', reason: 'r', idempotencyKey: k, coalesceKey: c },
  setCommercialBudget: { t: 'setCommercialBudget', input: { costHeadCode: 'h', amount: '1', reason: 'r' }, idempotencyKey: k, coalesceKey: c },
  defineCostHead: { t: 'defineCostHead', input: { code: 'h', name: 'n' }, idempotencyKey: k, coalesceKey: c },
  reattributeCommitment: { t: 'reattributeCommitment', input: { costHeadCode: 'h', reason: 'r', poLineId: 'p' }, idempotencyKey: k, coalesceKey: c },
  takeMeasurement: { t: 'takeMeasurement', input: { labourPoLineId: 'l', activityId: 'a', quantity: '1', citedOutputId: 'o' }, idempotencyKey: k, coalesceKey: c },
  correctMeasurement: { t: 'correctMeasurement', input: { measurementId: 'm', quantity: '1', reason: 'r' }, labourPoLineId: 'l', idempotencyKey: k, coalesceKey: c },
  recordVendorBill: { t: 'recordVendorBill', input: { vendorId: 'v', vendorBillNumber: 'n', documentDate: '2026-10-21', lines: [line] }, idempotencyKey: k, coalesceKey: c },
  beginVerification: { t: 'beginVerification', input: { billId: 'b' }, idempotencyKey: k, coalesceKey: c },
  verifyVendorBill: { t: 'verifyVendorBill', input: { billId: 'b' }, idempotencyKey: k, coalesceKey: c },
  submitVendorBill: { t: 'submitVendorBill', input: { billId: 'b' }, idempotencyKey: k, coalesceKey: c },
  certifyBill: { t: 'certifyBill', input: { billId: 'b', versionId: 'v', lifecycleVersion: 1 }, idempotencyKey: k, coalesceKey: c },
  supersedeCertificate: { t: 'supersedeCertificate', input: { billId: 'b', reason: 'r', certificateId: 'c' }, idempotencyKey: k, coalesceKey: c },
  grantSodException: { t: 'grantSodException', input: { billId: 'b', actorId: 'a', reason: 'r', versionId: 'v', status: 's', lifecycleVersion: 1, rule: 'certifier-may-not-approve' }, idempotencyKey: k, coalesceKey: c },
  recordDeduction: { t: 'recordDeduction', input: { billId: 'b', type: 't', amount: '1' }, idempotencyKey: k, coalesceKey: c },
  releaseDeduction: { t: 'releaseDeduction', input: { deductionId: 'd', amount: '1', reason: 'r' }, idempotencyKey: k, coalesceKey: c },
  approvePayment: { t: 'approvePayment', input: { billId: 'b', amount: '1', lifecycleVersion: 1 }, idempotencyKey: k, coalesceKey: c },
  payAdvance: { t: 'payAdvance', input: { vendorId: 'v', amount: '1', reason: 'r', method: 'm' }, idempotencyKey: k, coalesceKey: c },
  recordPayment: { t: 'recordPayment', input: { approvalId: 'a', amount: '1', method: 'm' }, idempotencyKey: k, coalesceKey: c },
  reversePayment: { t: 'reversePayment', input: { paymentId: 'p', amount: '1', reason: 'r' }, idempotencyKey: k, coalesceKey: c },
  amendVendorBill: { t: 'amendVendorBill', input: { billId: 'b', reason: 'r', lines: [line] }, idempotencyKey: k, coalesceKey: c },
  rejectVendorBill: { t: 'rejectVendorBill', input: { billId: 'b', reason: 'r' }, idempotencyKey: k, coalesceKey: c },
  uploadMedia: { t: 'uploadMedia', input: { kind: 'progress', mime: 'image/png', data: 'AA==' } },
  uploadEvidence: { t: 'uploadEvidence', scope: 's', clientKey: 'ck' },
};

/** the kinds with optional fields, holding every one of them */
const FULL: OutboxOp[] = [
  { ...MIN.siteVisitStart, body: { id: 'v-1', claimedAt: '2026-10-21T05:30:00.000Z', nodeId: 'n', location: { lat: 1, lng: 2, accuracyM: 3, at: '2026-10-21T05:30:00.000Z' } } },
  { ...MIN.siteVisitAddAttendee, body: { id: 'a-2', guestName: 'g' } },
  { ...MIN.siteVisitAddFile, queuedAt: 'T', file: { id: 'f-1', mime: 'image/png', takenAt: 'T', geoLat: 1, geoLng: 2, nodeId: 'n', note: 'x', rating: 'concern', sourceMediaId: 'm' } },
  { ...MIN.forwardDecision, input: { toDesignationKind: 'member', toDesignationMembershipId: 'm', reason: 'r' } },
  { ...MIN.disagreeDecision, input: { path: 'forward_on', reason: 'r', costImpact: 1, timeImpactDays: 2, toDesignationKind: 'member', toDesignationMembershipId: 'm' } },
  { ...MIN.resolveStrandedCountersign, input: { outcome: 'returned', reason: 'r', costImpact: 1, timeImpactDays: 2, toDesignationKind: 'member', toDesignationMembershipId: 'm' } },
  { ...MIN.consultationRespond, recommendedOptionIndex: 1 },
  { ...MIN.setDrawingNode, nodeId: 'n' },
  { ...MIN.submitInspection, items: [{ id: 'x', name: 'n', state: 'pass', photos: 1, note: '', evidence: ['u'] }] },
  { ...MIN.decideReview, idempotencyKey: k },
  { ...MIN.startActivity, idempotencyKey: k },
  { ...MIN.completeActivity, idempotencyKey: k },
  { ...MIN.addSiteMaterial, input: { name: 'n', qty: '1', zone: 'z', decisionId: 'd', swatch: 's', nodeId: 'n' } },
  { ...MIN.submitDailyLog, log: { checkedIn: true, checkinTime: '07:00', progress: 5, crew: [] } },
  { ...MIN.issueStock, input: { ...MIN.issueStock.input, note: 'x' } },
  { ...MIN.consumeStock, input: { ...MIN.consumeStock.input, note: 'x' } },
  { ...MIN.createRequisition, input: { ...MIN.createRequisition.input, notes: 'x' } },
  { ...MIN.allocateLabour, input: { activityId: 'a', requirementId: 'r', civilDate: '2026-10-21', crewId: 'c', capacityCommitmentId: 'cc', originRevision: 1, labourSpecFingerprint: 'f' } },
  { ...MIN.recordAttendance, input: { workerId: 'w', civilDate: '2026-10-21', shift: 'night', manualReason: 'm', evidenceMediaId: 'e' } },
  { ...MIN.recordLabourWork, input: { ...MIN.recordLabourWork.input, note: 'x' } },
  { ...MIN.createLabourRequisition, input: { ...MIN.createLabourRequisition.input, notes: 'x' } },
  { ...MIN.reattributeCommitment, input: { costHeadCode: 'h', reason: 'r', labourPoLineId: 'l' } },
  { ...MIN.takeMeasurement, input: { ...MIN.takeMeasurement.input, measuredOn: '2026-10-21', evidenceMediaId: 'e', reason: 'r' } },
  { ...MIN.recordVendorBill, input: { ...MIN.recordVendorBill.input, lines: [{ labourPoLineId: 'l', quantity: '1', rate: '1', taxAmount: '1', freightAmount: '1' }] } },
  { ...MIN.amendVendorBill, input: { ...MIN.amendVendorBill.input, lines: [{ poLineId: 'p', quantity: '1', rate: '1' }] } },
  { ...MIN.reserveStock, coalesceKey: undefined } as unknown as OutboxOp,
  { ...MIN.recordDeduction, input: { ...MIN.recordDeduction.input, reason: null } },
  { ...MIN.recordDeduction, input: { ...MIN.recordDeduction.input, reason: 'r' } },
  { ...MIN.payAdvance, input: { ...MIN.payAdvance.input, reference: null } },
  { ...MIN.recordPayment, input: { ...MIN.recordPayment.input, reference: 'x' } },
  { ...MIN.uploadMedia, input: { ...MIN.uploadMedia.input, kind: 'visit', decisionId: 'd', nodeId: 'n', inspectionId: 'i', inspectionItemId: 'ii', clientKey: 'ck', dailyLogId: 'dl', siteVisit: { visitId: 'v', note: 'x', rating: 'fine' }, geoLat: 1, geoLng: 2, takenAt: 'T', sourceMediaId: 's' } },
];

/** the fields an earlier release stored some acts of a kind without (#1051 r1 re-check G2), by their path: such an act
 *  replays as it did there */
const KEYED_LATER = ['approve', 'change', 'changeWithdraw', 'ackDrawing', 'flagMismatch', 'submitDailyLog'];
const HISTORICAL: Partial<Record<OutboxOp['t'], string[]>> = {
  ...Object.fromEntries(KEYED_LATER.map((t) => [t, ['idempotencyKey']])),
  grantSodException: ['input.rule'],
};
const MATERIALS: string[] = ['reserveStock', 'issueStock', 'consumeStock', 'createRequisition'];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const wrong = (v: unknown): unknown => (typeof v === 'string' || v === null ? 7 : 'x');

/** every required field of an act, by its path: each act made by leaving one out, and by giving it the wrong type */
function damaged(op: OutboxOp): { label: string; act: unknown }[] {
  const out: { label: string; act: unknown }[] = [];
  // a materials act from PR #207 has no coalesceKey: it is derived on load
  const mayLack = [...(MATERIALS.includes(op.t) ? ['coalesceKey'] : []), ...(HISTORICAL[op.t] ?? [])];
  const walk = (path: (string | number)[], v: unknown) => {
    if (Array.isArray(v)) { v.forEach((x, i) => walk([...path, i], x)); return; }
    if (!isObj(v)) return;
    for (const [f, x] of Object.entries(v)) {
      if (path.length === 0 && f === 't') continue;
      const at = [...path, f];
      for (const [how, change] of [['without', undefined], ['with a wrong type of', wrong(x)]] as const) {
        const copy = structuredClone(op) as unknown;
        let node = copy as Record<string | number, unknown>;
        for (const p of path) node = node[p] as Record<string | number, unknown>;
        if (how === 'without' && mayLack.includes(at.join('.'))) continue;
        if (how === 'without') delete node[f]; else node[f] = change;
        out.push({ label: `${op.t} ${how} ${at.join('.')}`, act: copy });
      }
      walk(at, x);
    }
  };
  walk([], op);
  return out;
}

describe('#1051 r1, Codex 4336713248: a stored act is read through the fields its replay reads', () => {
  it('an act of every kind, holding only its required fields or every optional one too, is read', () => {
    for (const op of [...Object.values(MIN), ...FULL]) expect([op.t, isKnownOutboxOp(op)]).toEqual([op.t, true]);
  });

  it.each(Object.keys(MIN) as OutboxOp['t'][])('%s missing any field its replay reads, or holding it as the wrong type, is not read', (t) => {
    const cases = damaged(MIN[t]);
    expect(cases.length).toBeGreaterThan(0);
    for (const { label, act } of cases) expect([label, isKnownOutboxOp(act)]).toEqual([label, false]);
  });

  it('every shape an earlier release stored is read (re-check G2)', () => {
    for (const t of KEYED_LATER) {
      const { idempotencyKey: _k, ...keyless } = MIN[t as OutboxOp['t']] as { idempotencyKey: string };
      expect([t, isKnownOutboxOp(keyless)]).toEqual([t, true]);
    }
    const { rule: _r, ...noRule } = MIN.grantSodException.input;
    expect(isKnownOutboxOp({ ...MIN.grantSodException, input: noRule })).toBe(true);
    // a review queued before ce360ae5 names no item ids: sent with none, as main sends it (the server defaults them)
    expect(isKnownOutboxOp({ t: 'decideReview', inspectionId: 'i-1', approve: true, rejectedItemNames: [] })).toBe(true);
    expect(isKnownOutboxOp({ t: 'decideReview', inspectionId: 'i-1', approve: false, rejectedItemNames: ['n'] })).toBe(true);
    // one naming neither is damage
    expect(isKnownOutboxOp({ t: 'decideReview', inspectionId: 'i-1', approve: false })).toBe(false);
  });
});

const USER = 'u-eng';
const P2 = 'p-2';
const general = `vitan.outbox.dev:${USER}.${P2}`;
const lane = `vitan.siteVisitQueue.dev:${USER}.${P2}`;
const VISIT_STORED = ['siteVisitStart', 'siteVisitEnd', 'siteVisitClose', 'siteVisitAddPlace', 'siteVisitRetirePlace', 'siteVisitAddAttendee', 'siteVisitRetireAttendee'];
const keyOf = (t: string) => (VISIT_STORED.includes(t) ? lane : general);
const neighbour = (t: string): OutboxOp => (VISIT_STORED.includes(t) ? MIN.siteVisitEnd : { t: 'startActivity', activityId: 'n-1', idempotencyKey: 'k-n' });

function onP2(stored: Record<string, string>) {
  for (const [x, v] of Object.entries(stored)) localStorage.setItem(x, v);
  useStore.setState({ ...getInitialState(), outbox: [], role: 'engineer', lang: 'en', sessionUserId: USER, activeProjectId: P2, online: false });
  useStore.getState()._setGateway({ project: P2, listSiteVisits: vi.fn(async () => []) } as unknown as ApiGateway);
  useStore.getState().hydrateOutbox();
}
const copiesOf = (x: string) => Object.keys(localStorage).filter((y) => y.startsWith(`vitan.unreadable.${x}.`)).map((y) => localStorage.getItem(y));

afterEach(() => {
  vi.restoreAllMocks();
  useStore.getState()._setGateway(null);
  localStorage.clear();
  sessionStorage.clear();
});

describe('#1051 r1, Codex 4336713248: a key holding a damaged act of a known kind is unreadable', () => {
  // the photo's act is kept in its IndexedDB row, never in a queue key: a damaged row is left as it is (gap 5's rule)
  const stored = (Object.keys(MIN) as OutboxOp['t'][]).filter((t) => t !== 'siteVisitAddFile');

  it.each(stored)('%s missing its first field: listed, set aside on the tap, never loaded, replayed or written over', async (t) => {
    const bad = damaged(MIN[t])[0].act;
    const raw = JSON.stringify([neighbour(t), bad]);
    onP2({ [keyOf(t)]: raw });
    expect(useStore.getState().queueUnreadable.map((u) => u.key)).toEqual([keyOf(t)]);
    expect(useStore.getState().queueUnreadable.filter((u) => u.read === 'newer').map((u) => u.key)).toEqual([]);
    expect(useStore.getState().outbox).toEqual([]);
    useStore.setState({ online: true });
    await useStore.getState().flushOutbox();
    useStore.setState({ online: false });
    useStore.getState().startActivity('B-1');
    expect(localStorage.getItem(keyOf(t))).toBe(raw);
    useStore.getState().setAsideUnreadableQueue();
    expect(useStore.getState().queueUnreadable).toEqual([]);
    // the key's bytes are copied aside; so, beside the general key, is the start this tab could not store there (#1079 4344436665)
    const copies = copiesOf(keyOf(t));
    expect(copies.filter((c) => c === raw)).toHaveLength(1);
    expect(copies.filter((c) => c !== raw).map((c) => (JSON.parse(c!) as OutboxOp[]).map((o) => o.t))).toEqual(keyOf(t) === general ? [['startActivity']] : []);
  });

  it('a key holding an act of every kind it keeps, each whole, loads every one', () => {
    const generalActs = stored.filter((t) => !VISIT_STORED.includes(t)).map((t, i) => ({ ...MIN[t], ...('idempotencyKey' in MIN[t] ? { idempotencyKey: `k-${i}` } : {}), ...('coalesceKey' in MIN[t] ? { coalesceKey: `c-${i}` } : {}) }));
    const laneActs = VISIT_STORED.map((t, i) => ({ ...MIN[t as OutboxOp['t']], idempotencyKey: `kv-${i}` }));
    onP2({ [general]: JSON.stringify(generalActs), [lane]: JSON.stringify(laneActs) });
    expect(useStore.getState().queueUnreadable).toEqual([]);
    expect(useStore.getState().outbox.map((o) => o.t).sort()).toEqual([...generalActs, ...laneActs].map((o) => o.t).sort());
  });

  it('a visit start with no visitor, which the Site Visits screen reads, makes its lane unreadable (re-check G3)', () => {
    const { visitor: _v, ...noVisitor } = MIN.siteVisitStart;
    const raw = JSON.stringify([noVisitor]);
    onP2({ [lane]: raw });
    expect(useStore.getState().queueUnreadable.map((u) => u.key)).toEqual([lane]);
    expect(useStore.getState().outbox).toEqual([]);
    expect(localStorage.getItem(lane)).toBe(raw);
  });

  /** each shape a released build stored, with the gateway call its replay makes: loaded whole, sent unkeyed, cleared */
  const OLD: [string, object, string, unknown[]][] = [
    ['approve (b22895b1..466814c0)', { t: 'approve', decisionId: 'd-1', optionIndex: 0 }, 'approveDecision', ['d-1', 0, undefined]],
    ['change (b22895b1..466814c0)', { t: 'change', decisionId: 'd-1', reason: 'r', costImpact: 0, timeImpactDays: 0 }, 'requestChange', ['d-1', 'r', 0, 0, undefined]],
    ['changeWithdraw (41ff9dc1..466814c0)', { t: 'changeWithdraw', decisionId: 'd-1' }, 'withdrawChange', ['d-1', undefined]],
    ['ackDrawing (d29287b0..f59dc583)', { t: 'ackDrawing', revisionId: 'r-1' }, 'acknowledgeDrawing', ['r-1', undefined]],
    ['flagMismatch (b22895b1..c0940a02)', { t: 'flagMismatch', decisionId: 'd-1' }, 'flagMismatch', ['d-1', undefined]],
    ['submitDailyLog (b22895b1..c0940a02)', { t: 'submitDailyLog', log: { checkedIn: true, checkinTime: '8:00 AM', progress: 1, crew: [] } }, 'submitDailyLog', [{ checkedIn: true, checkinTime: '8:00 AM', progress: 1, crew: [] }, undefined]],
    ['decideReview approving, rejectedItemNames (b22895b1..ce360ae5)', { t: 'decideReview', inspectionId: 'i-1', approve: true, rejectedItemNames: [] }, 'decideReview', ['i-1', true, undefined, undefined]],
    ['decideReview rejecting, rejectedItemNames (b22895b1..ce360ae5)', { t: 'decideReview', inspectionId: 'i-1', approve: false, rejectedItemNames: ['Sealant'] }, 'decideReview', ['i-1', false, undefined, undefined]],
    ['grantSodException with no rule (090ec501..86d45cf7)', { ...MIN.grantSodException, input: { billId: 'b', actorId: 'a', reason: 'r', versionId: 'v', status: 's', lifecycleVersion: 1 } }, 'grantSodException', [{ billId: 'b', actorId: 'a', reason: 'r', versionId: 'v', status: 's', lifecycleVersion: 1 }, k]],
  ];
  it.each(OLD)('%s, stored by a released build, loads whole, is sent as it was stored, and leaves the key', async (_label, op, call, args) => {
    onP2({ [general]: JSON.stringify([op]) });
    expect(useStore.getState().queueUnreadable).toEqual([]);
    expect(useStore.getState().outbox).toEqual([op]);
    const send = vi.fn(async () => null);
    useStore.getState()._setGateway({ project: P2, listSiteVisits: vi.fn(async () => []), snapshot: vi.fn(async () => null), [call]: send } as unknown as ApiGateway);
    useStore.setState({ online: true });
    await useStore.getState().flushOutbox();
    expect(send.mock.calls).toEqual([args]);
    expect(useStore.getState().outbox).toEqual([]);
    expect(JSON.parse(localStorage.getItem(general) ?? '[]')).toEqual([]);
  });

  it('a July approve in the legacy unscoped queue moves into the scoped key and loads (re-check G2)', () => {
    const op = { t: 'approve', decisionId: 'd-1', optionIndex: 0 };
    localStorage.setItem('vitan.outbox', JSON.stringify([op]));
    onP2({});
    expect(useStore.getState().queueUnreadable).toEqual([]);
    expect(useStore.getState().outbox).toEqual([op]);
  });

  it('a damaged act of a known kind beside a newer release’s act is not taken as a newer release’s key', () => {
    onP2({ [general]: JSON.stringify([{ t: 'approve' }, { t: 'futureOperation', idempotencyKey: 'k-f' }]) });
    expect(useStore.getState().queueUnreadable.map((u) => u.key)).toEqual([general]);
    expect(useStore.getState().queueUnreadable.filter((u) => u.read === 'newer').map((u) => u.key)).toEqual([]);
  });

  it('a whole act beside a newer release’s act is still a newer release’s key', () => {
    onP2({ [general]: JSON.stringify([MIN.approve, { t: 'futureOperation', idempotencyKey: 'k-f' }]) });
    expect(useStore.getState().queueUnreadable.filter((u) => u.read === 'newer').map((u) => u.key)).toEqual([general]);
  });
});
