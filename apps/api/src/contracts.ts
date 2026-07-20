import { z } from 'zod';
import { parseCivilDate } from './common/civil-date';

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

/** One menu pick at Create Project: which module, how many, and (for a room-anchored
 *  module) which zone name to graft under — created if it doesn't exist yet. */
export const moduleSelectionSchema = z.object({
  moduleId: z.string().min(1),
  count: z.number().int().min(1).max(20).default(1),
  underZone: z.string().trim().min(1).optional(),
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
  name: z.string().min(1),
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

// ── Phase 3 Task 1 — the ActivityRequirement demand contract (plan §§B/F) ──────────────
// Quantities travel as DECIMAL STRINGS (never floats); the service canonicalizes via the
// shared parseQuantity and refuses anything that does not round-trip numeric(18,6).
const requirementSpecShape = {
  activityId: z.string().trim().min(1),
  materialCategory: z.string().trim().min(1),
  make: z.string().trim().min(1),
  grade: z.string().trim().min(1),
  attributes: z.string().trim().default(''),
  baseUom: z.string().trim().min(1),
  qty: z.string().trim().min(1),
  requiredBy: isoCivilDateSchema,
  // provenance is SERVER-resolved from the referenced decision's approval record (correction
  // finding 1): the caller may name a decision, never author its version or option
  decisionId: z.string().trim().min(1).nullish(),
  responsibleId: z.string().trim().min(1).nullish(),
  criticality: z.enum(['normal', 'critical']).default('normal'),
  tolerance: z.string().trim().min(1).nullish(),
};
export const createRequirementSchema = z.object(requirementSpecShape).strict();
export type CreateRequirementInput = z.infer<typeof createRequirementSchema>;
// a revision restates the full specification (append-only; CAS on the expected revision)
export const reviseRequirementSchema = z.object({ ...requirementSpecShape, expectedRevision: z.number().int().min(1) }).strict();
export type ReviseRequirementInput = z.infer<typeof reviseRequirementSchema>;
export const cancelRequirementSchema = z.object({ expectedRevision: z.number().int().min(1), reason: z.string().trim().min(1) }).strict();
export type CancelRequirementInput = z.infer<typeof cancelRequirementSchema>;

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
export const issuePoSchema = z.object({
  overages: z.array(poOverageShape).max(50).optional(),
}).strict();
export type IssuePoInput = z.infer<typeof issuePoSchema>;
export const amendPoSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
  lines: z.array(poLineShape).min(1).max(50),
  overages: z.array(poOverageShape).max(50).optional(),
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
