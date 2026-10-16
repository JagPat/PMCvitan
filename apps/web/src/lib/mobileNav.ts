import { engineerNavLabels, homeNavLabels, navLabels, type Lang, type Role, type ScreenKey } from '@vitan/shared';
import { ROLE_SCREEN_LABEL } from './screens';

/**
 * Mobile information architecture: which of the role's permitted screens earn a permanent
 * bottom-tab slot, and which live behind "More".
 *
 * This is a PRESENTATION split over an ALREADY-FILTERED list. It never widens access: the
 * input is whatever `enabledScreensFor(role, enabledModules, capabilities)` produced, so a
 * screen the role, the enabled modules or the project's capabilities exclude is absent from
 * BOTH halves. A screen is never dropped — every input item lands in exactly one half.
 */

/** The destinations that earn a permanent tab, in the order they should appear.
 *  Dashboard (home, #811) · For You (what needs me) · Schedule (when) · Places (where) · Portfolio (which
 *  project); with four slots, the first four a role holds win. */
export const MOBILE_PRIMARY_PREFERENCE: readonly ScreenKey[] = ['dashboard', 'inbox', 'site-schedule', 'places', 'portfolio'];

/** Tabs beside "More". Five bars fit a 390px viewport at a 44px touch target; four plus More is the cap. */
export const MOBILE_PRIMARY_SLOTS = 4;

/** With no overflow there is nothing for More to hold, so the bar may use all five slots. */
export const MOBILE_MAX_TABS = MOBILE_PRIMARY_SLOTS + 1;

/**
 * UX foundations (owner design brief) — a role whose phone day has a fixed rhythm gets its own,
 * shorter bar. The site engineer's is Dashboard · Today · Site · More: the Dashboard is every role's home
 * (#811), For You is their day, the daily site log is their site, and every other screen they hold stays
 * one tap away behind More. This
 * supersedes Unit E's single-preference-list recommendation (E3) for the engineer only; every
 * other role keeps the shared rule.
 */
export const MOBILE_ROLE_PRIMARY: Partial<Record<Role, readonly ScreenKey[]>> = {
  engineer: ['dashboard', 'inbox', 'daily-log'],
  // Board decision 14 Oct 2026 (#482): the PMC reaches the Daily Site Log from its bar, beside the Site Map
  // (#633, the main way around a project). Schedule and Portfolio stay one tap away behind More.
  pmc: ['dashboard', 'inbox', 'daily-log', 'places'],
  // #482 QA item 2 (coordinator call, 14 Oct 2026): the contractor's bar is Dashboard · For You · Site Map ·
  // Drawings; Decisions (and Site Visits, where the server lets them read it) sit behind More
  contractor: ['dashboard', 'inbox', 'places', 'drawings'],
};

/**
 * Stage 1 redesign (#482, Rev 3.1 unit H1) — the bars on a project whose `home-nav` server switch is on
 * (`useHomeNav`). The engineer gains the Site Map beside Today and Site; the PMC's bar keeps its four tabs
 * (its "Daily" tab reads "Site Log", `homeNavLabels`). Every other role keeps today's bar. With the
 * switch off, `MOBILE_ROLE_PRIMARY` applies unchanged.
 */
export const MOBILE_ROLE_PRIMARY_HOME_NAV: Partial<Record<Role, readonly ScreenKey[]>> = {
  ...MOBILE_ROLE_PRIMARY,
  engineer: ['dashboard', 'inbox', 'daily-log', 'places'],
};

/** The bar/More label for a screen, in the viewer's language (the engineer's two fixed tabs carry
 *  their day names). English equals the `short` of the role's `screensFor` entry for every other screen,
 *  except where the project's `home-nav` switch renames it. */
export function navLabelFor(key: ScreenKey, role: Role, lang: Lang, homeNav = false): string {
  // #482 QA — a role's own English name for a screen ("Decisions" for the engineer, contractor, consultant)
  const renamed = lang === 'en' ? ROLE_SCREEN_LABEL[role]?.[key] : undefined;
  if (renamed) return renamed;
  const own = role === 'engineer' ? engineerNavLabels[key] : undefined;
  const stage1 = homeNav ? homeNavLabels[key] : undefined;
  return (own ?? stage1 ?? navLabels[key])[lang];
}

export interface MobileNavSplit<T> {
  /** the bottom-bar destinations, preference order first */
  primary: T[];
  /** everything else, in the role's own nav order — the More sheet's contents */
  secondary: T[];
}

/**
 * Split a role's permitted screens into bottom-bar tabs and More.
 *
 * The preferred destinations come first, in preference order, but only when the role actually
 * has them (a client has no Schedule and no Portfolio — nothing is fabricated). The bar is then
 * topped up from the role's remaining screens IN ROLE ORDER, so every role gets a full,
 * meaningful bar rather than a preference list padded with gaps. When the whole list already
 * fits (<= 5), nothing is hidden and no More tab is needed.
 */
export function splitMobileNav<T extends { key: ScreenKey }>(items: readonly T[], role?: Role, homeNav = false): MobileNavSplit<T> {
  const fixed = role ? (homeNav ? MOBILE_ROLE_PRIMARY_HOME_NAV : MOBILE_ROLE_PRIMARY)[role] : undefined;
  if (fixed) {
    // a role with its own bar keeps exactly those tabs it actually holds, in that order; a tab
    // whose module is off is simply absent (never fabricated), and if none survive, the
    // shared rule below applies
    const primary = fixed
      .map((key) => items.find((i) => i.key === key))
      .filter((i): i is T => i !== undefined);
    if (primary.length) {
      const chosen = new Set(primary.map((i) => i.key));
      return { primary, secondary: items.filter((i) => !chosen.has(i.key)) };
    }
  }
  if (items.length <= MOBILE_MAX_TABS) return { primary: [...items], secondary: [] };

  const preferred = MOBILE_PRIMARY_PREFERENCE
    .map((key) => items.find((i) => i.key === key))
    .filter((i): i is T => i !== undefined)
    .slice(0, MOBILE_PRIMARY_SLOTS);

  const chosen = new Set(preferred.map((i) => i.key));
  const primary = [...preferred];
  for (const item of items) {
    if (primary.length >= MOBILE_PRIMARY_SLOTS) break;
    if (chosen.has(item.key)) continue;
    chosen.add(item.key);
    primary.push(item);
  }

  return { primary, secondary: items.filter((i) => !chosen.has(i.key)) };
}
