import { z } from 'zod';

export const sessionSchema = z.object({
  role: z.enum(['pmc', 'client', 'engineer', 'contractor']),
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
  rejectedItemNames: z.array(z.string()).default([]),
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
// A site photo upload. `data` is base64 (no data: URL prefix). Images only.
export const createMediaSchema = z.object({
  kind: z.enum(['progress', 'inspection', 'decision', 'attendance', 'material']),
  mime: z.string().regex(/^image\//, 'images only'),
  data: z.string().min(1),
  decisionId: z.string().optional(),
  dailyLogId: z.string().optional(),
  geoLat: z.number().optional(),
  geoLng: z.number().optional(),
  takenAt: z.string().optional(),
});
export type CreateMediaInput = z.infer<typeof createMediaSchema>;

// ── Phase 8: web push ────────────────────────────────────────────────────────
export const pushSubscribeSchema = z.object({
  subscription: z.object({
    endpoint: z.string().url(),
    keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
  }),
});
export type PushSubscribeInput = z.infer<typeof pushSubscribeSchema>;

// ── Drawings register (Slice 1) ──────────────────────────────────────────────
// Issue a drawing. If `number` already exists in the project a new revision is
// added and the prior ones are superseded; otherwise a new register entry is
// created. PDF/DWG/images accepted; DWG is a downloadable source (viewed as PDF).
export const issueDrawingSchema = z
  .object({
    number: z.string().min(1),
    title: z.string().min(1),
    discipline: z.enum(['architectural', 'structural', 'mep', 'other']),
    rev: z.string().min(1),
    status: z.enum(['for_review', 'for_construction']).default('for_construction'),
    mime: z.string().min(1),
    // one of: inline base64 body (dev stub / small files) OR a storageKey from a
    // completed presigned direct-to-bucket upload (Slice 3, large files).
    data: z.string().min(1).optional(),
    storageKey: z.string().min(1).optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    note: z.string().optional(),
    zone: z.string().optional(),
    activityId: z.string().optional(),
    decisionId: z.string().optional(),
  })
  .refine((v) => Boolean(v.data) !== Boolean(v.storageKey), {
    message: 'Provide exactly one of data (base64) or storageKey (presigned upload)',
  });
export type IssueDrawingInput = z.infer<typeof issueDrawingSchema>;

export const presignDrawingSchema = z.object({
  mime: z.string().min(1),
});
export type PresignDrawingInput = z.infer<typeof presignDrawingSchema>;

// ── Orgs & multi-project (multi-tenant foundation) ───────────────────────────
export const createOrgSchema = z.object({ name: z.string().min(1) });
export type CreateOrgInput = z.infer<typeof createOrgSchema>;

export const createProjectSchema = z.object({
  name: z.string().min(1),
  short: z.string().min(1),
  descriptor: z.string().default(''),
  stage: z.string().default('Planning'),
  siteCode: z.string().default(''),
  location: z.string().default(''),
  projStart: z.string().default(''),
  projEnd: z.string().default(''),
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
  room: z.string().trim().min(1),
  options: z.array(decisionOptionInput).min(2).max(4),
});
export type CreateDecisionInput = z.infer<typeof createDecisionSchema>;

// Planning & scheduling (PMC). Planned start/end are day-offsets on the schedule
// timeline (same unit the seeded schedule uses).
const gateState = z.enum(['ok', 'wait', 'fail', 'na']);
export const createActivitySchema = z
  .object({
    name: z.string().trim().min(1),
    zone: z.string().trim().default(''),
    plannedStart: z.number().int().min(0),
    plannedEnd: z.number().int().min(0),
    phaseId: z.string().optional(),
    decisionId: z.string().optional(),
    gateMaterial: gateState.default('na'),
    gateTeam: gateState.default('na'),
    gateInspection: gateState.default('na'),
  })
  .refine((v) => v.plannedEnd >= v.plannedStart, { message: 'plannedEnd must be on or after plannedStart' });
export type CreateActivityInput = z.infer<typeof createActivitySchema>;

export const updateActivitySchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    zone: z.string().trim().optional(),
    plannedStart: z.number().int().min(0).optional(),
    plannedEnd: z.number().int().min(0).optional(),
    // null clears the link / phase
    phaseId: z.string().nullable().optional(),
    decisionId: z.string().nullable().optional(),
    gateMaterial: gateState.optional(),
    gateTeam: gateState.optional(),
    gateInspection: gateState.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });
export type UpdateActivityInput = z.infer<typeof updateActivitySchema>;

export const createPhaseSchema = z.object({
  name: z.string().trim().min(1),
  plannedStart: z.number().int().min(0).default(0),
  plannedEnd: z.number().int().min(0).default(0),
});
export type CreatePhaseInput = z.infer<typeof createPhaseSchema>;

// Issue an inspection checklist (PMC) — the engineer fills it in the field.
export const createInspectionSchema = z.object({
  title: z.string().trim().min(1),
  zone: z.string().trim().min(1),
  items: z.array(z.string().trim().min(1)).min(1).max(20),
});
export type CreateInspectionInput = z.infer<typeof createInspectionSchema>;

// Daily-log authoring (engineer/PMC): add a material delivery to today's log.
export const addMaterialSchema = z.object({
  name: z.string().trim().min(1),
  qty: z.string().trim().min(1),
  zone: z.string().trim().default(''),
  decisionId: z.string().optional(),
  swatch: z.string().trim().default('tile'),
});
export type AddMaterialInput = z.infer<typeof addMaterialSchema>;

export const switchProjectSchema = z.object({ projectId: z.string().min(1) });
export type SwitchProjectInput = z.infer<typeof switchProjectSchema>;

const projectRole = z.enum(['pmc', 'client', 'engineer', 'contractor']);
export const addMemberSchema = z
  .object({
    name: z.string().min(1),
    role: projectRole,
    email: z.string().email().optional(),
    phone: z.string().min(6).optional(),
  })
  .refine((v) => v.email || v.phone, { message: 'email or phone required' });
export type AddMemberInput = z.infer<typeof addMemberSchema>;

export const updateMemberSchema = z.object({ role: projectRole });
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
