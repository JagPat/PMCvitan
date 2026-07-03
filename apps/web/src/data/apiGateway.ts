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

export class ApiGateway {
  private token: string | null = null;
  private readonly base: string;
  private readonly projectId: string;

  constructor(base: string, projectId = 'ambli') {
    this.base = base;
    this.projectId = projectId;
  }

  /** Obtain a scoped session token for the given role (dev auth for Slice 1). */
  async connect(role: Role): Promise<void> {
    const res = await fetch(`${this.base}/auth/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role, projectId: this.projectId }),
    });
    if (!res.ok) throw new Error(`auth/session ${res.status}`);
    this.token = (await res.json()).token;
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
}
