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

/** The screen a notice of `kind` opens for `role`, validated against the role's own nav, so a tap can
 *  never land somewhere the role can't go (RouteBridge would bounce it). */
function screenForKind(kind: NotificationKind, role: Role): ScreenKey | null {
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
 * Which screen a notification should jump to for the given role — the bridge from the bell to
 * the "For You" world. Returns null when the role has no relevant screen (the notification is
 * then not a link).
 */
export function notificationTarget(text: string, role: Role): ScreenKey | null {
  const kind = notificationKind(text);
  return kind ? screenForKind(kind, role) : null;
}

/**
 * Live bug 1 (deep-link target fidelity) — what a notification opens: its screen AND, where the
 * notice NAMES one record, that record. A notice names a record only through structure, never by a
 * guess:
 *
 * - a `decisionId` (the server's, judged against the viewer's slice, or a local writer's);
 * - an inspection id (`INSP-N`) in its text;
 * - one of the fixed notice templates that quote a decision title, or an inspection's work and zone,
 *   matched EXACTLY against the viewer's records (never by substring: a near title is another record).
 *
 * A notice that names nothing opens its screen, as it always did. A named record that the settled
 * records do not hold is `missing`, and the bell says so; while the records it must be matched against
 * are still loading (or failed), it is `loading` rather than wrongly missing. Two records that both
 * match exactly name neither, and the notice opens its screen.
 */
export interface NotificationLink {
  screen: ScreenKey;
  item: string | null;
  missing: boolean;
  loading: boolean;
}

/** The records a notice may name, from the viewer's own slices (nothing here widens access). */
export interface NotificationRecords {
  /** `awaitsViewer`: the decision is open and this viewer is its decider (the client's approval screen
   *  shows exactly those; every other decision is read in the Decision Log). */
  decisions: readonly { id: string; title: string; awaitsViewer: boolean }[];
  /** false while the decision slice is loading or failed: a title cannot be judged absent then */
  decisionsSettled: boolean;
  /** Inspections the Inspection Review screen can show: the review queue and the outstanding
   *  checklists (a re-inspection task is an outstanding checklist until it is submitted). */
  inspections: readonly { id: string; title: string; zone: string }[];
  inspectionsSettled: boolean;
}

/** The store fields that decide whether a slice can be trusted to say a record is absent. */
export interface SliceSettledState {
  projectLoadState: string;
  commandReconcilePending: boolean;
  decisionsLoad: 'idle' | 'loading' | 'ready' | 'error';
  inspectionsLoad: 'idle' | 'loading' | 'ready' | 'error';
}

// Codex 4204448859 / 4205058538 — ONE definition of "settled" for every judge (the bell, the Decision
// Log, Inspection Review): a committed command whose reconcile is still owed has retained the
// pre-command slices, whichever read mode owns them, so no arm may call them settled until it lands.
const projectSettled = (s: SliceSettledState): boolean =>
  !s.commandReconcilePending && (s.projectLoadState === 'ready' || s.projectLoadState === 'idle');

export const decisionsSliceSettled = (s: SliceSettledState): boolean =>
  projectSettled(s) && (s.decisionsLoad === 'ready' || s.decisionsLoad === 'idle');

/** `moduleOwned`: the inspections read mode is `moduleQuery`, so the slice has its own load state. */
export const inspectionsSliceSettled = (s: SliceSettledState, moduleOwned: boolean): boolean =>
  !s.commandReconcilePending && (moduleOwned ? s.inspectionsLoad === 'ready' : projectSettled(s));

/** The decision-notice templates that quote a title (legacy rows, and the demo seed, carry no id). */
const DECISION_TITLE_TEMPLATES: readonly RegExp[] = [
  /^Decision awaiting approval: (.+)$/,
  /^New decision issued for approval: (.+)$/,
  /^Client approved (.+) — [^—]*$/,
];
const INSPECTION_ID = /\bINSP-\d+\b/;
/** "Re-inspection due: <work>, <zone>" — names its work and place, but no id. */
const REINSPECTION_DUE = /^Re-inspection due:\s*(.+?),\s*(.+)$/i;
/** "New checklist issued: <title> — <zone>" — the checklist writer's notice (inspections.service). */
const CHECKLIST_ISSUED = /^New checklist issued:\s*(.+) — (.+)$/;

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

type Match = { kind: 'one'; id: string } | { kind: 'none' } | { kind: 'many' };
function matchOf(ids: readonly string[]): Match {
  const unique = [...new Set(ids)];
  return unique.length === 1 ? { kind: 'one', id: unique[0] } : unique.length === 0 ? { kind: 'none' } : { kind: 'many' };
}

function decisionLink(n: AppNotification, role: Role, records: NotificationRecords): NotificationLink | null {
  const fallback = screenForKind('decision', role);
  if (!fallback) return null;
  // the client's approval screen shows only decisions awaiting that client; any other decision is
  // opened where it can be read, the Decision Log (every role holds it). Codex 4203960922 — "awaiting"
  // is read only from a SETTLED decision slice: a command snapshot can carry the new notice while the
  // slice still holds the decision's previous state, and the register is right in every state.
  const screenFor = (id: string): ScreenKey =>
    role === 'client' && !(records.decisionsSettled && records.decisions.some((d) => d.id === id && d.awaitsViewer)) ? 'decision-log' : fallback;
  const open = (id: string): NotificationLink => ({ screen: screenFor(id), item: id, missing: false, loading: false });

  if (n.decisionId !== undefined) return open(n.decisionId);
  const title = DECISION_TITLE_TEMPLATES.map((re) => n.text.match(re)?.[1]).find((t) => t !== undefined);
  if (title === undefined) return { screen: fallback, item: null, missing: false, loading: false };
  if (!records.decisionsSettled) return { screen: fallback, item: null, missing: false, loading: true };
  const match = matchOf(records.decisions.filter((d) => d.title === title).map((d) => d.id));
  if (match.kind === 'one') return open(match.id);
  return { screen: fallback, item: null, missing: match.kind === 'none', loading: false };
}

function inspectionLink(n: AppNotification, screen: ScreenKey, records: NotificationRecords): NotificationLink {
  const plain: NotificationLink = { screen, item: null, missing: false, loading: false };
  const named = n.text.match(INSPECTION_ID)?.[0];
  if (named) return { ...plain, item: named };

  let candidates: readonly { id: string; title: string; zone: string }[] | null = null;
  const due = n.text.match(REINSPECTION_DUE);
  const issued = n.text.match(CHECKLIST_ISSUED);
  if (due) {
    // Codex 4203960929 — EXACT only: the re-inspection task the server files for this work
    // ("Re-inspection: <work>") or an inspection titled exactly <work>, in that zone. A title that
    // merely contains the work ("Basement Waterproofing") is another record, never a stand-in.
    const [, work, zone] = due;
    candidates = records.inspections.filter((i) => same(i.zone, zone) && (same(i.title, `Re-inspection: ${work}`) || same(i.title, work)));
  } else if (issued) {
    const [, title, zone] = issued;
    candidates = records.inspections.filter((i) => same(i.title, title) && same(i.zone, zone));
  }
  if (candidates === null) return plain;
  if (!records.inspectionsSettled) return { ...plain, loading: true };
  const match = matchOf(candidates.map((i) => i.id));
  if (match.kind === 'one') return { ...plain, item: match.id };
  return { ...plain, missing: match.kind === 'none' };
}

export function notificationLink(n: AppNotification, role: Role, records: NotificationRecords): NotificationLink | null {
  // a structured decision id decides the kind before any wording does ("…: Material selection" is a decision)
  const kind = n.decisionId !== undefined ? 'decision' : notificationKind(n.text);
  if (!kind) return null;
  if (kind === 'decision') return decisionLink(n, role, records);
  const screen = screenForKind(kind, role);
  if (!screen) return null;
  // a screen that cannot show one record (the field checklist, the daily log, …) opens as before
  if (kind !== 'inspection' || !ITEM_SCREENS.has(screen)) return { screen, item: null, missing: false, loading: false };
  return inspectionLink(n, screen, records);
}
