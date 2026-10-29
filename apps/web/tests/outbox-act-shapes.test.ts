import { describe, it, expect, afterEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import { ApiGateway, replayOutboxOp, type OutboxOp } from '@/data/apiGateway';
import { isKnownOutboxOp, SERVER_SCHEMA_OF, serverBodyOf } from '@/data/storedActs';
import { syncResultText as SYNC } from '@vitan/shared';
import { queueWritten, storedQueue } from './queueWrites';

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
/** the server takes a visit's, a place's and an attendee's id only as a UUID */
const V = '6f1c2b0e-8a4d-4c5e-9b7a-1d2e3f4a5b6c';
const P = '7a2d3c1f-9b5e-4d6f-8c8b-2e3f4a5b6c7d';
const A = '8b3e4d2a-0c6f-4e7a-9d9c-3f4a5b6c7d8e';
/** the user scopes the store derives for the dev user `u-eng`'s keys (below): an evidence or visit photo act naming any
 *  other is not read (#1085 r2, Codex 4346169609) */
const S = { evidence: 'anon', visitPhoto: 'dev:u-eng' };

/** one act of every kind, holding only the fields its type requires */
const MIN: { [K in OutboxOp['t']]: Act<K> } = {
  siteVisitStart: { t: 'siteVisitStart', body: { id: V, claimedAt: '2026-10-21T05:30:00.000Z' }, visitor: { name: 'n', role: 'pmc', placeName: null }, idempotencyKey: k },
  siteVisitEnd: { t: 'siteVisitEnd', visitId: V, claimedAt: '2026-10-21T05:30:00.000Z', idempotencyKey: k },
  siteVisitClose: { t: 'siteVisitClose', visitId: V, reason: 'r', idempotencyKey: k },
  siteVisitAddPlace: { t: 'siteVisitAddPlace', visitId: V, body: { id: P, nodeId: 'n-1', claimedAt: '2026-10-21T05:30:00.000Z' }, name: 'n', idempotencyKey: k },
  siteVisitRetirePlace: { t: 'siteVisitRetirePlace', visitId: V, placeId: P, idempotencyKey: k },
  siteVisitAddAttendee: { t: 'siteVisitAddAttendee', visitId: V, body: { id: A, userId: 'u-1', role: 'client' }, name: 'n', idempotencyKey: k },
  siteVisitRetireAttendee: { t: 'siteVisitRetireAttendee', visitId: V, attendeeId: A, idempotencyKey: k },
  siteVisitAddFile: { t: 'siteVisitAddFile', visitId: V, scope: S.visitPhoto, file: { id: 'f-1', mime: 'image/png' }, by: { name: 'n', role: 'pmc' }, placeName: null, idempotencyKey: k },
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
  submitInspection: { t: 'submitInspection', inspectionId: 'i-1', items: [{ id: 'x', name: 'n', state: null, photos: 0, note: '' }] },
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
  recordDeduction: { t: 'recordDeduction', input: { billId: 'b', type: 'retention', amount: '1' }, idempotencyKey: k, coalesceKey: c },
  releaseDeduction: { t: 'releaseDeduction', input: { deductionId: 'd', amount: '1', reason: 'r' }, idempotencyKey: k, coalesceKey: c },
  approvePayment: { t: 'approvePayment', input: { billId: 'b', amount: '1', lifecycleVersion: 1 }, idempotencyKey: k, coalesceKey: c },
  payAdvance: { t: 'payAdvance', input: { vendorId: 'v', amount: '1', reason: 'r', method: 'm' }, idempotencyKey: k, coalesceKey: c },
  recordPayment: { t: 'recordPayment', input: { approvalId: 'a', amount: '1', method: 'm' }, idempotencyKey: k, coalesceKey: c },
  reversePayment: { t: 'reversePayment', input: { paymentId: 'p', amount: '1', reason: 'r' }, idempotencyKey: k, coalesceKey: c },
  amendVendorBill: { t: 'amendVendorBill', input: { billId: 'b', reason: 'r', lines: [line] }, idempotencyKey: k, coalesceKey: c },
  rejectVendorBill: { t: 'rejectVendorBill', input: { billId: 'b', reason: 'r' }, idempotencyKey: k, coalesceKey: c },
  uploadMedia: { t: 'uploadMedia', input: { kind: 'progress', mime: 'image/png', data: 'AA==' } },
  uploadEvidence: { t: 'uploadEvidence', scope: S.evidence, clientKey: 'ck' },
  uploadSitePhoto: { t: 'uploadSitePhoto', scope: S.visitPhoto, clientKey: 'ck' },
};

/** the kinds with optional fields, holding every one of them */
const FULL: OutboxOp[] = [
  { ...MIN.siteVisitStart, body: { id: V, claimedAt: '2026-10-21T05:30:00.000Z', nodeId: 'n', location: { lat: 1, lng: 2, accuracyM: 3, at: '2026-10-21T05:30:00.000Z' } } },
  { ...MIN.siteVisitAddAttendee, body: { id: A, guestName: 'g' } },
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
  { ...MIN.allocateLabour, input: { activityId: 'a', requirementId: 'r', civilDate: '2026-10-21', crewId: 'c', capacityCommitmentId: 'cc', originRevision: 1, labourSpecFingerprint: 'f'.repeat(64) } },
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
  { ...MIN.uploadMedia, input: { ...MIN.uploadMedia.input, kind: 'visit', decisionId: 'd', nodeId: 'n', inspectionId: 'i', inspectionItemId: 'ii', clientKey: 'ck', dailyLogId: 'dl', siteVisit: { visitId: V, note: 'x', rating: 'fine' }, geoLat: 1, geoLng: 2, takenAt: 'T', sourceMediaId: 's' } },
];

/** the fields an earlier release stored some acts of a kind without (#1051 r1 re-check G2), by their path: such an act
 *  replays as it did there */
const KEYED_LATER = ['approve', 'change', 'changeWithdraw', 'ackDrawing', 'flagMismatch', 'submitDailyLog'];
const HISTORICAL: Partial<Record<OutboxOp['t'], string[]>> = {
  ...Object.fromEntries(KEYED_LATER.map((t) => [t, ['idempotencyKey']])),
  grantSodException: ['input.rule'],
  // #1088 r4 (Codex 4351952407): a certification #310 queued names no lifecycleVersion; a checklist before #114, no row id
  certifyBill: ['input.lifecycleVersion'],
  submitInspection: ['items.0.id'],
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
    for (const op of [...Object.values(MIN), ...FULL]) expect([op.t, isKnownOutboxOp(op, S)]).toEqual([op.t, true]);
  });

  it.each(Object.keys(MIN) as OutboxOp['t'][])('%s missing any field its replay reads, or holding it as the wrong type, is not read', (t) => {
    const cases = damaged(MIN[t]);
    expect(cases.length).toBeGreaterThan(0);
    for (const { label, act } of cases) expect([label, isKnownOutboxOp(act, S)]).toEqual([label, false]);
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

describe('#1085 r1 (Codex 4345664659): the body a stored act is read by is the body its replay sends', () => {
  it('for every kind the server parses a body of, the gateway sends exactly the body the server contract reads it by', async () => {
    const sent: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      sent.push(init?.body === undefined ? undefined : JSON.parse(init.body as string));
      return { ok: true, status: 200, json: async () => ({}) };
    }));
    const gw = new ApiGateway('http://api.test', 'p-2');
    const mismatched: string[] = [];
    for (const op of [...Object.values(MIN), ...FULL]) {
      if (SERVER_SCHEMA_OF[op.t] === null) continue;
      sent.length = 0;
      await replayOutboxOp(gw, op).catch(() => null);
      const expected = serverBodyOf(op as OutboxOp & Record<string, unknown>);
      if (JSON.stringify(sent[0]) !== JSON.stringify(expected)) mismatched.push(`${op.t}: sent ${JSON.stringify(sent[0])}, read ${JSON.stringify(expected)}`);
    }
    vi.unstubAllGlobals();
    expect(mismatched).toEqual([]);
  });
});

describe('#1085 r2 (Codex 4346169580): every field a replay puts in its request path is a route id the path can carry', () => {
  /** each kind's fields the gateway puts in the request path as they stand, found by replaying it (below) */
  const PATH_FIELDS: Record<string, string[]> = {
    siteVisitEnd: ['visitId'], siteVisitClose: ['visitId'], siteVisitAddPlace: ['visitId'], siteVisitRetirePlace: ['visitId', 'placeId'],
    siteVisitAddAttendee: ['visitId'], siteVisitRetireAttendee: ['visitId', 'attendeeId'],
    approve: ['decisionId'], forwardDecision: ['decisionId'], countersignDecision: ['decisionId'], disagreeDecision: ['decisionId'],
    resolveStrandedCountersign: ['decisionId'], change: ['decisionId'], changeWithdraw: ['decisionId'], withdraw: ['decisionId'],
    consultationRequest: ['decisionId'], consultationRespond: ['decisionId'],
    ackDrawing: ['revisionId'], publishDrawing: ['drawingId'], setDrawingNode: ['drawingId'],
    submitInspection: ['inspectionId'], decideReview: ['inspectionId'],
    startActivity: ['activityId'], completeActivity: ['activityId'], releaseLabourAllocation: ['allocationId'],
  };

  it('the path fields of every kind, found by replaying each through the real gateway, are the ones listed', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { urls.push(url); return { ok: true, status: 200, json: async () => ({}) }; }));
    const gw = new ApiGateway('http://api.test', 'p-2');
    const found: Record<string, string[]> = {};
    for (const op of Object.values(MIN)) {
      // a photo's and an evidence row's replay reads its row on this phone first; neither puts an act field in a path
      if (op.t === 'siteVisitAddFile' || op.t === 'uploadEvidence') continue;
      urls.length = 0;
      await replayOutboxOp(gw, op).catch(() => null);
      // every request the replay makes (a command, then its snapshot), each path past /projects/p-2
      const segments = urls.flatMap((u) => new URL(u).pathname.split('/').slice(3));
      // every string the act holds, however deep (`input.billId`), named by its path
      const leaves: [string, string][] = [];
      const walk = (at: string, v: unknown): void => {
        if (typeof v === 'string') leaves.push([at, v]);
        else if (v !== null && typeof v === 'object') for (const [f, x] of Object.entries(v)) walk(at ? `${at}.${f}` : f, x);
      };
      walk('', op);
      const fields = leaves.filter(([f, v]) => f !== 't' && segments.includes(v)).map(([f]) => f);
      if (fields.length > 0) found[op.t] = fields.sort();
    }
    vi.unstubAllGlobals();
    expect(found).toEqual(Object.fromEntries(Object.entries(PATH_FIELDS).map(([t, f]) => [t, [...f].sort()])));
  });

  it.each(Object.entries(PATH_FIELDS))('%s: a path field empty, holding a path character, or a dot segment is not read; a server id is', (t, fields) => {
    const op = MIN[t as OutboxOp['t']] as unknown as Record<string, unknown>;
    for (const f of fields) {
      for (const bad of ['', ' ', 'a/b', '..', '.', 'a?b', 'a#b', 'a%2Fb', 'a b', 7]) expect([f, bad, isKnownOutboxOp({ ...op, [f]: bad }, S)]).toEqual([f, bad, false]);
      // the server's ids: a uuid, or a seed id; the server reads each such param as a plain string
      expect([f, isKnownOutboxOp({ ...op, [f]: '0F1C2B0E-8A4D-4C5E-9B7A-1D2E3F4A5B6C' }, S)]).toEqual([f, true]);
      expect([f, isKnownOutboxOp({ ...op, [f]: 'DL-1' }, S)]).toEqual([f, true]);
    }
  });

  it('a photo act names its visit by uuid and its file by a client key the server takes', () => {
    expect(isKnownOutboxOp({ ...MIN.siteVisitAddFile, visitId: 'v-1' }, S)).toBe(false);
    for (const id of ['', '  ', 'x'.repeat(121)]) expect(isKnownOutboxOp({ ...MIN.siteVisitAddFile, file: { ...MIN.siteVisitAddFile.file, id } }, S)).toBe(false);
    for (const clientKey of ['', '  ', 'x'.repeat(121)]) expect(isKnownOutboxOp({ ...MIN.uploadEvidence, clientKey }, S)).toBe(false);
    expect(isKnownOutboxOp({ ...MIN.uploadEvidence, clientKey: 'x'.repeat(120) }, S)).toBe(true);
  });

  it('a stored countersign naming no decision: listed, never replayed or dropped, and its key kept (the finding’s case)', async () => {
    const raw = JSON.stringify([{ t: 'countersignDecision', decisionId: '', idempotencyKey: 'k-cs' }]);
    onP2({ [general]: raw });
    expect(useStore.getState().queueUnreadable.map((u) => u.key)).toEqual([general]);
    expect(useStore.getState().outbox).toEqual([]);
    useStore.setState({ online: true });
    await useStore.getState().flushOutbox();
    expect(localStorage.getItem(general)).toBe(raw);
  });
});

describe('#1088 r2 (Codex 4350723956): an idempotency key is one the Idempotency-Key header can carry and the server keeps', () => {
  /** every kind's act as stored with every optional field, a key included */
  const withKey = (t: OutboxOp['t']): Record<string, unknown> => {
    const full = FULL.find((o) => o.t === t && 'idempotencyKey' in o);
    return { ...(full ?? MIN[t]) } as Record<string, unknown>;
  };
  const KEYED = (Object.keys(MIN) as OutboxOp['t'][]).filter((t) => 'idempotencyKey' in withKey(t));

  it('the only act field a replay sends as a header is its idempotency key, found by replaying every kind through the real gateway', async () => {
    const heads: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      heads.push(...new Headers(init?.headers).values());
      return { ok: true, status: 200, json: async () => ({}) };
    }));
    const gw = new ApiGateway('http://api.test', 'p-2');
    const found = new Set<string>();
    for (const op of [...Object.values(MIN), ...FULL]) {
      // a photo's and an evidence row's replay reads its row on this phone first (the photo act's key is checked below)
      if (op.t === 'siteVisitAddFile' || op.t === 'uploadEvidence') continue;
      heads.length = 0;
      await replayOutboxOp(gw, op).catch(() => null);
      for (const [f, v] of Object.entries(op)) if (f !== 't' && typeof v === 'string' && heads.includes(v)) found.add(f);
    }
    vi.unstubAllGlobals();
    expect([...found]).toEqual(['idempotencyKey']);
  });

  it.each(KEYED)('%s: a blank key, or one a header cannot carry, is not read; every key this app makes is', (t) => {
    const op = withKey(t);
    for (const bad of ['', ' ', '\t', ' \t ', 'a\r\nb', 'a\nb', 'a\rb', 'a\u0000b', 'ключ', 'clé', 7]) {
      expect([t, bad, isKnownOutboxOp({ ...op, idempotencyKey: bad }, S)]).toEqual([t, bad, false]);
    }
    for (const good of ['6f1c2b0e-8a4d-4c5e-9b7a-1d2e3f4a5b6c', 'k-1712345678901-4fzyo82mvyk', 'k-1', ' k-1 ']) {
      expect([t, good, isKnownOutboxOp({ ...op, idempotencyKey: good }, S)]).toEqual([t, good, true]);
    }
  });

  it('forced probe, the finding’s case: a stored approval whose key is blank is listed, never replayed, and its key kept', async () => {
    const raw = JSON.stringify([{ t: 'approve', decisionId: 'd-1', optionIndex: 0, idempotencyKey: '   ' }]);
    const approveDecision = vi.fn(async () => null);
    onP2({ [general]: raw });
    useStore.getState()._setGateway({ project: P2, listSiteVisits: vi.fn(async () => []), approveDecision } as unknown as ApiGateway);
    expect(useStore.getState().queueUnreadable.map((u) => u.key)).toEqual([general]);
    expect(useStore.getState().outbox).toEqual([]);
    useStore.setState({ online: true });
    await useStore.getState().flushOutbox();
    expect(approveDecision).not.toHaveBeenCalled();
    expect(localStorage.getItem(general)).toBe(raw);
  });

  it('forced probe: a stored labour start whose key holds a line break is listed, never replayed', () => {
    onP2({ [general]: JSON.stringify([{ t: 'startActivity', activityId: 'a-1', idempotencyKey: 'k\r\nX-Other: 1' }]) });
    expect(useStore.getState().queueUnreadable.map((u) => u.key)).toEqual([general]);
    expect(useStore.getState().outbox).toEqual([]);
  });
});

describe('#1085 r2 (Codex 4346169609): an act naming a user scope is read only under its own user’s key', () => {
  it('an evidence or visit photo act naming another scope, or read with none, is not read', () => {
    expect(isKnownOutboxOp(MIN.uploadEvidence, S)).toBe(true);
    expect(isKnownOutboxOp({ ...MIN.uploadEvidence, scope: 'user-a' }, S)).toBe(false);
    expect(isKnownOutboxOp(MIN.uploadEvidence)).toBe(false);
    expect(isKnownOutboxOp(MIN.siteVisitAddFile, S)).toBe(true);
    expect(isKnownOutboxOp({ ...MIN.siteVisitAddFile, scope: 'dev:someone-else' }, S)).toBe(false);
    expect(isKnownOutboxOp(MIN.siteVisitAddFile)).toBe(false);
  });

  it('user B’s key holding an evidence act naming user A: listed, A’s row never read, sent or deleted, the key kept', async () => {
    const raw = JSON.stringify([{ t: 'uploadEvidence', scope: 'user-a', clientKey: 'ck-a' }]);
    onP2({ [general]: raw });
    expect(useStore.getState().queueUnreadable.map((u) => u.key)).toEqual([general]);
    expect(useStore.getState().outbox.filter((o) => o.t === 'uploadEvidence')).toEqual([]);
    useStore.setState({ online: true });
    await useStore.getState().flushOutbox();
    expect(localStorage.getItem(general)).toBe(raw);
  });

  it('the evidence act this user queued is read under their key, as before', () => {
    const raw = JSON.stringify([MIN.uploadEvidence]);
    onP2({ [general]: raw });
    expect(useStore.getState().queueUnreadable).toEqual([]);
    expect(useStore.getState().outbox).toEqual([MIN.uploadEvidence]);
  });
});

describe('#1051 r1, Codex 4336713248: a key holding a damaged act of a known kind is unreadable', () => {
  // the photo's act is kept in its IndexedDB row, never in a queue key: a damaged row is left as it is (gap 5's rule)
  // (a visit photo's act and a site photo's are never stored: each is rebuilt from its row, SV2 and #917)
  const stored = (Object.keys(MIN) as OutboxOp['t'][]).filter((t) => t !== 'siteVisitAddFile' && t !== 'uploadSitePhoto');

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
    await queueWritten(); // step B1: written under the queue's lock, after the act
    expect(localStorage.getItem(keyOf(t))).toBe(raw);
    await useStore.getState().setAsideUnreadableQueue();
    await queueWritten();
    expect(useStore.getState().queueUnreadable).toEqual([]);
    // the key's bytes are copied aside. The start this tab could not store beside the general key was copied aside too
    // (#1079 4344436665); once Set aside writes it to the key, that copy is removed (#1096, Codex 4356145036)
    const copies = copiesOf(keyOf(t));
    expect(copies.filter((c) => c === raw)).toHaveLength(1);
    expect(copies.filter((c) => c !== raw)).toEqual([]);
    expect((storedQueue(localStorage.getItem(general)!) as OutboxOp[]).map((o) => o.t)).toEqual(['startActivity']);
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

  /** Idempotency-Key Unit 1: a keyless start, completion, review, mismatch flag or daily-log submit is sent under a key
   *  made from what it is (legacy-act-key.test.ts), never unkeyed */
  const LEGACY_KEY = expect.stringMatching(/^legacy-[0-9a-f]{64}$/);
  /** each shape a released build stored, with the gateway call its replay makes: loaded whole, sent as stored, cleared */
  const OLD: [string, object, string, unknown[]][] = [
    ['approve (b22895b1..466814c0)', { t: 'approve', decisionId: 'd-1', optionIndex: 0 }, 'approveDecision', ['d-1', 0, undefined]],
    ['change (b22895b1..466814c0)', { t: 'change', decisionId: 'd-1', reason: 'r', costImpact: 0, timeImpactDays: 0 }, 'requestChange', ['d-1', 'r', 0, 0, undefined]],
    ['changeWithdraw (41ff9dc1..466814c0)', { t: 'changeWithdraw', decisionId: 'd-1' }, 'withdrawChange', ['d-1', undefined]],
    ['ackDrawing (d29287b0..f59dc583)', { t: 'ackDrawing', revisionId: 'r-1' }, 'acknowledgeDrawing', ['r-1', undefined]],
    ['flagMismatch (b22895b1..c0940a02)', { t: 'flagMismatch', decisionId: 'd-1' }, 'flagMismatch', ['d-1', LEGACY_KEY]],
    ['submitDailyLog (b22895b1..c0940a02)', { t: 'submitDailyLog', log: { checkedIn: true, checkinTime: '8:00 AM', progress: 1, crew: [] } }, 'submitDailyLog', [{ checkedIn: true, checkinTime: '8:00 AM', progress: 1, crew: [] }, LEGACY_KEY]],
    ['decideReview approving, rejectedItemNames (b22895b1..ce360ae5)', { t: 'decideReview', inspectionId: 'i-1', approve: true, rejectedItemNames: [] }, 'decideReview', ['i-1', true, undefined, LEGACY_KEY]],
    ['decideReview rejecting, rejectedItemNames (b22895b1..ce360ae5)', { t: 'decideReview', inspectionId: 'i-1', approve: false, rejectedItemNames: ['Sealant'] }, 'decideReview', ['i-1', false, undefined, LEGACY_KEY]],
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
    expect(storedQueue(localStorage.getItem(general) ?? '[]')).toEqual([]);
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

/** #1088 r4 (Codex 4351952407): every body a released build stored, kind by kind, as `apps/web/src/data/apiGateway.ts`'s
 *  queue and its types held it at each release in git history. Each reads; a key holding one beside an unrelated act
 *  loads both. Only the three marked are refused by today's contract for their shape (`RELEASED_CONTRACTS_OF`) */
const RELEASED: { since: string; act: unknown }[] = [
  // b4671544 (#20's queue, 4 Jul): keyless decision acts, a review naming rows by label, a keyless labour start
  { since: 'b4671544', act: { t: 'approve', decisionId: 'd-1', optionIndex: 0 } },
  { since: 'b4671544', act: { t: 'change', decisionId: 'd-1', reason: 'r', costImpact: 0, timeImpactDays: 0 } },
  { since: 'b4671544', act: { t: 'decideReview', inspectionId: 'i-1', approve: false, rejectedItemNames: ['Slope'] } },
  { since: 'b4671544', act: { t: 'startActivity', activityId: 'a-1' } },
  { since: 'b4671544', act: { t: 'completeActivity', activityId: 'a-1' } },
  { since: 'b4671544', act: { t: 'flagMismatch', decisionId: 'd-1' } },
  { since: 'b4671544', act: { t: 'submitDailyLog', log: { checkedIn: true, checkinTime: '9:03 AM', progress: 2, crew: [{ trade: 'Mason', count: 3 }] } } },
  // shape refused today: rows named by label only, before #114 (ce360ae5)
  { since: 'b4671544', act: { t: 'submitInspection', inspectionId: 'i-1', items: [{ name: 'Slope', state: 'pass', photos: 0, note: '' }, { name: 'Slope', state: null, photos: 1, note: 'n' }] } },
  // shape refused today: a photo of any image type, before #54's raster list (6f8f22ba)
  { since: 'ecc9f049', act: { t: 'uploadMedia', input: { kind: 'progress', mime: 'image/bmp', data: 'AA==' } } },
  { since: '14c397fa', act: { t: 'changeWithdraw', decisionId: 'd-1' } },
  { since: '4a552e7b', act: { t: 'ackDrawing', revisionId: 'r-1' } },
  { since: '1ceccf71', act: { t: 'submitInspection', inspectionId: 'i-1', items: [{ id: 'x', name: 'Slope', state: 'fail', photos: 1, note: '', evidence: ['/media/m-1'] }] } },
  { since: '3380f758', act: { t: 'decideReview', inspectionId: 'i-1', approve: true, rejectedItemIds: [] } },
  { since: 'a1d78807', act: { t: 'reserveStock', input: { lotId: 'l', storeLocation: 's', activityId: 'a', qty: '1' }, idempotencyKey: 'k-1' } },
  // shape refused today: a certification #310 queued, before #312 made lifecycleVersion required (fbc95108)
  { since: '6861a850', act: { t: 'certifyBill', input: { billId: 'b', versionId: 'v' }, idempotencyKey: 'k-1', coalesceKey: 'c-1' } },
  { since: '090ec501', act: { t: 'grantSodException', input: { billId: 'b', actorId: 'u', reason: 'r', versionId: 'v', status: 's', lifecycleVersion: 1 }, idempotencyKey: 'k-1', coalesceKey: 'c-1' } },
];

describe('#1088 r4 (Codex 4351952407): every shape a released build stored is read, never taken as damage', () => {
  it.each(RELEASED.map((r) => [(r.act as { t: string }).t, r.since, r.act] as const))('%s as %s stored it is read', (_t, _since, act) => {
    expect(isKnownOutboxOp(act, S)).toBe(true);
  });

  it('forced probe, the finding’s case: a checklist submitted before #114, its rows named by label, loads with the act behind it', () => {
    const before114 = RELEASED.find((r) => (r.act as { t: string }).t === 'submitInspection')!.act;
    const behind = { t: 'startActivity', activityId: 'n-1', idempotencyKey: 'k-n' };
    onP2({ [general]: JSON.stringify([before114, behind]) });
    expect(useStore.getState().queueUnreadable).toEqual([]);
    expect(useStore.getState().outbox).toEqual([before114, behind]);
  });

  it('its body is its release’s: the rows by label, no id made up', async () => {
    const before114 = RELEASED.find((r) => (r.act as { t: string }).t === 'submitInspection')!.act as { items: unknown };
    expect(serverBodyOf(before114 as never)).toEqual({ items: before114.items });
  });

  it('today’s server refuses it, so its flush drops it as discarded, and the act behind it is sent', async () => {
    const before114 = RELEASED.find((r) => (r.act as { t: string }).t === 'submitInspection')!.act;
    const behind = { t: 'startActivity', activityId: 'n-1', idempotencyKey: 'k-n' };
    onP2({ [general]: JSON.stringify([before114, behind]) });
    const submitInspection = vi.fn(async () => { throw Object.assign(new Error('items.0.id: Required'), { status: 400 }); });
    const startActivity = vi.fn(async () => null);
    useStore.getState()._setGateway({ project: P2, listSiteVisits: vi.fn(async () => []), snapshot: vi.fn(async () => null), submitInspection, startActivity } as unknown as ApiGateway);
    useStore.setState({ online: true });
    await useStore.getState().flushOutbox();
    expect(submitInspection).toHaveBeenCalledTimes(1);
    expect(startActivity).toHaveBeenCalledTimes(1);
    expect(useStore.getState().outbox).toEqual([]);
    expect(useStore.getState().toast).toContain(SYNC.dropped(1, 'en'));
  });

  it('a body no release stored is still damage: rows some of which name an id, or a certification naming an unknown field', () => {
    const mixed = { t: 'submitInspection', inspectionId: 'i-1', items: [{ id: 'x', name: 'a', state: null, photos: 0, note: '' }, { name: 'b', state: null, photos: 0, note: '' }] };
    expect(isKnownOutboxOp(mixed, S)).toBe(false);
    // Codex 4356145032: rows with no id but a field that came after #114 (evidence) are no release's either
    const hybrid = { t: 'submitInspection', inspectionId: 'i-1', items: [{ name: 'a', state: 'fail', photos: 1, note: '', evidence: ['/media/m-1'] }] };
    expect(isKnownOutboxOp(hybrid, S)).toBe(false);
    expect(isKnownOutboxOp({ ...MIN.certifyBill, input: { billId: 'b', versionId: 'v', extra: 1 } }, S)).toBe(false);
    expect(isKnownOutboxOp({ ...MIN.uploadMedia, input: { kind: 'progress', mime: 'text/html', data: 'AA==' } }, S)).toBe(false);
    // a photo of any image type is read only in the fields its release sent (and the client key a load gave it)
    expect(isKnownOutboxOp({ ...MIN.uploadMedia, input: { kind: 'progress', mime: 'image/bmp', data: 'AA==', clientKey: 'ck' } }, S)).toBe(true);
    expect(isKnownOutboxOp({ ...MIN.uploadMedia, input: { kind: 'progress', mime: 'image/bmp', data: 'AA==', clientKey: ' ' } }, S)).toBe(false);
    expect(isKnownOutboxOp({ ...MIN.uploadMedia, input: { kind: 'progress', mime: 'image/bmp', data: 'AA==', nodeId: 'n' } }, S)).toBe(false);
    expect(isKnownOutboxOp({ ...MIN.uploadMedia, input: { kind: 'progress', mime: 'image/png', data: 'AA==', siteVisit: { visitId: V } } }, S)).toBe(false);
  });
});
