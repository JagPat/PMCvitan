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
 * Live bug 1a (deep-link target fidelity, decisions) — what a notification opens: its screen AND,
 * where a DECISION notice names one decision, that decision. A notice names a decision only through
 * structure, never by a guess:
 *
 * - a `decisionId` (the server's, judged against the viewer's slice, or a local writer's);
 * - one of the fixed decision-notice templates that quote a title, matched EXACTLY against the
 *   viewer's decisions (never by substring: a near title is another record);
 * - (live bug 1b) an inspection id (`INSP-N`) in its text, or one of the fixed inspection templates
 *   ("New checklist issued: <title> — <zone>", "Re-inspection due: <work>, <zone>"), matched as WHOLE
 *   text against the inspections the target screen can show.
 *
 * A notice that names nothing opens its screen, as it always did (drawing notices are resolved to their
 * records by unit 1c). A named record that the settled slice does not hold is `missing`, and the bell
 * says so; while that slice is still loading (or failed), it is `loading` rather than wrongly missing.
 * Two records that both match exactly name neither, and the notice opens its screen.
 */
export interface NotificationLink {
  screen: ScreenKey;
  item: string | null;
  missing: boolean;
  loading: boolean;
}

/** The decisions a notice may name: exactly those the Decision Log shows this viewer (nothing here
 *  widens access, and a notice never resolves to a row its destination would hide). */
export interface NotificationRecords {
  /** `awaitsViewer`: the decision is open and this viewer is its decider — exactly the rows the
   *  approval screen shows; every other decision is read in the Decision Log. */
  decisions: readonly { id: string; title: string; awaitsViewer: boolean }[];
  /** false while the decision slice is loading, failed or still reconciling a command: a title
   *  cannot be judged absent, nor a decision judged awaiting, then */
  decisionsSettled: boolean;
  /** Live bug 1b — the inspections each inspection screen can show this viewer: Inspection Review's
   *  queue and outstanding checklists (`review`), and the engineer's field checklists (`field`). A
   *  notice is matched only against the screen it opens, so it never resolves to a record that screen
   *  cannot show. */
  inspections: { review: readonly InspectionRecord[]; field: readonly InspectionRecord[] };
  inspectionsSettled: boolean;
}

export interface InspectionRecord { id: string; title: string; zone: string }

/** The store fields that decide whether a slice can be trusted. */
export interface SliceSettledState {
  projectLoadState: string;
  commandReconcilePending: boolean;
  decisionsLoad: 'idle' | 'loading' | 'ready' | 'error';
  inspectionsLoad: 'idle' | 'loading' | 'ready' | 'error';
}

/**
 * ONE definition of "settled" for every judge (the bell and the Decision Log). Codex 4204448859 — a
 * committed command whose reconcile is still owed (`commandReconcilePending`) has retained the
 * pre-command slice, so it is not settled until that reconcile lands.
 */
const projectSettled = (s: Pick<SliceSettledState, 'projectLoadState' | 'commandReconcilePending'>): boolean =>
  !s.commandReconcilePending && (s.projectLoadState === 'ready' || s.projectLoadState === 'idle');

export const decisionsSliceSettled = (s: Pick<SliceSettledState, 'projectLoadState' | 'commandReconcilePending' | 'decisionsLoad'>): boolean =>
  projectSettled(s) && (s.decisionsLoad === 'ready' || s.decisionsLoad === 'idle');

/** Live bug 1b (Codex 4205058538) — the inspection slice, in either read mode: `moduleOwned` (the
 *  `moduleQuery` read) is settled by its own read, the snapshot mode by the project read, and BOTH are
 *  unsettled while a committed command's reconcile is owed. */
export const inspectionsSliceSettled = (s: SliceSettledState, moduleOwned: boolean): boolean =>
  !s.commandReconcilePending && (moduleOwned ? s.inspectionsLoad === 'ready' : projectSettled(s));

/**
 * The decision-notice templates that quote a title (legacy rows, and the demo seed, carry no id).
 * `dash`: the title is followed by " — <material>" — titles and materials may themselves contain an em
 * dash, so the title is never split out of the text: a decision matches when the text is exactly its
 * prefix, its title and " — " and more (Codex 4206188348), and two such titles name neither.
 */
const DECISION_TITLE_TEMPLATES: readonly { prefix: string; dash: boolean }[] = [
  { prefix: 'Decision awaiting approval: ', dash: false },
  { prefix: 'New decision issued for approval: ', dash: false },
  { prefix: 'Client approved ', dash: true },
];
const DASH = ' — ';

/** The decision template a notice is in, if any. */
function decisionTemplateOf(text: string): { prefix: string; dash: boolean } | null {
  return DECISION_TITLE_TEMPLATES.find((t) =>
    text.startsWith(t.prefix) && text.length > t.prefix.length && (!t.dash || text.indexOf(DASH, t.prefix.length + 1) > 0)) ?? null;
}

type Match = { kind: 'one'; id: string } | { kind: 'none' } | { kind: 'many' };
function matchOf(ids: readonly string[]): Match {
  const unique = [...new Set(ids)];
  return unique.length === 1 ? { kind: 'one', id: unique[0] } : unique.length === 0 ? { kind: 'none' } : { kind: 'many' };
}

function decisionLink(n: AppNotification, role: Role, records: NotificationRecords): NotificationLink | null {
  const fallback = screenForKind('decision', role);
  if (!fallback) return null;
  // A named decision opens on the approval screen exactly when a SETTLED slice shows it awaiting THIS
  // viewer — whatever their role: an engineer, contractor or consultant named as decider is granted
  // that route (`withDeciderRoute`), and it is the screen where they can act (Codex review 5440751865).
  // Every other decision — and any while the slice is unsettled (Codex 4203960922) — opens in the
  // Decision Log, which every role holds and which is right in every state.
  const screenFor = (id: string): ScreenKey =>
    records.decisionsSettled && records.decisions.some((d) => d.id === id && d.awaitsViewer) ? 'client-decisions' : 'decision-log';
  const open = (id: string): NotificationLink => ({ screen: screenFor(id), item: id, missing: false, loading: false });
  // a notice whose decision is not resolved — still loading, gone, or ambiguous — offers the register:
  // the approval screen shows only decisions confirmed awaiting this viewer (Codex 4206188340)
  const unresolved = (state: { missing?: boolean; loading?: boolean }): NotificationLink =>
    ({ screen: 'decision-log', item: null, missing: state.missing ?? false, loading: state.loading ?? false });

  if (n.decisionId !== undefined) return open(n.decisionId);
  const template = decisionTemplateOf(n.text);
  if (!template) return { screen: fallback, item: null, missing: false, loading: false };
  if (!records.decisionsSettled) return unresolved({ loading: true });
  const quoted = (title: string): boolean =>
    template.dash ? n.text.startsWith(`${template.prefix}${title}${DASH}`) : n.text === `${template.prefix}${title}`;
  const match = matchOf(records.decisions.filter((d) => quoted(d.title)).map((d) => d.id));
  if (match.kind === 'one') return open(match.id);
  return unresolved({ missing: match.kind === 'none' });
}

const INSPECTION_ID = /\bINSP-\d+\b/;
/** The inspection templates: "New checklist issued: <title> — <zone>" (the checklist writer) and
 *  "Re-inspection due: <work>, <zone>". A title, work or zone may hold a dash or a comma itself, so the
 *  text is never split: a record matches when the WHOLE text is its template (as for decisions). */
const CHECKLIST_ISSUED = 'New checklist issued: ';
const REINSPECTION_DUE = 'Re-inspection due: ';

function inspectionTemplateOf(text: string): 'issued' | 'due' | null {
  if (text.startsWith(CHECKLIST_ISSUED) && text.indexOf(DASH, CHECKLIST_ISSUED.length) > 0) return 'issued';
  if (text.startsWith(REINSPECTION_DUE) && text.indexOf(', ', REINSPECTION_DUE.length) > 0) return 'due';
  return null;
}

function inspectionLink(n: AppNotification, screen: ScreenKey, records: NotificationRecords): NotificationLink {
  const plain: NotificationLink = { screen, item: null, missing: false, loading: false };
  const named = n.text.match(INSPECTION_ID)?.[0];
  if (named) return { ...plain, item: named };
  const template = inspectionTemplateOf(n.text);
  if (!template) return plain;
  if (!records.inspectionsSettled) return { ...plain, loading: true };
  const pool = screen === 'engineer-check' ? records.inspections.field : records.inspections.review;
  // Codex 4203960929 — EXACT only. "Re-inspection due" names the re-inspection task the server files
  // for that work ("Re-inspection: <work>") or an inspection titled exactly <work>, in that zone; a
  // title that merely contains the work ("Basement Waterproofing") is another record, never a stand-in.
  const quoted = (i: InspectionRecord): boolean => template === 'issued'
    ? n.text === `${CHECKLIST_ISSUED}${i.title}${DASH}${i.zone}`
    : n.text === `${REINSPECTION_DUE}${i.title.replace(/^Re-inspection: /, '')}, ${i.zone}`;
  const match = matchOf(pool.filter(quoted).map((i) => i.id));
  if (match.kind === 'one') return { ...plain, item: match.id };
  return { ...plain, missing: match.kind === 'none' };
}

export function notificationLink(n: AppNotification, role: Role, records: NotificationRecords): NotificationLink | null {
  // structure decides the kind before any wording does: a decision id, or a decision or inspection
  // template — a quoted title may itself contain another kind's keyword ("…: Material selection")
  const kind = n.decisionId !== undefined || decisionTemplateOf(n.text)
    ? 'decision'
    : inspectionTemplateOf(n.text) ? 'inspection' : notificationKind(n.text);
  if (!kind) return null;
  if (kind === 'decision') return decisionLink(n, role, records);
  const screen = screenForKind(kind, role);
  if (!screen) return null;
  // a screen that cannot show one record (the daily log, the drawings register until unit 1c) opens as before
  if (kind !== 'inspection' || !ITEM_SCREENS.has(screen)) return { screen, item: null, missing: false, loading: false };
  return inspectionLink(n, screen, records);
}
