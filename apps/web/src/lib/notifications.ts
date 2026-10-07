import type { AppNotification, Role, ScreenKey } from '@vitan/shared';
import { ITEM_SCREENS, screensFor } from './screens';

/**
 * The subject a notification is about, inferred from its (templated) text. The backend and the
 * demo both produce a small, fixed set of phrasings — "Decision awaiting approval: …", "Drawing
 * issued: …", "Client is building to …", "Re-inspection due: …", "Material mismatch: …" — so a
 * keyword match is reliable. Returns null when the text doesn't map to an actionable screen.
 */
export type NotificationKind = 'decision' | 'drawing' | 'inspection' | 'material';

export function notificationKind(text: string): NotificationKind | null {
  const t = text.toLowerCase();
  // order matters: "material mismatch: … ≠ approved DL-…" mentions a decision id, so match
  // material before decision; "re-inspection" contains "inspection" and is matched there.
  if (t.includes('material') || t.includes('mismatch')) return 'material';
  if (t.includes('drawing') || t.includes('building to')) return 'drawing';
  if (t.includes('inspection') || t.includes('checklist')) return 'inspection';
  if (t.includes('decision') || t.includes('approved')) return 'decision';
  return null;
}

/**
 * Which screen a notification should jump to for the given role — the bridge from the bell to
 * the "For You" world. Returns null when the role has no relevant screen (the notification is
 * then not a link). The target is always validated against the role's own nav, so tapping a
 * notification can never land somewhere the role can't go (RouteBridge would bounce it).
 */
export function notificationTarget(text: string, role: Role): ScreenKey | null {
  const kind = notificationKind(text);
  if (!kind) return null;
  const allowed = new Set(screensFor(role).map((m) => m.key));
  const pick = (...keys: ScreenKey[]): ScreenKey | null => keys.find((k) => allowed.has(k)) ?? null;
  switch (kind) {
    case 'decision':
      return role === 'client' ? pick('client-decisions', 'decision-log') : pick('decision-log');
    case 'drawing':
      return pick('drawings');
    case 'inspection':
      return pick('inspect-review', 'engineer-check');
    case 'material':
      return pick('daily-log', 'site-schedule');
  }
}

/**
 * Live bug 1 (deep-link target fidelity) — what a notification opens: its screen AND, where the
 * screen can show one record, that record. A notice about a decision opens the decision; a notice
 * about an inspection opens that inspection. A record the notice names by id is followed as given,
 * and the screen says so if it cannot show it. `missing` marks a notice that names no record at all
 * and whose title or place matches none the viewer can open: the bell then says so, instead of
 * dropping the viewer on the parent list as if that were the answer.
 */
export interface NotificationLink {
  screen: ScreenKey;
  item: string | null;
  missing: boolean;
}

/** The records a notice may name, from the viewer's own slices (nothing here widens access). */
export interface NotificationRecords {
  decisions: readonly { id: string; title: string }[];
  /** Inspections the Inspection Review screen can show: the review queue and the outstanding
   *  checklists (a re-inspection task is an outstanding checklist until it is submitted). */
  inspections: readonly { id: string; title: string; zone: string }[];
}

const INSPECTION_ID = /\bINSP-\d+\b/;
/** "Re-inspection due: <trade>, <zone>" — the shape that names its work and place but no id. */
const REINSPECTION_DUE = /re-inspection due:\s*(.+?),\s*(.+)$/i;

/** The ONE record among `candidates`, or null when there is none or more than one. */
function unique<T extends { id: string }>(candidates: readonly T[]): string | null {
  const ids = [...new Set(candidates.map((c) => c.id))];
  return ids.length === 1 ? ids[0] : null;
}

function decisionFor(n: AppNotification, records: NotificationRecords): string | null {
  // the server names a decision only when it is in this viewer's slice, so its id is followed as
  // given; the register itself says so if the decision is gone by the time it has loaded
  if (n.decisionId !== undefined) return n.decisionId;
  // a notice without the server's id (a legacy row, or one written locally): the decision whose
  // title it quotes, the LONGEST quoted title winning so "Living Room Flooring" is not shadowed by
  // a shorter title it contains; a tie is ambiguous and names nothing
  const quoted = records.decisions.filter((d) => d.title.trim() !== '' && n.text.includes(d.title));
  const longest = Math.max(0, ...quoted.map((d) => d.title.length));
  return unique(quoted.filter((d) => d.title.length === longest));
}

function inspectionFor(n: AppNotification, records: NotificationRecords): string | null {
  // an id the notice names is followed as given (the review screen says so if it cannot show it)
  const named = n.text.match(INSPECTION_ID)?.[0];
  if (named) return named;
  const due = n.text.match(REINSPECTION_DUE);
  if (!due) return null;
  const work = due[1].trim().toLowerCase();
  const zone = due[2].trim().toLowerCase();
  const here = records.inspections.filter((i) => i.zone.trim().toLowerCase() === zone && i.title.toLowerCase().includes(work));
  // the re-inspection TASK itself when one is out on site, else the one inspection of that work there
  const tasks = here.filter((i) => /^re-inspection\b/i.test(i.title));
  return unique(tasks.length > 0 ? tasks : here);
}

export function notificationLink(n: AppNotification, role: Role, records: NotificationRecords): NotificationLink | null {
  const screen = notificationTarget(n.text, role);
  if (!screen) return null;
  // a screen that cannot show one record (the field checklist, the daily log, …) opens as before
  if (!ITEM_SCREENS.has(screen)) return { screen, item: null, missing: false };
  const kind = notificationKind(n.text);
  const item =
    kind === 'decision' ? decisionFor(n, records)
    : kind === 'inspection' ? inspectionFor(n, records)
    : null;
  // a drawing notice names its sheet by number, not id; it opens the register as before
  if (kind !== 'decision' && kind !== 'inspection') return { screen, item: null, missing: false };
  return { screen, item, missing: item === null };
}
