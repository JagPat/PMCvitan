/**
 * #1088 r1 (Codex 4349463894): the web's own copy of the server's request contracts its stored queue check reads
 * (`storedActs.ts`), so the web no longer imports API source or resolves `zod` through the API. Each statement below is
 * a byte-for-byte copy of the same-named one in `apps/api/src/contracts.ts`, with every statement it uses, in that
 * file's order. `queue-contracts-drift.test.ts` reads that file as text and fails when any copy differs, so a server
 * change to one of these contracts cannot land without this copy changing with it. `parseCivilDate` is the shared one,
 * which `apps/api/src/common/civil-date.ts` re-exports.
 */
import { z } from 'zod';
import { DEDUCTION_TYPES, MONEY_STRING, QUANTITY_STRING, SOD_RULES, parseCivilDate } from '@vitan/shared';

export const approveSchema = z.object({ optionIndex: z.number().int().min(0) });

/** Phase 6 task 4a — the withdrawal reason is REQUIRED and non-blank at the contract:
 *  a withdrawal without one is the silent delete this design refuses (zod's .trim() strips
 *  the full whitespace class, so a tabs-and-newlines-only reason is a 400 here). */
export const withdrawDecisionSchema = z.object({ reason: z.string().trim().min(1, 'A withdrawal needs a reason') });

/** Phase 6 task 4d (4d-ii-a / A8a, §A.2) — FORWARD a published, open decision to another designation.
 *  The target mirrors the decider designation at issue (a role, or a NAMED active member); `none` is
 *  not a holder. The reason is REQUIRED and non-blank at the contract, as the withdrawal's is, beside
 *  the `DecisionForward.reason` CHECK. */
export const forwardDecisionSchema = z
  .object({
    toDesignationKind: z.enum(['client', 'pmc', 'member', 'architect']),
    toDesignationMembershipId: z.string().trim().min(1).optional(),
    reason: z.string().trim().min(1, 'A forward needs a reason'),
  })
  .refine((v) => (v.toDesignationKind === 'member') === (v.toDesignationMembershipId !== undefined), {
    message: 'toDesignationMembershipId is required exactly when toDesignationKind is member',
  });

// Phase 6 task 4d (4d-ii-a / A8b, §A.2) — the architect's disagreement: reject back, or forward on to a
// named designation (the target exactly as the forward takes it). The reason is non-blank at both layers;
// the impacts default to 0 (the plan: "the command accepts the impacts as OPTIONAL inputs defaulting to 0").
export const disagreeDecisionSchema = z
  .object({
    path: z.enum(['reject_back', 'forward_on']),
    reason: z.string().trim().min(1, 'A disagreement needs a reason'),
    costImpact: z.number().int().optional(),
    timeImpactDays: z.number().int().optional(),
    toDesignationKind: z.enum(['client', 'pmc', 'member', 'architect']).optional(),
    toDesignationMembershipId: z.string().trim().min(1).optional(),
  })
  .refine((v) => (v.path === 'forward_on') === (v.toDesignationKind !== undefined), {
    message: 'toDesignationKind is required exactly when path is forward_on',
  })
  .refine((v) => (v.toDesignationKind === 'member') === (v.toDesignationMembershipId !== undefined), {
    message: 'toDesignationMembershipId is required exactly when toDesignationKind is member',
  });

// Phase 6 task 4d (4d-ii-a / A8b, §A.2 "the stranded decision") — the PMC's named resolution. The reason is
// non-blank at zod and at the fact (the seal); a target is admitted on `returned` only (an ordinary same-
// bundle forward, or the REQUIRED re-homing of a designation with no active holder — judged in the service).
export const resolveStrandedCountersignSchema = z
  .object({
    outcome: z.enum(['completed', 'returned']),
    reason: z.string().trim().min(1, 'A stranded resolution needs a reason'),
    costImpact: z.number().int().optional(),
    timeImpactDays: z.number().int().optional(),
    toDesignationKind: z.enum(['client', 'pmc', 'member', 'architect']).optional(),
    toDesignationMembershipId: z.string().trim().min(1).optional(),
  })
  .refine((v) => v.outcome === 'returned' || v.toDesignationKind === undefined, {
    message: 'a target is admitted only on a returned resolution',
  })
  .refine((v) => (v.toDesignationKind === 'member') === (v.toDesignationMembershipId !== undefined), {
    message: 'toDesignationMembershipId is required exactly when toDesignationKind is member',
  });

export const changeSchema = z.object({
  reason: z.string().min(1),
  costImpact: z.number().int(),
  timeImpactDays: z.number().int(),
});

export const submitInspectionSchema = z.object({
  items: z.array(
    z.object({
      // gate finding 3: items are ROWS — the id addresses the exact row, because
      // labels are not unique (two "Slope" items are two independent facts)
      id: z.string().min(1),
      name: z.string(),
      state: z.enum(['pass', 'fail', 'na']).nullable(),
      photos: z.number().int().min(0),
      note: z.string(),
    }),
  ),
});

export const decideReviewSchema = z.object({
  approve: z.boolean(),
  // gate finding 3: rejection names exact rows by id, never by non-unique label
  rejectedItemIds: z.array(z.string()).default([]),
  // Phase 1 Tasks 4/5 (reject only): who corrects the work — defaults to the recorded
  // submitter (ordinary) / the recorded COMPLETER (closing sign-off); must resolve to
  // an ACTIVE engineer/contractor member — and when it's due.
  assigneeId: z.string().trim().min(1).optional(),
  dueInDays: z.number().int().min(1).max(60).optional(),
});

export const submitDailyLogSchema = z.object({
  checkedIn: z.boolean(),
  checkinTime: z.string().nullable(),
  progress: z.number().int().min(0),
  crew: z.array(z.object({ trade: z.string(), count: z.number().int().min(0) })),
});

export const flagMismatchSchema = z.object({ decisionId: z.string().min(1) });

// ── Phase 7c-media ─────────────────────────────────────────────────────────
// A site photo upload. `data` is base64 (no data: URL prefix).
// P2-5: a raster-image allowlist — NOT `image/*`, which admits `image/svg+xml`
// (active content → stored XSS when the file is served inline). Base64 is capped so
// a single request can't push an unbounded blob through the API body.
export const RASTER_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif', 'image/heic', 'image/heif'] as const;

export const MAX_MEDIA_BASE64 = 14_000_000;

 // ~10.5 MB decoded
// Stage 1 voice notes (Jagrut, 19 Oct 2026, "yes to all" on the media plan): a spoken note on a site visit, up to two
// minutes. Android browsers record WebM (Opus), iPhones MP4 (AAC), Firefox Ogg; only base types are named, so a
// recorder's `;codecs=` parameter is the client's to strip. Two minutes is about 1 to 2 MB, well inside the cap above.
export const VOICE_NOTE_MIMES = ['audio/webm', 'audio/mp4', 'audio/ogg'] as const;

export const VOICE_NOTE_MAX_SEC = 120;

// the length a voice note is stored with is read from the file; a length the client also sends must agree with it to
// within this many seconds (a recorder's timer and its container can differ by a frame or a rounding)
export const VOICE_NOTE_SEC_TOLERANCE = 2;

// Site Visits #792 SV2 — a file added on a site visit: the visit, and what the adder saw (a note, a rating), both
// optional. Such a file is its own kind, 'visit', so it stays inside its visit: every photo list (the Site Map, the
// Dashboard, the daily log) reads the kinds it shows, and none of them reads 'visit'.
export const SITE_VISIT_RATINGS = ['fine', 'concern', 'action_needed'] as const;

const mediaSiteVisitSchema = z.object({
  visitId: z.string().uuid().transform((value) => value.toLowerCase()),
  note: z.string().trim().min(1).max(500).optional(),
  rating: z.enum(SITE_VISIT_RATINGS).optional(),
}).strict();

export const createMediaSchema = z.object({
  kind: z.enum(['progress', 'inspection', 'decision', 'attendance', 'material', 'visit']),
  mime: z.enum([...RASTER_IMAGE_MIMES, ...VOICE_NOTE_MIMES]),
  data: z.string().min(1).max(MAX_MEDIA_BASE64, 'file too large'),
  // a voice note's length in whole seconds as the recorder counted it, optional: the length stored is read from the
  // file, and this, when sent, must agree with it; a photo has none (the database holds the same rule)
  durationSec: z.number().int().min(1).max(VOICE_NOTE_MAX_SEC).optional(),
  decisionId: z.string().optional(),
  dailyLogId: z.string().optional(),
  // Evidence linkage (Phase 1 Task 4): the inspection item this photo proves.
  // An item requires its inspection (service + DB CHECK enforce it).
  inspectionId: z.string().trim().min(1).optional(),
  inspectionItemId: z.string().trim().min(1).optional(),
  // PROJECT-scoped idempotency key for offline replays — same key, same photo, one row.
  clientKey: z.string().trim().min(1).max(120).optional(),
  // Location spine: the place this photo shows (a location-tree node). Optional — an
  // unplaced photo still uploads; a placed one appears in that location's Place view.
  nodeId: z.string().trim().min(1).optional(),
  geoLat: z.number().optional(),
  geoLng: z.number().optional(),
  takenAt: z.string().optional(),
  siteVisit: mediaSiteVisitSchema.optional(),
  // Stage 1 markup: a marked-up copy names the photo it was drawn on, which is kept as it was (a copy is a NEW file)
  sourceMediaId: z.string().trim().min(1).optional(),
}).refine((m) => (m.kind === 'visit') === (m.siteVisit !== undefined), {
  message: "a file on a site visit has kind 'visit' and names its visit; no other upload names one",
  path: ['siteVisit'],
}).refine((m) => m.mime.startsWith('audio/') || m.durationSec === undefined, {
  message: 'a photo has no length',
  path: ['durationSec'],
});

// Re-file an existing photo or drawing onto a location-tree node (or null to unfile).
// Shared by PATCH /media/:id/node and /drawings/:id/node — "manage & modify" from the tree.
export const setNodeSchema = z.object({ nodeId: z.string().trim().min(1).nullable() });

/** An ISO civil date — YYYY-MM-DD AND a real calendar day (Task 6 / Codex gate
 *  finding 5): '2026-02-31' matches the shape but must be a 400 at the boundary,
 *  never a 500 (or a silently rolled-over date) deeper in. */
export const isoCivilDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected an ISO civil date (YYYY-MM-DD)')
  .refine((v) => {
    try {
      parseCivilDate(v);
      return true;
    } catch {
      return false;
    }
  }, 'Not a real calendar date');

/** A civil date in a body: trimmed and required as before, then `isoCivilDateSchema`. The trim and the required
 *  check run first, so a padded day still lands and an empty one keeps its own 400; a value that is no real day was
 *  handed to `parseCivilDate`, which throws a plain Error (500), and is now the 400 above at the boundary. */
export const civilDateField = z.string().trim().min(1).pipe(isoCivilDateSchema);

/**
 * Phase 6 unit 4c-ii (§A) — the consultation contracts.
 *
 * `question` and `response` are user-supplied EVIDENCE: `trim().min(1)` here, and the exact
 * `btrim(x, E' \t\n\x0B\f\r') <> ''` CHECK at the database, so a whitespace-only body is
 * refused at both layers and an append-only fact can never carry no evidence at all.
 */
export const requestConsultationSchema = z.object({
  consulteeMembershipId: z.string().trim().min(1),
  question: z.string().trim().min(1).max(2000),
});

export const respondToConsultationSchema = z.object({
  consultationId: z.string().trim().min(1),
  response: z.string().trim().min(1).max(2000),
  // an INDEX at the contract, resolved server-side to the option's id: the caller names a
  // position in the options they were shown, and the server binds it to the row that position
  // actually is, in this decision.
  recommendedOptionIndex: z.number().int().min(0).max(3).optional(),
});

// An instant with an offset that Date can read and Prisma can send, as #1045 checks the ops read's `since`: Zod's offset
// check admits hours and minutes Date cannot read (`+24:00`, `+02:60`, `+2400`), and an offset can carry year 0000 or
// 9999 past the 4-digit years ISO text has, so either reached Prisma and answered 500. Both are refused with Zod's own
// message, and only after the shape check, so a bad value gets one issue.
const ISO_MIN = Date.parse('0000-01-01T00:00:00.000Z');

const ISO_MAX = Date.parse('9999-12-31T23:59:59.999Z');

export const offsetInstant = z.string().datetime({ offset: true }).pipe(z.string().refine((v) => {
  const t = Date.parse(v);
  return Number.isFinite(t) && t >= ISO_MIN && t <= ISO_MAX;
}, { message: 'Invalid datetime' }));

// Daily-log authoring (engineer/PMC): add a material delivery to today's log.
export const addMaterialSchema = z.object({
  name: z.string().trim().min(1),
  qty: z.string().trim().min(1),
  zone: z.string().trim().default(''),
  decisionId: z.string().optional(),
  swatch: z.string().trim().default('tile'),
  // Location spine: where this material was delivered / is staged (a location-tree node).
  nodeId: z.string().trim().min(1).optional(),
});

export const createRequisitionSchema = z.object({
  title: z.string().trim().min(1).max(300),
  notes: z.string().trim().max(2000).optional(),
  lines: z.array(z.object({
    requirementId: z.string().min(1),
    revision: z.number().int().min(1),
    qty: z.string().trim().min(1),
  }).strict()).min(1).max(50),
}).strict();

// ── Phase 3 Task 4 — the inventory store (plan §C). Quantities are decimal strings
// (parseQuantity-canonicalized by the service). A receipt is entered in the PO line's
// PURCHASE units — the service derives the base quantity via the frozen conversion; every
// other movement is entered in base units against a lot + store location. The service (and
// the database CHECKs behind it) require quality evidence on accept/reject and a reason on
// adjust/reverse.
const qtyString = z.string().trim().min(1);

// ── Phase 3 Task 5 — store-to-site flows (plan §§C/E). Reservation/issue name an ACTIVITY;
// consumption/site-return/wastage name the ISSUE they are recorded against (§E — lot,
// location and activity derive from it); a transfer names the destination store location.
export const reserveStockSchema = z.object({
  lotId: z.string().min(1),
  storeLocation: z.string().trim().min(1).max(120).optional(), // default 'main'
  activityId: z.string().min(1),
  qty: qtyString, // base UOM
}).strict();

export const issueStockSchema = z.object({
  lotId: z.string().min(1),
  storeLocation: z.string().trim().min(1).max(120).optional(),
  activityId: z.string().min(1), // §C — an issue must reference activity + location
  qty: qtyString,
  note: z.string().trim().min(1).max(1000).optional(),
}).strict();

export const consumeStockSchema = z.object({
  issueId: z.string().min(1), // §E — recorded AGAINST the referenced issue
  qty: qtyString,
  note: z.string().trim().min(1).max(1000).optional(),
}).strict();

// ── Phase 4 Task 2 — the LABOUR COMMERCIAL chain (plan §F). Mirrors the material procurement
// schemas but per person-shift, never a bare headcount: every requisition/PO line names one
// explicit `(requirementId, revision, civilDate)` demand slice with a positive integer
// `personShiftQty`; the slice's shift + fingerprint are DERIVED by the service from the
// Labour-owned `LabourRequirementSpec` (never caller-authored). Rates are per person-shift, INR
// paise-safe decimals. `VendorLabourProfile` is an ORG-ADMIN surface (org membership, like vendor
// CRUD); every other command is project-scoped, capability-gated (`labour`), pmc/engineer authority.
const personShiftQty = z.number().int().min(1).max(100000);

export const createLabourRequisitionSchema = z.object({
  title: z.string().trim().min(1).max(300),
  notes: z.string().trim().max(2000).optional(),
  lines: z.array(z.object({
    requirementId: z.string().min(1),
    revision: z.number().int().min(1),
    civilDate: civilDateField, // must name a demand slice of the revision
    personShiftQty, // integer person-shifts, > 0
  }).strict()).min(1).max(100),
}).strict();

// ── Phase 4 Task 3 — the §C TIME-CAPACITY fact commands (plan §C/§H) ─────────────────────────
// Labour is EXPIRING capacity, so these are observations + one frozen-identity assignment, never
// bucket transfers. Server-derived everywhere it matters: the allocation's shift and
// `labourSpecFingerprint` come from the requirement's CURRENT head spec (never caller-authored),
// the work fact's worker/activity/slice come from its allocation, and a substitution's
// `fromFingerprint` is the requirement's current head (the Phase-3 T6-F2 rule verbatim).

/** Allocate exactly ONE `Worker`, or expand a `Crew` into one allocation per ACTIVE member, onto
 *  one `(civilDate, shift)` slice of one requirement. Exactly one of workerId/crewId. */
export const allocateLabourSchema = z
  .object({
    activityId: z.string().min(1),
    requirementId: z.string().min(1),
    civilDate: isoCivilDateSchema,
    workerId: z.string().min(1).nullish(),
    crewId: z.string().min(1).nullish(),
    // §F bound 3 — draw this person-shift from committed supplier capacity (omit for own workforce)
    capacityCommitmentId: z.string().min(1).nullish(),
    // Task 6 review round 3 (P1) — the head revision the CALLER selected against. The allocation's
    // shift/fingerprint stay SERVER-derived from the live head; this pin only lets the server
    // REFUSE head drift: an offline-queued command replaying after a revision is a 409, never a
    // silent coercion of a worker chosen for the old trade/skill/shift onto the new head.
    originRevision: z.number().int().min(1).nullish(),
    // Task 6 review round 8 — the SATISFYING identity the worker was offered under. A worker
    // eligible only through an ACTIVE §B skill substitution freezes the SUBSTITUTE fingerprint
    // (so revoking the substitution disqualifies the row from coverage, like every other
    // substitution-backed qualification); the server VERIFIES the value is the live head
    // identity or an active substitution target and refuses anything else. Absent = the head
    // identity (pre-round-8 clients unchanged).
    labourSpecFingerprint: z.string().regex(/^[0-9a-f]{64}$/).nullish(),
  })
  .strict()
  .refine((v) => (v.workerId ? 1 : 0) + (v.crewId ? 1 : 0) === 1, {
    message: 'Provide exactly one of workerId or crewId — a crew EXPANDS into one allocation per active member',
  });

export const releaseLabourAllocationSchema = z.object({ reason: z.string().trim().min(1).max(1000) }).strict();

/**
 * Record one worker PRESENT on one slice. Unit: headcount.
 *
 * Task-3 correction F2 — canonical presence must carry TRUSTED evidence, because the Team gate
 * reads it as execution truth. Exactly one of two paths:
 *   • `deviceId` — the worker's OWN bound device (§H; free-text device name/trade is never
 *     evidence, and a device bound to a different worker is rejected by the DB seal), or
 *   • `manualReason` — an EXPLICIT, attributable exception recorded by the pmc, so an unsupported
 *     presence claim is visible as such instead of silently counting as readiness.
 * `evidenceMediaId` (a selfie/QR capture) is optional on either path but, when given, must name a
 * same-project `Media` row, which then cannot be deleted while the muster cites it.
 */
export const recordAttendanceSchema = z
  .object({
    workerId: z.string().min(1),
    civilDate: isoCivilDateSchema,
    shift: z.enum(['day', 'night']),
    deviceId: z.string().min(1).nullish(),
    manualReason: z.string().trim().min(1).max(1000).nullish(),
    evidenceMediaId: z.string().min(1).nullish(),
  })
  .strict()
  .refine((v) => Boolean(v.deviceId) || Boolean(v.manualReason), {
    message: 'Attendance needs trusted evidence: either the worker\'s bound deviceId, or an explicit manualReason recorded as an attributable exception',
  })
  .refine((v) => !(v.deviceId && v.manualReason), {
    message: 'A muster is either device-evidenced or a manual exception — never both',
  });

/** Record effort performed UNDER an allocation. Unit: worked-minutes — never a transfer of the
 *  presence headcount. Worker/activity/slice are copied from the allocation (a DB trigger proves
 *  the copy); the cumulative `Σ workedMinutes ≤ shiftMinutes` bound is re-derived under the
 *  worker `FOR UPDATE` (a per-row CHECK cannot stop rows summing past the shift). */
export const recordLabourWorkSchema = z
  .object({
    allocationId: z.string().min(1),
    workedMinutes: z.number().int().positive().max(720),
    note: z.string().trim().min(1).max(1000).nullish(),
  })
  .strict();

// ── Phase 5 Task 1 — the COMMERCIAL module (plan §C/§L) ─────────────────────────────────────
// §0b non-blank discipline, mirroring the PostgreSQL CHECKs so a blank value is refused before
// it reaches the database rather than surfacing as a 500.
const commercialNonBlank = (label: string, max: number) =>
  z.string().max(max).refine((s) => s.replace(/[ \t\n\v\f\r]+/gu, '') !== '', `${label} must not be blank`);

export const defineCostHeadSchema = z
  .object({
    code: commercialNonBlank('code', 64),
    name: commercialNonBlank('name', 200),
  })
  .strict();

// §C: re-attribution is an ATOMIC REPLACEMENT, never a bare revocation — revoking Head A as
// miscoded would drop a live vendor obligation out of every budget and forecast while no other
// head picked the payable up. So the input names the target line and the NEW cost head; the
// service supersedes the active row and inserts its replacement in one transaction.
//
// The target is EXACTLY ONE line, mirroring the PG XOR CHECK: a request naming both or neither is
// refused by the contract before it reaches the database.
export const reattributeSchema = z
  .object({
    poLineId: z.string().min(1).optional(),
    labourPoLineId: z.string().min(1).optional(),
    costHeadCode: commercialNonBlank('costHeadCode', 64),
    reason: commercialNonBlank('reason', 500),
  })
  .strict()
  .refine(
    (v) => (v.poLineId === undefined) !== (v.labourPoLineId === undefined),
    'exactly one of poLineId or labourPoLineId must be supplied',
  );

// Phase 5 Task 2 (§B) — set or REVISE the live budget for one cost head. ONE command for both:
// v1 and a revision are the same act on a versioned immutable chain, and splitting them would let
// a caller "create" a second live version for a head that already has one. The service supersedes
// the live row and inserts the next version atomically.
export const setBudgetSchema = z
  .object({
    costHeadCode: commercialNonBlank('costHeadCode', 64),
    // a money STRING, parsed to Decimal server-side — never a float (§A)
    // §A — the shared money-string rule, so the browser form and this contract cannot drift
    amount: z.string().trim().regex(MONEY_STRING, 'amount must be a non-negative money value with at most 2 decimals'),
    reason: commercialNonBlank('reason', 500),
  })
  .strict();

/**
 * Phase 5 Task 3 (§D) — take a measurement. Person-shifts are DIVISIBLE (a half shift is real),
 * so the quantity is a positive decimal string; §A forbids a float64 round trip.
 *
 * `citedOutputId` is REQUIRED, not optional: §D bounds a measurement by operational evidence, and
 * an optional citation is one a caller can simply omit — which is precisely the "commercial actor
 * authors the only quantity evidence" failure the requirement exists to close.
 */
export const takeMeasurementSchema = z
  .object({
    labourPoLineId: z.string().min(1),
    activityId: z.string().min(1),
    quantity: z
      .string()
      .trim()
      .regex(QUANTITY_STRING, 'quantity must be a positive decimal with at most 6 places')
      .refine((v) => Number(v) > 0, 'a measurement of zero measures nothing'),
    citedOutputId: z.string().min(1),
    // the SHARED civil-date schema, not a shape regex: `2026-02-31` is well-shaped and impossible,
    // and letting it through means the service's `fromIsoCivilDate` throws a plain Error — a 500
    // for what is plainly a bad request. Boundary validation belongs at the boundary.
    measuredOn: isoCivilDateSchema.optional(),
    evidenceMediaId: z.string().min(1).optional(),
    reason: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();

/**
 * §D — a correction is a SIGNED delta against an existing measurement, never an edit. The sign is
 * part of the value (a leading `-` is permitted and meaningful), zero is refused because it
 * corrects nothing, and the reason is MANDATORY here while optional on an original: a restatement
 * of agreed work that nobody has to justify is how a record quietly loses its meaning.
 */
export const correctMeasurementSchema = z
  .object({
    measurementId: z.string().min(1),
    quantity: z
      .string()
      .trim()
      .regex(/^-?\d+(\.\d{1,6})?$/u, 'quantity must be a signed decimal with at most 6 places')
      .refine((v) => Number(v) !== 0, 'a correction of zero corrects nothing'),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();

// ── Phase 5 Task 4 — the VENDOR BILL (plan §F/§G) ────────────────────────────────────────────

/**
 * ONE claim line. The target is EXACTLY ONE PO line, mirroring the PG XOR CHECK plus the `type`
 * discriminator that must agree with it — a request naming both or neither is refused at the
 * boundary rather than surfacing as a constraint violation mid-transaction.
 *
 * Tax and freight are NON-negative (a zero-tax PO is legitimate and the claim must be able to
 * match it exactly), while the quantity is strictly positive: a credit is a separate document
 * with its own semantics, not a negative line inside a conservation fold, and Phase 5 has no
 * credit note (§0b).
 */
export const vendorBillLineSchema = z
  .object({
    poLineId: z.string().min(1).optional(),
    labourPoLineId: z.string().min(1).optional(),
    quantity: z
      .string().trim()
      .regex(QUANTITY_STRING, 'quantity must be a positive decimal with at most 6 places')
      .refine((v) => Number(v) > 0, 'a claim line for zero claims nothing'),
    rate: z.string().trim().regex(MONEY_STRING, 'rate must be a non-negative decimal with at most 2 places'),
    taxAmount: z.string().trim().regex(MONEY_STRING, 'taxAmount must be a non-negative decimal with at most 2 places').optional(),
    freightAmount: z.string().trim().regex(MONEY_STRING, 'freightAmount must be a non-negative decimal with at most 2 places').optional(),
  })
  .strict()
  .refine(
    (v) => (v.poLineId == null) !== (v.labourPoLineId == null),
    'a claim line names EXACTLY ONE purchase-order line — with neither, no §G bound can run; with both, the fold owner is ambiguous',
  );

export const recordVendorBillSchema = z
  .object({
    vendorId: z.string().min(1),
    // The duplicate-claim key: frozen after write at PostgreSQL, so it is validated here too — and
    // NORMALIZED here (Codex round-4), because surrounding whitespace is never part of a number a
    // vendor printed. Trimming at the contract also makes the idempotency `requestHash` stable, so
    // a retry that re-sends ` V-1 ` is recognised as the same request rather than a second claim.
    vendorBillNumber: commercialNonBlank('vendorBillNumber', 128).transform((s) => s.trim()),
    documentDate: isoCivilDateSchema,
    lines: z.array(vendorBillLineSchema).min(1).max(200),
  })
  .strict();

/**
 * §F — an amendment issues a NEW version retaining the prior verbatim. It is also how a DISPUTED
 * claim is RESOLVED: the disputed version stays terminal as history and the corrected claim
 * enters `submitted`, where the ordinary bounds apply.
 */
export const amendVendorBillSchema = z
  .object({
    billId: z.string().min(1),
    reason: z.string().trim().min(1).max(1000),
    lines: z.array(vendorBillLineSchema).min(1).max(200),
  })
  .strict();

/** §F — a JUDGEMENT about the claim (distinct from a dispute, which says its evidence moved). */
export const rejectVendorBillSchema = z
  .object({ billId: z.string().min(1), reason: z.string().trim().min(1).max(1000) })
  .strict();

/** §F — a bare lifecycle step: submit the recorded claim, or open the §E check on it. */
export const vendorBillStepSchema = z.object({ billId: z.string().min(1) }).strict();

/**
 * §E/§I — CERTIFY a verified claim.
 *
 * The input is the bill and NOTHING else, and that is the whole of Codex round-7's P1. An earlier
 * spelling took `sodOverride: { approverId, reason }` from the certifier's own request, so a
 * self-certifying pmc could type a colleague's id and the system would write an immutable record
 * asserting that colleague authorised it. §I's control is "a stronger authority said yes"; the
 * authority was never asked.
 *
 * So the override is no longer something a certifier supplies. The approver issues a GRANT with
 * their own authenticated command (`commercial.sod.grant`), and certification CONSUMES it. There is
 * no field here to forge.
 */
/**
 * Codex round-2 — `versionId` is the claim version the certifier READ.
 *
 * Round 1 pinned the GRANT to its viewed version and stopped there; certification has the same
 * exposure and it is the act that creates money. Queue Certify against a verified v1 offline,
 * another user amends and re-verifies v2, and the replay certifies a claim this certifier never
 * saw. Optional for the same reason as the grant's: in-process callers hold no rendered version,
 * and the risk is specific to a command that can sit in a queue across an amendment.
 */
/**
 * Codex round-5 — …and the claim REVISION the certifier read, REQUIRED at the boundary.
 *
 * The service already refuses a stale pin (`assertReviewedRevision`) and already records what the
 * certifier saw. What it could not do was tell the difference between "this certifier reviewed
 * revision 3" and "this certifier sent no pin at all", because the boundary never asked for one:
 * every web and offline certification arrived without the field, fell through to the server's own
 * reading of `now`, and was recorded as reviewed evidence. A default that fabricates the evidence
 * it stands in for is worse than no field, because it is indistinguishable from the real thing
 * afterwards.
 *
 * The version pin cannot cover this. `versionId` is stable across the whole payment lifecycle, so a
 * queued certify replayed after `verified → certified → superseded → verified` still matches it;
 * only the monotonic revision separates the two passages.
 */
export const certifyBillSchema = z
  .object({
    billId: z.string().min(1),
    versionId: z.string().min(1),
    lifecycleVersion: z.number().int().nonnegative(),
  })
  .strict();

/**
 * §I — GRANT permission for ONE otherwise-forbidden act. Issued BY the approver, so the
 * authenticated actor IS the authority; `actorId` names the person being excused.
 *
 * The reason belongs to the grant rather than to the act, because the justification is the
 * APPROVER'S ("Ravi is our only store user this week"), not the excused actor's.
 *
 * `rule` names WHICH half of §I is being overridden. Task 6A adds the payment half, and the rule
 * belongs in the grant rather than being inferred at consumption: a grant issued so a store user
 * could certify must not silently become permission to approve that claim's payment. It defaults
 * to the certification rule, so every Task-5 caller is byte-for-byte unchanged.
 */
export const grantSodExceptionSchema = z
  .object({
    billId: z.string().min(1),
    actorId: z.string().min(1),
    reason: z.string().trim().min(1).max(1000),
    // OPTIONAL, not `.default()`: a zod default only applies where the schema runs, which is the
    // HTTP boundary. Every in-process caller — the Task-5 suites, the operator paths — constructs
    // this object directly, and a default that lives only in the pipe leaves them writing a NULL
    // rule. The default belongs with the rule, in the service.
    /**
     * §I — the claim VERSION and the STATUS the approver had in front of them (7B-iii-h).
     *
     * REQUIRED at this boundary, and the asymmetry with the service's own shape is deliberate:
     * round 6 of PR #310 established that making a viewed-fact pin optional so in-process callers
     * compile skips the guard exactly where the risk lives — a posted or replayed body. The
     * boundary is attacker-reachable; an in-process caller is not, and carries no rendered fact.
     *
     * The VERSION says which claim; the STATUS says what was true about it. One version walks
     * `submitted → under-verification → verified` without changing id, so the version alone would
     * let an authorisation issued before the §E verdict excuse the certification of a verdict its
     * approver never saw.
     */
    versionId: z.string().min(1),
    status: z.string().min(1),
    /**
     * …and the claim's REVISION at that moment (Codex round 3).
     *
     * The version and the status are both RE-ENTERABLE: §F derives the payment status from the
     * folds, a claim returns to a label it has left, and a retention release moves what is owed
     * without moving the label at all. So neither pin says WHICH passage of the claim the approver
     * was looking at — and the first spelling of this command compared those two and then recorded
     * the DATABASE'S CURRENT revision as the thing reviewed, which is the server agreeing with
     * itself about a number nobody had seen.
     *
     * The claim read publishes it; the approver echoes it; it is compared under the bill lock
     * before it is persisted.
     */
    lifecycleVersion: z.number().int().nonnegative(),
    rule: z
      .enum([SOD_RULES.evidenceRecorderMayNotCertify, SOD_RULES.certifierMayNotApprove])
      .optional(),
  })
  .strict();

/** §F — past certification the correction path is a SUPERSEDING certificate, never an edit. */
export const supersedeCertificateSchema = z
  .object({
    billId: z.string().min(1),
    reason: z.string().trim().min(1).max(1000),
    /** Codex round-2 — the certificate the corrector was LOOKING AT. Supersession names "the live
     *  one" at execution, so a queued correction intended for c1 supersedes its replacement c2 if
     *  c1 was corrected first: a document nobody reviewed, replaced with a reason written about a
     *  different one. REQUIRED at the boundary from round 6; see `SupersedeCertificateCommand`. */
    certificateId: z.string().min(1),
  })
  .strict();

/**
 * §H — WITHHOLD money from a certified payable.
 *
 * The amount is a decimal STRING and is refused at zero or below HERE as well as at PostgreSQL:
 * the row TYPE carries direction, so a negative encodes it twice and the two encodings disagree —
 * a `-10` retention would RAISE a ₹100 certificate to ₹110, a deduction that pays out more, sealed
 * append-only so the inflated payable could not be corrected in place. §0b's sign constraint.
 *
 * `reason` is optional in the SHAPE and mandatory for `penalty` and `other` in the service and at
 * PostgreSQL. A retention is a contract term and needs no argument; the other two are judgements,
 * and the discriminating rule lives where the type is known rather than in a union that would have
 * to be restated on every future member.
 */
export const recordDeductionSchema = z
  .object({
    billId: z.string().min(1),
    type: z.enum(DEDUCTION_TYPES),
    amount: z.string().trim().min(1).max(32),
    reason: z.string().trim().min(1).max(1000).nullish(),
  })
  .strict();

/**
 * §H — give back part of a withholding. A release is its OWN append-only row, never an edit of the
 * deduction, so the reason is required: it returns money somebody withheld, and an unexplained
 * release is indistinguishable from a mistake.
 */
export const releaseDeductionSchema = z
  .object({
    deductionId: z.string().min(1),
    amount: z.string().trim().min(1).max(32),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();

/**
 * §F/§G/§I — AUTHORISE a certified payable for payment.
 *
 * The amount is a decimal STRING and refused at zero or below here as well as at PostgreSQL: an
 * approval's direction is carried by the ROW KIND, so a negative would encode it twice and let one
 * approval silently undo another on an append-only table (§0b's sign constraint, at its next site).
 *
 * No `certificateId`: the approval draws on whatever certificate is LIVE, resolved server-side
 * under the bill lock. A caller-supplied id would let an approval name a superseded certificate —
 * retained history that §G bounds 3–5 deliberately exclude — and the bound would then measure
 * against a certification that no longer stands.
 */
export const approvePaymentSchema = z
  .object({
    billId: z.string().min(1),
    amount: z.string().trim().min(1).max(32),
    /** …and the claim REVISION the approver read. Codex named this for the grant and the certify
     *  commands; it belongs here for the same reason and was missing from both — an approval is
     *  an act that spends a §I authority, and it must be able to say which passage of the claim it
     *  was performed on. The §F payment status is re-enterable, so nothing else can say it. */
    lifecycleVersion: z.number().int().nonnegative(),
  })
  .strict();

/**
 * §G — RECORD money leaving against an approval that covers it.
 *
 * `method` is required and non-blank: a payment that cannot say how the money moved cannot be
 * reconciled against a bank statement, which is the only thing that makes it evidence rather than
 * an assertion. `reference` is optional because not every method has one.
 */
export const recordPaymentSchema = z
  .object({
    approvalId: z.string().min(1),
    amount: z.string().trim().min(1).max(32),
    method: z.string().trim().min(1).max(64),
    reference: z.string().trim().min(1).max(200).nullish(),
  })
  .strict();

/**
 * Task 6B unit ii (§0/§H) — RECOVER money already paid, against the payment that moved it.
 *
 * `reason` is required and non-blank, unlike a payment's optional `reference`. A payment's own
 * justification is the approval it draws on; a reversal has no such parent authority — it undoes
 * one — so the reason IS its justification, and an append-only row cannot acquire one later.
 *
 * There is no `method` field, deliberately. A reversal names the payment it returns, and that
 * payment already froze how the money moved; asking again would invite a second answer to a
 * question the ledger has already recorded.
 */
export const reversePaymentSchema = z
  .object({
    paymentId: z.string().min(1),
    amount: z.string().trim().min(1).max(32),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

/**
 * Task 6C (§H) — PAY a counterparty ahead of any certified claim.
 *
 * `reason` is required, unlike a payment's optional `reference`, and the asymmetry is the point: a
 * payment's justification is the approval it draws on, and an advance has none. It is recovered
 * over later bills by `advance-recovery` deductions that carry no reason of their own, so this row
 * is where the whole arrangement is explained or it is explained nowhere.
 *
 * The vendor is named directly rather than resolved from a bill, because an advance precedes every
 * bill it will be recovered from — that is what makes it an advance.
 */
export const payAdvanceSchema = z
  .object({
    vendorId: z.string().min(1),
    amount: z.string().trim().min(1).max(32),
    reason: z.string().trim().min(1).max(500),
    method: z.string().trim().min(1).max(64),
    reference: z.string().trim().min(1).max(200).nullish(),
  })
  .strict();

// ── Site Visits SV1-b (#792) ───────────────────────────────────────────────
// The caller sends only CLAIMED times; the database stamps each receipt and decides the accepted time (SV1-a, V3).
// `id` is minted by the device so an offline end can name a visit whose start has not reached the server yet. It is
// stored lowercase, as SV1-a's shape check requires, whatever case the device writes it in.
const siteVisitClaim = offsetInstant;

export const siteVisitIdSchema = z.string().uuid().transform((value) => value.toLowerCase());

export const startSiteVisitSchema = z.object({
  id: siteVisitIdSchema,
  claimedAt: siteVisitClaim,
  nodeId: z.string().trim().min(1).optional(),
  // Q6: a location is recorded when the device offers one, and its absence never blocks a start
  location: z.object({
    lat: z.number().finite().min(-90).max(90),
    lng: z.number().finite().min(-180).max(180),
    accuracyM: z.number().finite().min(0),
    at: siteVisitClaim,
  }).strict().optional(),
}).strict();

export const endSiteVisitSchema = z.object({ claimedAt: siteVisitClaim }).strict();

export const closeSiteVisitSchema = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

// SV1-b unit 2: the visitor adds or retires the places walked and the people with them. Each row's id is minted by
// the device, as the visit's is, so a queued retire can name a row whose add has not reached the server yet.
export const addSiteVisitPlaceSchema = z.object({
  id: siteVisitIdSchema,
  nodeId: z.string().trim().min(1),
  claimedAt: siteVisitClaim,
}).strict();

// a member of the project, in the role they attended in, or a guest by name (SV1-a's shape check)
export const addSiteVisitAttendeeSchema = z.union([
  z.object({ id: siteVisitIdSchema, userId: z.string().trim().min(1), role: z.string().trim().min(1).max(32) }).strict(),
  z.object({ id: siteVisitIdSchema, guestName: z.string().trim().min(1).max(120) }).strict(),
]);
