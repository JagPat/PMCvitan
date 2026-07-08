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
export const issueDrawingSchema = z.object({
  number: z.string().min(1),
  title: z.string().min(1),
  discipline: z.enum(['architectural', 'structural', 'mep', 'other']),
  rev: z.string().min(1),
  status: z.enum(['for_review', 'for_construction']).default('for_construction'),
  mime: z.string().min(1),
  data: z.string().min(1),
  note: z.string().optional(),
  zone: z.string().optional(),
  activityId: z.string().optional(),
  decisionId: z.string().optional(),
});
export type IssueDrawingInput = z.infer<typeof issueDrawingSchema>;

// ── Orgs & multi-project (multi-tenant foundation) ───────────────────────────
export const createOrgSchema = z.object({ name: z.string().min(1) });
export type CreateOrgInput = z.infer<typeof createOrgSchema>;

export const createProjectSchema = z.object({
  name: z.string().min(1),
  short: z.string().min(1),
  descriptor: z.string().default(''),
  stage: z.string().default('Planning'),
  siteCode: z.string().default(''),
  projStart: z.string().default(''),
  projEnd: z.string().default(''),
});
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

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
