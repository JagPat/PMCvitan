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
import type {
  Activity,
  AppNotification,
  Checklist,
  DailyLog,
  Decision,
  Drawing,
  MembershipSummary,
  OrgSummary,
  Phase,
  PortfolioProject,
  ProjectMember,
  Review,
  Role,
} from '@vitan/shared';

export interface ApiSnapshot {
  project: {
    id: string;
    name: string;
    short: string;
    descriptor: string;
    stage: string;
    siteCode: string;
    projStart: string;
    projEnd: string;
    elapsedPct: number;
    todayDay: number;
    milestonePct: number;
  };
  decisions: Decision[];
  activities: Activity[];
  checklist: Checklist | null;
  reviews: Review[];
  review: Review | null; // deprecated (first pending) — back-compat; use `reviews`
  reinspectionCreated: boolean;
  drawings: Drawing[];
  phases: Phase[];
  dailyLog: DailyLog | null;
  notifications: AppNotification[];
}

/** Add a project team member (provisions the account when new). */
export interface AddMemberInput {
  name: string;
  role: Role;
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
  projStart?: string;
  projEnd?: string;
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

export class ApiGateway {
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
  /** List the active project's team. */
  listMembers(): Promise<ProjectMember[]> {
    return this.req(`/projects/${this.projectId}/members`);
  }
  /** Add a member to the active project (provisions the account if new). */
  addMember(input: AddMemberInput): Promise<ProjectMember> {
    return this.req(`/projects/${this.projectId}/members`, { method: 'POST', body: JSON.stringify(input) });
  }
  /** Change a member's role. */
  updateMemberRole(userId: string, role: Role): Promise<ProjectMember> {
    return this.req(`/projects/${this.projectId}/members/${userId}`, { method: 'PATCH', body: JSON.stringify({ role }) });
  }
  /** Remove a member from the active project (soft delete). */
  removeMember(userId: string): Promise<{ ok: boolean }> {
    return this.req(`/projects/${this.projectId}/members/${userId}`, { method: 'DELETE' });
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
    if (!res.ok) throw new Error(`${path} ${res.status}`);
    return res.json() as Promise<T>;
  }

  private p(path: string, body?: unknown): Promise<ApiSnapshot> {
    return this.req<ApiSnapshot>(`/projects/${this.projectId}${path}`, {
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  snapshot(): Promise<ApiSnapshot> {
    return this.req<ApiSnapshot>(`/projects/${this.projectId}/snapshot`);
  }

  approveDecision(decisionId: string, optionIndex: number): Promise<ApiSnapshot> {
    return this.p(`/decisions/${decisionId}/approve`, { optionIndex });
  }
  requestChange(decisionId: string, reason: string, costImpact: number, timeImpactDays: number): Promise<ApiSnapshot> {
    return this.p(`/decisions/${decisionId}/change`, { reason, costImpact, timeImpactDays });
  }
  startActivity(activityId: string): Promise<ApiSnapshot> {
    return this.p(`/activities/${activityId}/start`);
  }
  completeActivity(activityId: string): Promise<ApiSnapshot> {
    return this.p(`/activities/${activityId}/complete`);
  }
  flagMismatch(decisionId: string): Promise<ApiSnapshot> {
    return this.p(`/daily-log/flag-mismatch`, { decisionId });
  }
  submitInspection(inspectionId: string, items: Checklist['items']): Promise<ApiSnapshot> {
    return this.p(`/inspections/${inspectionId}/submit`, { items });
  }
  decideReview(inspectionId: string, approve: boolean, rejectedItemNames: string[]): Promise<ApiSnapshot> {
    return this.p(`/inspections/${inspectionId}/decide`, { approve, rejectedItemNames });
  }
  submitDailyLog(log: Pick<DailyLog, 'checkedIn' | 'checkinTime' | 'progress' | 'crew'>): Promise<ApiSnapshot> {
    return this.p(`/daily-log/submit`, log);
  }

  /** Upload a site photo; returns its id + resolvable URL. */
  uploadMedia(input: UploadMediaInput): Promise<{ id: string; url: string }> {
    return this.req<{ id: string; url: string }>(`/projects/${this.projectId}/media`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  /**
   * Issue a drawing revision. A large file is uploaded direct-to-bucket via a
   * presigned PUT (bypassing the API body limit) when the server offers one;
   * otherwise the base64 body is posted (dev stub / small files). The snapshot
   * then reconciles via the realtime `changed`.
   */
  async issueDrawing(input: IssueDrawingInput): Promise<{ drawingId: string; revisionId: string }> {
    if (input.data.length >= PRESIGN_MIN_DATA_LEN) {
      const presigned = await this.presignDrawing(input.mime).catch(() => null);
      if (presigned && 'uploadUrl' in presigned) {
        const bytes = Uint8Array.from(atob(input.data), (c) => c.charCodeAt(0));
        const put = await fetch(presigned.uploadUrl, { method: 'PUT', headers: { 'Content-Type': input.mime }, body: bytes });
        if (put.ok) {
          const { data: _drop, ...meta } = input;
          return this.req(`/projects/${this.projectId}/drawings`, {
            method: 'POST',
            body: JSON.stringify({ ...meta, storageKey: presigned.storageKey, sizeBytes: bytes.length }),
          });
        }
        // presigned PUT failed → fall through to the base64 body path
      }
    }
    return this.req<{ drawingId: string; revisionId: string }>(`/projects/${this.projectId}/drawings`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  /** Request a presigned direct-to-bucket upload target for a drawing (S3 mode). */
  presignDrawing(mime: string): Promise<{ uploadUrl: string; storageKey: string } | { presign: null }> {
    return this.req(`/projects/${this.projectId}/drawings/presign`, { method: 'POST', body: JSON.stringify({ mime }) });
  }

  /** Acknowledge building to a drawing revision ("building to Rev C"). */
  acknowledgeDrawing(revisionId: string): Promise<{ ok: boolean; ackCount: number }> {
    return this.req<{ ok: boolean; ackCount: number }>(`/projects/${this.projectId}/drawings/rev/${revisionId}/ack`, {
      method: 'POST',
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
export type OutboxOp =
  | { t: 'approve'; decisionId: string; optionIndex: number }
  | { t: 'change'; decisionId: string; reason: string; costImpact: number; timeImpactDays: number }
  | { t: 'submitInspection'; inspectionId: string; items: Checklist['items'] }
  | { t: 'decideReview'; inspectionId: string; approve: boolean; rejectedItemNames: string[] }
  | { t: 'startActivity'; activityId: string }
  | { t: 'completeActivity'; activityId: string }
  | { t: 'flagMismatch'; decisionId: string }
  | { t: 'submitDailyLog'; log: Pick<DailyLog, 'checkedIn' | 'checkinTime' | 'progress' | 'crew'> }
  | { t: 'uploadMedia'; input: UploadMediaInput };

/** Replay one queued mutation; resolves to the fresh snapshot. */
export function replayOutboxOp(gw: ApiGateway, op: OutboxOp): Promise<ApiSnapshot> {
  switch (op.t) {
    case 'approve':
      return gw.approveDecision(op.decisionId, op.optionIndex);
    case 'change':
      return gw.requestChange(op.decisionId, op.reason, op.costImpact, op.timeImpactDays);
    case 'submitInspection':
      return gw.submitInspection(op.inspectionId, op.items);
    case 'decideReview':
      return gw.decideReview(op.inspectionId, op.approve, op.rejectedItemNames);
    case 'startActivity':
      return gw.startActivity(op.activityId);
    case 'completeActivity':
      return gw.completeActivity(op.activityId);
    case 'flagMismatch':
      return gw.flagMismatch(op.decisionId);
    case 'submitDailyLog':
      return gw.submitDailyLog(op.log);
    case 'uploadMedia':
      // uploadMedia returns {id,url}, not a snapshot — refetch so the flush
      // reconciles dailyLog.photos (the real, server-stored photo replaces the
      // optimistic local data-URL one).
      return gw.uploadMedia(op.input).then(() => gw.snapshot());
  }
}
