import { z } from 'zod';
import { parseCivilDate } from './common/civil-date';
import { DEDUCTION_TYPES, MONEY_STRING, QUANTITY_STRING, SOD_RULES } from '@vitan/shared';

export const sessionSchema = z.object({
  role: z.enum(['pmc', 'client', 'engineer', 'contractor', 'consultant']),
  projectId: z.string().min(1),
});
export type SessionInput = z.infer<typeof sessionSchema>;

// ── Phase 7c-auth ──────────────────────────────────────────────────────────
// Email + password sign-in for PMC / client / contractor accounts.
export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginSchema>;

// Invite-only password enrollment/reset. Verifying the OTP returns a one-time
// setup token, never an application session.
export const passwordCredentialRequestSchema = z.object({
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
});
export type PasswordCredentialRequestInput = z.infer<typeof passwordCredentialRequestSchema>;

export const passwordCredentialVerifySchema = z.object({
  requestId: z.string().uuid(),
  code: z.string().regex(/^\d{6}$/),
});
export type PasswordCredentialVerifyInput = z.infer<typeof passwordCredentialVerifySchema>;

export const passwordCredentialCompleteSchema = z.object({
  setupToken: z.string().min(32).max(256),
  password: z.string().min(12).max(128),
});
export type PasswordCredentialCompleteInput = z.infer<typeof passwordCredentialCompleteSchema>;

// Phone-OTP sign-in for site engineers (MSG91, dev-stubbed with no provider).
export const otpRequestSchema = z.object({
  phone: z.string().min(8),
  projectId: z.string().min(1).default('ambli'),
});
export type OtpRequestInput = z.infer<typeof otpRequestSchema>;

export const otpVerifySchema = z.object({
  phone: z.string().min(8),
  code: z.string().min(4).max(8),
  projectId: z.string().min(1).default('ambli'),
});
export type OtpVerifyInput = z.infer<typeof otpVerifySchema>;

// A worker's no-account device token (QR / tap-photo job card).
export const workerTokenSchema = z.object({
  projectId: z.string().min(1).default('ambli'),
  name: z.string().optional(),
  trade: z.string().optional(),
  // Enrollment secret from the site QR. Enforced only when WORKER_ENROLL_SECRET is set
  // on the API (prod lockdown); left unset in dev/demo so QR onboarding stays frictionless.
  enrollSecret: z.string().optional(),
});
export type WorkerTokenInput = z.infer<typeof workerTokenSchema>;

// Email-OTP sign-in (zero-DLT universal fallback).
export const emailOtpRequestSchema = z.object({
  email: z.string().email(),
  projectId: z.string().min(1).default('ambli'),
});
export type EmailOtpRequestInput = z.infer<typeof emailOtpRequestSchema>;

export const emailOtpVerifySchema = z.object({
  email: z.string().email(),
  code: z.string().min(4).max(8),
  projectId: z.string().min(1).default('ambli'),
});
export type EmailOtpVerifyInput = z.infer<typeof emailOtpVerifySchema>;

// Google sign-in — a Google ID token from Google Identity Services on the client.
export const googleSignInSchema = z.object({
  idToken: z.string().min(10),
  projectId: z.string().min(1).default('ambli'),
});
export type GoogleSignInInput = z.infer<typeof googleSignInSchema>;

export const approveSchema = z.object({ optionIndex: z.number().int().min(0) });
export type ApproveInput = z.infer<typeof approveSchema>;

export const changeSchema = z.object({
  reason: z.string().min(1),
  costImpact: z.number().int(),
  timeImpactDays: z.number().int(),
});
export type ChangeInput = z.infer<typeof changeSchema>;

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
export type SubmitInspectionInput = z.infer<typeof submitInspectionSchema>;

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
export type DecideReviewInput = z.infer<typeof decideReviewSchema>;

export const submitDailyLogSchema = z.object({
  checkedIn: z.boolean(),
  checkinTime: z.string().nullable(),
  progress: z.number().int().min(0),
  crew: z.array(z.object({ trade: z.string(), count: z.number().int().min(0) })),
});
export type SubmitDailyLogInput = z.infer<typeof submitDailyLogSchema>;

export const flagMismatchSchema = z.object({ decisionId: z.string().min(1) });
export type FlagMismatchInput = z.infer<typeof flagMismatchSchema>;
// Phase 3 Task 5 (§E) — close ONE mismatch observation with an explicit disposition + reason
// (the observation row is never edited; one resolution per observation).
export const resolveMismatchSchema = z.object({
  siteMaterialId: z.string().min(1),
  resolution: z.string().trim().min(1).max(300), // e.g. 'returned-and-replaced', 'accepted-by-client'
  reason: z.string().trim().min(1).max(1000),
}).strict();
export type ResolveMismatchInput = z.infer<typeof resolveMismatchSchema>;

// ── Phase 7c-media ─────────────────────────────────────────────────────────
// A site photo upload. `data` is base64 (no data: URL prefix).
// P2-5: a raster-image allowlist — NOT `image/*`, which admits `image/svg+xml`
// (active content → stored XSS when the file is served inline). Base64 is capped so
// a single request can't push an unbounded blob through the API body.
export const RASTER_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif', 'image/heic', 'image/heif'] as const;
export const MAX_MEDIA_BASE64 = 14_000_000; // ~10.5 MB decoded
export const createMediaSchema = z.object({
  kind: z.enum(['progress', 'inspection', 'decision', 'attendance', 'material']),
  mime: z.enum(RASTER_IMAGE_MIMES),
  data: z.string().min(1).max(MAX_MEDIA_BASE64, 'image too large'),
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
});
export type CreateMediaInput = z.infer<typeof createMediaSchema>;

// Re-file an existing photo or drawing onto a location-tree node (or null to unfile).
// Shared by PATCH /media/:id/node and /drawings/:id/node — "manage & modify" from the tree.
export const setNodeSchema = z.object({ nodeId: z.string().trim().min(1).nullable() });
export type SetNodeInput = z.infer<typeof setNodeSchema>;

// ── Phase 8: web push ────────────────────────────────────────────────────────
// P2-1: constrain the push endpoint to a public HTTPS host — reject non-https and any
// localhost / private / link-local / reserved literal, so the subscription can't be used
// to make the server POST to internal services or the cloud metadata endpoint (SSRF).
export function isSafeExternalHttpsUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (host.includes(':')) return false; // IPv6 literal (incl. ::1, ULA) — not a push provider
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false; // link-local + cloud metadata (169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    return false; // any other bare-IP endpoint is not a real push provider
  }
  return true;
}
export const pushSubscribeSchema = z.object({
  subscription: z.object({
    endpoint: z.string().url().refine(isSafeExternalHttpsUrl, 'endpoint must be an https URL to a public host'),
    keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
  }),
});
export type PushSubscribeInput = z.infer<typeof pushSubscribeSchema>;

// ── Drawings register (Slice 1) ──────────────────────────────────────────────
// Issue a drawing. If `number` already exists in the project a new revision is
// added and the prior ones are superseded; otherwise a new register entry is
// created. PDF/DWG/images accepted; DWG is a downloadable source (viewed as PDF).
// P2-5: a drawing MIME allowlist (PDF / CAD / raster) — excludes SVG and any
// text/html/script type. Inline base64 is capped; the large-file path goes direct
// to the bucket via presign with a server-enforced size cap.
export const DRAWING_MIMES = [
  'application/pdf',
  'image/vnd.dwg',
  'application/acad',
  'application/dwg',
  'image/vnd.dxf',
  'application/dxf',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
] as const;
export const MAX_DRAWING_BASE64 = 14_000_000; // ~10.5 MB inline; larger files use presign
export const MAX_DRAWING_BYTES = 100_000_000; // 100 MB hard cap for presigned uploads
export const issueDrawingSchema = z
  .object({
    number: z.string().min(1),
    title: z.string().min(1),
    discipline: z.enum(['architectural', 'structural', 'mep', 'other']),
    rev: z.string().min(1),
    status: z.enum(['for_review', 'for_construction']).default('for_construction'),
    mime: z.enum(DRAWING_MIMES),
    // one of: inline base64 body (dev stub / small files) OR a storageKey from a
    // completed presigned direct-to-bucket upload (Slice 3, large files).
    data: z.string().min(1).max(MAX_DRAWING_BASE64, 'file too large for inline upload').optional(),
    storageKey: z.string().min(1).optional(),
    sizeBytes: z.number().int().nonnegative().max(MAX_DRAWING_BYTES, 'file too large').optional(),
    // Content-bound command identity (Task 10 correction): a lowercase hex SHA-256 of the ORIGINAL
    // file bytes. For the inline path the server recomputes it from `data` (authoritative); for the
    // presigned path the server never sees the bytes, so the client-supplied digest is the ONLY content
    // identity — the command hash binds to it so a same-key/same-metadata retry with DIFFERENT bytes is
    // a 409, not a silent replay of the wrong file. Required on the presigned path (see refine below).
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/, 'contentSha256 must be a lowercase hex SHA-256').optional(),
    note: z.string().optional(),
    zone: z.string().optional(),
    activityId: z.string().optional(),
    decisionId: z.string().optional(),
    // Location spine: the place this drawing governs (a location-tree node). Filed at its
    // natural level and inherited down to rooms/objects beneath it. Optional (unfiled).
    nodeId: z.string().trim().min(1).nullish(),
    // Draft → Publish: default saves a NEW drawing as a private draft (author-only, no team
    // notice); `publish: true` issues it in one step. Ignored when adding a revision to an
    // already-published drawing (that's a normal issue).
    publish: z.boolean().default(false),
  })
  .refine((v) => Boolean(v.data) !== Boolean(v.storageKey), {
    message: 'Provide exactly one of data (base64) or storageKey (presigned upload)',
  })
  // Content-bound identity: the presigned path carries no bytes for the server to hash, so the client
  // MUST supply the content digest — otherwise the command hash could not distinguish two different
  // files uploaded under the same key + metadata.
  .refine((v) => !v.storageKey || Boolean(v.contentSha256), {
    message: 'contentSha256 is required for a presigned (storageKey) upload',
    path: ['contentSha256'],
  });
export type IssueDrawingInput = z.infer<typeof issueDrawingSchema>;

export const presignDrawingSchema = z.object({
  mime: z.enum(DRAWING_MIMES),
});
export type PresignDrawingInput = z.infer<typeof presignDrawingSchema>;

// ── Orgs & multi-project (multi-tenant foundation) ───────────────────────────
export const createOrgSchema = z.object({ name: z.string().min(1) });
export type CreateOrgInput = z.infer<typeof createOrgSchema>;

// ── Templates (docs/TEMPLATES.md) ─────────────────────────────────────────────

/** A module's self-contained structure payload. Node `key`s are payload-internal —
 *  instantiation mints fresh ids; activities/inspections reference nodes by key and
 *  activities reference phases by name, so a payload never leaks real row ids. */
export const modulePayloadSchema = z.object({
  nodes: z
    .array(
      z.object({
        key: z.string().min(1),
        parentKey: z.string().nullable().default(null),
        name: z.string().min(1),
        kind: z.enum(['zone', 'room', 'element']),
        order: z.number().int().default(0),
      }),
    )
    .max(500)
    .default([]),
  phases: z.array(z.object({ name: z.string().min(1), order: z.number().int().default(0), plannedStart: z.number().int().default(0), plannedEnd: z.number().int().default(0) })).max(50).default([]),
  activities: z
    .array(
      z.object({
        name: z.string().min(1),
        zone: z.string().default(''),
        plannedStart: z.number().int().default(0),
        plannedEnd: z.number().int().default(0),
        nodeKey: z.string().optional(),
        phaseName: z.string().optional(),
        order: z.number().int().default(0),
      }),
    )
    .max(500)
    .default([]),
  inspections: z
    .array(z.object({ title: z.string().min(1), zone: z.string().default(''), nodeKey: z.string().optional(), items: z.array(z.string().min(1)).min(1).max(50) }))
    .max(100)
    .default([]),
});
export type ModulePayload = z.infer<typeof modulePayloadSchema>;

/** Create a module: either with an explicit payload, or extracted server-side from a
 *  same-org project (`fromProject`, optionally one node's subtree via `fromNodeId`). */
export const createModuleSchema = z
  .object({
    name: z.string().trim().min(1),
    category: z.enum(['space', 'zone', 'element', 'discipline', 'schedule']),
    description: z.string().default(''),
    payload: modulePayloadSchema.optional(),
    fromProject: z.string().trim().min(1).optional(),
    fromNodeId: z.string().trim().min(1).optional(),
  })
  .refine((v) => Boolean(v.payload) !== Boolean(v.fromProject), { message: 'Provide exactly one of payload or fromProject' })
  .refine((v) => !v.fromNodeId || v.fromProject, { message: 'fromNodeId requires fromProject' });
export type CreateModuleInput = z.infer<typeof createModuleSchema>;

/** One menu pick at Create Project: which module, how many, and where it grafts.
 *  A zone-anchored module (room roots) takes `underZone` — a zone NAME, created as a
 *  draft if it doesn't exist yet. A room-anchored module (element roots, e.g. a saved
 *  "Main Door") takes EXACTLY ONE of `underRoom` — a room NAME resolved among the rooms
 *  the copied source or an earlier selection creates (a room cannot be invented without
 *  its own parent) — or `underZone`, grafting the element directly under that zone (the
 *  nested-locations decision's new legal edge). The anchor-specific requirements are
 *  enforced server-side where the module's anchor kind is known. */
export const moduleSelectionSchema = z.object({
  moduleId: z.string().min(1),
  count: z.number().int().min(1).max(20).default(1),
  underZone: z.string().trim().min(1).optional(),
  underRoom: z.string().trim().min(1).optional(),
});

/** Create a named preset (Slice 3): an explicit module selection, or `fromProject` —
 *  which captures that project's full structure as ONE new module and wraps it in a
 *  preset (a single coherent module keeps activity/checklist place references intact;
 *  richer multi-module presets are hand-composed from the menu via `items`). */
export const createTemplateSchema = z
  .object({
    name: z.string().trim().min(1),
    description: z.string().default(''),
    items: z.array(moduleSelectionSchema).min(1).max(50).optional(),
    fromProject: z.string().trim().min(1).optional(),
  })
  .refine((v) => Boolean(v.items) !== Boolean(v.fromProject), { message: 'Provide exactly one of items or fromProject' });
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;

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

/** A real IANA time zone — validated against the runtime's zone database, so a
 *  typo can't silently corrupt every "today on site" the Clock stamps. */
export const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'Unknown IANA time zone');

export const createProjectSchema = z.object({
  name: z.string().min(1),
  short: z.string().min(1),
  descriptor: z.string().default(''),
  stage: z.string().default('Planning'),
  siteCode: z.string().default(''),
  location: z.string().default(''),
  projStart: z.string().default(''),
  projEnd: z.string().default(''),
  /** Task 6: the schedule anchor — the calendar day offset 0 refers to. Defaults to
   *  TODAY in the project's time zone at creation. */
  scheduleStartDate: isoCivilDateSchema.optional(),
  timeZone: timeZoneSchema.optional(),
  /** Templates Slice 1: copy another project's STRUCTURE into the new one — the location
   *  tree (as drafts), phases, planned activities and inspection checklist definitions.
   *  Actuals (approvals, dates, statuses, photos, people) are never copied. */
  structureFrom: z.string().trim().min(1).optional(),
  /** Templates Slice 2: compose the new project from org modules (may combine with
   *  structureFrom — the result is the union). */
  modules: z.array(moduleSelectionSchema).max(50).optional(),
  /** Templates Slice 3: start from a named preset — expands to its module selection
   *  ahead of any explicit `modules` picks (the result is the union of all sources). */
  templateId: z.string().trim().min(1).optional(),
});
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

// Edit a project's details — every field optional; only provided ones change.
export const updateProjectSchema = z
  .object({
    name: z.string().min(1).optional(),
    short: z.string().min(1).optional(),
    descriptor: z.string().optional(),
    stage: z.string().optional(),
    siteCode: z.string().optional(),
    location: z.string().optional(),
    projStart: z.string().optional(),
    projEnd: z.string().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

// Companies & consultants attached to a project (firm + contact, keyed by kind).
export const companyKindSchema = z.enum(['client', 'contractor', 'architect', 'structural', 'mep', 'pmc', 'consultant', 'other']);
const optText = z.string().trim().optional();
export const addCompanySchema = z.object({
  // Phase 6 unit 6.1a — this name is copied into the canonical `ExternalParty`, so it is the
  // firm identity a person reads before granting access. `min(1)` without `trim()` admitted a
  // name of spaces; `createVendorSchema` above has always trimmed, and the inconsistency is the
  // finding. Trimming here also keeps the value the DB's non-blank CHECK will accept.
  name: z.string().trim().min(1).max(200),
  kind: companyKindSchema,
  contactName: optText,
  contactEmail: z.string().trim().email().optional().or(z.literal('')),
  contactPhone: optText,
  notes: optText,
});
export type AddCompanyInput = z.infer<typeof addCompanySchema>;

export const updateCompanySchema = addCompanySchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });
export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>;

// Issue a decision (PMC): 2–4 options the client chooses between. Labels/keys are
// derived from order (Option A/B/…) when omitted; photoUrl is an uploaded media url.
const decisionOptionInput = z.object({
  label: z.string().trim().min(1).optional(),
  material: z.string().trim().min(1),
  delta: z.number().int(),
  swatch: z.string().trim().min(1),
  photoUrl: z.string().trim().optional(),
  recommended: z.boolean().default(false),
});
export const createDecisionSchema = z.object({
  title: z.string().trim().min(1),
  // Location: either a tree node (authoritative) or the legacy free-text room. At least
  // one is required — the service derives the display `room` from the node path when nodeId
  // is set. `room` stays for back-compat and for decisions authored without the tree.
  nodeId: z.string().trim().min(1).optional(),
  room: z.string().trim().default(''),
  options: z.array(decisionOptionInput).min(2).max(4),
  // Draft → Publish lifecycle: default is to save a PRIVATE DRAFT (author-only, no client
  // notice). Pass `publish: true` to create it already-published (the one-step "issue now").
  publish: z.boolean().default(false),
});
export type CreateDecisionInput = z.infer<typeof createDecisionSchema>;

// ── Location tree (zones → rooms → elements) ─────────────────────────────────
export const NODE_KINDS = ['zone', 'room', 'element'] as const;
export const createNodeSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(NODE_KINDS),
  parentId: z.string().trim().min(1).nullish(),
  // Draft → Publish: default true (a node created inline while filing is live immediately, so
  // the item can attach to it). Pass false from the "stage a layout" flow to create a private
  // draft node. A node created under a draft parent is always a draft, regardless of this flag.
  publish: z.boolean().default(true),
});
export type CreateNodeInput = z.infer<typeof createNodeSchema>;

export const renameNodeSchema = z.object({ name: z.string().trim().min(1).max(80) });
export type RenameNodeInput = z.infer<typeof renameNodeSchema>;

export const moveNodeSchema = z.object({
  parentId: z.string().trim().min(1).nullable(),
  order: z.number().int().min(0).optional(),
});
export type MoveNodeInput = z.infer<typeof moveNodeSchema>;

// Planning & scheduling (PMC). Planned start/end are day-offsets on the schedule
// timeline (same unit the seeded schedule uses).
const gateState = z.enum(['ok', 'wait', 'fail', 'na']);
export const createActivitySchema = z
  .object({
    name: z.string().trim().min(1),
    zone: z.string().trim().default(''),
    plannedStart: z.number().int().min(0),
    plannedEnd: z.number().int().min(0),
    // Task 6: real civil dates (preferred); when given they drive the write and the
    // legacy offsets are derived from the project's schedule anchor
    plannedStartDate: isoCivilDateSchema.optional(),
    plannedEndDate: isoCivilDateSchema.optional(),
    // null == "no link" (the same convention the update schema documents): the web contract
    // (`NewActivityInput`) sends `phaseId/decisionId/nodeId: null` when unset, and the service
    // normalizes with `?? null` — rejecting null here 400'd every UI plan without a phase,
    // decision or location (caught by the activities module-read e2e).
    phaseId: z.string().nullable().optional(),
    decisionId: z.string().nullable().optional(),
    // Location spine: the place this work happens (a location-tree node).
    nodeId: z.string().trim().min(1).nullable().optional(),
    // material/team stay STORED site flags (Phases 3/4 derive them); the
    // inspection and drawing gates are DERIVED from explicit links (Task 6) —
    // gateInspection left the write contracts entirely (deprecated column)
    gateMaterial: gateState.default('na'),
    gateTeam: gateState.default('na'),
  })
  .refine((v) => v.plannedEnd >= v.plannedStart, { message: 'plannedEnd must be on or after plannedStart' })
  // ISO civil dates compare lexicographically = chronologically (finding 5: a
  // reversed window must be a 400 whether it arrives as offsets OR as dates)
  .refine((v) => !v.plannedStartDate || !v.plannedEndDate || v.plannedStartDate <= v.plannedEndDate, {
    message: 'plannedEndDate must be on or after plannedStartDate',
  });
export type CreateActivityInput = z.infer<typeof createActivitySchema>;

export const updateActivitySchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    zone: z.string().trim().optional(),
    plannedStart: z.number().int().min(0).optional(),
    plannedEnd: z.number().int().min(0).optional(),
    plannedStartDate: isoCivilDateSchema.optional(),
    plannedEndDate: isoCivilDateSchema.optional(),
    // null clears the link / phase / location
    phaseId: z.string().nullable().optional(),
    decisionId: z.string().nullable().optional(),
    nodeId: z.string().nullable().optional(),
    // no route can set gateInspection any more (Task 6) — readiness derives it
    gateMaterial: gateState.optional(),
    gateTeam: gateState.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' })
  .refine((v) => v.plannedStart === undefined || v.plannedEnd === undefined || v.plannedEnd >= v.plannedStart, {
    message: 'plannedEnd must be on or after plannedStart',
  })
  .refine((v) => !v.plannedStartDate || !v.plannedEndDate || v.plannedStartDate <= v.plannedEndDate, {
    message: 'plannedEndDate must be on or after plannedStartDate',
  });
export type UpdateActivityInput = z.infer<typeof updateActivitySchema>;

// A manual readiness exception (Phase 1 Task 6): pmc-only, always with a reason
// and an EXPIRY in the future; optionally backed by a same-project photo.
export const overrideGateSchema = z.object({
  gate: z.enum(['decision', 'material', 'team', 'inspection', 'drawing']),
  state: gateState,
  reason: z.string().trim().min(1).max(500),
  evidenceMediaId: z.string().trim().min(1).optional(),
  expiresAt: z.string().datetime({ offset: true }),
});
export type OverrideGateInput = z.infer<typeof overrideGateSchema>;

export const createPhaseSchema = z
  .object({
    name: z.string().trim().min(1),
    plannedStart: z.number().int().min(0).default(0),
    plannedEnd: z.number().int().min(0).default(0),
    // real civil dates (preferred); legacy offsets derived from the schedule anchor
    plannedStartDate: isoCivilDateSchema.optional(),
    plannedEndDate: isoCivilDateSchema.optional(),
  })
  .refine((v) => v.plannedEnd >= v.plannedStart, { message: 'plannedEnd must be on or after plannedStart' })
  .refine((v) => !v.plannedStartDate || !v.plannedEndDate || v.plannedStartDate <= v.plannedEndDate, {
    message: 'plannedEndDate must be on or after plannedStartDate',
  });
export type CreatePhaseInput = z.infer<typeof createPhaseSchema>;

// Issue an inspection checklist (PMC) — the engineer fills it in the field.
export const createInspectionSchema = z.object({
  title: z.string().trim().min(1),
  zone: z.string().trim().min(1),
  items: z.array(z.string().trim().min(1)).min(1).max(20),
  // Location spine: the place this quality check happens (a location-tree node).
  nodeId: z.string().trim().min(1).optional(),
  // The REQUIREMENT EDGE (Phase 1 Task 4): the Activity this inspection accepts.
  activityId: z.string().trim().min(1).optional(),
});
export type CreateInspectionInput = z.infer<typeof createInspectionSchema>;

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
export type AddMaterialInput = z.infer<typeof addMaterialSchema>;

export const switchProjectSchema = z.object({ projectId: z.string().min(1) });
export type SwitchProjectInput = z.infer<typeof switchProjectSchema>;

const projectRole = z.enum(['pmc', 'client', 'engineer', 'contractor', 'consultant']);
// A consultant's discipline is a free-ish label (a new consultant type needs no code);
// trimmed, capped, optional. Only meaningful for role === 'consultant'.
const disciplineField = z.string().trim().min(1).max(40).optional();
export const addMemberSchema = z
  .object({
    name: z.string().min(1),
    role: projectRole,
    email: z.string().email().optional(),
    phone: z.string().min(6).optional(),
    discipline: disciplineField,
  })
  .refine((v) => v.email || v.phone, { message: 'email or phone required' });
export type AddMemberInput = z.infer<typeof addMemberSchema>;

export const updateMemberSchema = z.object({ role: projectRole, discipline: disciplineField });
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;

// Add someone to the org's admin roster (owner/admin/member). This is the org
// tier — distinct from project membership. An org owner can operate every
// project in the org as PMC; see OrgsService.addOrgMember.
const orgRole = z.enum(['owner', 'admin', 'member']);
export const addOrgMemberSchema = z
  .object({
    name: z.string().min(1),
    email: z.string().email().optional(),
    phone: z.string().min(6).optional(),
    role: orgRole,
  })
  .refine((v) => v.email || v.phone, { message: 'email or phone required' });
export type AddOrgMemberInput = z.infer<typeof addOrgMemberSchema>;

// Change an org member's role (owner only) — see OrgsService.updateOrgMemberRole.
export const updateOrgMemberSchema = z.object({ role: orgRole });
export type UpdateOrgMemberInput = z.infer<typeof updateOrgMemberSchema>;

// Correct a mistyped invitation address only before that identity establishes a
// password. Authorization and the enrolled-state guard live in OrgsService.
export const correctInvitationEmailSchema = z.object({
  email: z.string().trim().email().transform((value) => value.toLowerCase()),
});
export type CorrectInvitationEmailInput = z.infer<typeof correctInvitationEmailSchema>;

// ── Phase 3 Task 1 / Phase 4 Task 1 — the TYPE-ROUTED ActivityRequirement demand contract ──
// (plan §B). The requirement is type-neutral: a `type='material'` revision carries the material
// identity (quantities as DECIMAL STRINGS, canonicalized by the shared parseQuantity so they
// round-trip numeric(18,6)); a `type='labour'` revision carries the trade/skill/shift technical
// identity + explicit per-`(civilDate, personShiftQty)` demand slices (integer person-shifts).
// `type` DEFAULTS to 'material' when absent, so every existing material caller (which never sent
// `type`) is byte-for-byte unchanged.

// fields common to every requirement type (caller-provided). provenance is SERVER-resolved from
// the referenced decision's approval record (correction finding 1): the caller may name a
// decision, never author its version or option.
const requirementCommonShape = {
  activityId: z.string().trim().min(1),
  decisionId: z.string().trim().min(1).nullish(),
  responsibleId: z.string().trim().min(1).nullish(),
  criticality: z.enum(['normal', 'critical']).default('normal'),
  tolerance: z.string().trim().min(1).nullish(),
};

// the MATERIAL detail (the Phase-3 shape verbatim, now tagged `type:'material'`).
const materialRequirementShape = {
  ...requirementCommonShape,
  type: z.literal('material'),
  materialCategory: z.string().trim().min(1),
  make: z.string().trim().min(1),
  grade: z.string().trim().min(1),
  attributes: z.string().trim().default(''),
  baseUom: z.string().trim().min(1),
  qty: z.string().trim().min(1),
  requiredBy: isoCivilDateSchema,
};

// one explicit `(civilDate, personShiftQty)` labour demand slice (§B). The shift is the spec's
// shift (one per requirement), so a slice needs only its civil date + person-shift count.
export const labourDemandSliceSchema = z
  .object({ civilDate: isoCivilDateSchema, personShiftQty: z.number().int().positive() })
  .strict();
export type LabourDemandSliceInput = z.infer<typeof labourDemandSliceSchema>;

// the LABOUR detail — trade/skill/shift technical identity + explicit demand slices (§B). The
// service DERIVES the neutral row's baseUom='person-shift', qty=Σ personShiftQty and
// requiredBy=max(civilDate) from the slices (they are not caller-authored for labour).
const labourRequirementShape = {
  ...requirementCommonShape,
  type: z.literal('labour'),
  tradeCode: z.string().trim().min(1),
  skillCode: z.string().trim().min(1).nullish(),
  shift: z.enum(['day', 'night']),
  demandSlices: z.array(labourDemandSliceSchema).min(1),
};

/** Default `type` to 'material' when a caller omits it (backward compatibility). */
function withDefaultMaterialType(v: unknown): unknown {
  return v && typeof v === 'object' && !Array.isArray(v) && !('type' in (v as Record<string, unknown>))
    ? { type: 'material', ...(v as Record<string, unknown>) }
    : v;
}

export const createRequirementSchema = z.preprocess(
  withDefaultMaterialType,
  z.discriminatedUnion('type', [z.object(materialRequirementShape).strict(), z.object(labourRequirementShape).strict()]),
);
export type CreateRequirementInput = z.infer<typeof createRequirementSchema>;
// a revision restates the full specification (append-only; CAS on the expected revision)
export const reviseRequirementSchema = z.preprocess(
  withDefaultMaterialType,
  z.discriminatedUnion('type', [
    z.object({ ...materialRequirementShape, expectedRevision: z.number().int().min(1) }).strict(),
    z.object({ ...labourRequirementShape, expectedRevision: z.number().int().min(1) }).strict(),
  ]),
);
export type ReviseRequirementInput = z.infer<typeof reviseRequirementSchema>;
export const cancelRequirementSchema = z.object({ expectedRevision: z.number().int().min(1), reason: z.string().trim().min(1) }).strict();
export type CancelRequirementInput = z.infer<typeof cancelRequirementSchema>;

// ── Phase 4 Task 1 — labour trusted-identity onboarding commands (plan §H) ──────────────
// The labour requirement DEMAND is authored through the Activities-owned requirement command
// (type-routed above); THESE are the labour module's own roster commands (pmc authority).
export const upsertLabourTradeSchema = z.object({ code: z.string().trim().min(1), name: z.string().trim().min(1) }).strict();
export type UpsertLabourTradeInput = z.infer<typeof upsertLabourTradeSchema>;

export const upsertLabourSkillSchema = z.object({ code: z.string().trim().min(1), name: z.string().trim().min(1) }).strict();
export type UpsertLabourSkillInput = z.infer<typeof upsertLabourSkillSchema>;

export const onboardWorkerSchema = z
  .object({
    name: z.string().trim().min(1),
    tradeCode: z.string().trim().min(1),
    skillCodes: z.array(z.string().trim().min(1)).default([]),
    activeFrom: isoCivilDateSchema,
    activeTo: isoCivilDateSchema.nullish(),
  })
  .strict();
export type OnboardWorkerInput = z.infer<typeof onboardWorkerSchema>;

export const revokeWorkerSchema = z.object({ reason: z.string().trim().min(1).nullish() }).strict();
export type RevokeWorkerInput = z.infer<typeof revokeWorkerSchema>;

export const formCrewSchema = z
  .object({
    name: z.string().trim().min(1),
    inchargeWorkerId: z.string().trim().min(1).nullish(),
    activeFrom: isoCivilDateSchema,
    activeTo: isoCivilDateSchema.nullish(),
  })
  .strict();
export type FormCrewInput = z.infer<typeof formCrewSchema>;

// Task-1 correction F5 — an attributable, idempotent crew revocation (a CAS lifecycle transition,
// symmetric with worker revocation): a reason is optional, the actor + timestamp are server-stamped.
export const revokeCrewSchema = z.object({ reason: z.string().trim().min(1).nullish() }).strict();
export type RevokeCrewInput = z.infer<typeof revokeCrewSchema>;

export const addCrewMemberSchema = z.object({ workerId: z.string().trim().min(1) }).strict();
export type AddCrewMemberInput = z.infer<typeof addCrewMemberSchema>;

export const removeCrewMemberSchema = z.object({}).strict();
export type RemoveCrewMemberInput = z.infer<typeof removeCrewMemberSchema>;

// ── Phase 3 Task 6 — approved material substitutions (plan §B). Approve DESCRIBES the
// alternative material (the server computes its `toFingerprint` via the ONE shared fingerprint
// function — never caller-authored) plus the audit reason; the requirement's own `fromFingerprint`
// is server-resolved from its head revision. Revoke stamps the row (never deletes it).
export const approveSubstitutionSchema = z
  .object({
    materialCategory: z.string().trim().min(1),
    make: z.string().trim().min(1),
    grade: z.string().trim().min(1),
    attributes: z.string().trim().default(''),
    baseUom: z.string().trim().min(1),
    reason: z.string().trim().min(1),
  })
  .strict();
export type ApproveSubstitutionInput = z.infer<typeof approveSubstitutionSchema>;
export const revokeSubstitutionSchema = z.object({ reason: z.string().trim().min(1) }).strict();
export type RevokeSubstitutionInput = z.infer<typeof revokeSubstitutionSchema>;

// ── Phase 3 Task 2 — procurement (plan §§F/H). Strict schemas: no caller-authored server
// facts; quantities are positive decimal STRINGS (≤6 dp, parseQuantity-canonicalized in the
// service); money is a positive decimal STRING with at most 2 fractional digits (INR).
const money = z.string().trim().regex(/^\d{1,16}(\.\d{1,2})?$/, 'money must be a decimal amount with at most 2 fractional digits');
export const createVendorSchema = z.object({
  name: z.string().trim().min(1).max(200),
  contact: z.string().trim().min(1).max(500).optional(),
  gstin: z.string().trim().min(1).max(30).optional(),
}).strict();
export type CreateVendorInput = z.infer<typeof createVendorSchema>;
export const bindVendorSchema = z.object({ vendorId: z.string().min(1) }).strict();
export type BindVendorInput = z.infer<typeof bindVendorSchema>;
export const createRequisitionSchema = z.object({
  title: z.string().trim().min(1).max(300),
  notes: z.string().trim().max(2000).optional(),
  lines: z.array(z.object({
    requirementId: z.string().min(1),
    revision: z.number().int().min(1),
    qty: z.string().trim().min(1),
  }).strict()).min(1).max(50),
}).strict();
export type CreateRequisitionInput = z.infer<typeof createRequisitionSchema>;
export const rejectRequisitionSchema = z.object({ reason: z.string().trim().min(1).max(1000) }).strict();
export type RejectRequisitionInput = z.infer<typeof rejectRequisitionSchema>;
export const createRfqSchema = z.object({ requisitionId: z.string().min(1) }).strict();
export type CreateRfqInput = z.infer<typeof createRfqSchema>;
export const recordQuoteSchema = z.object({
  vendorId: z.string().min(1),
  validUntil: z.string().trim().min(1), // ISO civil date (validated by the civil-date helper)
  leadTimeDays: z.number().int().min(0).max(3650).optional(),
  paymentTerms: z.string().trim().max(1000).optional(),
  warrantyTerms: z.string().trim().max(1000).optional(),
  historicalScore: z.string().trim().regex(/^\d{1,3}(\.\d{1,2})?$/).optional(),
  lines: z.array(z.object({
    requisitionLineId: z.string().min(1),
    baseRate: money,
    taxAmount: money,
    freightAmount: money,
    landedCost: money,
    quotedMake: z.string().trim().min(1).max(300),
    matchesSpecification: z.boolean(),
    sampleCompliant: z.boolean().optional(),
    vendorStockQty: z.string().trim().min(1).optional(),
    deliveryPromise: z.string().trim().min(1).optional(), // ISO civil date
  }).strict()).min(1).max(50),
}).strict();
export type RecordQuoteInput = z.infer<typeof recordQuoteSchema>;
export const approveComparisonSchema = z.object({
  selectedQuoteId: z.string().min(1),
  reason: z.string().trim().min(1).max(1000),
  justification: z.string().trim().min(1).max(2000).optional(),
}).strict();
export type ApproveComparisonInput = z.infer<typeof approveComparisonSchema>;

// ── Phase 3 Task 3 — purchase orders + delivery commitments (plan §F). The commercial
// snapshot is SERVER-frozen from the comparison-approved quote — the caller picks lines and
// quantities, never authors rates or landed amounts. approvedOverage is accepted ONLY by the
// issue/amend commands (with a reason), matching "set only by pmc at issuance/amendment".
// T2-3 correction F2 — the EXPLICIT purchase triple: the caller orders purchaseQty in the
// vendor's purchase unit; conversionToBase converts one purchase unit to base units; the
// base quantity is DERIVED by the service (and re-derived by a DB CHECK), never authored.
const poLineShape = z.object({
  requisitionLineId: z.string().min(1),
  purchaseQty: z.string().trim().min(1), // decimal string (parseQuantity-canonicalized)
  conversionToBase: z.string().trim().min(1).optional(), // one purchase unit in base units (default 1)
  purchaseUom: z.string().trim().min(1).max(50).optional(), // pack unit label (default: the base UOM)
}).strict();
const poOverageShape = z.object({
  requisitionLineId: z.string().min(1), // names the line the headroom applies to
  approvedOverage: z.string().trim().min(1),
  reason: z.string().trim().min(1).max(1000),
}).strict();
export const createPoSchema = z.object({
  comparisonId: z.string().min(1),
  lines: z.array(poLineShape).min(1).max(50),
}).strict();
export type CreatePoInput = z.infer<typeof createPoSchema>;
// Phase 5 Task 1 (§C) — the cost head is an INPUT to issuance when the `commercial` capability
// is on: a PO version becomes live at `pos.issue`, and §C's "a live line can never be
// unattributed" has to hold from that first instant. Optional in the contract so every existing
// material caller is byte-for-byte unchanged off-pilot; the service REFUSES an issue that leaves
// a line unattributed when the capability IS on.
export const poCostHeadShape = z.object({
  poLineId: z.string().min(1),
  costHeadCode: z.string().trim().min(1).max(64),
}).strict();
// Codex round 3 (P2) — an AMENDMENT's heads are keyed by REQUISITION LINE, not by PO line. The
// replacement `PurchaseOrderLine` rows are generated INSIDE the amend transaction, so their ids
// cannot exist in a caller's request: keyed by `poLineId`, a new line always failed "name the
// cost head" and a carried line silently kept its old head, making reclassification-at-amend
// unreachable. The requisition line is the identity the caller already supplies in `lines`.
// Issuance keeps `poLineId` because at issue the lines already exist and ARE addressable.
export const poAmendCostHeadShape = z.object({
  requisitionLineId: z.string().min(1),
  costHeadCode: z.string().trim().min(1).max(64),
}).strict();
export const issuePoSchema = z.object({
  overages: z.array(poOverageShape).max(50).optional(),
  costHeads: z.array(poCostHeadShape).max(50).optional(),
}).strict();
export type IssuePoInput = z.infer<typeof issuePoSchema>;
export const amendPoSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
  lines: z.array(poLineShape).min(1).max(50),
  overages: z.array(poOverageShape).max(50).optional(),
  // §C: an amendment issues a NEW version, so its lines need attribution too. Omitted entries
  // carry the amended line's own head forward; supplying one reclassifies at the same time.
  costHeads: z.array(poAmendCostHeadShape).max(50).optional(),
}).strict();
export type AmendPoInput = z.infer<typeof amendPoSchema>;
export const cancelPoSchema = z.object({ reason: z.string().trim().min(1).max(1000) }).strict();
export type CancelPoInput = z.infer<typeof cancelPoSchema>;
export const closeShortPoSchema = z.object({ reason: z.string().trim().min(1).max(1000) }).strict();
export type CloseShortPoInput = z.infer<typeof closeShortPoSchema>;
export const commitDeliverySchema = z.object({
  poLineId: z.string().min(1),
  promisedDate: z.string().trim().min(1), // ISO civil date (validated by the civil-date helper)
}).strict();
export type CommitDeliveryInput = z.infer<typeof commitDeliverySchema>;
export const reviseDeliverySchema = z.object({
  promisedDate: z.string().trim().min(1),
  reason: z.string().trim().min(1).max(1000), // every revision explains itself (§F)
}).strict();
export type ReviseDeliveryInput = z.infer<typeof reviseDeliverySchema>;

// ── Phase 3 Task 4 — the inventory store (plan §C). Quantities are decimal strings
// (parseQuantity-canonicalized by the service). A receipt is entered in the PO line's
// PURCHASE units — the service derives the base quantity via the frozen conversion; every
// other movement is entered in base units against a lot + store location. The service (and
// the database CHECKs behind it) require quality evidence on accept/reject and a reason on
// adjust/reverse.
const qtyString = z.string().trim().min(1);
export const recordReceiptSchema = z.object({
  poLineId: z.string().min(1),
  commitmentId: z.string().min(1),
  purchaseQty: qtyString, // in the PO line's purchase UOM
  storeLocation: z.string().trim().min(1).max(120).optional(), // default 'main'
  note: z.string().trim().min(1).max(1000).optional(),
}).strict();
export type RecordReceiptInput = z.infer<typeof recordReceiptSchema>;
const stockQualitySchema = z.object({
  lotId: z.string().min(1),
  storeLocation: z.string().trim().min(1).max(120).optional(),
  qty: qtyString, // base UOM
  evidenceMediaId: z.string().min(1), // quality evidence photo — required (§C)
  note: z.string().trim().min(1).max(1000).optional(),
});
export const acceptStockSchema = stockQualitySchema.extend({
  qualityResult: z.string().trim().min(1).max(300), // e.g. 'passed', 'passed-with-remarks'
}).strict();
export type AcceptStockInput = z.infer<typeof acceptStockSchema>;
export const rejectStockSchema = stockQualitySchema.extend({
  reason: z.string().trim().min(1).max(1000).optional(),
}).strict();
export type RejectStockInput = z.infer<typeof rejectStockSchema>;
export const vendorReturnSchema = z.object({
  lotId: z.string().min(1),
  storeLocation: z.string().trim().min(1).max(120).optional(),
  qty: qtyString,
  note: z.string().trim().min(1).max(1000).optional(),
}).strict();
export type VendorReturnInput = z.infer<typeof vendorReturnSchema>;
export const adjustStockSchema = z.object({
  lotId: z.string().min(1),
  storeLocation: z.string().trim().min(1).max(120).optional(),
  qty: qtyString,
  fromBucket: z.enum(['quarantine', 'acceptedOnHand', 'rejected']).optional(), // omit = write-on
  toBucket: z.enum(['quarantine', 'acceptedOnHand', 'rejected']).optional(), // omit = write-off
  reason: z.string().trim().min(1).max(1000), // audited, reasoned (§C)
}).strict();
export type AdjustStockInput = z.infer<typeof adjustStockSchema>;
export const reverseStockSchema = z.object({
  txId: z.string().min(1), // the ledger row to reverse, in full
  reason: z.string().trim().min(1).max(1000),
}).strict();
export type ReverseStockInput = z.infer<typeof reverseStockSchema>;

// ── Phase 3 Task 5 — store-to-site flows (plan §§C/E). Reservation/issue name an ACTIVITY;
// consumption/site-return/wastage name the ISSUE they are recorded against (§E — lot,
// location and activity derive from it); a transfer names the destination store location.
export const reserveStockSchema = z.object({
  lotId: z.string().min(1),
  storeLocation: z.string().trim().min(1).max(120).optional(), // default 'main'
  activityId: z.string().min(1),
  qty: qtyString, // base UOM
}).strict();
export type ReserveStockInput = z.infer<typeof reserveStockSchema>;
export const releaseReservationSchema = z.object({
  lotId: z.string().min(1),
  storeLocation: z.string().trim().min(1).max(120).optional(),
  activityId: z.string().min(1),
  qty: qtyString,
  note: z.string().trim().min(1).max(1000).optional(), // cancel / revise / no-longer-needed
}).strict();
export type ReleaseReservationInput = z.infer<typeof releaseReservationSchema>;
export const issueStockSchema = z.object({
  lotId: z.string().min(1),
  storeLocation: z.string().trim().min(1).max(120).optional(),
  activityId: z.string().min(1), // §C — an issue must reference activity + location
  qty: qtyString,
  note: z.string().trim().min(1).max(1000).optional(),
}).strict();
export type IssueStockInput = z.infer<typeof issueStockSchema>;
export const consumeStockSchema = z.object({
  issueId: z.string().min(1), // §E — recorded AGAINST the referenced issue
  qty: qtyString,
  note: z.string().trim().min(1).max(1000).optional(),
}).strict();
export type ConsumeStockInput = z.infer<typeof consumeStockSchema>;
export const siteReturnSchema = z.object({
  issueId: z.string().min(1),
  qty: qtyString,
  note: z.string().trim().min(1).max(1000).optional(),
}).strict();
export type SiteReturnInput = z.infer<typeof siteReturnSchema>;
export const wastageSchema = z.object({
  issueId: z.string().min(1),
  qty: qtyString,
  reason: z.string().trim().min(1).max(1000), // §C — wastage always explains itself
  evidenceMediaId: z.string().min(1), // §C — photographic evidence, thereafter delete-sealed
}).strict();
export type WastageInput = z.infer<typeof wastageSchema>;
export const transferStockSchema = z.object({
  lotId: z.string().min(1),
  storeLocation: z.string().trim().min(1).max(120).optional(), // SOURCE, default 'main'
  toStoreLocation: z.string().trim().min(1).max(120), // destination — must differ
  qty: qtyString,
  note: z.string().trim().min(1).max(1000).optional(),
}).strict();
export type TransferStockInput = z.infer<typeof transferStockSchema>;

// ── Phase 4 Task 2 — the LABOUR COMMERCIAL chain (plan §F). Mirrors the material procurement
// schemas but per person-shift, never a bare headcount: every requisition/PO line names one
// explicit `(requirementId, revision, civilDate)` demand slice with a positive integer
// `personShiftQty`; the slice's shift + fingerprint are DERIVED by the service from the
// Labour-owned `LabourRequirementSpec` (never caller-authored). Rates are per person-shift, INR
// paise-safe decimals. `VendorLabourProfile` is an ORG-ADMIN surface (org membership, like vendor
// CRUD); every other command is project-scoped, capability-gated (`labour`), pmc/engineer authority.
const personShiftQty = z.number().int().min(1).max(100000);
export const setVendorLabourProfileSchema = z.object({
  vendorId: z.string().min(1),
  trades: z.array(z.string().trim().min(1).max(120)).max(200).default([]),
  skills: z.array(z.string().trim().min(1).max(120)).max(200).default([]),
}).strict();
export type SetVendorLabourProfileInput = z.infer<typeof setVendorLabourProfileSchema>;

export const createLabourRequisitionSchema = z.object({
  title: z.string().trim().min(1).max(300),
  notes: z.string().trim().max(2000).optional(),
  lines: z.array(z.object({
    requirementId: z.string().min(1),
    revision: z.number().int().min(1),
    civilDate: z.string().trim().min(1), // ISO civil date — must name a demand slice of the revision
    personShiftQty, // integer person-shifts, > 0
  }).strict()).min(1).max(100),
}).strict();
export type CreateLabourRequisitionInput = z.infer<typeof createLabourRequisitionSchema>;
export const rejectLabourRequisitionSchema = z.object({ reason: z.string().trim().min(1).max(1000) }).strict();
export type RejectLabourRequisitionInput = z.infer<typeof rejectLabourRequisitionSchema>;

export const createLabourRfqSchema = z.object({ requisitionId: z.string().min(1) }).strict();
export type CreateLabourRfqInput = z.infer<typeof createLabourRfqSchema>;

export const recordLabourQuoteSchema = z.object({
  vendorId: z.string().min(1),
  validUntil: z.string().trim().min(1), // ISO civil date
  leadTimeDays: z.number().int().min(0).max(3650).optional(),
  notes: z.string().trim().max(1000).optional(),
  lines: z.array(z.object({
    requisitionLineId: z.string().min(1),
    ratePerPersonShift: money, // INR per person-shift
    shiftPremium: money, // INR shift premium per person-shift (0 when none)
    landedPerPersonShift: money, // the landed rate the comparison ranks by
    matchesSpecification: z.boolean(),
  }).strict()).min(1).max(100),
}).strict();
export type RecordLabourQuoteInput = z.infer<typeof recordLabourQuoteSchema>;

export const approveLabourComparisonSchema = z.object({
  selectedQuoteId: z.string().min(1),
  reason: z.string().trim().min(1).max(1000),
  justification: z.string().trim().min(1).max(2000).optional(),
}).strict();
export type ApproveLabourComparisonInput = z.infer<typeof approveLabourComparisonSchema>;

// A labour PO line orders a portion (≤ the requisition line's remaining, §F bound 2) of ONE
// requisition line's person-shifts; the slice identity + rate are frozen by the service from the
// requisition line + the comparison-approved quote, never authored by the caller.
const labourPoLineShape = z.object({
  requisitionLineId: z.string().min(1),
  personShiftQty, // person-shifts ordered on this line (≤ remaining per slice)
}).strict();
export const createLabourPoSchema = z.object({
  comparisonId: z.string().min(1),
  lines: z.array(labourPoLineShape).min(1).max(100),
}).strict();
export type CreateLabourPoInput = z.infer<typeof createLabourPoSchema>;
// Issuance carries no overage in Task 2 — the §F bound-3 approvedOverage is a Task-3 concern.
// Phase 5 Task 1 (§C) — the labour twin of the material cost-head input: a labour PO version
// becomes live at issue, so the head that carries it is named in the SAME command. Optional, so
// every existing labour caller is byte-for-byte unchanged off-pilot.
export const labourPoCostHeadShape = z.object({
  labourPoLineId: z.string().min(1),
  costHeadCode: z.string().trim().min(1).max(64),
}).strict();
// The labour twin of the amendment key (§0b — same rule, every site).
export const labourAmendCostHeadShape = z.object({
  requisitionLineId: z.string().min(1),
  costHeadCode: z.string().trim().min(1).max(64),
}).strict();
export const issueLabourPoSchema = z.object({
  costHeads: z.array(labourPoCostHeadShape).max(200).optional(),
}).strict();
export type IssueLabourPoInput = z.infer<typeof issueLabourPoSchema>;
export const amendLabourPoSchema = z.object({
  costHeads: z.array(labourAmendCostHeadShape).max(200).optional(),
  reason: z.string().trim().min(1).max(1000),
  lines: z.array(labourPoLineShape).min(1).max(100),
}).strict();
export type AmendLabourPoInput = z.infer<typeof amendLabourPoSchema>;
export const cancelLabourPoSchema = z.object({ reason: z.string().trim().min(1).max(1000) }).strict();
export type CancelLabourPoInput = z.infer<typeof cancelLabourPoSchema>;
export const closeShortLabourPoSchema = z.object({ reason: z.string().trim().min(1).max(1000) }).strict();
export type CloseShortLabourPoInput = z.infer<typeof closeShortLabourPoSchema>;

// A capacity commitment covers ONE issued PO line (its slice is copied from the line); the
// first dated promise carries no reason, each revision does (§F append-only register).
export const commitCapacitySchema = z.object({
  poLineId: z.string().min(1),
  promisedDate: z.string().trim().min(1), // ISO civil date
}).strict();
export type CommitCapacityInput = z.infer<typeof commitCapacitySchema>;
export const reviseCapacitySchema = z.object({
  promisedDate: z.string().trim().min(1),
  reason: z.string().trim().min(1).max(1000),
}).strict();
export type ReviseCapacityInput = z.infer<typeof reviseCapacitySchema>;

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
export type AllocateLabourInput = z.infer<typeof allocateLabourSchema>;

export const releaseLabourAllocationSchema = z.object({ reason: z.string().trim().min(1).max(1000) }).strict();
export type ReleaseLabourAllocationInput = z.infer<typeof releaseLabourAllocationSchema>;

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
export type RecordAttendanceInput = z.infer<typeof recordAttendanceSchema>;

export const revokeAttendanceSchema = z.object({ reason: z.string().trim().min(1).max(1000) }).strict();
export type RevokeAttendanceInput = z.infer<typeof revokeAttendanceSchema>;

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
export type RecordLabourWorkInput = z.infer<typeof recordLabourWorkSchema>;

// ── Phase 4 Task 5 — §E labour mismatch (observation + pmc-only resolution) + §I output ───────
/** Record a crew-vs-allocation mismatch OBSERVATION (§E): a present worker of the wrong trade
 *  names the worker; a shortfall names none. Append-only — a correction is a resolution, never
 *  an edit. */
export const recordLabourMismatchSchema = z
  .object({
    activityId: z.string().min(1),
    civilDate: isoCivilDateSchema,
    shift: z.enum(['day', 'night']),
    kind: z.enum(['wrong_trade', 'shortfall']),
    workerId: z.string().min(1).nullish(),
    note: z.string().trim().min(1).max(1000),
  })
  .strict()
  .refine((v) => v.kind !== 'wrong_trade' || Boolean(v.workerId), {
    message: 'a wrong_trade observation names the observed worker',
  })
  .refine((v) => v.kind !== 'shortfall' || !v.workerId, {
    message: 'a shortfall observation names no worker',
  });
export type RecordLabourMismatchInput = z.infer<typeof recordLabourMismatchSchema>;

/** Close exactly ONE mismatch observation with an append-only resolution register row (§E —
 *  pmc authority; the observation itself is never edited). */
export const resolveLabourMismatchSchema = z
  .object({
    resolution: z.string().trim().min(1).max(300),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();
export type ResolveLabourMismatchInput = z.infer<typeof resolveLabourMismatchSchema>;

/** Record the §I ACTIVITIES-owned measured-output fact: quantity + UOM (+ optional photo
 *  evidence), immutable. Quantity travels as a decimal string (the shared decimal rule). */
export const recordActivityOutputSchema = z
  .object({
    activityId: z.string().min(1),
    civilDate: isoCivilDateSchema,
    shift: z.enum(['day', 'night']),
    quantity: z.string().regex(/^\d{1,12}(\.\d{1,6})?$/, 'quantity must be a positive decimal'),
    uom: z.string().trim().min(1).max(32),
    evidenceMediaId: z.string().min(1).nullish(),
    note: z.string().trim().min(1).max(1000).nullish(),
  })
  .strict()
  .refine((v) => Number(v.quantity) > 0, { message: 'quantity must be > 0' });
export type RecordActivityOutputInput = z.infer<typeof recordActivityOutputSchema>;

/** Widen §B satisfaction for ONE requirement: work of the given trade/skill/shift may satisfy the
 *  requirement's CURRENT head identity. The server computes both fingerprints — `from` from the
 *  head spec, `to` from this technical triple — so neither is ever caller-authored. */
export const approveSkillSubstitutionSchema = z
  .object({
    requirementId: z.string().min(1),
    tradeCode: z.string().trim().min(1),
    skillCode: z.string().trim().min(1).nullish(),
    shift: z.enum(['day', 'night']),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();
export type ApproveSkillSubstitutionInput = z.infer<typeof approveSkillSubstitutionSchema>;

export const revokeSkillSubstitutionSchema = z.object({ reason: z.string().trim().min(1).max(1000) }).strict();
export type RevokeSkillSubstitutionInput = z.infer<typeof revokeSkillSubstitutionSchema>;

// Phase 4 Task 3 — bind an orgs-owned `WorkerDevice` to a trusted `Worker` (§H, F5). The
// structural FK landed in Task 1; this is the command the owning module exposes so a muster may
// cite the device as evidence. A device starts UNBOUND (anonymous QR/tap onboarding unchanged).
export const bindWorkerDeviceSchema = z.object({ workerId: z.string().min(1) }).strict();
export type BindWorkerDeviceInput = z.infer<typeof bindWorkerDeviceSchema>;

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
export type DefineCostHeadInput = z.infer<typeof defineCostHeadSchema>;

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
export type ReattributeInput = z.infer<typeof reattributeSchema>;

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
export type SetBudgetInput = z.infer<typeof setBudgetSchema>;

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
export type TakeMeasurementInput = z.infer<typeof takeMeasurementSchema>;

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
export type CorrectMeasurementInput = z.infer<typeof correctMeasurementSchema>;

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
export type RecordVendorBillInput = z.infer<typeof recordVendorBillSchema>;

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
export type AmendVendorBillInput = z.infer<typeof amendVendorBillSchema>;

/** §F — a JUDGEMENT about the claim (distinct from a dispute, which says its evidence moved). */
export const rejectVendorBillSchema = z
  .object({ billId: z.string().min(1), reason: z.string().trim().min(1).max(1000) })
  .strict();
export type RejectVendorBillInput = z.infer<typeof rejectVendorBillSchema>;

/** §F — a bare lifecycle step: submit the recorded claim, or open the §E check on it. */
export const vendorBillStepSchema = z.object({ billId: z.string().min(1) }).strict();
export type VendorBillStepInput = z.infer<typeof vendorBillStepSchema>;

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
export type CertifyBillInput = z.infer<typeof certifyBillSchema>;
/**
 * The SERVICE's shape, deliberately WEAKER than the HTTP one above.
 *
 * Codex round 6 — round 2 made the viewed version optional so in-process callers (121 call sites
 * across the Task-5 suites and operator paths, which hold no rendered version) would compile, and
 * that weakened the guard for the boundary too: a request omitting the field simply skipped the
 * drift check, which is the one place the check exists for. A replayed body is an HTTP body.
 *
 * The fix is to stop making one contract serve two callers with different threat models. The
 * BOUNDARY requires the pin, because that is where an unreviewed version can be posted or
 * replayed; the INTERNAL shape does not, because a caller inside the process has no rendered fact
 * to pin and is not attacker-reachable. Requiring it in both would have meant editing 121 call
 * sites to invent a version they never displayed — which is not evidence, it is ceremony.
 */
export type CertifyBillCommand = { billId: string; versionId?: string; lifecycleVersion?: number };

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
export type GrantSodExceptionInput = z.infer<typeof grantSodExceptionSchema>;
/** The SERVICE's shape — weaker than the boundary's, for the reason given on `CertifyBillCommand`. */
export type GrantSodExceptionCommand = {
  billId: string; actorId: string; reason: string;
  versionId?: string; status?: string; lifecycleVersion?: number;
  rule?: GrantSodExceptionInput['rule'];
};

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
export type SupersedeCertificateInput = z.infer<typeof supersedeCertificateSchema>;
/** The SERVICE's shape — weaker than the boundary's, for the reason given on `CertifyBillCommand`. */
export type SupersedeCertificateCommand = { billId: string; reason: string; certificateId?: string };

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
export type RecordDeductionInput = z.infer<typeof recordDeductionSchema>;

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
export type ReleaseDeductionInput = z.infer<typeof releaseDeductionSchema>;

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
export type ApprovePaymentInput = z.infer<typeof approvePaymentSchema>;
/** The SERVICE shape, deliberately weaker than the HTTP one — the boundary is where a posted or
 *  replayed body can carry a revision nobody read; an in-process caller has no rendered fact. */
export type ApprovePaymentCommand = Omit<ApprovePaymentInput, 'lifecycleVersion'> & { lifecycleVersion?: number };

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
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;

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
export type ReversePaymentInput = z.infer<typeof reversePaymentSchema>;

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
export type PayAdvanceInput = z.infer<typeof payAdvanceSchema>;
