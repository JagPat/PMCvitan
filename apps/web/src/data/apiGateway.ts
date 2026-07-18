/**
 * apiGateway — the DataGateway implementation over the Phase-7 REST API.
 *
 * Activated only when `VITE_API_URL` is set; otherwise the app runs entirely
 * against the seeded local store (the current default, and what the live demo
 * uses). Every mutation returns a fresh project snapshot, which `hydrate()`
 * applies to the store — so the interconnected counts/gates recompute exactly
 * as they do locally.
 *
 * NOTE: this bridge compiles and is ready, but has not been exercised
 * end-to-end in CI (the sandbox has no Postgres). Validate it once the API is
 * deployed and `VITE_API_URL` points at it.
 */
import { deleteEvidence, getEvidence, markEvidenceFailed } from './evidenceStore';
import type {
  Activity,
  AppNotification,
  Checklist,
  DailyLog,
  Decision,
  Drawing,
  MembershipSummary,
  OrgMember,
  OrgRole,
  OrgSummary,
  Phase,
  PortfolioProject,
  ProjectCompany,
  CompanyKind,
  ProjectMember,
  ProjectNode,
  NodeKind,
  Photo,
  Material,
  PlacedInspection,
  Review,
  Role,
  DailyLogModuleResult,
  DrawingsModuleResult,
  InspectionsModuleResult,
} from '@vitan/shared';

export interface ApiSnapshot {
  project: {
    id: string;
    name: string;
    short: string;
    descriptor: string;
    /** Task 6: the schedule anchor + real window end (ISO civil dates) */
    scheduleStartDate?: string | null;
    scheduleEndDate?: string | null;
    timeZone?: string;
    stage: string;
    siteCode: string;
    location: string;
    projStart: string;
    projEnd: string;
    elapsedPct: number;
    todayDay: number;
    milestonePct: number;
  };
  decisions: Decision[];
  activities: Activity[];
  /** inspections placed on the tree — Site Map's "inspections here" (pmc/engineer only) */
  placedInspections: PlacedInspection[];
  checklist: Checklist | null;
  reviews: Review[];
  review: Review | null; // deprecated (first pending) — back-compat; use `reviews`
  reinspectionCreated: boolean;
  drawings: Drawing[];
  phases: Phase[];
  dailyLog: DailyLog | null;
  notifications: AppNotification[];
  companies: ProjectCompany[];
  nodes: ProjectNode[];
  /** site photos placed on the location tree — the reality layer for the Place view */
  photos: Photo[];
  /** all material deliveries across the project, with their place — the Site Map's "materials here" */
  materials: Material[];
}

/** Add a project team member (provisions the account when new). */
export interface AddMemberInput {
  name: string;
  role: Role;
  email?: string;
  phone?: string;
  /** for a consultant: the discipline they cover (architect / lighting / plumbing / …) */
  discipline?: string;
}

/** Add someone to an org's admin roster (owner/admin/member). */
export interface AddOrgMemberInput {
  name: string;
  role: OrgRole;
  email?: string;
  phone?: string;
}

/** Create a project under an org. */
export interface NewProjectInput {
  name: string;
  short: string;
  descriptor?: string;
  stage?: string;
  siteCode?: string;
  location?: string;
  projStart?: string;
  projEnd?: string;
  /** Task 6: the schedule anchor (ISO civil date; defaults to today in the project zone). */
  scheduleStartDate?: string;
  timeZone?: string;
  /** Templates Slice 1: start from another project's STRUCTURE (location tree as drafts,
   *  phases, planned activities, checklist definitions) instead of a blank slate. */
  structureFrom?: string;
  /** Templates Slice 2: compose the new project from org modules (unions with structureFrom). */
  modules?: ModuleSelection[];
  /** Templates Slice 3: start from a named preset (expands to its module selection). */
  templateId?: string;
}

/** A named org preset — an ordered module selection ("G+2 Residence"). */
export interface OrgProjectTemplate {
  id: string;
  name: string;
  description: string;
  version: number;
  items: ModuleSelection[];
  /** module names resolved for display, e.g. ["Ground Floor", "Kitchen ×2"] */
  moduleNames: string[];
}

/** An org-owned reusable structure module (Templates Slice 2) — the menu row shape. */
export interface OrgTemplateModule {
  id: string;
  name: string;
  category: string; // space | zone | element | discipline | schedule
  /** where its roots graft: null = top level (zones), 'zone' = rooms, 'room' = elements */
  anchorKind: string | null;
  version: number;
  description: string;
  counts: { nodes: number; phases: number; activities: number; inspections: number };
}

/** One menu pick at Create Project: which module, how many, where room modules graft. */
export interface ModuleSelection {
  moduleId: string;
  count?: number;
  underZone?: string;
}

/** Create a module: from a live project (a zone's subtree, or the whole project). */
export interface NewModuleInput {
  name: string;
  category: 'space' | 'zone' | 'element' | 'discipline' | 'schedule';
  description?: string;
  fromProject: string;
  fromNodeId?: string;
}

/** Create/update payload for a project company/consultant. */
export interface CompanyInput {
  name: string;
  kind: CompanyKind;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  notes?: string;
}

/** An archived project row (restore UI). */
export interface ArchivedProject {
  id: string;
  name: string;
  short: string;
  archivedAt: string;
}

/** Issue-decision payload (PMC): 2–4 options; photoUrl comes from a prior media upload.
 *  Location is either a tree node (`nodeId`, authoritative) or the free-text `room`. */
export interface NewDecisionInput {
  title: string;
  nodeId?: string;
  room?: string;
  options: { material: string; delta: number; swatch: string; photoUrl?: string; recommended?: boolean }[];
  /** default false → saved as a private draft; true → issued to the client in one step */
  publish?: boolean;
}

/** Create a location-tree node (PMC). */
export interface NewNodeInput {
  name: string;
  kind: NodeKind;
  parentId?: string | null;
  /** default true → live on the tree at once; false → a private draft only its author sees */
  publish?: boolean;
}

export type GateInput = 'ok' | 'wait' | 'fail' | 'na';

/** Plan/edit-activity payload (PMC). Planned start/end are timeline day-offsets. */
export interface NewActivityInput {
  name: string;
  zone?: string;
  plannedStart: number;
  plannedEnd: number;
  phaseId?: string | null;
  decisionId?: string | null;
  nodeId?: string | null; // location spine: where this work happens
  // material/team stay STORED site flags; the inspection + drawing gates are
  // DERIVED from explicit links (Task 6) — gateInspection left the contract
  gateMaterial?: GateInput;
  gateTeam?: GateInput;
}

/** A manual readiness exception (Task 6): pmc-only, reasoned, always expiring. */
export interface OverrideGateInput {
  gate: 'decision' | 'material' | 'team' | 'inspection' | 'drawing';
  state: GateInput;
  reason: string;
  evidenceMediaId?: string;
  expiresAt: string; // ISO instant, must be in the future
}

/** Issue a drawing revision (new register entry, or a new rev that supersedes). */
export interface IssueDrawingInput {
  number: string;
  title: string;
  discipline: 'architectural' | 'structural' | 'mep' | 'other';
  rev: string;
  status?: 'for_review' | 'for_construction';
  mime: string;
  data: string; // base64, no data: prefix
  note?: string;
  zone?: string;
  activityId?: string;
  decisionId?: string;
  nodeId?: string; // location spine: the place this drawing governs
  /** default false → saved as a private draft; true → issued to the build team in one step */
  publish?: boolean;
}

/** The FINAL, retryable issue POST body (Task 10 correction). Prepared ONCE from an
 *  {@link IssueDrawingInput}: the file's content digest is computed, and a large file is uploaded
 *  direct-to-bucket so the body carries `storageKey`+`sizeBytes` instead of inline `data`. A bounded
 *  same-key retry re-POSTs THIS exact body, so it never re-presigns a new key or re-uploads bytes. The
 *  `contentSha256` binds the command identity to the actual file content (not its length). */
export interface PreparedIssueBody extends Omit<IssueDrawingInput, 'data'> {
  data?: string; // inline path: the base64 bytes
  storageKey?: string; // presigned path: the bucket pointer (mutually exclusive with `data`)
  sizeBytes?: number; // presigned path: the uploaded byte length
  contentSha256: string; // lowercase hex SHA-256 of the original file bytes (always present)
}

/** Base64 payloads above this length (~3 MB file) are uploaded direct-to-bucket
 *  via a presigned PUT instead of through the API body (Slice 3). */
const PRESIGN_MIN_DATA_LEN = 4_000_000;

export const API_BASE: string | undefined = import.meta.env.VITE_API_URL;
export const PROJECT_ID = 'ambli';

/**
 * Passwordless dev auth (the "Viewing as" persona switcher + auto-connect).
 * SECURE BY DEFAULT on a real deployment: when an API is configured, dev auth is
 * off unless VITE_ALLOW_DEV_AUTH is exactly "true" — the persona switcher is
 * hidden and the shell is gated behind a real sign-in. Mirrors the API's
 * ALLOW_DEV_AUTH.
 *
 * With no API (`VITE_API_URL` unset) the app is the pure local demo — there's no
 * backend to authenticate against and local sign-in never mints a token, so dev
 * auth stays ON so the seeded demo (persona switch, any-4-digit OTP) keeps working.
 */
export const DEV_AUTH: boolean = import.meta.env.VITE_ALLOW_DEV_AUTH === 'true' || !API_BASE;

/**
 * Phase 2 Task 9 — the decisions read mode (capability-versioned XOR cutover). `'snapshot'` (the
 * DEFAULT) keeps decisions owned by the full-snapshot slice — old behaviour, unchanged. `'moduleQuery'`
 * flips ownership to the module-owned `GET …/decisions` read (served from the rebuildable projection):
 * the snapshot's decision slice is then IGNORED and the module fetch — carried under the SAME snapshot
 * scope lease — owns `s.decisions`. Additive: backend endpoints ship first, the old frontend still
 * works, and the flip is a config change once proven (mirrors the outbox legacy→outbox cutover).
 */
export function decisionsReadMode(): 'snapshot' | 'moduleQuery' {
  return import.meta.env.VITE_DECISIONS_READ === 'moduleQuery' ? 'moduleQuery' : 'snapshot';
}

/** Phase 2 Task 9 — the module-owned decisions read payload (projection-served, with live fallback). */
export interface ModuleDecisions {
  decisions: Decision[];
  source: 'projection' | 'live';
  generation: number | null;
}

/**
 * Phase 2 Task 10 — the daily-log read-ownership mode (XOR), mirroring `decisionsReadMode`. `'snapshot'`
 * (the DEFAULT) keeps the daily-log slice (log + crew + materials) owned by the full-snapshot slice —
 * old behaviour, unchanged. `'moduleQuery'` flips ownership to the module-owned `GET …/daily-log` read
 * (served from the rebuildable projection): the snapshot's daily-log slice is then IGNORED and the
 * module fetch — carried under the SAME snapshot scope lease — owns `s.dailyLog` (its media progress
 * PHOTOS are still composed from the snapshot, which owns media) and `s.materials`. Additive: the
 * endpoint ships first, the old frontend still works, and the flip is a config change once proven.
 */
export function dailyLogReadMode(): 'snapshot' | 'moduleQuery' {
  return import.meta.env.VITE_DAILYLOG_READ === 'moduleQuery' ? 'moduleQuery' : 'snapshot';
}

/** Phase 2 Task 10 — the module-owned daily-log read payload (projection-served, with live fallback).
 *  The COMPLETE HTTP result is defined ONCE in `@vitan/shared` ({@link DailyLogModuleResult}) and
 *  imported by BOTH the API's query service and this gateway, so the two cannot drift (finding 5). The
 *  `dailyLog` core is PHOTO-LESS (media, not daily-log, owns progress photos — the store composes them
 *  from the snapshot); its `swatch` fields are open strings on the wire, narrowed to `SwatchKey` at the
 *  store boundary. This name is retained as the gateway alias so existing consumers keep importing it. */
export type ModuleDailyLog = DailyLogModuleResult;

/**
 * Phase 2 Task 10 (Module 2 — Drawings) — the drawings read-ownership mode (XOR), mirroring
 * `decisionsReadMode`/`dailyLogReadMode`. `'snapshot'` (the DEFAULT) keeps the drawing register owned by
 * the full-snapshot slice — old behaviour, unchanged. `'moduleQuery'` flips ownership to the
 * module-owned `GET …/drawings` read (served from the rebuildable projection, live fallback): the
 * snapshot's drawings slice is then IGNORED and the module fetch — carried under the SAME snapshot scope
 * lease — owns `s.drawings`. The register is baked FOR THE CALLER (draft-author visibility + their
 * per-revision ack/recipient state + a fresh signed file URL), so the read is viewer-scoped by
 * construction. Additive: the endpoint ships first, the old frontend still works, and the flip is a
 * config change once proven.
 */
export function drawingsReadMode(): 'snapshot' | 'moduleQuery' {
  return import.meta.env.VITE_DRAWINGS_READ === 'moduleQuery' ? 'moduleQuery' : 'snapshot';
}

/** Phase 2 Task 10 — the module-owned drawings read payload (projection-served, live fallback). The
 *  COMPLETE HTTP result is defined ONCE in `@vitan/shared` ({@link DrawingsModuleResult}) and imported by
 *  BOTH the API's query service and this gateway, so the two cannot drift (finding 5). The register is
 *  baked per-viewer at read time (author-visible drafts, `ackedByMe`/`recipientOfCurrent`, a fresh
 *  time-limited signed `url`) — it can never be served from a cross-viewer cache. */
export type ModuleDrawings = DrawingsModuleResult;

/**
 * Phase 2 Task 10 (Module 3 — Inspections) — the inspections read-ownership mode (XOR), mirroring
 * `decisionsReadMode`/`drawingsReadMode`. `'snapshot'` (the DEFAULT) keeps the inspection slices
 * (checklist / reviews / review / reinspectionCreated / placedInspections) owned by the full-snapshot
 * slice — old behaviour, unchanged. `'moduleQuery'` flips ownership to the module-owned
 * `GET …/inspections` read (served from the rebuildable projection, live fallback): the snapshot's
 * inspection slices are then IGNORED and the module fetch — carried under the SAME snapshot scope lease —
 * owns them. The slices are baked FOR THE CALLER'S ROLE (the PMC-only review queue, pmc/engineer
 * placement) with fresh signed evidence paths, exactly as the snapshot slice, so the read is never an
 * RBAC bypass. Additive: the endpoint ships first, the old frontend still works, and the flip is a config
 * change once proven.
 */
export function inspectionsReadMode(): 'snapshot' | 'moduleQuery' {
  return import.meta.env.VITE_INSPECTIONS_READ === 'moduleQuery' ? 'moduleQuery' : 'snapshot';
}

/** Phase 2 Task 10 (Module 3) — the module-owned inspections read payload (projection-served, live
 *  fallback). The COMPLETE HTTP result is defined ONCE in `@vitan/shared` ({@link InspectionsModuleResult})
 *  and imported by BOTH the API's query service and this gateway, so the two cannot drift (finding 5). The
 *  slices are baked per-viewer/role at read time (the PMC-only review queue, each item's fresh signed
 *  evidence paths) — they can never be served from a cross-viewer cache. */
export type ModuleInspections = InspectionsModuleResult;

/** Phase 2 Task 9 — the project-shell summary (identity + enabled modules + projection counts). */
export interface ProjectShell {
  id: string;
  name: string;
  descriptor: string;
  stage: string;
  siteCode: string;
  org: { id: string; name: string } | null;
  enabledModules: string[];
  counts: { pendingDecisions: number; decisionsGeneration: number | null };
}

/** Result of a real sign-in (phone OTP / worker token / password). */
export interface AuthResult {
  token: string;
  role: Role;
  projectId: string;
  name?: string;
}

export interface UploadMediaInput {
  kind: 'progress' | 'inspection' | 'decision' | 'attendance' | 'material';
  mime: string;
  data: string; // base64, no data: prefix
  decisionId?: string;
  nodeId?: string; // location spine: the place this photo shows
  // Evidence linkage (Phase 1 Task 4): the inspection item this photo proves,
  // and the PROJECT-scoped idempotency key (same key ⇒ same photo, uploaded once).
  inspectionId?: string;
  inspectionItemId?: string;
  clientKey?: string;
  geoLat?: number;
  geoLng?: number;
  takenAt?: string;
}

/** Resolve a snapshot media URL: dev-stub rows are relative (/media/:id) → prefix the API base. */
export function resolveMediaUrl(url: string): string {
  if (url && url.startsWith('/') && API_BASE) return `${API_BASE}${url}`;
  return url;
}

/** Resolve a drawing revision URL: relative /drawings/rev/:id → prefix the API base;
 *  data: URLs (the local-demo sheets) and absolute bucket URLs pass through. */
export function resolveDrawingUrl(url: string): string {
  if (url && url.startsWith('/') && API_BASE) return `${API_BASE}${url}`;
  return url;
}

/** Lowercase-hex SHA-256 of a byte buffer via the Web Crypto SubtleCrypto API. Used to bind a drawing
 *  issue's command identity to the actual file CONTENT (Task 10 correction) — not merely its length. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class ApiGateway {
  /** the project this gateway is scoped to (evidence replay keys off it) */
  get project(): string {
    return this.projectId;
  }

  private token: string | null = null;
  private readonly base: string;
  private readonly projectId: string;

  constructor(base: string, projectId = PROJECT_ID) {
    this.base = base;
    this.projectId = projectId;
  }

  /** Obtain a scoped session token for the given role (passwordless dev auth). */
  async connect(role: Role): Promise<void> {
    const res = await fetch(`${this.base}/auth/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, projectId: this.projectId }),
    });
    if (!res.ok) throw new Error(`auth/session ${res.status}`);
    this.token = (await res.json()).token;
  }

  /** Adopt an already-issued token (from a real sign-in) for subsequent calls. */
  setToken(token: string): void {
    this.token = token;
  }

  /** POST to a public (no-auth) auth endpoint. */
  private pub<T>(path: string, body: unknown): Promise<T> {
    return this.req<T>(path, { method: 'POST', body: JSON.stringify(body) });
  }

  /** Email + password sign-in (PMC / client / contractor). */
  login(email: string, password: string): Promise<AuthResult> {
    return this.pub('/auth/login', { email, password });
  }
  /** Begin invite-only password enrollment/reset. The public response is generic. */
  passwordCredentialRequest(email: string): Promise<{ accepted: true; requestId: string }> {
    return this.pub('/auth/password/request', { email });
  }
  /** Prove email control. This returns no application session. */
  passwordCredentialVerify(requestId: string, code: string): Promise<{ setupToken: string; expiresInSeconds: number }> {
    return this.pub('/auth/password/verify', { requestId, code });
  }
  /** Commit the new password and receive the normal project-scoped session. */
  passwordCredentialComplete(setupToken: string, password: string): Promise<AuthResult> {
    return this.pub('/auth/password/complete', { setupToken, password });
  }
  /** Ask the server to send a phone OTP. `devCode` is present only in dev-stub mode. */
  requestOtp(phone: string): Promise<{ sent: boolean; live: boolean; devCode?: string }> {
    return this.pub('/auth/otp/request', { phone, projectId: this.projectId });
  }
  /** Verify a phone OTP; on success the server returns a role-scoped session token. */
  verifyOtp(phone: string, code: string): Promise<AuthResult> {
    return this.pub('/auth/otp/verify', { phone, code, projectId: this.projectId });
  }
  /** Mint a no-account worker device token (QR / tap-photo job card). */
  workerToken(name?: string, trade?: string): Promise<AuthResult> {
    return this.pub('/auth/worker/token', { projectId: this.projectId, name, trade });
  }
  /** Ask the server to email an OTP. `devCode` is present only with no SMTP. */
  emailOtpRequest(email: string): Promise<{ sent: boolean; live: boolean; devCode?: string }> {
    return this.pub('/auth/email/request', { email, projectId: this.projectId });
  }
  /** Verify an email OTP; on success the server returns a role-scoped session token. */
  emailOtpVerify(email: string, code: string): Promise<AuthResult> {
    return this.pub('/auth/email/verify', { email, code, projectId: this.projectId });
  }
  /** Exchange a Google ID token for a role-scoped session token. */
  googleSignIn(idToken: string): Promise<AuthResult> {
    return this.pub('/auth/google', { idToken, projectId: this.projectId });
  }

  /** The project this gateway is scoped to. */
  get activeProject(): string {
    return this.projectId;
  }

  // ── orgs / projects / team (multi-tenant) ──
  /** Projects the signed-in user can access (drives the project switcher). */
  listMemberships(): Promise<MembershipSummary[]> {
    return this.req('/me/memberships');
  }
  /** Orgs the user administers/belongs to. */
  myOrgs(): Promise<OrgSummary[]> {
    return this.req('/me/orgs');
  }
  /** Cross-project monitoring rollup (one row per project the user can access). */
  getPortfolio(): Promise<PortfolioProject[]> {
    return this.req('/me/portfolio');
  }
  /** Re-scope the session to another project; returns a fresh token. */
  switchProject(projectId: string): Promise<AuthResult> {
    return this.req('/auth/switch', { method: 'POST', body: JSON.stringify({ projectId }) });
  }
  /** Create a project under an org (owner/admin); the creator becomes its PMC. */
  createProject(orgId: string, input: NewProjectInput): Promise<{ id: string; name: string; short: string }> {
    return this.req(`/orgs/${orgId}/projects`, { method: 'POST', body: JSON.stringify(input) });
  }
  /** Edit a project's details (project PMC or org owner/admin); only provided fields change. */
  updateProject(orgId: string, projectId: string, input: Partial<NewProjectInput>): Promise<{ id: string; name: string; short: string }> {
    return this.req(`/orgs/${orgId}/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify(input) });
  }
  /** Archive (soft-delete) a project — hides it everywhere; reversible via restore (owner/admin). */
  deleteProject(orgId: string, projectId: string): Promise<{ ok: boolean }> {
    return this.req(`/orgs/${orgId}/projects/${projectId}`, { method: 'DELETE' });
  }
  /** Restore a previously archived project (owner/admin). */
  restoreProject(orgId: string, projectId: string): Promise<{ ok: boolean }> {
    return this.req(`/orgs/${orgId}/projects/${projectId}/restore`, { method: 'POST' });
  }
  /** Archived (soft-deleted) projects in an org — owner/admin only, for the restore UI. */
  listArchivedProjects(orgId: string): Promise<ArchivedProject[]> {
    return this.req(`/orgs/${orgId}/projects/archived`);
  }
  /** The org's reusable structure modules — the template menu (Templates Slice 2). */
  listModules(orgId: string): Promise<OrgTemplateModule[]> {
    return this.req(`/orgs/${orgId}/modules`);
  }
  /** Save a module from a live project — a zone's subtree, or the whole project (owner/admin). */
  createModule(orgId: string, input: NewModuleInput): Promise<OrgTemplateModule> {
    return this.req(`/orgs/${orgId}/modules`, { method: 'POST', body: JSON.stringify(input) });
  }
  /** Archive a module — removes it from the menu; existing projects untouched (owner/admin). */
  archiveModule(orgId: string, moduleId: string): Promise<{ ok: boolean }> {
    return this.req(`/orgs/${orgId}/modules/${moduleId}`, { method: 'DELETE' });
  }
  /** The org's named presets — module selections ready to start a project from (Slice 3). */
  listTemplates(orgId: string): Promise<OrgProjectTemplate[]> {
    return this.req(`/orgs/${orgId}/templates`);
  }
  /** Create a preset — explicit module items, or a whole project's structure (owner/admin). */
  createTemplate(orgId: string, input: { name: string; description?: string; items?: ModuleSelection[]; fromProject?: string }): Promise<OrgProjectTemplate> {
    return this.req(`/orgs/${orgId}/templates`, { method: 'POST', body: JSON.stringify(input) });
  }
  /** Archive a preset — leaves the picker; modules and existing projects untouched (owner/admin). */
  archiveTemplate(orgId: string, templateId: string): Promise<{ ok: boolean }> {
    return this.req(`/orgs/${orgId}/templates/${templateId}`, { method: 'DELETE' });
  }
  /** The org's admin roster (owner/admin only). */
  listOrgMembers(orgId: string): Promise<OrgMember[]> {
    return this.req(`/orgs/${orgId}/members`);
  }
  /** Add someone to the org's admin roster — owner/admin/member (org owner only). */
  addOrgMember(orgId: string, input: AddOrgMemberInput): Promise<OrgMember> {
    return this.req(`/orgs/${orgId}/members`, { method: 'POST', body: JSON.stringify(input) });
  }
  /** Change an org member's role (org owner only). */
  updateOrgMemberRole(orgId: string, userId: string, role: OrgRole): Promise<OrgMember> {
    return this.req(`/orgs/${orgId}/members/${userId}`, { method: 'PATCH', body: JSON.stringify({ role }) });
  }
  /** Correct an invitation email before the member establishes a password. */
  correctInvitationEmail(orgId: string, userId: string, email: string): Promise<OrgMember> {
    return this.req(`/orgs/${orgId}/members/${userId}/invitation-email`, { method: 'PATCH', body: JSON.stringify({ email }) });
  }
  /** Revoke someone's org membership (org owner only). */
  removeOrgMember(orgId: string, userId: string): Promise<{ ok: boolean }> {
    return this.req(`/orgs/${orgId}/members/${userId}`, { method: 'DELETE' });
  }

  /** List the active project's team. */
  listMembers(): Promise<ProjectMember[]> {
    return this.req(`/projects/${this.projectId}/members`);
  }
  /** Add a member to the active project (provisions the account if new). */
  addMember(input: AddMemberInput): Promise<ProjectMember> {
    return this.req(`/projects/${this.projectId}/members`, { method: 'POST', body: JSON.stringify(input) });
  }
  /** Change a member's role (and, for a consultant, their discipline). */
  updateMemberRole(userId: string, role: Role, discipline?: string): Promise<ProjectMember> {
    return this.req(`/projects/${this.projectId}/members/${userId}`, { method: 'PATCH', body: JSON.stringify({ role, ...(discipline ? { discipline } : {}) }) });
  }
  /** Remove a member from the active project (soft delete). */
  removeMember(userId: string): Promise<{ ok: boolean }> {
    return this.req(`/projects/${this.projectId}/members/${userId}`, { method: 'DELETE' });
  }

  /** Add a company/consultant to the active project. */
  addCompany(input: CompanyInput): Promise<ProjectCompany> {
    return this.req(`/projects/${this.projectId}/companies`, { method: 'POST', body: JSON.stringify(input) });
  }
  /** Edit a company/consultant (only provided fields change). */
  updateCompany(companyId: string, input: Partial<CompanyInput>): Promise<ProjectCompany> {
    return this.req(`/projects/${this.projectId}/companies/${companyId}`, { method: 'PATCH', body: JSON.stringify(input) });
  }
  /** Remove a company/consultant. */
  removeCompany(companyId: string): Promise<{ ok: boolean }> {
    return this.req(`/projects/${this.projectId}/companies/${companyId}`, { method: 'DELETE' });
  }

  /** Create a decision (PMC). Defaults to a private draft; pass `publish: true` to issue it. */
  createDecision(input: NewDecisionInput, idempotencyKey?: string): Promise<ApiSnapshot> {
    return this.p('/decisions', input, idempotencyKey);
  }
  /** Publish a private draft decision (PMC) → issue it to the client. */
  publishDecision(decisionId: string, idempotencyKey?: string): Promise<ApiSnapshot> {
    return this.p(`/decisions/${decisionId}/publish`, {}, idempotencyKey);
  }
  /** Create a location node (zone/room/element) — PMC. Returns a node-carrying snapshot. */
  createNode(input: NewNodeInput): Promise<ApiSnapshot> {
    return this.p('/nodes', input);
  }
  /** Publish a private draft node (PMC) — reveals it (and its draft branch) to everyone. */
  publishNode(nodeId: string): Promise<ApiSnapshot> {
    return this.p(`/nodes/${nodeId}/publish`, {});
  }
  /** Rename a location node (PMC). */
  renameNode(nodeId: string, name: string): Promise<ApiSnapshot> {
    return this.req(`/projects/${this.projectId}/nodes/${nodeId}`, { method: 'PATCH', body: JSON.stringify({ name }) });
  }
  /** Reparent/reorder a location node (PMC). */
  moveNode(nodeId: string, parentId: string | null, order?: number): Promise<ApiSnapshot> {
    return this.p(`/nodes/${nodeId}/move`, { parentId, order });
  }
  /** Delete a location node (PMC) — refused server-side if decisions are attached. */
  deleteNode(nodeId: string): Promise<ApiSnapshot> {
    return this.req(`/projects/${this.projectId}/nodes/${nodeId}`, { method: 'DELETE' });
  }
  /** Plan a new schedule activity (PMC). */
  createActivity(input: NewActivityInput): Promise<ApiSnapshot> {
    return this.p('/activities', input);
  }
  /** Edit a planned activity (PMC) — only provided fields change. */
  updateActivity(activityId: string, input: Partial<NewActivityInput>): Promise<ApiSnapshot> {
    return this.req(`/projects/${this.projectId}/activities/${activityId}`, { method: 'PATCH', body: JSON.stringify(input) });
  }
  /** Remove a planned activity (PMC). */
  deleteActivity(activityId: string): Promise<ApiSnapshot> {
    return this.req(`/projects/${this.projectId}/activities/${activityId}`, { method: 'DELETE' });
  }
  /** Record a manual readiness exception on one gate (PMC, Task 6). */
  overrideGate(activityId: string, input: OverrideGateInput): Promise<ApiSnapshot> {
    return this.p(`/activities/${activityId}/override`, input);
  }
  /** Revoke an override early (PMC) — the derivation rules again. */
  revokeOverride(activityId: string, overrideId: string): Promise<ApiSnapshot> {
    return this.req(`/projects/${this.projectId}/activities/${activityId}/override/${overrideId}`, { method: 'DELETE' });
  }
  /** Add a schedule phase (PMC). */
  createPhase(input: { name: string; plannedStart?: number; plannedEnd?: number }): Promise<ApiSnapshot> {
    return this.p('/phases', input);
  }
  /** Remove a phase (PMC) — its activities become unphased. */
  deletePhase(phaseId: string): Promise<ApiSnapshot> {
    return this.req(`/projects/${this.projectId}/phases/${phaseId}`, { method: 'DELETE' });
  }
  /** Issue a stage checklist (PMC) — becomes the engineer's current field checklist. */
  createInspection(input: { title: string; zone: string; items: string[]; nodeId?: string }): Promise<ApiSnapshot> {
    return this.p('/inspections', input);
  }
  /** Start a fresh day's daily log (engineer/PMC). Keyed for replay-safety (Task 10 correction). */
  startDailyLog(idempotencyKey?: string): Promise<ApiSnapshot> {
    return this.p('/daily-log/start', undefined, idempotencyKey);
  }
  /** Record a material delivery on the open daily log (engineer/PMC). Keyed for replay-safety. */
  addSiteMaterial(input: AddSiteMaterialInput, idempotencyKey?: string): Promise<ApiSnapshot> {
    return this.p('/daily-log/materials', input, idempotencyKey);
  }

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      // Surface the HTTP status so callers can react (e.g. 429 throttle vs 503 send-failure).
      const err = new Error(`${path} ${res.status}`) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    return res.json() as Promise<T>;
  }

  /** POST to a project-scoped route. An optional `idempotencyKey` becomes the `Idempotency-Key`
   *  header (Phase 2 Task 5): the server reserves→executes→receipts under it, so a network retry
   *  or offline replay of the SAME key applies the effect exactly once and returns the same result. */
  private p(path: string, body?: unknown, idempotencyKey?: string): Promise<ApiSnapshot> {
    return this.req<ApiSnapshot>(`/projects/${this.projectId}${path}`, {
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
      ...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
    });
  }

  snapshot(): Promise<ApiSnapshot> {
    return this.req<ApiSnapshot>(`/projects/${this.projectId}/snapshot`);
  }

  /** Phase 2 Task 9 — the MODULE-OWNED decisions read (projection-served, role-filtered). Fetched
   *  under the snapshot's scope lease when `DECISIONS_READ_MODE === 'moduleQuery'` (XOR read-ownership). */
  decisions(): Promise<ModuleDecisions> {
    return this.req<ModuleDecisions>(`/projects/${this.projectId}/decisions`);
  }

  /** Phase 2 Task 10 — the MODULE-OWNED daily-log read (projection-served, live fallback). Fetched
   *  under the snapshot's scope lease when `DAILYLOG_READ_MODE === 'moduleQuery'` (XOR read-ownership). */
  dailyLog(): Promise<ModuleDailyLog> {
    return this.req<ModuleDailyLog>(`/projects/${this.projectId}/daily-log`);
  }

  /** Phase 2 Task 10 (Module 2 — Drawings) — the MODULE-OWNED drawings read (projection-served, live
   *  fallback, baked per-viewer). Fetched under the snapshot's scope lease when
   *  `DRAWINGS_READ_MODE === 'moduleQuery'` (XOR read-ownership). */
  drawings(): Promise<ModuleDrawings> {
    return this.req<ModuleDrawings>(`/projects/${this.projectId}/drawings`);
  }

  /** Phase 2 Task 10 (Module 3 — Inspections) — the MODULE-OWNED inspections read (projection-served,
   *  live fallback, baked per-viewer/role). Fetched under the snapshot's scope lease when
   *  `INSPECTIONS_READ_MODE === 'moduleQuery'` (XOR read-ownership). */
  inspections(): Promise<ModuleInspections> {
    return this.req<ModuleInspections>(`/projects/${this.projectId}/inspections`);
  }

  /** Phase 2 Task 9 — the project-shell summary (identity + enabledModules + projection counts). */
  shell(): Promise<ProjectShell> {
    return this.req<ProjectShell>(`/projects/${this.projectId}/shell`);
  }

  approveDecision(decisionId: string, optionIndex: number, idempotencyKey?: string): Promise<ApiSnapshot> {
    return this.p(`/decisions/${decisionId}/approve`, { optionIndex }, idempotencyKey);
  }
  requestChange(decisionId: string, reason: string, costImpact: number, timeImpactDays: number, idempotencyKey?: string): Promise<ApiSnapshot> {
    return this.p(`/decisions/${decisionId}/change`, { reason, costImpact, timeImpactDays }, idempotencyKey);
  }
  /** Withdraw the open change request — the decision re-locks (requester or PMC only). */
  withdrawChange(decisionId: string, idempotencyKey?: string): Promise<ApiSnapshot> {
    return this.p(`/decisions/${decisionId}/change/withdraw`, undefined, idempotencyKey);
  }
  startActivity(activityId: string): Promise<ApiSnapshot> {
    return this.p(`/activities/${activityId}/start`);
  }
  completeActivity(activityId: string): Promise<ApiSnapshot> {
    return this.p(`/activities/${activityId}/complete`);
  }
  flagMismatch(decisionId: string, idempotencyKey?: string): Promise<ApiSnapshot> {
    return this.p(`/daily-log/flag-mismatch`, { decisionId }, idempotencyKey);
  }
  submitInspection(inspectionId: string, items: Checklist['items']): Promise<ApiSnapshot> {
    return this.p(`/inspections/${inspectionId}/submit`, { items });
  }
  decideReview(inspectionId: string, approve: boolean, rejectedItemIds: string[]): Promise<ApiSnapshot> {
    return this.p(`/inspections/${inspectionId}/decide`, { approve, rejectedItemIds });
  }
  submitDailyLog(log: Pick<DailyLog, 'checkedIn' | 'checkinTime' | 'progress' | 'crew'>, idempotencyKey?: string): Promise<ApiSnapshot> {
    return this.p(`/daily-log/submit`, log, idempotencyKey);
  }

  /** Upload a site photo; returns its id + resolvable URL. */
  uploadMedia(input: UploadMediaInput): Promise<{ id: string; url: string }> {
    return this.req<{ id: string; url: string }>(`/projects/${this.projectId}/media`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  /** Re-file a photo onto a location-tree node (null = unfile). Returns the fresh snapshot. */
  setMediaNode(mediaId: string, nodeId: string | null): Promise<ApiSnapshot> {
    return this.req<ApiSnapshot>(`/projects/${this.projectId}/media/${mediaId}/node`, {
      method: 'PATCH',
      body: JSON.stringify({ nodeId }),
    });
  }

  /** Re-file a drawing onto a location-tree node (null = unfile). Returns the fresh snapshot.
   *  An optional `idempotencyKey` becomes the `Idempotency-Key` header (Phase 2 Task 5): a network
   *  retry or offline replay under the SAME key re-files exactly once. */
  setDrawingNode(drawingId: string, nodeId: string | null, idempotencyKey?: string): Promise<ApiSnapshot> {
    return this.req<ApiSnapshot>(`/projects/${this.projectId}/drawings/${drawingId}/node`, {
      method: 'PATCH',
      body: JSON.stringify({ nodeId }),
      ...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
    });
  }

  /**
   * Issue a drawing revision. A large file is uploaded direct-to-bucket via a
   * presigned PUT (bypassing the API body limit) when the server offers one;
   * otherwise the base64 body is posted (dev stub / small files). The snapshot
   * then reconciles via the realtime `changed`.
   */
  /**
   * PHASE 1 of an issue (Task 10 correction — prepare ONCE). Decode the file, compute its content
   * digest, and — for a large file — upload the bytes direct-to-bucket via a presigned PUT. Returns the
   * FINAL, retryable POST body: `{storageKey,sizeBytes,contentSha256}` (presigned) or `{data,
   * contentSha256}` (inline, when small or presign unavailable). The caller runs this once, then retries
   * only PHASE 2 with the same body + same key — so a lost-response retry never re-presigns a new key or
   * re-uploads the bytes, and the content digest binds the command identity to the actual file content.
   */
  async prepareIssue(input: IssueDrawingInput): Promise<PreparedIssueBody> {
    const bytes = Uint8Array.from(atob(input.data), (c) => c.charCodeAt(0));
    const contentSha256 = await sha256Hex(bytes);
    if (input.data.length >= PRESIGN_MIN_DATA_LEN) {
      const presigned = await this.presignDrawing(input.mime).catch(() => null);
      if (presigned && 'uploadUrl' in presigned) {
        const put = await fetch(presigned.uploadUrl, { method: 'PUT', headers: { 'Content-Type': input.mime }, body: bytes });
        if (put.ok) {
          const { data: _drop, ...meta } = input;
          return { ...meta, storageKey: presigned.storageKey, sizeBytes: bytes.length, contentSha256 };
        }
        // presigned PUT failed → fall back to the inline body path (the digest is already computed)
      }
    }
    return { ...input, contentSha256 };
  }

  /**
   * PHASE 2 of an issue (Task 10 correction — the retryable register-write). POSTs the prepared body
   * under the stable `Idempotency-Key`. Safe to retry: the command-ledger replays the ONE success for a
   * repeated key, so a lost/uncertain response is recovered by re-calling this with the SAME prepared
   * body + SAME key — never a duplicate revision.
   */
  submitIssue(prepared: PreparedIssueBody, idempotencyKey: string): Promise<{ drawingId: string; revisionId: string }> {
    return this.req<{ drawingId: string; revisionId: string }>(`/projects/${this.projectId}/drawings`, {
      method: 'POST',
      body: JSON.stringify(prepared),
      headers: { 'Idempotency-Key': idempotencyKey },
    });
  }

  /** Publish a private draft drawing (PMC) → issue it to the build team.
   *  An optional `idempotencyKey` becomes the `Idempotency-Key` header (publishes exactly once). */
  publishDrawing(drawingId: string, idempotencyKey?: string): Promise<ApiSnapshot> {
    return this.p(`/drawings/${drawingId}/publish`, {}, idempotencyKey);
  }

  /** Request a presigned direct-to-bucket upload target for a drawing (S3 mode). */
  presignDrawing(mime: string): Promise<{ uploadUrl: string; storageKey: string } | { presign: null }> {
    return this.req(`/projects/${this.projectId}/drawings/presign`, { method: 'POST', body: JSON.stringify({ mime }) });
  }

  /** Acknowledge building to a drawing revision ("building to Rev C"). An optional `idempotencyKey`
   *  becomes the `Idempotency-Key` header (Phase 2 Task 5): a lost-response retry or offline replay
   *  under the SAME key records the acknowledgement exactly once (actor-scoped) and replays the count. */
  acknowledgeDrawing(revisionId: string, idempotencyKey?: string): Promise<{ ok: boolean; ackCount: number }> {
    return this.req<{ ok: boolean; ackCount: number }>(`/projects/${this.projectId}/drawings/rev/${revisionId}/ack`, {
      method: 'POST',
      ...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
    });
  }

  /** The server's VAPID public key (empty string ⇒ web push disabled server-side). */
  pushPublicKey(): Promise<{ key: string }> {
    return this.req<{ key: string }>(`/push/public-key`);
  }
  /** Register a browser push subscription for this project. */
  pushSubscribe(subscription: unknown): Promise<{ ok: boolean }> {
    return this.req<{ ok: boolean }>(`/projects/${this.projectId}/push/subscribe`, {
      method: 'POST',
      body: JSON.stringify({ subscription }),
    });
  }
}

/**
 * A mutation captured while offline, replayed through the gateway on reconnect
 * (Phase 8 offline write outbox). Each variant maps 1:1 to a gateway method.
 */
/** A stable client idempotency key (Phase 2 Task 5). Generated ONCE when a command is initiated
 *  and carried on its outbox op, so the immediate online send AND any later offline replay reach
 *  the server under the SAME key — the command-ledger then applies the effect exactly once. */
export function newIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** The validated body of `daily-log.addMaterial` (the gateway + the write-ahead outbox op share it). */
export interface AddSiteMaterialInput {
  name: string;
  qty: string;
  zone?: string;
  decisionId?: string;
  swatch?: string;
  nodeId?: string;
}

export type OutboxOp =
  // the decision-pillar ops carry a stable idempotencyKey (Phase 2 Task 5): a queued op replayed
  // on reconnect reaches the server under the SAME key it was first sent with, so a lost-response
  // retry never double-applies.
  | { t: 'approve'; decisionId: string; optionIndex: number; idempotencyKey: string }
  | { t: 'change'; decisionId: string; reason: string; costImpact: number; timeImpactDays: number; idempotencyKey: string }
  | { t: 'changeWithdraw'; decisionId: string; idempotencyKey: string }
  // the drawing acknowledgement carries a stable idempotencyKey (Phase 2 Task 10): a queued ack
  // replayed on reconnect reaches the server under the SAME key it was first sent with, so a
  // lost-response retry records the acknowledgement exactly once (actor-scoped).
  | { t: 'ackDrawing'; revisionId: string; idempotencyKey: string }
  // the small drawing commands (publish, re-file/unfile) are WRITE-AHEAD to the durable outbox with a
  // stable key (Task 10 correction): a lost/uncertain response replays the SAME op under the SAME key,
  // so the command-ledger applies it exactly once and the reconcile snapshot restores truth.
  | { t: 'publishDrawing'; drawingId: string; idempotencyKey: string }
  | { t: 'setDrawingNode'; drawingId: string; nodeId: string | null; idempotencyKey: string }
  | { t: 'submitInspection'; inspectionId: string; items: Checklist['items'] }
  | { t: 'decideReview'; inspectionId: string; approve: boolean; rejectedItemIds: string[] }
  | { t: 'startActivity'; activityId: string }
  | { t: 'completeActivity'; activityId: string }
  // ALL FOUR daily-log commands carry a stable idempotencyKey and are WRITE-AHEAD to the durable
  // outbox before the first network request — online OR offline (Task 10 correction round 2, finding
  // 1). A lost/uncertain online response leaves the op (and its key) persisted, so a retry or a reload
  // replays the SAME op under the SAME key and the command-ledger applies it exactly once.
  | { t: 'startDailyLog'; idempotencyKey: string }
  | { t: 'addSiteMaterial'; input: AddSiteMaterialInput; idempotencyKey: string }
  | { t: 'flagMismatch'; decisionId: string; idempotencyKey: string }
  | { t: 'submitDailyLog'; log: Pick<DailyLog, 'checkedIn' | 'checkinTime' | 'progress' | 'crew'>; idempotencyKey: string }
  | { t: 'uploadMedia'; input: UploadMediaInput }
  // Task 4 evidence: metadata + clientKey ONLY — the bytes live in the durable
  // IndexedDB evidenceStore under (scope, projectId, clientKey) until confirmed.
  | { t: 'uploadEvidence'; scope: string; clientKey: string };

/**
 * Classify an outbox replay failure. A *terminal* failure is one the server will keep
 * rejecting however many times we retry — a business-rule 4xx (bad request, forbidden,
 * not found, conflict, unprocessable, …). Such an op must be DROPPED from the outbox, or
 * it poisons the queue: every reconnect re-runs it and re-runs every op behind it,
 * duplicating the server writes that already succeeded.
 *
 * Everything else is transient and the op is kept for a later retry: a network error
 * (no `status`), auth (401 — recoverable by re-signing-in), request timeout (408),
 * rate limiting (429), and any 5xx.
 */
export function isTerminalOutboxError(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  if (typeof status !== 'number') return false; // network / unknown → transient, retry later
  if (status === 401 || status === 408 || status === 429) return false; // recoverable
  return status >= 400 && status < 500; // other 4xx → permanent client error, drop it
}

/** Replay one queued mutation; resolves to the fresh snapshot. */
export function replayOutboxOp(gw: ApiGateway, op: OutboxOp): Promise<ApiSnapshot> {
  switch (op.t) {
    case 'approve':
      return gw.approveDecision(op.decisionId, op.optionIndex, op.idempotencyKey);
    case 'change':
      return gw.requestChange(op.decisionId, op.reason, op.costImpact, op.timeImpactDays, op.idempotencyKey);
    case 'changeWithdraw':
      return gw.withdrawChange(op.decisionId, op.idempotencyKey);
    case 'ackDrawing':
      // the server ack is idempotent under the command-ledger (same key ⇒ recorded once,
      // actor-scoped); it returns {ok,ackCount}, so refetch to reconcile the register
      return gw.acknowledgeDrawing(op.revisionId, op.idempotencyKey).then(() => gw.snapshot());
    case 'publishDrawing':
      // the publish returns the fresh snapshot directly (same key ⇒ published exactly once)
      return gw.publishDrawing(op.drawingId, op.idempotencyKey);
    case 'setDrawingNode':
      // the re-file/unfile returns the fresh snapshot directly (same key ⇒ re-filed exactly once)
      return gw.setDrawingNode(op.drawingId, op.nodeId, op.idempotencyKey);
    case 'submitInspection':
      return gw.submitInspection(op.inspectionId, op.items);
    case 'decideReview':
      return gw.decideReview(op.inspectionId, op.approve, op.rejectedItemIds);
    case 'startActivity':
      return gw.startActivity(op.activityId);
    case 'completeActivity':
      return gw.completeActivity(op.activityId);
    case 'startDailyLog':
      return gw.startDailyLog(op.idempotencyKey);
    case 'addSiteMaterial':
      return gw.addSiteMaterial(op.input, op.idempotencyKey);
    case 'flagMismatch':
      return gw.flagMismatch(op.decisionId, op.idempotencyKey);
    case 'submitDailyLog':
      return gw.submitDailyLog(op.log, op.idempotencyKey);
    case 'uploadMedia':
      // uploadMedia returns {id,url}, not a snapshot — refetch so the flush
      // reconciles dailyLog.photos (the real, server-stored photo replaces the
      // optimistic local data-URL one).
      return gw.uploadMedia(op.input).then(() => gw.snapshot());
    case 'uploadEvidence': {
      // Task 4 durability lifecycle: bytes come from the IndexedDB evidenceStore;
      // they are deleted ONLY on confirmed server persistence (the 2xx — the server
      // dedupes per (projectId, clientKey), so a replayed 2xx is the same proof).
      // A terminal 4xx flags the entry FAILED (kept for the user's Retry/Delete)
      // and rethrows so the flush drops the op — the bytes never silently vanish.
      return getEvidence(op.scope, gw.project, op.clientKey).then(async (entry) => {
        if (!entry) return gw.snapshot(); // user already deleted the bytes — nothing to upload
        // gate round-2 finding 2: a row that is not PENDING must never replay — a
        // dead-lettered (failed) row is parked for the USER's explicit Retry/Delete,
        // and a stale op must not smuggle it past that pause. Retry flips the row
        // back to pending first, so the legitimate path is unaffected.
        if (entry.status !== 'pending') return gw.snapshot();
        try {
          await gw.uploadMedia({
            kind: 'inspection',
            mime: entry.mime,
            data: entry.data,
            inspectionId: entry.inspectionId,
            inspectionItemId: entry.inspectionItemId,
            clientKey: op.clientKey,
          });
        } catch (err) {
          if (isTerminalOutboxError(err)) {
            try {
              await markEvidenceFailed(op.scope, gw.project, op.clientKey, `upload rejected (${(err as { status?: number }).status ?? 'error'})`);
            } catch {
              // gate finding 2: the dead-letter write ITSELF failed — the queued op
              // is now the ONLY replay path to these bytes. Rethrow WITHOUT a status
              // so the flush classifies it transient and KEEPS the op, instead of
              // dropping a "terminal" op whose bytes never reached the Retry surface.
              throw new Error('evidence dead-letter write failed — keeping the replay op queued');
            }
          }
          throw err;
        }
        await deleteEvidence(op.scope, gw.project, op.clientKey).catch(() => {}); // confirmed — exactly-once cleanup
        return gw.snapshot();
      });
    }
  }
}
