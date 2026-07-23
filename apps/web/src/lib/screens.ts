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
  Package,
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
  materials: { key: 'materials', label: 'Materials', short: 'Materials', path: '/materials', icon: Package },
};

/**
 * Phase 3 Task 7 (§D) — the per-project CAPABILITY a screen requires, or `null` for a screen with no
 * capability gate. A capability-gated screen (`materials` → `'materials'`) is present ONLY when the
 * active project's shell reports that capability; a non-pilot project shows none — matching the server's
 * 404 stance. Unlike `SCREEN_MODULE` (registry-global — `inventory`/`procurement` are enabled for every
 * project), this is the PER-PROJECT pilot gate.
 */
export const SCREEN_CAPABILITY: Partial<Record<ScreenKey, string>> = {
  materials: 'materials',
};

/**
 * Phase 2 Task 9 — the domain MODULE each screen belongs to (for manifest-driven nav). `null` marks a
 * cross-cutting shell surface (the For-You inbox, Dashboard, Drafts workspace, project health,
 * Portfolio, Team, Team Access) that is always present regardless of which domain modules are enabled.
 * A screen whose module is DISABLED (absent from the shell's `enabledModules`) is hidden.
 */
export const SCREEN_MODULE: Record<ScreenKey, string | null> = {
  inbox: null,
  dashboard: null,
  drafts: null,
  'site-schedule': 'activities',
  'decision-log': 'decisions',
  'inspect-review': 'inspections',
  'client-decisions': 'decisions',
  'client-health': null,
  'daily-log': 'daily-log',
  'engineer-check': 'inspections',
  drawings: 'drawings',
  places: 'nodes',
  team: 'orgs',
  portfolio: null,
  'team-access': null,
  // Materials is gated by the per-project `materials` CAPABILITY (SCREEN_CAPABILITY), not a global
  // module — `inventory`/`procurement` are registry-enabled for every project, so a module gate can't
  // pilot-gate it. `null` here so the module filter is a no-op; the capability filter does the gating.
  materials: null,
};

/**
 * Manifest-driven nav (Task 9): the role's screens filtered by the ENABLED modules from the shell
 * summary. An empty `enabledModules` (not yet loaded, or the pure local demo) applies NO filter, so the
 * full role list shows — behaviour-preserving until the shell lands. A shell-surface screen (module
 * `null`) is always kept.
 */
export function enabledScreensFor(
  role: Role,
  enabledModules: readonly string[],
  capabilities: readonly string[] = [],
): ScreenMeta[] {
  const caps = new Set(capabilities);
  // The CAPABILITY gate (Phase 3 Task 7) always applies — a capability-gated screen is hidden until the
  // project's shell reports that capability. This runs even when `enabledModules` is empty (not yet
  // loaded / local demo), so a Materials screen never flashes for a project that lacks the pilot.
  const screens = screensFor(role).filter((m) => {
    const cap = SCREEN_CAPABILITY[m.key];
    return cap === undefined || caps.has(cap);
  });
  if (!enabledModules.length) return screens;
  const enabled = new Set(enabledModules);
  return screens.filter((m) => {
    const mod = SCREEN_MODULE[m.key];
    return mod === null || enabled.has(mod);
  });
}

/** Permission-filtered screen list per role (mirrors the prototype's screensFor). */
export function screensFor(role: Role): ScreenMeta[] {
  // 'inbox' ("For You") is the home for every role — a live, cross-cutting to-do list, first
  // in the nav so everyone lands on exactly what needs them before drilling into a screen.
  const keys: Record<Role, ScreenKey[]> = {
    pmc: ['inbox', 'dashboard', 'site-schedule', 'decision-log', 'drafts', 'inspect-review', 'drawings', 'materials', 'places', 'team', 'portfolio'],
    client: ['inbox', 'client-decisions', 'client-health', 'decision-log', 'drawings', 'places'],
    // engineers hold activity.start/complete, so they get the Schedule (its authoring
    // controls stay behind activity.manage — pmc only). Materials is a pmc/engineer planning surface.
    engineer: ['inbox', 'daily-log', 'engineer-check', 'site-schedule', 'drawings', 'materials', 'places', 'team-access', 'decision-log'],
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
