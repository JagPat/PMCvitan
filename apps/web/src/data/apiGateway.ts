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
  review: Review | null;
  reinspectionCreated: boolean;
  dailyLog: DailyLog | null;
  notifications: AppNotification[];
}

export const API_BASE: string | undefined = import.meta.env.VITE_API_URL;
export const PROJECT_ID = 'ambli';

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
}
