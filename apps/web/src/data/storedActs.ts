import { SOD_RULES } from '@vitan/shared';
import { z } from 'zod';
import * as contracts from './queueContracts';
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
 * never loaded, sent, or written over, and the strip reports it (Set aside is step A2's).
 */

type Check = (v: unknown) => boolean;
type Fields = Record<string, unknown>;
const isFields = (v: unknown): v is Fields => typeof v === 'object' && v !== null && !Array.isArray(v);
const str: Check = (v) => typeof v === 'string';
const key: Check = (v) => typeof v === 'string' && v.length > 0;
/** An idempotency key, which the replay sends as its `Idempotency-Key` header as it stands. The server trims the header and
 *  takes a blank one as no key (`platform/commands.ts:147`): a command that needs one is refused for good and its act
 *  dropped, and one that does not runs with no receipt, so a lost response can run it twice. A CR, LF, NUL or other
 *  character a header cannot carry makes `fetch` throw before it sends, at every flush. So the key is nonblank once
 *  trimmed and only printable ASCII, spaces and tabs (Codex 4350723956). Every key this app has made is a uuid or
 *  `k-<time>-<random>`, so every stored key it wrote still reads */
const headerKey: Check = (v) => typeof v === 'string' && v.trim().length > 0 && /^[\t\x20-\x7E]+$/.test(v);
const num: Check = (v) => typeof v === 'number' && Number.isFinite(v);
const int: Check = (v) => Number.isInteger(v);
const bool: Check = (v) => typeof v === 'boolean';
/** A route id: a field the replay puts in the request's path as it stands (the gateway does not encode it). Nonempty,
 *  only URL-unreserved characters, and never a dot segment. An empty one replayed `countersignDecision` to
 *  `/decisions//countersign`, was refused 404 for good, and dropped (Codex 4346169580); one holding `/`, `?` or `..`
 *  would reach another route. The server reads every such param as a plain string, and its ids (uuids, seed ids such
 *  as `DL-1`) are all of this form */
const routeId: Check = (v) => typeof v === 'string' && /^[A-Za-z0-9_~-][A-Za-z0-9._~-]*$/.test(v);
/** a photo's visit, sent as its upload's `siteVisit.visitId`, which the server reads as a uuid (`siteVisitIdSchema`).
 *  A visit's path id is a route id: the server reads that param as a plain string */
const uuid: Check = (v) => contracts.siteVisitIdSchema.safeParse(v).success;
/** a photo's client key, sent as its upload's `clientKey` (`createMediaSchema`: trimmed, 1 to 120 characters) and the
 *  key of its row on this phone */
const clientKey: Check = (v) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= 120;
const opt = (c: Check): Check => (v) => v === undefined || c(v);
const orNull = (c: Check): Check => (v) => v === null || c(v);
const oneOf = (...values: readonly string[]): Check => (v) => typeof v === 'string' && values.includes(v);
const list = (c: Check): Check => (v) => Array.isArray(v) && v.every(c);
const shape = (fields: Record<string, Check>): Check => (v) => isFields(v) && Object.entries(fields).every(([k, c]) => c(v[k]));
/** an act: its own fields, under its kind */
const act = (fields: Record<string, Check>): Check => shape(fields);
const keyed = (fields: Record<string, Check>): Check => act({ ...fields, idempotencyKey: headerKey });
/** a kind an earlier release queued with no key: such an act replays unkeyed, as it did there (#1051 r1 re-check G2) */
const keyedLater = (fields: Record<string, Check>): Check => act({ ...fields, idempotencyKey: opt(headerKey) });
/** the two-key split (materials, labour, commercial): a fresh key per act and the coalescing identity. A materials act
 *  from PR #207 has no `coalesceKey`; `normalizeMaterialsOutbox` derives it on load */
const twoKeys = (fields: Record<string, Check>): Check => act({ ...fields, idempotencyKey: headerKey, coalesceKey: key });
const twoKeysMaterials = (fields: Record<string, Check>): Check => act({ ...fields, idempotencyKey: headerKey, coalesceKey: opt(key) });
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
  siteVisitEnd: keyed({ visitId: routeId, claimedAt: str }),
  siteVisitClose: keyed({ visitId: routeId, reason: str }),
  siteVisitAddPlace: keyed({ visitId: routeId, body: shape({ id: str, nodeId: str, claimedAt: str }), name: str }),
  siteVisitRetirePlace: keyed({ visitId: routeId, placeId: routeId }),
  siteVisitAddAttendee: keyed({ visitId: routeId, body: (v) => shape({ id: str, userId: str, role: str })(v) || shape({ id: str, guestName: str })(v), name: str }),
  siteVisitRetireAttendee: keyed({ visitId: routeId, attendeeId: routeId }),
  siteVisitAddFile: keyed({
    visitId: uuid, scope: str, by: shape({ name: str, role: str }), placeName: orNull(str), queuedAt: opt(str),
    file: shape({ id: clientKey, mime: str, takenAt: opt(str), geoLat: opt(num), geoLng: opt(num), nodeId: opt(str), note: opt(str), rating: opt(oneOf('fine', 'concern', 'action_needed')), sourceMediaId: opt(str) }),
  }),
  // keyless before 466814c0 (approve, change, changeWithdraw), c0940a02 (flagMismatch, submitDailyLog) and f59dc583
  // (ackDrawing): an act an earlier release queued replays unkeyed
  approve: keyedLater({ decisionId: routeId, optionIndex: int }),
  forwardDecision: keyed({ decisionId: routeId, input: shape({ toDesignationKind: designation, toDesignationMembershipId: opt(str), reason: str }) }),
  countersignDecision: keyed({ decisionId: routeId }),
  disagreeDecision: keyed({
    decisionId: routeId,
    input: shape({ path: oneOf('reject_back', 'forward_on'), reason: str, costImpact: opt(num), timeImpactDays: opt(num), toDesignationKind: opt(designation), toDesignationMembershipId: opt(str) }),
  }),
  resolveStrandedCountersign: keyed({
    decisionId: routeId,
    input: shape({ outcome: oneOf('completed', 'returned'), reason: str, costImpact: opt(num), timeImpactDays: opt(num), toDesignationKind: opt(designation), toDesignationMembershipId: opt(str) }),
  }),
  change: keyedLater({ decisionId: routeId, reason: str, costImpact: num, timeImpactDays: num }),
  changeWithdraw: keyedLater({ decisionId: routeId }),
  withdraw: keyed({ decisionId: routeId, reason: str }),
  consultationRequest: keyed({ decisionId: routeId, consulteeMembershipId: str, question: str }),
  consultationRespond: keyed({ decisionId: routeId, consultationId: str, response: str, recommendedOptionIndex: opt(int) }),
  ackDrawing: keyedLater({ revisionId: routeId }),
  publishDrawing: keyed({ drawingId: routeId }),
  setDrawingNode: keyed({ drawingId: routeId, nodeId: orNull(str) }),
  submitInspection: act({ inspectionId: routeId, items: list(shape({ id: opt(str), name: str, state: orNull(oneOf('pass', 'fail', 'na')), photos: num, note: str, evidence: opt(list(str)) })) }),
  // keyless before Task 10: an act queued by an earlier release replays unkeyed
  // and a review queued before ce360ae5 names no item ids (`rejectedItemNames`): it is sent as that release's would be
  // now, with none, and the server takes none as none: an approval approves; a rejection sends back the rows the
  // inspection holds as failed, or is refused 400 when there are none (inspections.service.ts, "No items rejected")
  decideReview: (v) => act({ inspectionId: routeId, approve: bool, idempotencyKey: opt(headerKey) })(v) && isFields(v)
    && (list(str)(v.rejectedItemIds) || (v.rejectedItemIds === undefined && list(str)(v.rejectedItemNames))),
  startActivity: act({ activityId: routeId, idempotencyKey: opt(headerKey) }),
  completeActivity: act({ activityId: routeId, idempotencyKey: opt(headerKey) }),
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
  // `lifecycleVersion` came in fbc95108 (#312); a certification #310 queued names none (`RELEASED_CONTRACTS_OF`)
  certifyBill: twoKeys({ input: shape({ billId: str, versionId: str, lifecycleVersion: opt(num) }) }),
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
  releaseLabourAllocation: twoKeys({ allocationId: routeId, reason: str }),
  uploadMedia: act({
    input: shape({
      kind: oneOf('progress', 'inspection', 'decision', 'attendance', 'material', 'visit'), mime: str, data: str,
      decisionId: opt(str), nodeId: opt(str), inspectionId: opt(str), inspectionItemId: opt(str), clientKey: opt(str), dailyLogId: opt(str),
      siteVisit: opt(shape({ visitId: str, note: opt(str), rating: opt(oneOf('fine', 'concern', 'action_needed')) })),
      geoLat: opt(num), geoLng: opt(num), takenAt: opt(str), sourceMediaId: opt(str),
    }),
  }),
  uploadEvidence: act({ scope: str, clientKey }),
  // #917: never stored (its row in IndexedDB is its record, and the op is rebuilt from it), so no key holds one; read
  // as its type is, should one ever be met
  uploadSitePhoto: act({ scope: str, clientKey }),
};

type ServerSchema = { safeParse: (v: unknown) => { success: boolean } };
type SchemaName = { [N in keyof typeof contracts]: (typeof contracts)[N] extends ServerSchema ? N : never }[keyof typeof contracts];
const field = (v: Fields, f: string): unknown => v[f];
const inputBody = (v: Fields): unknown => v.input;
const bodyBody = (v: Fields): unknown => v.body;

/** The request body each queued kind's replay sends (`replayOutboxOp` through its gateway method), and the server's own
 *  contract that parses it, or `null` with why the stored act holds no body the server parses (Codex 4345664659). The
 *  contract is the server's zod schema, as `queueContracts.ts` copies it byte for byte from `apps/api/src/contracts.ts`
 *  (`queue-contracts-drift.test.ts` holds the two the same), so every `min`, `max`, `regex`, `.strict()` and `.refine`
 *  the server applies is applied here, no stricter and no looser. Typed against
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
  // its upload comes from the site photo row in IndexedDB (#917), and the act is never stored
  uploadSitePhoto: null,
};

/** Bodies a released build queued whose shape today's contract refuses, each read by the contract of the release that
 *  queued it, copied from that release's `apps/api/src/contracts.ts`. Such an act is a released shape, never damaged, so
 *  its key stays readable and the acts behind it are sent (Codex 4351952407). Today's server refuses the act itself (400:
 *  the row id, the `lifecycleVersion` pin and the raster list are required now), so its flush drops it, counted as
 *  discarded, as any refused act. No phone holds one: none of those releases was deployed with users. Every kind was walked against each body its
 *  queue ever stored, release by release (`apps/web/src/data/apiGateway.ts`, the contracts and the shared types in
 *  git history); these three are the bodies today's contract refuses for their shape:
 *  - a checklist submitted before #114 (ce360ae5) names its rows by label only, no `id`: its release's contract
 *  - a certification queued by #310 (6861a850) names no `lifecycleVersion`, which #312 (fbc95108) made required
 *  - a photo queued before #54 (6f8f22ba) took any `image/` type and any size, before the raster list and the cap */
const RELEASED_CONTRACTS_OF: Partial<Record<OutboxOp['t'], ServerSchema>> = {
  submitInspection: z.object({
    items: z.array(
      z.object({
        name: z.string(),
        state: z.enum(['pass', 'fail', 'na']).nullable(),
        photos: z.number().int().min(0),
        note: z.string(),
      }),
    ),
  }),
  certifyBill: z
    .object({ billId: z.string().min(1), versionId: z.string().min(1) })
    .strict(),
  uploadMedia: z.object({
    kind: z.enum(['progress', 'inspection', 'decision', 'attendance', 'material']),
    mime: z.string().regex(/^image\//, 'images only'),
    data: z.string().min(1),
    decisionId: z.string().optional(),
    dailyLogId: z.string().optional(),
    geoLat: z.number().optional(),
    geoLng: z.number().optional(),
    takenAt: z.string().optional(),
  }),
};
/** the fields each such release stored, so a body today's contract refuses for another reason is not read as released:
 *  a checklist's rows before #114 hold only the four fields that release's rows had, so a row naming an `id`, or a field
 *  that came after it such as `evidence`, is no release's (Codex 4356145032: the legacy contract strips such a field),
 *  and a photo before #54 holds only the fields its release sent, and the `clientKey` a load since #482 gives it
 *  (`keyQueuedPhotoUploads`) */
const ROW_BEFORE_114 = new Set(['name', 'state', 'photos', 'note']);
const PHOTO_BEFORE_54 = new Set(['kind', 'mime', 'data', 'decisionId', 'geoLat', 'geoLng', 'takenAt', 'clientKey']);
const RELEASED_SHAPE_OF: Partial<Record<OutboxOp['t'], (v: Fields) => boolean>> = {
  submitInspection: (v) => Array.isArray(v.items) && v.items.every((i) => isFields(i) && Object.keys(i).every((f) => ROW_BEFORE_114.has(f))),
  uploadMedia: (v) => isFields(v.input) && Object.keys(v.input).every((f) => PHOTO_BEFORE_54.has(f)) && opt(clientKey)(v.input.clientKey),
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
  if (contract === null || (contracts[contract.schema] as ServerSchema).safeParse(serverBodyOf(v)).success) return true;
  const released = RELEASED_CONTRACTS_OF[v.t];
  return released !== undefined && (RELEASED_SHAPE_OF[v.t]?.(v) ?? true) && released.safeParse(serverBodyOf(v)).success;
}

/** The user scopes a queue key's acts may name, as the store derives them for that key: the evidence rows' (the token's
 *  `sub`, else 'anon') and the visit photos' (the key's own sub, `visitPhotoScope`) */
export type QueueScopes = { evidence: string; visitPhoto: string };
/** The kinds whose replay reads a row on this phone by a scope the act itself names, and which of the key's scopes it
 *  must be. An act naming another scope would read that user's row, send its bytes as this user, and delete it
 *  (Codex 4346169609), so it makes its key unreadable. Read with no scopes, such an act is unreadable too: never
 *  taken on trust */
const SCOPE_OF: Partial<Record<OutboxOp['t'], keyof QueueScopes>> = { uploadEvidence: 'evidence', siteVisitAddFile: 'visitPhoto' };
function boundToKey(v: Fields & { t: OutboxOp['t'] }, scopes: QueueScopes | undefined): boolean {
  const which = SCOPE_OF[v.t];
  return which === undefined || (scopes !== undefined && v.scope === scopes[which]);
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
export function isKnownOutboxOp(v: unknown, scopes?: QueueScopes): v is OutboxOp {
  return isKnownOutboxKind(v) && OUTBOX_OP_KINDS[v.t](v) && serverTakes(v as { t: OutboxOp['t'] } & Fields) && boundToKey(v as { t: OutboxOp['t'] } & Fields, scopes);
}

/** A stored queue key's bytes, as this release reads them */
export type StoredQueue = { acts: OutboxOp[] } | { unreadable: 'newer' | 'damaged' };

/** An absent key is an empty list. Bytes that are not a list, or a list holding any entry this release cannot load, are
 *  unreadable as a whole: 'newer' when every such entry is an act of a kind this release does not know (a newer
 *  release's, which that release can read and send), else 'damaged'. */
export function readStoredQueue(raw: string | null, scopes?: QueueScopes): StoredQueue {
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
    if (isKnownOutboxOp(entry, scopes)) continue;
    if (isFields(entry) && typeof entry.t === 'string' && !isKnownOutboxKind(entry)) { newer = true; continue; }
    return { unreadable: 'damaged' };
  }
  return newer ? { unreadable: 'newer' } : { acts: parsed as OutboxOp[] };
}

/** WEB-02 L2a (plan r3 v4): the write token a ledger write puts first in a queue key, in the same write as its acts,
 *  `{ "t": "vitan.writeToken", "n": "<nonce>" }`. It is no act: it is never loaded, sent or counted. The same kind as
 *  the ledger's `TOKEN_KIND` (pinned by a test) */
export const WRITE_TOKEN_KIND = 'vitan.writeToken';
const isWriteToken = (v: Fields): boolean =>
  Object.keys(v).length === 2 && v.t === WRITE_TOKEN_KIND && typeof v.n === 'string' && v.n.length > 0;

/** A queue key's bytes as the ledger reads them (L2b): its acts, and the write token they carry (null for none)
 *  (#1117 r1, Codex 4368845658) */
export type LedgerQueue = { acts: OutboxOp[]; token: string | null } | { unreadable: 'newer' | 'damaged' };

/** The ledger's reader, and only the ledger's. A first entry that is a write token is the key's token, never an act; a
 *  token anywhere else, or one malformed, makes the bytes damaged; the rest reads as `readStoredQueue` reads it.
 *  `readStoredQueue` itself, which main's guard and its made records read through, still takes a token as a newer
 *  release's entry: that guard matches acts by identity, and a key, record or settled mark the ledger wrote holds
 *  occurrences it cannot tell apart (#1117 gap-check G1, Codex 4368845658), so it never loads, removes or writes them */
export function readLedgerQueue(raw: string | null, scopes?: QueueScopes): LedgerQueue {
  if (raw === null) return { acts: [], token: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { unreadable: 'damaged' };
  }
  if (!Array.isArray(parsed)) return { unreadable: 'damaged' };
  const first: unknown = parsed[0];
  const tokened = isFields(first) && first.t === WRITE_TOKEN_KIND;
  if (tokened && !isWriteToken(first)) return { unreadable: 'damaged' };
  const rest = tokened ? parsed.slice(1) : parsed;
  // a token after the first entry: the bytes were not written by one ledger write
  if (rest.some((e) => isFields(e) && e.t === WRITE_TOKEN_KIND)) return { unreadable: 'damaged' };
  const read = readStoredQueue(JSON.stringify(rest), scopes);
  return 'acts' in read ? { acts: read.acts, token: tokened ? (first as { n: string }).n : null } : read;
}
