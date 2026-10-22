import { SOD_RULES } from '@vitan/shared';
// the server's own request contracts, so a stored act is read by exactly the rules its replay is parsed by. Its `zod`
// resolves from apps/api, whose dependency it is
import * as contracts from '../../../api/src/contracts';
import type { OutboxOp } from '@/data/apiGateway';

/**
 * WEB-02 step 2 (#482 6326129029): which stored queue entries this release can load and send.
 *
 * A stored act was taken as loadable whatever its fields held: `[{"t":"approve"}]` loaded, its replay sent `undefined`,
 * the server refused it for good, and the flush dropped it (Codex 4336713248). An act whose fields hold but that breaks a
 * server rule across them (an allocation naming both a worker and a crew) was likewise refused and dropped (#1071 F4,
 * Codex 4341067934), as was one breaking a bound (an approval of option -1: Codex 4345664659). Each kind is now read
 * through the fields this release reads (`OUTBOX_OP_KINDS`), and the body its replay sends is parsed by the server's own
 * contract (`SERVER_CONTRACT_OF`). A key holding any entry that fails is unreadable as a whole (`readStoredQueue`): it is
 * never loaded, sent, or written over, and the person is offered Set aside.
 */

type Check = (v: unknown) => boolean;
type Fields = Record<string, unknown>;
const isFields = (v: unknown): v is Fields => typeof v === 'object' && v !== null && !Array.isArray(v);
const str: Check = (v) => typeof v === 'string';
const key: Check = (v) => typeof v === 'string' && v.length > 0;
const num: Check = (v) => typeof v === 'number' && Number.isFinite(v);
const int: Check = (v) => Number.isInteger(v);
const bool: Check = (v) => typeof v === 'boolean';
const opt = (c: Check): Check => (v) => v === undefined || c(v);
const orNull = (c: Check): Check => (v) => v === null || c(v);
const oneOf = (...values: readonly string[]): Check => (v) => typeof v === 'string' && values.includes(v);
const list = (c: Check): Check => (v) => Array.isArray(v) && v.every(c);
const shape = (fields: Record<string, Check>): Check => (v) => isFields(v) && Object.entries(fields).every(([k, c]) => c(v[k]));
/** an act: its own fields, under its kind */
const act = (fields: Record<string, Check>): Check => shape(fields);
const keyed = (fields: Record<string, Check>): Check => act({ ...fields, idempotencyKey: key });
/** a kind an earlier release queued with no key: such an act replays unkeyed, as it did there (#1051 r1 re-check G2) */
const keyedLater = (fields: Record<string, Check>): Check => act({ ...fields, idempotencyKey: opt(key) });
/** the two-key split (materials, labour, commercial): a fresh key per act and the coalescing identity. A materials act
 *  from PR #207 has no `coalesceKey`; `normalizeMaterialsOutbox` derives it on load */
const twoKeys = (fields: Record<string, Check>): Check => act({ ...fields, idempotencyKey: key, coalesceKey: key });
const twoKeysMaterials = (fields: Record<string, Check>): Check => act({ ...fields, idempotencyKey: key, coalesceKey: opt(key) });
const designation = oneOf('client', 'pmc', 'member', 'architect');
const billLine = shape({ poLineId: opt(str), labourPoLineId: opt(str), quantity: str, rate: str, taxAmount: opt(str), freightAmount: opt(str) });

/** Every kind of act this release queues and sends, with the fields its replay reads (WEB-02, #1037 r1; Codex
 *  4336713248: a stored act missing one would be sent with it undefined, refused for good, and dropped). Typed against
 *  `OutboxOp['t']`, so a new kind that is not listed here fails the build. Fields this tab reads but never sends are
 *  checked too (a visit's `visitor` and `name`, a photo's `by`, `placeName` and `queuedAt`, read by the Site Visits
 *  screen; a correction's `labourPoLineId`, read by `capReservationOf`: #1051 r1 re-check G3). Every shape an earlier
 *  release stored stays readable: a key added later is optional on the kinds it came to (G2).
 *  Release rule (#792): a new kind may ship only after the chain-version unit has merged, so newer tabs can tell an
 *  older tab (one before #1037 takes an unknown act as sent and writes over its key). Never reshape an existing kind
 *  (a release that cannot load its shape makes the whole key unreadable), and never store an existing kind under
 *  another key (each lane's key holds only its own acts): add a new kind instead. */
const OUTBOX_OP_KINDS: Record<OutboxOp['t'], Check> = {
  siteVisitStart: keyed({ body: shape({ id: str, claimedAt: str, nodeId: opt(str), location: opt(shape({ lat: num, lng: num, accuracyM: num, at: str })) }), visitor: shape({ name: str, role: str, placeName: orNull(str) }) }),
  siteVisitEnd: keyed({ visitId: str, claimedAt: str }),
  siteVisitClose: keyed({ visitId: str, reason: str }),
  siteVisitAddPlace: keyed({ visitId: str, body: shape({ id: str, nodeId: str, claimedAt: str }), name: str }),
  siteVisitRetirePlace: keyed({ visitId: str, placeId: str }),
  siteVisitAddAttendee: keyed({ visitId: str, body: (v) => shape({ id: str, userId: str, role: str })(v) || shape({ id: str, guestName: str })(v), name: str }),
  siteVisitRetireAttendee: keyed({ visitId: str, attendeeId: str }),
  siteVisitAddFile: keyed({
    visitId: str, scope: str, by: shape({ name: str, role: str }), placeName: orNull(str), queuedAt: opt(str),
    file: shape({ id: str, mime: str, takenAt: opt(str), geoLat: opt(num), geoLng: opt(num), nodeId: opt(str), note: opt(str), rating: opt(oneOf('fine', 'concern', 'action_needed')), sourceMediaId: opt(str) }),
  }),
  // keyless before 466814c0 (approve, change, changeWithdraw), c0940a02 (flagMismatch, submitDailyLog) and f59dc583
  // (ackDrawing): an act an earlier release queued replays unkeyed
  approve: keyedLater({ decisionId: str, optionIndex: int }),
  forwardDecision: keyed({ decisionId: str, input: shape({ toDesignationKind: designation, toDesignationMembershipId: opt(str), reason: str }) }),
  countersignDecision: keyed({ decisionId: str }),
  disagreeDecision: keyed({
    decisionId: str,
    input: shape({ path: oneOf('reject_back', 'forward_on'), reason: str, costImpact: opt(num), timeImpactDays: opt(num), toDesignationKind: opt(designation), toDesignationMembershipId: opt(str) }),
  }),
  resolveStrandedCountersign: keyed({
    decisionId: str,
    input: shape({ outcome: oneOf('completed', 'returned'), reason: str, costImpact: opt(num), timeImpactDays: opt(num), toDesignationKind: opt(designation), toDesignationMembershipId: opt(str) }),
  }),
  change: keyedLater({ decisionId: str, reason: str, costImpact: num, timeImpactDays: num }),
  changeWithdraw: keyedLater({ decisionId: str }),
  withdraw: keyed({ decisionId: str, reason: str }),
  consultationRequest: keyed({ decisionId: str, consulteeMembershipId: str, question: str }),
  consultationRespond: keyed({ decisionId: str, consultationId: str, response: str, recommendedOptionIndex: opt(int) }),
  ackDrawing: keyedLater({ revisionId: str }),
  publishDrawing: keyed({ drawingId: str }),
  setDrawingNode: keyed({ drawingId: str, nodeId: orNull(str) }),
  submitInspection: act({ inspectionId: str, items: list(shape({ id: opt(str), name: str, state: orNull(oneOf('pass', 'fail', 'na')), photos: num, note: str, evidence: opt(list(str)) })) }),
  // keyless before Task 10: an act queued by an earlier release replays unkeyed
  // and a review queued before ce360ae5 names no item ids (`rejectedItemNames`): it is sent as that release's would be
  // now, with none, and the server takes none as none: an approval approves; a rejection sends back the rows the
  // inspection holds as failed, or is refused 400 when there are none (inspections.service.ts, "No items rejected")
  decideReview: (v) => act({ inspectionId: str, approve: bool, idempotencyKey: opt(key) })(v) && isFields(v)
    && (list(str)(v.rejectedItemIds) || (v.rejectedItemIds === undefined && list(str)(v.rejectedItemNames))),
  startActivity: act({ activityId: str, idempotencyKey: opt(key) }),
  completeActivity: act({ activityId: str, idempotencyKey: opt(key) }),
  startDailyLog: keyed({}),
  addSiteMaterial: keyed({ input: shape({ name: str, qty: str, zone: opt(str), decisionId: opt(str), swatch: opt(str), nodeId: opt(str) }) }),
  flagMismatch: keyedLater({ decisionId: str }),
  submitDailyLog: keyedLater({ log: shape({ checkedIn: bool, checkinTime: orNull(str), progress: num, crew: list(shape({ trade: str, count: num })) }) }),
  reserveStock: twoKeysMaterials({ input: shape({ lotId: str, storeLocation: str, activityId: str, qty: str }) }),
  issueStock: twoKeysMaterials({ input: shape({ lotId: str, storeLocation: str, activityId: str, qty: str, note: opt(str) }) }),
  consumeStock: twoKeysMaterials({ input: shape({ issueId: str, qty: str, note: opt(str) }) }),
  createRequisition: twoKeysMaterials({ input: shape({ title: str, notes: opt(str), lines: list(shape({ requirementId: str, revision: num, qty: str })) }) }),
  allocateLabour: twoKeys({
    input: shape({ activityId: str, requirementId: str, civilDate: str, workerId: opt(str), crewId: opt(str), capacityCommitmentId: opt(str), originRevision: opt(num), labourSpecFingerprint: opt(str) }),
  }),
  recordAttendance: twoKeys({ input: shape({ workerId: str, civilDate: str, shift: oneOf('day', 'night'), deviceId: opt(str), manualReason: opt(str), evidenceMediaId: opt(str) }) }),
  recordLabourWork: twoKeys({ input: shape({ allocationId: str, workedMinutes: num, note: opt(str) }) }),
  createLabourRequisition: twoKeys({ input: shape({ title: str, notes: opt(str), lines: list(shape({ requirementId: str, revision: num, civilDate: str, personShiftQty: num })) }) }),
  setCommercialBudget: twoKeys({ input: shape({ costHeadCode: str, amount: str, reason: str }) }),
  defineCostHead: twoKeys({ input: shape({ code: str, name: str }) }),
  reattributeCommitment: twoKeys({ input: shape({ poLineId: opt(str), labourPoLineId: opt(str), costHeadCode: str, reason: str }) }),
  takeMeasurement: twoKeys({
    input: shape({ labourPoLineId: str, activityId: str, quantity: str, citedOutputId: str, measuredOn: opt(str), evidenceMediaId: opt(str), reason: opt(str) }),
  }),
  correctMeasurement: twoKeys({ input: shape({ measurementId: str, quantity: str, reason: str }), labourPoLineId: str }),
  recordVendorBill: twoKeys({ input: shape({ vendorId: str, vendorBillNumber: str, documentDate: str, lines: list(billLine) }) }),
  beginVerification: twoKeys({ input: shape({ billId: str }) }),
  verifyVendorBill: twoKeys({ input: shape({ billId: str }) }),
  certifyBill: twoKeys({ input: shape({ billId: str, versionId: str, lifecycleVersion: num }) }),
  supersedeCertificate: twoKeys({ input: shape({ billId: str, reason: str, certificateId: str }) }),
  // `rule` came in 86d45cf7 (#317); a grant queued before names none, and the server takes it so
  grantSodException: twoKeys({ input: shape({ billId: str, actorId: str, reason: str, versionId: str, status: str, lifecycleVersion: num, rule: opt(oneOf(...Object.values(SOD_RULES))) }) }),
  recordDeduction: twoKeys({ input: shape({ billId: str, type: str, amount: str, reason: opt(orNull(str)) }) }),
  releaseDeduction: twoKeys({ input: shape({ deductionId: str, amount: str, reason: str }) }),
  approvePayment: twoKeys({ input: shape({ billId: str, amount: str, lifecycleVersion: num }) }),
  payAdvance: twoKeys({ input: shape({ vendorId: str, amount: str, reason: str, method: str, reference: opt(orNull(str)) }) }),
  recordPayment: twoKeys({ input: shape({ approvalId: str, amount: str, method: str, reference: opt(orNull(str)) }) }),
  reversePayment: twoKeys({ input: shape({ paymentId: str, amount: str, reason: str }) }),
  submitVendorBill: twoKeys({ input: shape({ billId: str }) }),
  amendVendorBill: twoKeys({ input: shape({ billId: str, reason: str, lines: list(billLine) }) }),
  rejectVendorBill: twoKeys({ input: shape({ billId: str, reason: str }) }),
  releaseLabourAllocation: twoKeys({ allocationId: str, reason: str }),
  uploadMedia: act({
    input: shape({
      kind: oneOf('progress', 'inspection', 'decision', 'attendance', 'material', 'visit'), mime: str, data: str,
      decisionId: opt(str), nodeId: opt(str), inspectionId: opt(str), inspectionItemId: opt(str), clientKey: opt(str), dailyLogId: opt(str),
      siteVisit: opt(shape({ visitId: str, note: opt(str), rating: opt(oneOf('fine', 'concern', 'action_needed')) })),
      geoLat: opt(num), geoLng: opt(num), takenAt: opt(str), sourceMediaId: opt(str),
    }),
  }),
  uploadEvidence: act({ scope: str, clientKey: str }),
};

type ServerSchema = { safeParse: (v: unknown) => { success: boolean } };
type SchemaName = { [N in keyof typeof contracts]: (typeof contracts)[N] extends ServerSchema ? N : never }[keyof typeof contracts];
const field = (v: Fields, f: string): unknown => v[f];
const inputBody = (v: Fields): unknown => v.input;
const bodyBody = (v: Fields): unknown => v.body;

/** The request body each queued kind's replay sends (`replayOutboxOp` through its gateway method), and the server's own
 *  contract that parses it, or `null` with why the stored act holds no body the server parses (Codex 4345664659). The
 *  contract is the server's zod schema itself (`apps/api/src/contracts.ts`), never a copy of it, so every `min`, `max`,
 *  `regex`, `.strict()` and `.refine` the server applies is applied here, no stricter and no looser. Typed against
 *  `OutboxOp['t']`, so a new kind fails the build until it is named here. `stored-act-invariants.test.ts` checks each
 *  body against what the gateway sends, and each schema against the controller that parses it. */
const SERVER_CONTRACT_OF: Record<OutboxOp['t'], { schema: SchemaName; body: (v: Fields) => unknown } | null> = {
  siteVisitStart: { schema: 'startSiteVisitSchema', body: bodyBody },
  siteVisitEnd: { schema: 'endSiteVisitSchema', body: (v) => ({ claimedAt: v.claimedAt }) },
  siteVisitClose: { schema: 'closeSiteVisitSchema', body: (v) => ({ reason: v.reason }) },
  siteVisitAddPlace: { schema: 'addSiteVisitPlaceSchema', body: bodyBody },
  // no body: the visit and the place are in the path
  siteVisitRetirePlace: null,
  siteVisitAddAttendee: { schema: 'addSiteVisitAttendeeSchema', body: bodyBody },
  siteVisitRetireAttendee: null,
  // its replay builds the upload from the photo's IndexedDB row, and a refusal is kept on that row with the server's
  // words, so the screen shows which photo was not sent and why: the act is never dropped unseen
  siteVisitAddFile: null,
  approve: { schema: 'approveSchema', body: (v) => ({ optionIndex: v.optionIndex }) },
  forwardDecision: { schema: 'forwardDecisionSchema', body: inputBody },
  countersignDecision: null,
  disagreeDecision: { schema: 'disagreeDecisionSchema', body: inputBody },
  resolveStrandedCountersign: { schema: 'resolveStrandedCountersignSchema', body: inputBody },
  change: { schema: 'changeSchema', body: (v) => ({ reason: v.reason, costImpact: v.costImpact, timeImpactDays: v.timeImpactDays }) },
  changeWithdraw: null,
  withdraw: { schema: 'withdrawDecisionSchema', body: (v) => ({ reason: v.reason }) },
  consultationRequest: { schema: 'requestConsultationSchema', body: (v) => ({ consulteeMembershipId: v.consulteeMembershipId, question: v.question }) },
  consultationRespond: {
    schema: 'respondToConsultationSchema',
    body: (v) => ({ consultationId: v.consultationId, response: v.response, ...(v.recommendedOptionIndex !== undefined ? { recommendedOptionIndex: v.recommendedOptionIndex } : {}) }),
  },
  ackDrawing: null,
  // its body is `{}`, which no schema parses
  publishDrawing: null,
  setDrawingNode: { schema: 'setNodeSchema', body: (v) => ({ nodeId: v.nodeId }) },
  submitInspection: { schema: 'submitInspectionSchema', body: (v) => ({ items: v.items }) },
  decideReview: { schema: 'decideReviewSchema', body: (v) => ({ approve: v.approve, rejectedItemIds: v.rejectedItemIds }) },
  startActivity: null,
  completeActivity: null,
  startDailyLog: null,
  addSiteMaterial: { schema: 'addMaterialSchema', body: inputBody },
  flagMismatch: { schema: 'flagMismatchSchema', body: (v) => ({ decisionId: v.decisionId }) },
  submitDailyLog: { schema: 'submitDailyLogSchema', body: (v) => field(v, 'log') },
  reserveStock: { schema: 'reserveStockSchema', body: inputBody },
  issueStock: { schema: 'issueStockSchema', body: inputBody },
  consumeStock: { schema: 'consumeStockSchema', body: inputBody },
  createRequisition: { schema: 'createRequisitionSchema', body: inputBody },
  allocateLabour: { schema: 'allocateLabourSchema', body: inputBody },
  recordAttendance: { schema: 'recordAttendanceSchema', body: inputBody },
  recordLabourWork: { schema: 'recordLabourWorkSchema', body: inputBody },
  createLabourRequisition: { schema: 'createLabourRequisitionSchema', body: inputBody },
  setCommercialBudget: { schema: 'setBudgetSchema', body: inputBody },
  defineCostHead: { schema: 'defineCostHeadSchema', body: inputBody },
  reattributeCommitment: { schema: 'reattributeSchema', body: inputBody },
  takeMeasurement: { schema: 'takeMeasurementSchema', body: inputBody },
  correctMeasurement: { schema: 'correctMeasurementSchema', body: inputBody },
  recordVendorBill: { schema: 'recordVendorBillSchema', body: inputBody },
  beginVerification: { schema: 'vendorBillStepSchema', body: inputBody },
  verifyVendorBill: { schema: 'vendorBillStepSchema', body: inputBody },
  certifyBill: { schema: 'certifyBillSchema', body: inputBody },
  supersedeCertificate: { schema: 'supersedeCertificateSchema', body: inputBody },
  grantSodException: { schema: 'grantSodExceptionSchema', body: inputBody },
  recordDeduction: { schema: 'recordDeductionSchema', body: inputBody },
  releaseDeduction: { schema: 'releaseDeductionSchema', body: inputBody },
  approvePayment: { schema: 'approvePaymentSchema', body: inputBody },
  payAdvance: { schema: 'payAdvanceSchema', body: inputBody },
  recordPayment: { schema: 'recordPaymentSchema', body: inputBody },
  reversePayment: { schema: 'reversePaymentSchema', body: inputBody },
  submitVendorBill: { schema: 'vendorBillStepSchema', body: inputBody },
  amendVendorBill: { schema: 'amendVendorBillSchema', body: inputBody },
  rejectVendorBill: { schema: 'rejectVendorBillSchema', body: inputBody },
  releaseLabourAllocation: { schema: 'releaseLabourAllocationSchema', body: (v) => ({ reason: v.reason }) },
  uploadMedia: { schema: 'createMediaSchema', body: inputBody },
  // its bytes and fields come from the evidence row in IndexedDB, not from the stored act
  uploadEvidence: null,
};

/** each queued kind's server schema, by name (the invariants test reads the controllers for it) */
export const SERVER_SCHEMA_OF = Object.fromEntries(
  Object.entries(SERVER_CONTRACT_OF).map(([t, c]) => [t, c ? c.schema : null]),
) as Record<OutboxOp['t'], SchemaName | null>;

/** the body a stored act's replay sends, as the wire carries it (JSON drops an `undefined` field), or `null` for a kind
 *  whose stored act holds no body the server parses */
export function serverBodyOf(v: { t: OutboxOp['t'] } & Fields): unknown {
  const contract = SERVER_CONTRACT_OF[v.t];
  if (!contract) return null;
  const body = contract.body(v);
  return body === undefined ? undefined : JSON.parse(JSON.stringify(body)) as unknown;
}

/** the server's own contract takes the body the stored act's replay would send (Codex 4345664659: an act it refuses
 *  would be refused for good and dropped by its flush, so it makes its key unreadable, set aside and never sent) */
function serverTakes(v: { t: OutboxOp['t'] } & Fields): boolean {
  const contract = SERVER_CONTRACT_OF[v.t];
  return contract === null || (contracts[contract.schema] as ServerSchema).safeParse(serverBodyOf(v)).success;
}

/** A stored entry naming a kind of act this release knows, whatever its fields hold */
export function isKnownOutboxKind(v: unknown): v is { t: OutboxOp['t'] } {
  if (!isFields(v)) return false;
  const t = v.t;
  return typeof t === 'string' && Object.prototype.hasOwnProperty.call(OUTBOX_OP_KINDS, t);
}

/** A stored entry this release can load: an object naming a kind of act it knows, holding every field that act's
 *  replay reads, of its type. A key holding any other entry (a newer release's act, damaged bytes, or a known kind
 *  missing a field: Codex 4336713248) is unreadable as a whole, so it is never loaded, written or sent
 *  (WEB-02, #1037 r1, Codex 4331862684) */
export function isKnownOutboxOp(v: unknown): v is OutboxOp {
  return isKnownOutboxKind(v) && OUTBOX_OP_KINDS[v.t](v) && serverTakes(v as { t: OutboxOp['t'] } & Fields);
}

/** A stored queue key's bytes, as this release reads them */
export type StoredQueue = { acts: OutboxOp[] } | { unreadable: 'newer' | 'damaged' };

/** An absent key is an empty list. Bytes that are not a list, or a list holding any entry this release cannot load, are
 *  unreadable as a whole: 'newer' when every such entry is an act of a kind this release does not know (a newer
 *  release's, which that release can read and send), else 'damaged'. */
export function readStoredQueue(raw: string | null): StoredQueue {
  if (raw === null) return { acts: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { unreadable: 'damaged' };
  }
  if (!Array.isArray(parsed)) return { unreadable: 'damaged' };
  let newer = false;
  for (const entry of parsed) {
    if (isKnownOutboxOp(entry)) continue;
    if (isFields(entry) && typeof entry.t === 'string' && !isKnownOutboxKind(entry)) { newer = true; continue; }
    return { unreadable: 'damaged' };
  }
  return newer ? { unreadable: 'newer' } : { acts: parsed as OutboxOp[] };
}
