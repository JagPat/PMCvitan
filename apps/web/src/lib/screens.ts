import type { Role, ScreenKey } from '@vitan/shared';
import {
  LayoutDashboard,
  CalendarDays,
  ClipboardList,
  ClipboardCheck,
  BadgeCheck,
  Activity,
  NotebookPen,
  ListChecks,
  PencilRuler,
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
  dashboard: { key: 'dashboard', label: 'Dashboard', short: 'Dashboard', path: '/dashboard', icon: LayoutDashboard },
  'site-schedule': { key: 'site-schedule', label: 'Site Schedule', short: 'Schedule', path: '/schedule', icon: CalendarDays },
  'decision-log': { key: 'decision-log', label: 'Decision Log', short: 'Log', path: '/decisions', icon: ClipboardList },
  'inspect-review': { key: 'inspect-review', label: 'Inspection Review', short: 'Review', path: '/review', icon: ClipboardCheck },
  'client-decisions': { key: 'client-decisions', label: 'Decisions Waiting', short: 'Decisions', path: '/client/decisions', icon: BadgeCheck },
  'client-health': { key: 'client-health', label: 'Project Health', short: 'Health', path: '/client/health', icon: Activity },
  'daily-log': { key: 'daily-log', label: 'Daily Site Log', short: 'Daily', path: '/site/log', icon: NotebookPen },
  'engineer-check': { key: 'engineer-check', label: "Today's Checklist", short: 'Checklist', path: '/site/checklist', icon: ListChecks },
  drawings: { key: 'drawings', label: 'Drawings', short: 'Drawings', path: '/drawings', icon: PencilRuler },
  team: { key: 'team', label: 'Team', short: 'Team', path: '/team', icon: Users },
  portfolio: { key: 'portfolio', label: 'Portfolio', short: 'Portfolio', path: '/portfolio', icon: LayoutGrid },
  'team-access': { key: 'team-access', label: 'Team Access & Login', short: 'Access', path: '/access', icon: LogIn },
};

/** Permission-filtered screen list per role (mirrors the prototype's screensFor). */
export function screensFor(role: Role): ScreenMeta[] {
  const keys: Record<Role, ScreenKey[]> = {
    pmc: ['dashboard', 'site-schedule', 'decision-log', 'inspect-review', 'drawings', 'team', 'portfolio'],
    client: ['client-decisions', 'client-health', 'decision-log', 'drawings'],
    engineer: ['daily-log', 'engineer-check', 'drawings', 'team-access', 'decision-log'],
    contractor: ['drawings', 'team-access', 'decision-log'],
  };
  return keys[role].map((k) => SCREEN_META[k]);
}

export function pathForScreen(screen: ScreenKey): string {
  return SCREEN_META[screen].path;
}

export function screenForPath(path: string): ScreenKey | null {
  const entry = Object.values(SCREEN_META).find((m) => m.path === path);
  return entry ? entry.key : null;
}

/** Which persona owns each screen — for the temporary role switcher / route guard. */
export const ROLE_LABEL: Record<Role, string> = {
  pmc: 'PMC',
  client: 'Client',
  engineer: 'Engineer',
  contractor: 'Contractor',
};

export const ROLE_SUBTITLE: Record<Role, string> = {
  pmc: 'Architect · full access',
  client: 'Owner · Mr. & Mrs. Shah',
  engineer: 'Site Engineer · Ramesh',
  contractor: 'Contractor · read-only',
};
