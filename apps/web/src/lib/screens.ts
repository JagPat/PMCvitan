import type { Phase6_4dRollout } from '@/data/apiGateway';
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
  HardHat,
  IndianRupee,
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
  'decision-log': { key: 'decision-log', label: 'Decision Log', short: 'Decision Log', path: '/decisions', icon: ClipboardList },
  'inspect-review': { key: 'inspect-review', label: 'Inspection Review', short: 'Review', path: '/review', icon: ClipboardCheck },
  'client-decisions': { key: 'client-decisions', label: 'Decisions Waiting', short: 'Decisions', path: '/client/decisions', icon: BadgeCheck },
  'client-health': { key: 'client-health', label: 'Project Health', short: 'Health', path: '/client/health', icon: Activity },
  'daily-log': { key: 'daily-log', label: 'Daily Site Log', short: 'Daily', path: '/site/log', icon: NotebookPen },
  'engineer-check': { key: 'engineer-check', label: "Today's Checklist", short: 'Checklist', path: '/site/checklist', icon: ListChecks },
  drawings: { key: 'drawings', label: 'Drawings', short: 'Drawings', path: '/drawings', icon: PencilRuler },
  places: { key: 'places', label: 'Site Map', short: 'Site Map', path: '/places', icon: MapPin },
  team: { key: 'team', label: 'Team', short: 'Team', path: '/team', icon: Users },
  portfolio: { key: 'portfolio', label: 'Portfolio', short: 'Portfolio', path: '/portfolio', icon: LayoutGrid },
  'team-access': { key: 'team-access', label: 'Team Access & Login', short: 'Access', path: '/access', icon: LogIn },
  materials: { key: 'materials', label: 'Materials', short: 'Materials', path: '/materials', icon: Package },
  labour: { key: 'labour', label: 'Labour', short: 'Labour', path: '/labour', icon: HardHat },
  commercial: { key: 'commercial', label: 'Commercial', short: 'Money', path: '/commercial', icon: IndianRupee },
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
  // Phase 4 Task 6 (§J) — the Labour hub is gated by the per-project `labour` capability exactly
  // like Materials: absent from the nav (and inert in the store) unless the shell reports it.
  labour: 'labour',
  // Phase 5 Task 7B-i (§M) — the Commercial hub is gated by the per-project `commercial` capability
  // exactly like Materials and Labour: absent from the nav, and inert in the store, unless the
  // shell reports it. That matches the server, which 404s every commercial read off-pilot.
  commercial: 'commercial',
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
  // Labour (Phase 4 Task 6) — same stance: the `labour` module is registry-enabled everywhere; the
  // per-project pilot gate is the `labour` CAPABILITY above, so the module filter must be a no-op.
  labour: null,
  // Commercial (Phase 5 Task 7B-i) — same stance again: `commercial` is registry-enabled for every
  // project, so the module filter must be a no-op and the CAPABILITY above does the pilot gating.
  commercial: null,
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
    pmc: ['inbox', 'dashboard', 'site-schedule', 'decision-log', 'drafts', 'inspect-review', 'drawings', 'materials', 'labour', 'commercial', 'places', 'team', 'portfolio'],
    client: ['inbox', 'client-decisions', 'client-health', 'decision-log', 'drawings', 'places'],
    // engineers hold activity.start/complete, so they get the Schedule (its authoring
    // controls stay behind activity.manage — pmc only). Materials and Labour (`labour.read` is
    // pmc/engineer) are pmc/engineer planning surfaces.
    engineer: ['inbox', 'daily-log', 'engineer-check', 'site-schedule', 'drawings', 'materials', 'labour', 'commercial', 'places', 'team-access', 'decision-log'],
    contractor: ['inbox', 'drawings', 'places', 'team-access', 'decision-log'],
    // a discipline consultant: read-mostly reviewer — drawings, the register, the Site Map, project health
    consultant: ['inbox', 'drawings', 'decision-log', 'places', 'client-health'],
    // Phase 6 task 4d-ii-b / B2 — the architect's screens, from the role's ROLE_POLICY rows: the
    // Inbox (the awaiting-countersign item, B3), the Decision Log (Countersign / Reject back / Forward
    // on and the consultation surface, B4/B5b), the drawing register and the Site Map (`project.read`).
    // No session can carry the role until 4d-iii drops the doors; the list is what such a session lands on.
    architect: ['inbox', 'decision-log', 'drawings', 'places'],
  };
  return keys[role].map((k) => SCREEN_META[k]);
}

/**
 * Phase 6 task 4b (§A.3 round 4) — the decision-approval ROUTE follows the decider: a viewer who
 * is the DECIDER of at least one open (pending/change, published) decision may reach the
 * approval surface (`client-decisions`) even when their role's static list omits it — the Inbox
 * CTA lands and STAYS there — while a same-role non-decider still has no route. The caller
 * (RouteBridge) computes `isOpenDecider` from the store with the shared `viewerIsDecider`
 * predicate; this helper just applies it to the allowed-screen set.
 */
export function withDeciderRoute(allowed: ScreenKey[], isOpenDecider: boolean): ScreenKey[] {
  if (!isOpenDecider || allowed.includes('client-decisions')) return allowed;
  return [...allowed, 'client-decisions'];
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
  architect: 'Architect',
};

/**
 * Phase 6 task 4d-ii-b / B2 — the roles the server RESERVES behind the architect chain's rollout
 * (`rollout.phase6_4d`, §A.1): while 4d-i's doors stand the server refuses every membership or
 * designation in them 409, so no switcher or picker may offer them (ui-server-parity; P28b / P34's
 * web arm). Registered in the API's role tripwire, which pins this literal.
 */
export const RESERVED_ROLES: readonly Role[] = ['architect'];

/** Every persona the product knows, in switcher order — derived from `ROLE_LABEL`, a `Record<Role, string>`,
 *  so adding a role to the union forces a label here and every consumer of `rolesFor` gains the option
 *  with no further edit (#584 review round 11: two hand-written copies of this list once disagreed). */
export const ALL_ROLES = Object.keys(ROLE_LABEL) as Role[];

/** The personas offered while the chain is RESERVED — computed ONCE so `rolesFor` returns a stable
 *  reference per rollout value (a store selector returning a fresh array every read re-renders forever). */
const UNRESERVED_ROLES: readonly Role[] = ALL_ROLES.filter((r) => !RESERVED_ROLES.includes(r));

/**
 * THE persona list for a given rollout state — the ONE selector every switcher and picker reads
 * (the rail's `RolePicker`, the phone's `TopBar` switcher, the Team screen's pickers; B2), through
 * the store's `selectRoles`. `'reserved'` (the fail-closed default, B1) hides `RESERVED_ROLES`;
 * `'open'` — only once 4d-iii drops the doors and the shell says so — offers them all. A static
 * list here would offer the architect before the server admits one (#677 review, finding 4145060015).
 */
export function rolesFor(rollout: Phase6_4dRollout): readonly Role[] {
  return rollout === 'open' ? ALL_ROLES : UNRESERVED_ROLES;
}

export const ROLE_SUBTITLE: Record<Role, string> = {
  pmc: 'Architect · full access',
  client: 'Owner · Mr. & Mrs. Shah',
  engineer: 'Site Engineer · Ramesh',
  contractor: 'Contractor · read-only',
  consultant: 'Discipline consultant · reviews',
  architect: 'Architect · countersigns decisions',
};
