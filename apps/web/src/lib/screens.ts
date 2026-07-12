import type { Role, ScreenKey } from '@vitan/shared';
import {
  Inbox,
  LayoutDashboard,
  CalendarDays,
  FileEdit,
  ClipboardList,
  ClipboardCheck,
  BadgeCheck,
  Activity,
  NotebookPen,
  ListChecks,
  PencilRuler,
  MapPin,
  Users,
  LayoutGrid,
  LogIn,
  type LucideIcon,
} from 'lucide-react';

export interface ScreenMeta {
  key: ScreenKey;
  label: string;
  /** short label for the mobile bottom tab bar */
  short: string;
  path: string;
  icon: LucideIcon;
}

export const SCREEN_META: Record<ScreenKey, ScreenMeta> = {
  inbox: { key: 'inbox', label: 'For You', short: 'For You', path: '/for-you', icon: Inbox },
  dashboard: { key: 'dashboard', label: 'Dashboard', short: 'Dashboard', path: '/dashboard', icon: LayoutDashboard },
  drafts: { key: 'drafts', label: 'Drafts', short: 'Drafts', path: '/drafts', icon: FileEdit },
  'site-schedule': { key: 'site-schedule', label: 'Site Schedule', short: 'Schedule', path: '/schedule', icon: CalendarDays },
  'decision-log': { key: 'decision-log', label: 'Decision Log', short: 'Log', path: '/decisions', icon: ClipboardList },
  'inspect-review': { key: 'inspect-review', label: 'Inspection Review', short: 'Review', path: '/review', icon: ClipboardCheck },
  'client-decisions': { key: 'client-decisions', label: 'Decisions Waiting', short: 'Decisions', path: '/client/decisions', icon: BadgeCheck },
  'client-health': { key: 'client-health', label: 'Project Health', short: 'Health', path: '/client/health', icon: Activity },
  'daily-log': { key: 'daily-log', label: 'Daily Site Log', short: 'Daily', path: '/site/log', icon: NotebookPen },
  'engineer-check': { key: 'engineer-check', label: "Today's Checklist", short: 'Checklist', path: '/site/checklist', icon: ListChecks },
  drawings: { key: 'drawings', label: 'Drawings', short: 'Drawings', path: '/drawings', icon: PencilRuler },
  places: { key: 'places', label: 'Site Map', short: 'Places', path: '/places', icon: MapPin },
  team: { key: 'team', label: 'Team', short: 'Team', path: '/team', icon: Users },
  portfolio: { key: 'portfolio', label: 'Portfolio', short: 'Portfolio', path: '/portfolio', icon: LayoutGrid },
  'team-access': { key: 'team-access', label: 'Team Access & Login', short: 'Access', path: '/access', icon: LogIn },
};

/** Permission-filtered screen list per role (mirrors the prototype's screensFor). */
export function screensFor(role: Role): ScreenMeta[] {
  // 'inbox' ("For You") is the home for every role — a live, cross-cutting to-do list, first
  // in the nav so everyone lands on exactly what needs them before drilling into a screen.
  const keys: Record<Role, ScreenKey[]> = {
    pmc: ['inbox', 'dashboard', 'site-schedule', 'decision-log', 'drafts', 'inspect-review', 'drawings', 'places', 'team', 'portfolio'],
    client: ['inbox', 'client-decisions', 'client-health', 'decision-log', 'drawings', 'places'],
    engineer: ['inbox', 'daily-log', 'engineer-check', 'drawings', 'places', 'team-access', 'decision-log'],
    contractor: ['inbox', 'drawings', 'places', 'team-access', 'decision-log'],
    // a discipline consultant: read-mostly reviewer — drawings, the register, the Site Map, project health
    consultant: ['inbox', 'drawings', 'decision-log', 'places', 'client-health'],
  };
  return keys[role].map((k) => SCREEN_META[k]);
}

/** The full, project-scoped URL for a screen: `/projects/:projectId/<screen>`.
 *  The project id is part of the URL so a refresh, bookmark or shared link restores
 *  which project you were in (the URL is the source of truth for the active project). */
export function pathForScreen(screen: ScreenKey, projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}${SCREEN_META[screen].path}`;
}

/** Match a bare screen path (`/decisions`, `/client/decisions`) to its screen key. */
export function screenForPath(path: string): ScreenKey | null {
  const entry = Object.values(SCREEN_META).find((m) => m.path === path);
  return entry ? entry.key : null;
}

/** Parse a pathname into its project id (if present) and screen. Accepts the
 *  project-scoped form `/projects/:id/<screen>` and a legacy bare `/decisions` form
 *  (projectId null → the caller falls back to the active project). */
export function parseLocation(pathname: string): { projectId: string | null; screen: ScreenKey | null } {
  const m = pathname.match(/^\/projects\/([^/]+)(\/.*)?$/);
  if (m) {
    const screenPath = m[2] && m[2] !== '/' ? m[2] : null;
    return { projectId: decodeURIComponent(m[1]), screen: screenPath ? screenForPath(screenPath) : null };
  }
  return { projectId: null, screen: screenForPath(pathname) };
}

/** Which persona owns each screen — for the temporary role switcher / route guard. */
export const ROLE_LABEL: Record<Role, string> = {
  pmc: 'PMC',
  client: 'Client',
  engineer: 'Engineer',
  contractor: 'Contractor',
  consultant: 'Consultant',
};

export const ROLE_SUBTITLE: Record<Role, string> = {
  pmc: 'Architect · full access',
  client: 'Owner · Mr. & Mrs. Shah',
  engineer: 'Site Engineer · Ramesh',
  contractor: 'Contractor · read-only',
  consultant: 'Discipline consultant · reviews',
};
