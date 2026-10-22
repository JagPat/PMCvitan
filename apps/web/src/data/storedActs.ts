import { SOD_RULES, parseCivilDate } from '@vitan/shared';
import type { OutboxOp } from '@/data/apiGateway';

/**
 * WEB-02 step 2 (#482 6326129029): which stored queue entries this release can load and send.
 *
 * A stored act was taken as loadable whatever its fields held: `[{"t":"approve"}]` loaded, its replay sent `undefined`,
 * the server refused it for good, and the flush dropped it (Codex 4336713248). An act whose fields hold but that breaks a
 * server rule across them (an allocation naming both a worker and a crew) was likewise refused and dropped (#1071 F4,
 * Codex 4341067934). Each kind is now read through the fields its replay reads (`OUTBOX_OP_KINDS`) and every server
 * `.refine` its contract could break (`SERVER_REFINES_MIRRORED`). A key holding any entry that fails is unreadable as a
 * whole (`readStoredQueue`): it is never loaded, sent, or written over, and the person is offered Set aside.
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

/** The server contract (`apps/api/src/contracts.ts`) each queued kind's replay is parsed by, or `null` with why none
 *  of its `.refine`s can be broken by the stored act (#1071 F4). Typed against `OutboxOp['t']`, so a new kind fails the
 *  build until it is named here; `stored-act-invariants.test.ts` reads the contract file and fails when any `.refine`
 *  reachable from a named schema is not in `SERVER_REFINES_MIRRORED`. */
export const SERVER_SCHEMA_OF: Record<OutboxOp['t'], string | null> = {
  siteVisitStart: 'startSiteVisitSchema', siteVisitEnd: 'endSiteVisitSchema', siteVisitClose: 'closeSiteVisitSchema',
  siteVisitAddPlace: 'addSiteVisitPlaceSchema', siteVisitRetirePlace: null, siteVisitAddAttendee: 'addSiteVisitAttendeeSchema',
  siteVisitRetireAttendee: null,
  // its replay builds the upload itself, always as kind 'visit' naming its visit (`createMediaSchema`'s one refine)
  siteVisitAddFile: null,
  approve: 'approveSchema', forwardDecision: 'forwardDecisionSchema', countersignDecision: null,
  disagreeDecision: 'disagreeDecisionSchema', resolveStrandedCountersign: 'resolveStrandedCountersignSchema',
  change: 'changeSchema', changeWithdraw: null, withdraw: 'withdrawDecisionSchema',
  consultationRequest: 'requestConsultationSchema', consultationRespond: 'respondToConsultationSchema',
  ackDrawing: null, publishDrawing: null, setDrawingNode: 'setNodeSchema',
  submitInspection: 'submitInspectionSchema', decideReview: 'decideReviewSchema',
  startActivity: null, completeActivity: null, startDailyLog: null,
  addSiteMaterial: 'addMaterialSchema', flagMismatch: 'flagMismatchSchema', submitDailyLog: 'submitDailyLogSchema',
  reserveStock: 'reserveStockSchema', issueStock: 'issueStockSchema', consumeStock: 'consumeStockSchema',
  createRequisition: 'createRequisitionSchema', allocateLabour: 'allocateLabourSchema', recordAttendance: 'recordAttendanceSchema',
  recordLabourWork: 'recordLabourWorkSchema', createLabourRequisition: 'createLabourRequisitionSchema',
  setCommercialBudget: 'setBudgetSchema', defineCostHead: 'defineCostHeadSchema', reattributeCommitment: 'reattributeSchema',
  takeMeasurement: 'takeMeasurementSchema', correctMeasurement: 'correctMeasurementSchema',
  recordVendorBill: 'recordVendorBillSchema', beginVerification: 'vendorBillStepSchema', verifyVendorBill: 'vendorBillStepSchema',
  certifyBill: 'certifyBillSchema', supersedeCertificate: 'supersedeCertificateSchema', grantSodException: 'grantSodExceptionSchema',
  recordDeduction: 'recordDeductionSchema', releaseDeduction: 'releaseDeductionSchema', approvePayment: 'approvePaymentSchema',
  payAdvance: 'payAdvanceSchema', recordPayment: 'recordPaymentSchema', reversePayment: 'reversePaymentSchema',
  submitVendorBill: 'vendorBillStepSchema', amendVendorBill: 'amendVendorBillSchema', rejectVendorBill: 'rejectVendorBillSchema',
  releaseLabourAllocation: 'releaseLabourAllocationSchema', uploadMedia: 'createMediaSchema',
  // its bytes and fields come from the evidence row in IndexedDB, not from the stored act
  uploadEvidence: null,
};
/** a designation pair the server takes: a member target names its membership, no other target names one */
const memberPair = (input: Fields): boolean => (input.toDesignationKind === 'member') === (input.toDesignationMembershipId !== undefined);
/** `isoCivilDateSchema`'s refine: a real calendar day */
const realDay = (v: unknown): boolean => {
  try { parseCivilDate(v as string); return true; } catch { return false; }
};
/** `commercialNonBlank`'s refine */
const nonBlank = (v: unknown): boolean => typeof v === 'string' && v.replace(/[ \t\n\v\f\r]+/gu, '') !== '';
const positiveQty = (v: unknown): boolean => typeof v === 'string' && Number(v.trim()) > 0;
/** `vendorBillLineSchema`'s two refines */
const billLineHolds = (l: Fields): boolean => positiveQty(l.quantity) && (l.poLineId == null) !== (l.labourPoLineId == null);
const inputOf = (v: unknown): Fields => (isFields(v) && isFields(v.input) ? v.input : {});
const bodyOf = (v: unknown): Fields => (isFields(v) && isFields(v.body) ? v.body : {});
/** `offsetInstant`'s refine: an instant Date reads, within the years ISO text has */
const readableInstant = (v: unknown): boolean => {
  const t = Date.parse(v as string);
  return Number.isFinite(t) && t >= Date.parse('0000-01-01T00:00:00.000Z') && t <= Date.parse('9999-12-31T23:59:59.999Z');
};
/** Every `.refine` of the server contract a queued kind's stored act could break, mirrored exactly (never stricter:
 *  an act the server takes is never set aside), each named by the refine's message (#1071 F4, Codex 4341067934). A
 *  stored act that breaks one would be refused for good and dropped by its flush, so it makes its key unreadable, set
 *  aside and never sent, as a missing field does (`isKnownOutboxOp`). */
export const SERVER_REFINES_MIRRORED: Partial<Record<OutboxOp['t'], { refines: readonly string[]; holds: Check }>> = {
  siteVisitStart: {
    refines: ['Invalid datetime'],
    holds: (v) => readableInstant(bodyOf(v).claimedAt) && (!isFields(bodyOf(v).location) || readableInstant((bodyOf(v).location as Fields).at)),
  },
  siteVisitEnd: { refines: ['Invalid datetime'], holds: (v) => isFields(v) && readableInstant(v.claimedAt) },
  siteVisitAddPlace: { refines: ['Invalid datetime'], holds: (v) => readableInstant(bodyOf(v).claimedAt) },
  forwardDecision: {
    refines: ['toDesignationMembershipId is required exactly when toDesignationKind is member'],
    holds: (v) => memberPair(inputOf(v)),
  },
  disagreeDecision: {
    refines: ['toDesignationKind is required exactly when path is forward_on', 'toDesignationMembershipId is required exactly when toDesignationKind is member'],
    holds: (v) => (inputOf(v).path === 'forward_on') === (inputOf(v).toDesignationKind !== undefined) && memberPair(inputOf(v)),
  },
  resolveStrandedCountersign: {
    refines: ['a target is admitted only on a returned resolution', 'toDesignationMembershipId is required exactly when toDesignationKind is member'],
    holds: (v) => (inputOf(v).outcome === 'returned' || inputOf(v).toDesignationKind === undefined) && memberPair(inputOf(v)),
  },
  allocateLabour: {
    refines: ['Provide exactly one of workerId or crewId — a crew EXPANDS into one allocation per active member', 'Not a real calendar date'],
    holds: (v) => (inputOf(v).workerId ? 1 : 0) + (inputOf(v).crewId ? 1 : 0) === 1 && realDay(inputOf(v).civilDate),
  },
  recordAttendance: {
    refines: [
      'Attendance needs trusted evidence: either the worker\'s bound deviceId, or an explicit manualReason recorded as an attributable exception',
      'A muster is either device-evidenced or a manual exception — never both',
      'Not a real calendar date',
    ],
    holds: (v) => {
      const i = inputOf(v);
      const reason = typeof i.manualReason === 'string' ? i.manualReason.trim() : i.manualReason;
      return (Boolean(i.deviceId) || Boolean(reason)) && !(i.deviceId && reason) && realDay(i.civilDate);
    },
  },
  createLabourRequisition: {
    refines: ['Not a real calendar date'],
    holds: (v) => Array.isArray(inputOf(v).lines) && (inputOf(v).lines as Fields[]).every((l) => isFields(l) && realDay(l.civilDate)),
  },
  setCommercialBudget: { refines: ['{label} must not be blank'], holds: (v) => nonBlank(inputOf(v).costHeadCode) && nonBlank(inputOf(v).reason) },
  defineCostHead: { refines: ['{label} must not be blank'], holds: (v) => nonBlank(inputOf(v).code) && nonBlank(inputOf(v).name) },
  reattributeCommitment: {
    refines: ['{label} must not be blank', 'exactly one of poLineId or labourPoLineId must be supplied'],
    holds: (v) => nonBlank(inputOf(v).costHeadCode) && nonBlank(inputOf(v).reason) && (inputOf(v).poLineId === undefined) !== (inputOf(v).labourPoLineId === undefined),
  },
  takeMeasurement: {
    refines: ['a measurement of zero measures nothing', 'Not a real calendar date'],
    holds: (v) => positiveQty(inputOf(v).quantity) && (inputOf(v).measuredOn === undefined || realDay(inputOf(v).measuredOn)),
  },
  correctMeasurement: {
    refines: ['a correction of zero corrects nothing'],
    holds: (v) => typeof inputOf(v).quantity === 'string' && Number((inputOf(v).quantity as string).trim()) !== 0,
  },
  recordVendorBill: {
    refines: ['{label} must not be blank', 'Not a real calendar date', 'a claim line for zero claims nothing', 'a claim line names EXACTLY ONE purchase-order line — with neither, no §G bound can run; with both, the fold owner is ambiguous'],
    holds: (v) => nonBlank(inputOf(v).vendorBillNumber) && realDay(inputOf(v).documentDate) && (inputOf(v).lines as Fields[]).every(billLineHolds),
  },
  amendVendorBill: {
    refines: ['a claim line for zero claims nothing', 'a claim line names EXACTLY ONE purchase-order line — with neither, no §G bound can run; with both, the fold owner is ambiguous'],
    holds: (v) => (inputOf(v).lines as Fields[]).every(billLineHolds),
  },
  uploadMedia: {
    refines: ["a file on a site visit has kind 'visit' and names its visit; no other upload names one"],
    holds: (v) => (inputOf(v).kind === 'visit') === (inputOf(v).siteVisit !== undefined),
  },
};

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
  return isKnownOutboxKind(v) && OUTBOX_OP_KINDS[v.t](v) && (SERVER_REFINES_MIRRORED[v.t]?.holds(v) ?? true);
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
