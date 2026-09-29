import { engineerNavLabels, navLabels, type Lang, type Role, type ScreenKey } from '@vitan/shared';

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
 *  For You (what needs me) · Schedule (when) · Places (where) · Portfolio (which project). */
export const MOBILE_PRIMARY_PREFERENCE: readonly ScreenKey[] = ['inbox', 'site-schedule', 'places', 'portfolio'];

/** Tabs beside "More". Five bars fit a 390px viewport at a 44px touch target; four plus More is the cap. */
export const MOBILE_PRIMARY_SLOTS = 4;

/** With no overflow there is nothing for More to hold, so the bar may use all five slots. */
export const MOBILE_MAX_TABS = MOBILE_PRIMARY_SLOTS + 1;

/**
 * UX foundations (owner design brief) — a role whose phone day has a fixed rhythm gets its own,
 * shorter bar. The site engineer's is Today · Site · More: For You is their day, the daily site
 * log is their site, and every other screen they hold stays one tap away behind More. This
 * supersedes Unit E's single-preference-list recommendation (E3) for the engineer only; every
 * other role keeps the shared rule.
 */
export const MOBILE_ROLE_PRIMARY: Partial<Record<Role, readonly ScreenKey[]>> = {
  engineer: ['inbox', 'daily-log'],
};

/** The bar/More label for a screen, in the viewer's language (the engineer's two fixed tabs carry
 *  their day names). English equals `SCREEN_META.short` for every other screen. */
export function navLabelFor(key: ScreenKey, role: Role, lang: Lang): string {
  const own = role === 'engineer' ? engineerNavLabels[key] : undefined;
  return (own ?? navLabels[key])[lang];
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
export function splitMobileNav<T extends { key: ScreenKey }>(items: readonly T[], role?: Role): MobileNavSplit<T> {
  const fixed = role ? MOBILE_ROLE_PRIMARY[role] : undefined;
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
