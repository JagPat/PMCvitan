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
  ActivitiesModuleResult,
  DailyLogModuleResult,
  DrawingsModuleResult,
  InspectionsModuleResult,
  MaterialReadinessResult,
  ReservationPlan,
  RequirementListItem,
  RequisitionDto,
  PurchaseOrderDto,
  StockLotDto,
  MaterialIssueDto,
  LabourReadinessDto,
  LabourWorkforceDto,
  LabourCatalogDto,
  LabourRequisitionsDto,
  LabourPurchaseOrdersDto,
  LabourCommitmentsDto,
  LabourCapacityDto,
  LabourPresenceDto,
  CommercialMoneyPositionDto,
  CommercialClaimDto,
  SodRule,
  MeasurementRegisterDto,
  VendorBillListDto,
  VendorAdvanceListDto,
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

/** One menu pick at Create Project: which module, how many, and where it grafts. A
 *  zone-anchored (room-root) module takes `underZone`; a room-anchored (element-root)
 *  module takes EXACTLY ONE of `underRoom` — a room the copied source or an earlier
 *  selection creates — or `underZone`, grafting the element directly under that zone
 *  (nested locations). The server enforces the exactly-one rule. */
export interface ModuleSelection {
  moduleId: string;
  count?: number;
  underZone?: string;
  underRoom?: string;
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
 *  Location is either a tree node (`nodeId`, authoritative) or the free-text `room`.
 *  Phase 6 task 4b — `deciderKind` says WHO decides (server default 'client', byte-identical
 *  legacy behaviour when omitted); `member` requires the named membership id; `none` files a
 *  RECORD (exactly zero options, born terminal `recorded`). */
export interface NewDecisionInput {
  title: string;
  nodeId?: string;
  room?: string;
  options: { material: string; delta: number; swatch: string; photoUrl?: string; recommended?: boolean }[];
  /** default false → saved as a private draft; true → issued to the client in one step */
  publish?: boolean;
  deciderKind?: 'client' | 'pmc' | 'member' | 'none';
  deciderMembershipId?: string;
}

/** Phase 6 task 4b (§A.1/§A.2) — edit an UNPUBLISHED draft: re-point its decider, convert
 *  to/from a record (kind + status + options move as one coherent pair), or replace options. */
export interface UpdateDecisionDraftInput {
  deciderKind?: 'client' | 'pmc' | 'member' | 'none';
  deciderMembershipId?: string;
  options?: { material: string; delta: number; swatch: string; photoUrl?: string; recommended?: boolean }[];
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

/**
 * Phase 2 Task 10 (Module 4 — Activities) — the activities read-ownership mode (XOR), mirroring
 * `decisionsReadMode`/`inspectionsReadMode`. `'snapshot'` (the DEFAULT) keeps the activity spine
 * (`activities` + `phases`) owned by the full-snapshot slice — old behaviour, unchanged. `'moduleQuery'`
 * flips ownership to the module-owned `GET …/activities` read (served from the rebuildable projection,
 * live fallback): the snapshot's activity/phase slices are then IGNORED and the module fetch — carried
 * under the SAME snapshot scope lease — owns them. Each activity's five-gate readiness is baked FRESH
 * from the decisions/inspections/drawings query contracts on BOTH paths, so a projection read is never a
 * stale conclusion. Additive: the endpoint ships first, the old frontend still works, and the flip is a
 * config change once proven.
 */
export function activitiesReadMode(): 'snapshot' | 'moduleQuery' {
  return import.meta.env.VITE_ACTIVITIES_READ === 'moduleQuery' ? 'moduleQuery' : 'snapshot';
}

/** Phase 2 Task 10 (Module 4) — the module-owned activities read payload (projection-served, live
 *  fallback). The COMPLETE HTTP result is defined ONCE in `@vitan/shared` ({@link ActivitiesModuleResult})
 *  and imported by BOTH the API's query service and this gateway, so the two cannot drift (finding 5). */
export type ModuleActivities = ActivitiesModuleResult;

/** Phase 2 Task 9 — the project-shell summary (identity + enabled modules + projection counts). */
export interface ProjectShell {
  id: string;
  name: string;
  descriptor: string;
  stage: string;
  siteCode: string;
  org: { id: string; name: string } | null;
  enabledModules: string[];
  /** Phase 3 Task 7 (§D) — the PER-PROJECT pilot capabilities (`['materials']` on a pilot project,
   *  `[]` otherwise); the client gates the Materials surfaces on this. */
  capabilities: string[];
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
  /** Publish a private draft decision (PMC) → issue it to the decider. */
  publishDecision(decisionId: string, idempotencyKey?: string): Promise<ApiSnapshot> {
    return this.p(`/decisions/${decisionId}/publish`, {}, idempotencyKey);
  }
  /** Phase 6 task 4b — edit an UNPUBLISHED draft (decider re-point / record conversion / options). */
  updateDecisionDraft(decisionId: string, input: UpdateDecisionDraftInput, idempotencyKey?: string): Promise<ApiSnapshot> {
    return this.req(`/projects/${this.projectId}/decisions/${decisionId}/draft`, { method: 'PATCH', body: JSON.stringify(input), headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined });
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
  /** Plan a new schedule activity (PMC). Keyed for replay-safety (Task 10 Module 4). */
  createActivity(input: NewActivityInput, idempotencyKey?: string): Promise<ApiSnapshot> {
    return this.p('/activities', input, idempotencyKey);
  }
  /** Edit a planned activity (PMC) — only provided fields change. Keyed for replay-safety. */
  updateActivity(activityId: string, input: Partial<NewActivityInput>, idempotencyKey?: string): Promise<ApiSnapshot> {
    return this.req(`/projects/${this.projectId}/activities/${activityId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
      ...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
    });
  }
  /** Remove a planned activity (PMC). Keyed for replay-safety. */
  deleteActivity(activityId: string, idempotencyKey?: string): Promise<ApiSnapshot> {
    return this.req(`/projects/${this.projectId}/activities/${activityId}`, {
      method: 'DELETE',
      ...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
    });
  }
  /** Record a manual readiness exception on one gate (PMC, Task 6). Keyed for replay-safety. */
  overrideGate(activityId: string, input: OverrideGateInput, idempotencyKey?: string): Promise<ApiSnapshot> {
    return this.p(`/activities/${activityId}/override`, input, idempotencyKey);
  }
  /** Revoke an override early (PMC) — the derivation rules again. Keyed for replay-safety. */
  revokeOverride(activityId: string, overrideId: string, idempotencyKey?: string): Promise<ApiSnapshot> {
    return this.req(`/projects/${this.projectId}/activities/${activityId}/override/${overrideId}`, {
      method: 'DELETE',
      ...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
    });
  }
  /** Add a schedule phase (PMC). Keyed for replay-safety. */
  createPhase(input: { name: string; plannedStart?: number; plannedEnd?: number }, idempotencyKey?: string): Promise<ApiSnapshot> {
    return this.p('/phases', input, idempotencyKey);
  }
  /** Remove a phase (PMC) — its activities become unphased. Keyed for replay-safety. */
  deletePhase(phaseId: string, idempotencyKey?: string): Promise<ApiSnapshot> {
    return this.req(`/projects/${this.projectId}/phases/${phaseId}`, {
      method: 'DELETE',
      ...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
    });
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

  /** Phase 2 Task 10 (Module 4 — Activities) — the MODULE-OWNED activities read (projection-served,
   *  live fallback, readiness baked fresh on both paths). Fetched under the snapshot's scope lease when
   *  `ACTIVITIES_READ_MODE === 'moduleQuery'` (XOR read-ownership). */
  activities(): Promise<ModuleActivities> {
    return this.req<ModuleActivities>(`/projects/${this.projectId}/activities`);
  }

  /** Phase 2 Task 9 — the project-shell summary (identity + enabledModules + capabilities + counts). */
  shell(): Promise<ProjectShell> {
    return this.req<ProjectShell>(`/projects/${this.projectId}/shell`);
  }

  // ── Phase 3 Task 7 — the pilot MATERIALS reads (capability-gated on the server; 404 off-pilot). These
  //    are greenfield module reads (never in the snapshot), so they are module-query-only — the store
  //    fetches them together in `loadMaterials()` only when the project has the `materials` capability. ──

  /** The material-readiness view (per-requirement coverage + shortage forecast) — activities-owned. */
  materialReadiness(): Promise<MaterialReadinessResult> {
    return this.req<MaterialReadinessResult>(`/projects/${this.projectId}/activities/material-readiness`);
  }
  /** The activity material requirements (head revision per requirement + revision count). */
  materialRequirements(): Promise<{ requirements: RequirementListItem[] }> {
    return this.req<{ requirements: RequirementListItem[] }>(`/projects/${this.projectId}/requirements`);
  }
  /** The procurement requisitions (each with its lines). */
  materialRequisitions(): Promise<{ requisitions: RequisitionDto[] }> {
    return this.req<{ requisitions: RequisitionDto[] }>(`/projects/${this.projectId}/requisitions`);
  }
  /** The purchase orders (versions → lines → delivery commitments) — the deliveries view reads these too. */
  materialPurchaseOrders(): Promise<{ purchaseOrders: PurchaseOrderDto[] }> {
    return this.req<{ purchaseOrders: PurchaseOrderDto[] }>(`/projects/${this.projectId}/pos`);
  }
  /** The stock store (lots → per-location buckets incl. reserved/freeAvailable + the §C ledger) — the
   *  reservations view derives its per-activity reserved pool from these buckets + reservation ledger rows. */
  materialStock(): Promise<{ lots: StockLotDto[] }> {
    return this.req<{ lots: StockLotDto[] }>(`/projects/${this.projectId}/stock`);
  }
  /** The material issues (what LEFT the store for an activity/location — the §E canonical record). */
  materialIssues(): Promise<{ issues: MaterialIssueDto[] }> {
    return this.req<{ issues: MaterialIssueDto[] }>(`/projects/${this.projectId}/stock/issues`);
  }
  /** Phase 3 Task 7 (correction 2) — the CANONICAL reservation plan for covering ONE activity's shortage.
   *  The SERVER resolves coverage compatibility (requirements + active substitutions + base UOM + lot
   *  location + free qty) and returns exact single-command reserve candidates + the residual to
   *  requisition; the browser never recreates compatibility from fingerprints. 404 off-pilot. */
  materialReservationPlan(activityId: string): Promise<ReservationPlan> {
    return this.req<ReservationPlan>(`/projects/${this.projectId}/activities/${activityId}/reservation-plan`);
  }

  // ── Phase 3 Task 7 (correction 2) — the pilot MATERIALS operational COMMANDS. Each is ONE server
  //    command (no browser-side fan-out): reserve a SPECIFIC (lot, storeLocation, qty) candidate, issue a
  //    reservation to site, consume against an issue, or raise ONE requisition. They are routed through the
  //    durable write-ahead outbox with stable keys (see OutboxOp), so a lost/uncertain response replays the
  //    SAME command exactly once. They return the route's own JSON (Phase-3 reads are module-query-only),
  //    so the store reconciles the materials view separately after the flush. ──

  /** Reserve a SPECIFIC quantity of free stock at (lot, store location) to a NAMED activity (§C
   *  `stock.reserve`) — the exact candidate the server offered. */
  reserveStock(input: ReserveStockInput, idempotencyKey?: string): Promise<unknown> {
    return this.cmd('/stock/reserve', input, idempotencyKey);
  }
  /** Issue reserved stock from (lot, store location) to an activity — creates the §E MaterialIssue. */
  issueStock(input: IssueStockInput, idempotencyKey?: string): Promise<unknown> {
    return this.cmd('/stock/issue', input, idempotencyKey);
  }
  /** Record consumption against a MaterialIssue (§E `stock.consume`). */
  consumeStock(input: ConsumeStockInput, idempotencyKey?: string): Promise<unknown> {
    return this.cmd('/stock/consume', input, idempotencyKey);
  }
  /** Raise ONE procurement requisition for the residual shortage (`requisitions.create`). */
  createMaterialRequisition(input: CreateMaterialRequisitionInput, idempotencyKey?: string): Promise<unknown> {
    return this.cmd('/requisitions', input, idempotencyKey);
  }

  // ── Phase 4 Task 6 (§J) — the pilot LABOUR reads (capability-gated on the server; 404 off-pilot).
  //    Greenfield module reads, module-query-only: fetched together in `loadLabour()` only when the
  //    project has the `labour` capability. The requirements list is SHARED with materials (the
  //    type-neutral GET serves both types when either capability is on). ──

  /** The forecast Team readiness per activity (labour-owned, projection-backed). */
  labourReadiness(): Promise<LabourReadinessDto> {
    return this.req<LabourReadinessDto>(`/projects/${this.projectId}/labour/readiness`);
  }
  /** The workforce roster: workers (+skills, active windows, revocation) and crews. */
  labourWorkforce(): Promise<LabourWorkforceDto> {
    return this.req<LabourWorkforceDto>(`/projects/${this.projectId}/labour/workforce`);
  }
  /** The project trade/skill catalog (the §J trade pickers read this). */
  labourCatalog(): Promise<LabourCatalogDto> {
    return this.req<LabourCatalogDto>(`/projects/${this.projectId}/labour/catalog`);
  }
  /** The labour requisitions (§F chain, each with its demand-slice lines). */
  labourRequisitions(): Promise<LabourRequisitionsDto> {
    return this.req<LabourRequisitionsDto>(`/projects/${this.projectId}/labour/requisitions`);
  }
  /** The labour purchase orders (versions → slice lines with frozen rates). */
  labourPurchaseOrders(): Promise<LabourPurchaseOrdersDto> {
    return this.req<LabourPurchaseOrdersDto>(`/projects/${this.projectId}/labour/pos`);
  }
  /** The capacity commitments (per PO-line slice, with the append-only promise history). */
  labourCommitments(): Promise<LabourCommitmentsDto> {
    return this.req<LabourCommitmentsDto>(`/projects/${this.projectId}/labour/commitments`);
  }
  /** The §C capacity facts: allocations, attendance, work facts, skill substitutions. */
  labourCapacity(): Promise<LabourCapacityDto> {
    return this.req<LabourCapacityDto>(`/projects/${this.projectId}/labour/capacity`);
  }
  /** The §E presence read for ONE civil date: per-worker musters + UNRESOLVED mismatches. */
  labourPresence(civilDate: string): Promise<LabourPresenceDto> {
    return this.req<LabourPresenceDto>(`/projects/${this.projectId}/labour/presence?civilDate=${encodeURIComponent(civilDate)}`);
  }
  /** The §I planned-vs-actual productivity rows (activities-owned derived join). */
  labourProductivity(): Promise<LabourProductivityResult> {
    return this.req<LabourProductivityResult>(`/projects/${this.projectId}/activities/labour-productivity`);
  }

  // ── Phase 5 Task 7B-i (§M) — the MONEY-POSITION reads. Capability-gated on the server (404
  //    off-pilot), greenfield module-query reads fetched together in `loadCommercial()` only when
  //    the project has the `commercial` capability. All four are READS: nothing here can refuse a
  //    purchase order, and no command authority consults them. ──

  /** §M — the MONEY POSITION from ONE server snapshot: budget, cash forecast, cost heads and the
   *  attribution register, folded in a single repeatable-read transaction.
   *
   *  Codex round 2 (7B-i): the first spelling fetched these as FOUR requests, and a page assembled
   *  from four database moments can contradict itself — a re-attribution committing between two of
   *  them shows the obligation under one head in the budget while the register still names the
   *  other. One request, one instant. */
  commercialMoneyPosition(): Promise<CommercialMoneyPositionDto> {
    return this.req<CommercialMoneyPositionDto>(`/projects/${this.projectId}/commercial/money-position`);
  }

  // ── Phase 5 Task 7B-ii (§M) — the CLAIM-LIFECYCLE reads ────────────────────────────────────
  //
  // Two reads, and deliberately not folded into `money-position`. That bundle exists because its
  // four figures are MUTUALLY DERIVED — a re-attribution moves an obligation between the budget and
  // the register, so reading them at two instants renders a position that never existed. Nothing in
  // the claim list is derived from the money position or vice versa, so a bundle spanning them
  // would buy no consistency and would make opening the hub pay for a tab nobody opened yet.
  //
  // The CLAIM read is a bundle for exactly the reason `money-position` is: `approvable` is derived
  // from `netPayable`, so six requests can put two figures on one screen that were never true
  // together. The server folds all six in one repeatable-read transaction.

  // The SERVER's shape, not a convenient one: `CommercialBillService.list` returns the wrapper
  // `VendorBillListDto` (`{ bills: [...] }`), like every other list route here. Typing this as a
  // bare array made the store hold an object that `.map` throws on — and the store test's
  // hand-written mock returned an array, so the mock agreed with the bug instead of the server.
  commercialBills(): Promise<VendorBillListDto> {
    return this.req<VendorBillListDto>(`/projects/${this.projectId}/commercial/bills`);
  }

  commercialClaim(billId: string): Promise<CommercialClaimDto> {
    return this.req<CommercialClaimDto>(`/projects/${this.projectId}/commercial/claims/${encodeURIComponent(billId)}`);
  }

  /**
   * §D — ONE labour PO line's measurement register, from the line's own route.
   *
   * The claim bundle carries registers only for the lines of a LIVE version, and `draft` is not a
   * live status — deliberately, since a disputed or rejected claim's top version is in no fold and
   * presenting its registers would overstate what the claim measures. But the engineer measures
   * BEFORE the claim is live: that is the order §D describes and the order this unit exists to
   * support. Read against the bundle alone, a measurement taken on a lodged draft is recorded by
   * the server and invisible on screen, which is an invitation to take it twice.
   *
   * The register belongs to the LINE, not to any claim, so it is read from the line — the same
   * `registerIn` the bundle composes, without asking the claim query to say something about a
   * version it correctly refuses to speak for.
   */
  commercialLineRegister(labourPoLineId: string): Promise<MeasurementRegisterDto> {
    return this.req<MeasurementRegisterDto>(
      `/projects/${this.projectId}/commercial/labour-po-lines/${encodeURIComponent(labourPoLineId)}/measurements`,
    );
  }

  // ── Phase 5 Task 7B-iii-a (§M) — the COMMERCIAL write commands. Each is ONE server command
  //    routed through the durable write-ahead outbox with the two-key split (see OutboxOp), so a
  //    lost or uncertain response replays the SAME command exactly once. ──

  /** Set or REVISE the live budget for one cost head (§B — one command for v1 and every revision). */
  setCommercialBudget(input: SetCommercialBudgetInput, idempotencyKey?: string): Promise<unknown> {
    return this.cmd('/commercial/budget', input, idempotencyKey);
  }
  /** Define a cost head — the taxonomy budgets and attributions hang off (§C). */
  defineCostHead(input: DefineCostHeadInput, idempotencyKey?: string): Promise<unknown> {
    return this.cmd('/commercial/cost-heads', input, idempotencyKey);
  }
  /** Re-attribute ONE live PO line to a different cost head (§C — an atomic replacement,
   *  never a bare revocation, so no live obligation ever falls out of every budget). */
  reattributeCommitment(input: ReattributeCommitmentInput, idempotencyKey?: string): Promise<unknown> {
    return this.cmd('/commercial/attributions', input, idempotencyKey);
  }

  // ── Phase 5 Task 7B-iii-b (§D/§F) — the engineer's six writes, on the SAME lifecycle 7B-iii-a
  //    established. Nothing about the outbox, keys or reconcile is re-derived here. ──

  /** §D — measure a signed-off activity's labour PO line, citing its work output as evidence. */
  takeMeasurement(input: TakeMeasurementInput, idempotencyKey?: string): Promise<unknown> {
    return this.cmd('/commercial/measurements', input, idempotencyKey);
  }
  /** §D — correct a measurement by a SIGNED delta; the original row is never edited. */
  correctMeasurement(input: CorrectMeasurementInput, idempotencyKey?: string): Promise<unknown> {
    return this.cmd('/commercial/measurements/corrections', input, idempotencyKey);
  }
  /** §F — record a vendor's claim as lodged (draft). */
  recordVendorBill(input: RecordVendorBillInput, idempotencyKey?: string): Promise<unknown> {
    return this.cmd('/commercial/bills', input, idempotencyKey);
  }
  /** §F — open the §E three-way check on a submitted claim. */
  beginVerification(input: VendorBillStepInput, idempotencyKey?: string): Promise<unknown> {
    return this.cmd('/commercial/bills/begin-verification', input, idempotencyKey);
  }
  /** §E — run the three-way check and record its verdict; `matched` verifies, anything else disputes. */
  verifyVendorBill(input: VendorBillStepInput, idempotencyKey?: string): Promise<unknown> {
    return this.cmd('/commercial/bills/verify', input, idempotencyKey);
  }
  /** §F — submit a lodged claim for verification. */
  submitVendorBill(input: VendorBillStepInput, idempotencyKey?: string): Promise<unknown> {
    return this.cmd('/commercial/bills/submit', input, idempotencyKey);
  }
  /** §F — amend a claim: a NEW immutable version, the prior one retained verbatim. */
  amendVendorBill(input: AmendVendorBillInput, idempotencyKey?: string): Promise<unknown> {
    return this.cmd('/commercial/bills/amend', input, idempotencyKey);
  }
  /** §F — reject a claim with an attributable reason. */
  rejectVendorBill(input: RejectVendorBillInput, idempotencyKey?: string): Promise<unknown> {
    return this.cmd('/commercial/bills/reject', input, idempotencyKey);
  }
  /** §F/§I — CERTIFY a verified claim: freeze its evidence and create the payable. */
  certifyBill(input: CertifyBillInput, idempotencyKey?: string): Promise<unknown> {
    return this.cmd('/commercial/bills/certify', input, idempotencyKey);
  }
  /** §F — past certification the correction path is a SUPERSEDING certificate, never an edit. */
  supersedeCertificate(input: SupersedeCertificateInput, idempotencyKey?: string): Promise<unknown> {
    return this.cmd('/commercial/certificates/supersede', input, idempotencyKey);
  }
  /** §I — the APPROVER's own act: authorise one actor to perform one otherwise-forbidden act. */
  grantSodException(input: GrantSodExceptionInput, idempotencyKey?: string): Promise<unknown> {
    return this.cmd('/commercial/bills/sod-grant', input, idempotencyKey);
  }
  /** §H — withhold against a certified claim. */
  recordDeduction(input: RecordDeductionInput, idempotencyKey?: string): Promise<unknown> {
    return this.cmd('/commercial/deductions/record', input, idempotencyKey);
  }
  /** §H — return part of a withholding. Append-only: a release row, never an edit. */
  releaseDeduction(input: ReleaseDeductionInput, idempotencyKey?: string): Promise<unknown> {
    return this.cmd('/commercial/deductions/release', input, idempotencyKey);
  }
  /** §G bound 4 — authorise money to leave, against the claim's net payable. */
  approvePayment(input: ApprovePaymentInput, idempotencyKey?: string): Promise<unknown> {
    return this.cmd('/commercial/payments/approve', input, idempotencyKey);
  }
  /** §G bound 5 — record money that has left, against ONE approval. */
  recordPayment(input: RecordPaymentInput, idempotencyKey?: string): Promise<unknown> {
    return this.cmd('/commercial/payments/record', input, idempotencyKey);
  }
  /** §H — an advance to a counterparty, before any claim exists to draw it down. */
  /** 7B-vi (§H) — every advance on this project, with each counterparty's position. */
  commercialAdvances(): Promise<VendorAdvanceListDto> {
    return this.req<VendorAdvanceListDto>(`/projects/${this.projectId}/commercial/advances`);
  }

  payAdvance(input: PayAdvanceInput, idempotencyKey?: string): Promise<unknown> {
    return this.cmd('/commercial/advances', input, idempotencyKey);
  }
  /** §F — a reversal is its own fact; the payment it names is never edited. */
  reversePayment(input: ReversePaymentInput, idempotencyKey?: string): Promise<unknown> {
    return this.cmd('/commercial/payments/reverse', input, idempotencyKey);
  }

  // ── Phase 4 Task 6 (§J) — the LABOUR operational field COMMANDS. Each is ONE server command
  //    routed through the durable write-ahead outbox with the two-key split (see OutboxOp), so a
  //    lost/uncertain response replays the SAME command exactly once. ──

  /** Allocate ONE worker (or expand a crew) onto a requirement's demand slice (§C `allocation.allocate`). */
  allocateLabour(input: AllocateLabourInput, idempotencyKey?: string): Promise<unknown> {
    return this.cmd('/labour/allocations', input, idempotencyKey);
  }
  /** Record a worker's muster for a (civilDate, shift) — device-evidenced or a pmc manual exception. */
  recordLabourAttendance(input: RecordLabourAttendanceInput, idempotencyKey?: string): Promise<unknown> {
    return this.cmd('/labour/attendance', input, idempotencyKey);
  }
  /** Record worked minutes against an ACTIVE allocation (§C `work.record`). */
  recordLabourWork(input: RecordLabourWorkInput, idempotencyKey?: string): Promise<unknown> {
    return this.cmd('/labour/work', input, idempotencyKey);
  }
  /** Raise ONE labour requisition for a shortfall's demand slices (§F chain). */
  createLabourRequisition(input: CreateLabourRequisitionInput, idempotencyKey?: string): Promise<unknown> {
    return this.cmd('/labour/requisitions', input, idempotencyKey);
  }
  /** Release an ACTIVE allocation (CAS `active → released`) — the pmc/engineer corrective the
   *  hub's stranded-demand states point at (§C frees the worker's slice for re-allocation). */
  releaseLabourAllocation(allocationId: string, reason: string, idempotencyKey?: string): Promise<unknown> {
    return this.cmd(`/labour/allocations/${allocationId}/release`, { reason }, idempotencyKey);
  }

  // ── Phase 4 Task 6 (§J) — labour ROSTER commands (Team-screen onboarding surface). These are
  //    pmc-authored, low-frequency and dispatched DIRECTLY (not via the field outbox) with a fresh
  //    Idempotency-Key per action — the daily field ops above are the offline-first set. ──

  onboardWorker(input: { name: string; tradeCode: string; skillCodes: string[]; activeFrom: string; activeTo?: string | null }, idempotencyKey?: string): Promise<{ id: string }> {
    return this.cmd('/labour/workers', input, idempotencyKey);
  }
  formCrew(input: { name: string; inchargeWorkerId?: string; activeFrom: string; activeTo?: string | null }, idempotencyKey?: string): Promise<{ id: string }> {
    return this.cmd('/labour/crews', input, idempotencyKey);
  }
  addCrewMember(crewId: string, workerId: string, idempotencyKey?: string): Promise<{ id: string }> {
    return this.cmd(`/labour/crews/${crewId}/members`, { workerId }, idempotencyKey);
  }
  bindWorkerDevice(deviceId: string, workerId: string, idempotencyKey?: string): Promise<{ deviceId: string; workerId: string }> {
    return this.cmd(`/worker-devices/${deviceId}/bind`, { workerId }, idempotencyKey);
  }

  /** POST to a project-scoped route returning the ROUTE's own JSON (not an ApiSnapshot). Mirrors `p`'s
   *  idempotency-key behavior for the module-owned Phase-3 operational commands. */
  private cmd<T = unknown>(path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    return this.req<T>(`/projects/${this.projectId}${path}`, {
      method: 'POST',
      body: body !== undefined ? JSON.stringify(body) : undefined,
      ...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
    });
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
  /** Withdraw a PUBLISHED, never-approved decision — pmc only, terminal, reason required
   *  (Phase 6 task 4a). Distinct from `withdrawChange`, which closes a reopening. */
  withdrawDecision(decisionId: string, reason: string, idempotencyKey?: string): Promise<ApiSnapshot> {
    return this.p(`/decisions/${decisionId}/withdraw`, { reason }, idempotencyKey);
  }
  /** Keyed for replay-safety (Task 10 Module 4): a lost-response retry starts exactly once. */
  startActivity(activityId: string, idempotencyKey?: string): Promise<ApiSnapshot> {
    return this.p(`/activities/${activityId}/start`, undefined, idempotencyKey);
  }
  /** Keyed for replay-safety: a lost-response retry claims completion exactly once. */
  completeActivity(activityId: string, idempotencyKey?: string): Promise<ApiSnapshot> {
    return this.p(`/activities/${activityId}/complete`, undefined, idempotencyKey);
  }
  flagMismatch(decisionId: string, idempotencyKey?: string): Promise<ApiSnapshot> {
    return this.p(`/daily-log/flag-mismatch`, { decisionId }, idempotencyKey);
  }
  submitInspection(inspectionId: string, items: Checklist['items']): Promise<ApiSnapshot> {
    return this.p(`/inspections/${inspectionId}/submit`, { items });
  }
  decideReview(inspectionId: string, approve: boolean, rejectedItemIds: string[], idempotencyKey?: string): Promise<ApiSnapshot> {
    // Task 10 (Module 3) correction — the decide command carries the Task-5 idempotency key, so a
    // lost-response retry (or an offline replay) records the decision exactly once under the ledger.
    return this.p(`/inspections/${inspectionId}/decide`, { approve, rejectedItemIds }, idempotencyKey);
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
  /** Phase 6 task 4b (§A.3 round 13) — unlink this browser's subscription at sign-out. */
  pushUnlink(endpoint: string): Promise<{ ok: boolean }> {
    return this.req<{ ok: boolean }>(`/projects/${this.projectId}/push/unlink`, {
      method: 'POST',
      body: JSON.stringify({ endpoint }),
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

// ── Phase 3 Task 7 (correction 2) — the pilot MATERIALS operational command bodies. Each is ONE server
//    command with an EXPLICIT `storeLocation` (never the server default): a candidate the SERVER offered
//    (reserve/issue) or the residual the SERVER computed (requisition). The gateway + the write-ahead
//    outbox op share the interface, so the online send and any lost-response replay carry the same body. ──

/** `stock.reserve` — reserve an EXACT (lotId, storeLocation, qty) the server offered, to a NAMED activity.
 *  `storeLocation` is REQUIRED here (the browser sends the candidate's exact store, never the 'main'
 *  default) so a reservation is keyed by (lotId, storeLocation, activityId). */
export interface ReserveStockInput {
  lotId: string;
  storeLocation: string;
  activityId: string;
  qty: string;
}
/** `stock.issue` — issue reserved stock from (lotId, storeLocation) to an activity (creates the §E issue).
 *  `storeLocation` is REQUIRED so an issue draws from the SAME store the reservation was made in. */
export interface IssueStockInput {
  lotId: string;
  storeLocation: string;
  activityId: string;
  qty: string;
  note?: string;
}
/** `stock.consume` — record consumption against a §E MaterialIssue. */
export interface ConsumeStockInput {
  issueId: string;
  qty: string;
  note?: string;
}
/** `requisitions.create` — raise ONE requisition for the residual shortage (server-computed residuals).
 *  `lines` is a MUTABLE array: the op is stored in the durable (immer) outbox draft, which cannot hold a
 *  `readonly` member. `raiseRequisition` maps its readonly residuals into a fresh array before dispatch. */
export interface CreateMaterialRequisitionInput {
  title: string;
  notes?: string;
  lines: { requirementId: string; revision: number; qty: string }[];
}

// ── Phase 4 Task 6 (§J) — labour field-op inputs (server zod contracts mirror these). `lines`
//    arrays are mutable for the same immer-draft reason as the materials inputs. ──
export interface AllocateLabourInput {
  activityId: string;
  requirementId: string;
  civilDate: string;
  workerId?: string;
  crewId?: string;
  capacityCommitmentId?: string;
  /** Codex T6 round 3 (P1) — the head revision the caller selected against; the server refuses
   *  head drift with a terminal 409 (an offline replay after a revision never lands silently). */
  originRevision?: number;
  /** Codex T6 round 8 — the SATISFYING identity the worker was offered under (the head
   *  fingerprint, or an ACTIVE substitution target the server verifies + freezes). */
  labourSpecFingerprint?: string;
}
// ── Phase 5 Task 7B-iii-a (§M) — the COMMERCIAL write-command inputs. These mirror the server
//    zod contracts in `apps/api/src/contracts.ts`; money is a STRING end to end (§A forbids a
//    float64 round trip through the browser as much as through the server). ──
export interface SetCommercialBudgetInput {
  costHeadCode: string;
  /** a money string, never a number — parsed to Decimal server-side */
  amount: string;
  reason: string;
}
export interface DefineCostHeadInput {
  code: string;
  name: string;
}
export interface ReattributeCommitmentInput {
  /** EXACTLY ONE of these two, mirroring the server's XOR refinement and the PG CHECK */
  poLineId?: string;
  labourPoLineId?: string;
  costHeadCode: string;
  reason: string;
}

// ── Phase 5 Task 7B-iii-b (§D/§F) — the ENGINEER's commercial write inputs. Quantities and money
//    are STRINGS end to end (§A), validated against the SHARED `@vitan/shared` rules so the form
//    and the zod contract cannot disagree. ──
export interface TakeMeasurementInput {
  labourPoLineId: string;
  activityId: string;
  /** positive, ≤6dp — `isPositiveQuantity` */
  quantity: string;
  /** §D bounds a measurement by operational evidence: REQUIRED, never optional */
  citedOutputId: string;
  measuredOn?: string;
  evidenceMediaId?: string;
  reason?: string;
}
export interface CorrectMeasurementInput {
  measurementId: string;
  /** a SIGNED delta — a correction of zero corrects nothing */
  quantity: string;
  reason: string;
}
export interface VendorBillLineInput {
  /** EXACTLY ONE of these two (the server's XOR refinement and the PG CHECK) */
  poLineId?: string;
  labourPoLineId?: string;
  quantity: string;
  rate: string;
  taxAmount?: string;
  freightAmount?: string;
}
export interface RecordVendorBillInput {
  vendorId: string;
  vendorBillNumber: string;
  documentDate: string;
  lines: VendorBillLineInput[];
}
export interface AmendVendorBillInput {
  billId: string;
  reason: string;
  lines: VendorBillLineInput[];
}
export interface VendorBillStepInput { billId: string }
/** §F/§I — `versionId` is the claim version the certifier READ (Codex round-2): the server
 *  refuses a mismatch rather than freezing evidence for a version they never saw. */
/** `lifecycleVersion` is the claim REVISION the certifier read, required by the server contract:
 *  a version id is stable across the whole payment lifecycle, so it cannot say WHICH passage of
 *  the claim a queued certify was authored against. */
export interface CertifyBillInput { billId: string; versionId: string; lifecycleVersion: number }
/**
 * §I — the approver AUTHORISES one otherwise-forbidden act, and the request carries the three facts
 * they were looking at when they did.
 *
 * All three are REQUIRED by the server, and each closes a hole the previous one left open:
 * `versionId` the claim version they read; `status` the state that version was in (one version
 * walks the whole §E lifecycle without changing id); `lifecycleVersion` the claim's monotonic
 * revision (a status label recycles, and money can move without the label moving at all). A
 * queued authorisation is refused rather than silently re-pinned onto whatever is true when it
 * lands.
 *
 * There is no `approverId`: the AUTHENTICATED caller is the authority, and a field naming them
 * would be a field a caller could forge.
 */
export interface GrantSodExceptionInput {
  billId: string;
  /** the person being excused — never the caller; §I forbids a self-grant */
  actorId: string;
  reason: string;
  versionId: string;
  status: string;
  lifecycleVersion: number;
  /** WHICH §I rule is being excused. Two exist and a grant for one is refused for the other, so
   *  an authorisation surface that cannot name the rule can only ever issue half of them — which
   *  is what left a one-person site with an approval it could never unblock from the app. */
  rule: SodRule;
}
/**
 * ── 7B-iii-d (§G/§H) — the payer's chain. Six commands, and the shapes are the server's ────────
 *
 * Only `approve` carries a viewed-fact pin, and that asymmetry is the server's contract rather
 * than an omission here: the other five NAME the document they act on (`deductionId`,
 * `approvalId`, `paymentId`), and an id IS the viewed fact — it cannot silently mean a different
 * row later. An approval names only the claim, whose money moves underneath it, so it pins the
 * claim's monotonic revision instead.
 */
export interface RecordDeductionInput {
  billId: string; type: string; amount: string; reason?: string | null;
}
/** §H — a correction to a withholding is a RELEASE row, never an edit; the ledger is append-only. */
export interface ReleaseDeductionInput { deductionId: string; amount: string; reason: string }
/** §G bound 4 — approving is the authority that money MAY leave, against `NET_PAYABLE`. It is the
 *  ONE command carrying a viewed-fact pin: the server refuses it if the claim has moved since. */
export interface ApprovePaymentInput { billId: string; amount: string; lifecycleVersion: number }
/** §G bound 5 — a payment draws on ONE approval, and never more than it authorised. */
export interface RecordPaymentInput {
  approvalId: string; amount: string; method: string; reference?: string | null;
}
/** §F — cash already gone is not corrected by correcting a document; a reversal is its own fact. */
export interface ReversePaymentInput { paymentId: string; amount: string; reason: string }
/** §H — an advance names a VENDOR, not a claim: it is money paid before any claim exists. */
export interface PayAdvanceInput {
  vendorId: string; amount: string; reason: string; method: string; reference?: string | null;
}
/** §F — `certificateId` is the document the correction was WRITTEN ABOUT (Codex round-2). */
export interface SupersedeCertificateInput { billId: string; reason: string; certificateId: string }
export interface RejectVendorBillInput { billId: string; reason: string }

export interface RecordLabourAttendanceInput {
  workerId: string;
  civilDate: string;
  shift: 'day' | 'night';
  deviceId?: string;
  manualReason?: string;
  evidenceMediaId?: string;
}
export interface RecordLabourWorkInput {
  allocationId: string;
  workedMinutes: number;
  note?: string;
}
export interface CreateLabourRequisitionInput {
  title: string;
  notes?: string;
  lines: { requirementId: string; revision: number; civilDate: string; personShiftQty: number }[];
}

/** The §I productivity read (activities-owned; inline server shape, no shared DTO). */
export interface LabourProductivityResult {
  activities: {
    activityId: string;
    rows: {
      civilDate: string;
      shift: string;
      plannedPersonShifts: number;
      presentWorkers: number;
      workedMinutes: number;
      outputs: { quantity: string; uom: string }[];
      productivityPerHour: { uom: string; quantityPerHour: string }[] | null;
    }[];
  }[];
}

export type OutboxOp =
  // the decision-pillar ops carry a stable idempotencyKey (Phase 2 Task 5): a queued op replayed
  // on reconnect reaches the server under the SAME key it was first sent with, so a lost-response
  // retry never double-applies.
  | { t: 'approve'; decisionId: string; optionIndex: number; idempotencyKey: string }
  | { t: 'change'; decisionId: string; reason: string; costImpact: number; timeImpactDays: number; idempotencyKey: string }
  | { t: 'changeWithdraw'; decisionId: string; idempotencyKey: string }
  // Phase 6 task 4a — withdraw a published, never-approved decision (pmc; terminal; the reason
  // travels with the op so an offline replay carries the exact attribution evidence).
  | { t: 'withdraw'; decisionId: string; reason: string; idempotencyKey: string }
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
  // Task 10 (Module 3) correction — the decide command carries a stable idempotencyKey (optional so a
  // pre-upgrade persisted op without one still replays; the server treats a missing key as unkeyed).
  | { t: 'decideReview'; inspectionId: string; approve: boolean; rejectedItemIds: string[]; idempotencyKey?: string }
  // Task 10 (Module 4) — the activity commands carry a stable idempotencyKey (optional so a
  // pre-upgrade persisted op without one still replays; the server treats a missing key as unkeyed).
  | { t: 'startActivity'; activityId: string; idempotencyKey?: string }
  | { t: 'completeActivity'; activityId: string; idempotencyKey?: string }
  // ALL FOUR daily-log commands carry a stable idempotencyKey and are WRITE-AHEAD to the durable
  // outbox before the first network request — online OR offline (Task 10 correction round 2, finding
  // 1). A lost/uncertain online response leaves the op (and its key) persisted, so a retry or a reload
  // replays the SAME op under the SAME key and the command-ledger applies it exactly once.
  | { t: 'startDailyLog'; idempotencyKey: string }
  | { t: 'addSiteMaterial'; input: AddSiteMaterialInput; idempotencyKey: string }
  | { t: 'flagMismatch'; decisionId: string; idempotencyKey: string }
  | { t: 'submitDailyLog'; log: Pick<DailyLog, 'checkedIn' | 'checkinTime' | 'progress' | 'crew'>; idempotencyKey: string }
  // Phase 3 Task 7 (correction 2/3) — the pilot MATERIALS operational commands are WRITE-AHEAD to the
  // durable outbox before the first network request (online OR offline). Correction 3 (finding 1) splits
  // the two identities: `idempotencyKey` is a FRESH per-action key (reused unchanged on every retry/
  // reload so a lost response replays exactly once; DIFFERENT for the next legitimate action), and
  // `coalesceKey` is a deterministic identity used ONLY to dedupe an equivalent action WHILE pending
  // (double-click / reload). They return the route's own JSON (Phase-3 reads are module-query-only), so
  // the flush reconciles the materials view separately (see the store's materials reconcile hook).
  | { t: 'reserveStock'; input: ReserveStockInput; idempotencyKey: string; coalesceKey: string }
  | { t: 'issueStock'; input: IssueStockInput; idempotencyKey: string; coalesceKey: string }
  | { t: 'consumeStock'; input: ConsumeStockInput; idempotencyKey: string; coalesceKey: string }
  | { t: 'createRequisition'; input: CreateMaterialRequisitionInput; idempotencyKey: string; coalesceKey: string }
  // Phase 4 Task 6 (§J) — the labour field ops, born with the SAME two-key split (labourKeys.ts):
  // a fresh per-action idempotencyKey (exactly-once replay) + a deterministic coalesceKey
  // (equivalent-action dedupe while pending).
  | { t: 'allocateLabour'; input: AllocateLabourInput; idempotencyKey: string; coalesceKey: string }
  | { t: 'recordAttendance'; input: RecordLabourAttendanceInput; idempotencyKey: string; coalesceKey: string }
  | { t: 'recordLabourWork'; input: RecordLabourWorkInput; idempotencyKey: string; coalesceKey: string }
  | { t: 'createLabourRequisition'; input: CreateLabourRequisitionInput; idempotencyKey: string; coalesceKey: string }
  | { t: 'releaseLabourAllocation'; allocationId: string; reason: string; idempotencyKey: string; coalesceKey: string }
  // Phase 5 Task 7B-iii-a (§M) — the commercial write ops, born with the same two-key split
  // (commercialKeys.ts): a fresh per-action idempotencyKey + a deterministic coalesceKey.
  | { t: 'setCommercialBudget'; input: SetCommercialBudgetInput; idempotencyKey: string; coalesceKey: string }
  | { t: 'defineCostHead'; input: DefineCostHeadInput; idempotencyKey: string; coalesceKey: string }
  | { t: 'reattributeCommitment'; input: ReattributeCommitmentInput; idempotencyKey: string; coalesceKey: string }
  // Phase 5 Task 7B-iii-b (§D/§F) — the engineer's writes, same two-key split.
  | { t: 'takeMeasurement'; input: TakeMeasurementInput; idempotencyKey: string; coalesceKey: string }
  // `labourPoLineId` is CLIENT-side only — never sent. The server's contract takes the
  // measurement id alone; the cap needs the line a positive correction spends authority on.
  | { t: 'correctMeasurement'; input: CorrectMeasurementInput; labourPoLineId: string; idempotencyKey: string; coalesceKey: string }
  | { t: 'recordVendorBill'; input: RecordVendorBillInput; idempotencyKey: string; coalesceKey: string }
  | { t: 'beginVerification'; input: VendorBillStepInput; idempotencyKey: string; coalesceKey: string }
  | { t: 'verifyVendorBill'; input: VendorBillStepInput; idempotencyKey: string; coalesceKey: string }
  | { t: 'submitVendorBill'; input: VendorBillStepInput; idempotencyKey: string; coalesceKey: string }
  | { t: 'certifyBill'; input: CertifyBillInput; idempotencyKey: string; coalesceKey: string }
  | { t: 'supersedeCertificate'; input: SupersedeCertificateInput; idempotencyKey: string; coalesceKey: string }
  | { t: 'grantSodException'; input: GrantSodExceptionInput; idempotencyKey: string; coalesceKey: string }
  | { t: 'recordDeduction'; input: RecordDeductionInput; idempotencyKey: string; coalesceKey: string }
  | { t: 'releaseDeduction'; input: ReleaseDeductionInput; idempotencyKey: string; coalesceKey: string }
  | { t: 'approvePayment'; input: ApprovePaymentInput; idempotencyKey: string; coalesceKey: string }
  | { t: 'payAdvance'; input: PayAdvanceInput; idempotencyKey: string; coalesceKey: string }
  | { t: 'recordPayment'; input: RecordPaymentInput; idempotencyKey: string; coalesceKey: string }
  | { t: 'reversePayment'; input: ReversePaymentInput; idempotencyKey: string; coalesceKey: string }
  | { t: 'amendVendorBill'; input: AmendVendorBillInput; idempotencyKey: string; coalesceKey: string }
  | { t: 'rejectVendorBill'; input: RejectVendorBillInput; idempotencyKey: string; coalesceKey: string }
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
    case 'withdraw':
      return gw.withdrawDecision(op.decisionId, op.reason, op.idempotencyKey);
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
      return gw.decideReview(op.inspectionId, op.approve, op.rejectedItemIds, op.idempotencyKey);
    case 'startActivity':
      return gw.startActivity(op.activityId, op.idempotencyKey);
    case 'completeActivity':
      return gw.completeActivity(op.activityId, op.idempotencyKey);
    case 'startDailyLog':
      return gw.startDailyLog(op.idempotencyKey);
    case 'addSiteMaterial':
      return gw.addSiteMaterial(op.input, op.idempotencyKey);
    case 'flagMismatch':
      return gw.flagMismatch(op.decisionId, op.idempotencyKey);
    case 'submitDailyLog':
      return gw.submitDailyLog(op.log, op.idempotencyKey);
    // Phase 3 Task 7 (correction 2) — the pilot materials commands return the route's own JSON (not a
    // snapshot; Phase-3 reads are module-query-only), so refetch the base snapshot to reconcile the
    // non-materials view. The store's materials reconcile hook reloads the materials view + open
    // reservation plans separately after the flush (same key ⇒ the ledger applied the effect once).
    case 'reserveStock':
      return gw.reserveStock(op.input, op.idempotencyKey).then(() => gw.snapshot());
    case 'issueStock':
      return gw.issueStock(op.input, op.idempotencyKey).then(() => gw.snapshot());
    case 'consumeStock':
      return gw.consumeStock(op.input, op.idempotencyKey).then(() => gw.snapshot());
    case 'createRequisition':
      return gw.createMaterialRequisition(op.input, op.idempotencyKey).then(() => gw.snapshot());
    // Phase 4 Task 6 (§J) — the labour field ops follow the identical replay contract: route JSON
    // chased with a snapshot refetch; the store's labour reconcile hook reloads the labour view.
    case 'allocateLabour':
      return gw.allocateLabour(op.input, op.idempotencyKey).then(() => gw.snapshot());
    case 'recordAttendance':
      return gw.recordLabourAttendance(op.input, op.idempotencyKey).then(() => gw.snapshot());
    case 'recordLabourWork':
      return gw.recordLabourWork(op.input, op.idempotencyKey).then(() => gw.snapshot());
    case 'createLabourRequisition':
      return gw.createLabourRequisition(op.input, op.idempotencyKey).then(() => gw.snapshot());
    // Phase 5 Task 7B-iii-a (§M) — identical replay contract: route JSON chased with a snapshot
    // refetch; the store's commercial reconcile hook reloads the money position.
    case 'setCommercialBudget':
      return gw.setCommercialBudget(op.input, op.idempotencyKey).then(() => gw.snapshot());
    case 'defineCostHead':
      return gw.defineCostHead(op.input, op.idempotencyKey).then(() => gw.snapshot());
    case 'reattributeCommitment':
      return gw.reattributeCommitment(op.input, op.idempotencyKey).then(() => gw.snapshot());
    case 'takeMeasurement':
      return gw.takeMeasurement(op.input, op.idempotencyKey).then(() => gw.snapshot());
    case 'correctMeasurement':
      return gw.correctMeasurement(op.input, op.idempotencyKey).then(() => gw.snapshot());
    case 'recordVendorBill':
      return gw.recordVendorBill(op.input, op.idempotencyKey).then(() => gw.snapshot());
    case 'beginVerification':
      return gw.beginVerification(op.input, op.idempotencyKey).then(() => gw.snapshot());
    case 'verifyVendorBill':
      return gw.verifyVendorBill(op.input, op.idempotencyKey).then(() => gw.snapshot());
    case 'certifyBill':
      return gw.certifyBill(op.input, op.idempotencyKey).then(() => gw.snapshot());
    case 'supersedeCertificate':
      return gw.supersedeCertificate(op.input, op.idempotencyKey).then(() => gw.snapshot());
    case 'grantSodException':
      return gw.grantSodException(op.input, op.idempotencyKey).then(() => gw.snapshot());
    case 'recordDeduction':
      return gw.recordDeduction(op.input, op.idempotencyKey).then(() => gw.snapshot());
    case 'releaseDeduction':
      return gw.releaseDeduction(op.input, op.idempotencyKey).then(() => gw.snapshot());
    case 'approvePayment':
      return gw.approvePayment(op.input, op.idempotencyKey).then(() => gw.snapshot());
    case 'payAdvance':
      return gw.payAdvance(op.input, op.idempotencyKey).then(() => gw.snapshot());
    case 'recordPayment':
      return gw.recordPayment(op.input, op.idempotencyKey).then(() => gw.snapshot());
    case 'reversePayment':
      return gw.reversePayment(op.input, op.idempotencyKey).then(() => gw.snapshot());
    case 'submitVendorBill':
      return gw.submitVendorBill(op.input, op.idempotencyKey).then(() => gw.snapshot());
    case 'amendVendorBill':
      return gw.amendVendorBill(op.input, op.idempotencyKey).then(() => gw.snapshot());
    case 'rejectVendorBill':
      return gw.rejectVendorBill(op.input, op.idempotencyKey).then(() => gw.snapshot());
    case 'releaseLabourAllocation':
      return gw.releaseLabourAllocation(op.allocationId, op.reason, op.idempotencyKey).then(() => gw.snapshot());
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
