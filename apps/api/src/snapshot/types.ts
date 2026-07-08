/** API response shapes — aligned with the frontend domain model so the client
 *  hydrates its store directly from a snapshot. */

export interface OptionDto {
  label: string;
  key: string;
  material: string;
  delta: number;
  swatch: string;
  recommended: boolean;
}

export interface DecisionDto {
  id: string;
  title: string;
  room: string;
  status: 'pending' | 'approved' | 'change';
  ageDays?: number;
  photoSwatch: string;
  options: OptionDto[];
  approvedOption?: string;
  material?: string;
  approver?: string;
  date?: string;
  cost?: number;
}

export interface ActivityDto {
  id: string;
  name: string;
  zone: string;
  decisionId: string | null;
  ps: number;
  pe: number;
  as: number | null;
  ae: number | null;
  status: 'not-started' | 'in-progress' | 'done' | 'blocked';
  gm: 'ok' | 'wait' | 'fail' | 'na';
  gt: 'ok' | 'wait' | 'fail' | 'na';
  gi: 'ok' | 'wait' | 'fail' | 'na';
  block?: string;
}

export interface ChecklistDto {
  id: string;
  title: string;
  zone: string;
  date: string;
  submitted: boolean;
  items: { name: string; state: string | null; photos: number; note: string }[];
}

export interface ReviewDto {
  id: string;
  title: string;
  zone: string;
  by: string;
  date: string;
  decided: boolean;
  items: { name: string; result: 'PASS' | 'FAIL'; swatch: string; note: string; rejected: boolean }[];
}

export interface DailyLogDto {
  date: string;
  checkedIn: boolean;
  checkinTime: string | null;
  submitted: boolean;
  crew: { trade: string; count: number }[];
  materials: { name: string; decisionId: string; qty: string; zone: string; matched: boolean; swatch: string; photo: boolean }[];
  progress: number;
  photos: { id: string; url: string; takenAt?: string }[];
}

export interface ProjectMetaDto {
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
}

export interface SnapshotDto {
  project: ProjectMetaDto;
  decisions: DecisionDto[];
  activities: ActivityDto[];
  checklist: ChecklistDto | null;
  /** The PMC review queue: every submitted-but-undecided inspection (a submitted
   *  checklist, the seeded review, an auto-created closing inspection), oldest first. */
  reviews: ReviewDto[];
  /** @deprecated first pending review — kept for back-compat; use `reviews`. */
  review: ReviewDto | null;
  reinspectionCreated: boolean;
  dailyLog: DailyLogDto | null;
  notifications: { text: string; time: string; color: string }[];
}
