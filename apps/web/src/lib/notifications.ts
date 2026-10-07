import type { AppNotification, Role, ScreenKey } from '@vitan/shared';
import { ITEM_SCREENS, screensFor } from './screens';
import { decisionsReadMode } from '@/data/apiGateway';

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
 * - (live bug 1b) an inspection id its WRITER stamped: "Re-inspection <id> created for …" and
 *   "New checklist issued: <title> — <zone> (<id>)". An id-less legacy inspection notice names nothing.
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
}

/** The store fields that decide whether a slice can be trusted. */
export interface SliceSettledState {
  projectLoadState: string;
  commandReconcilePending: boolean;
  commandReconcileModulesOnly: boolean;
  decisionsLoad: 'idle' | 'loading' | 'ready' | 'error';
  inspectionsLoad: 'idle' | 'loading' | 'ready' | 'error';
}

/**
 * ONE definition of "settled" for every judge (the bell and the Decision Log). Codex 4204448859 — a
 * committed command whose reconcile is still owed (`commandReconcilePending`) has retained the
 * pre-command slice, so it is not settled until that reconcile lands.
 */
type ReconcileState = Pick<SliceSettledState, 'commandReconcilePending' | 'commandReconcileModulesOnly'>;

/** Codex 4209321885 — an owed reconcile unsettles a slice only if the slice is one it is owed FOR: every
 *  slice after a superseded command snapshot, only module-owned slices after an applied one (the applied
 *  snapshot already refreshed the snapshot-owned ones). */
const reconcileOwed = (s: ReconcileState, moduleOwned: boolean): boolean =>
  s.commandReconcilePending && (moduleOwned || !s.commandReconcileModulesOnly);

const projectReady = (s: Pick<SliceSettledState, 'projectLoadState'>): boolean =>
  s.projectLoadState === 'ready' || s.projectLoadState === 'idle';

export const decisionsSliceSettled = (
  s: Pick<SliceSettledState, 'projectLoadState' | 'commandReconcilePending' | 'commandReconcileModulesOnly' | 'decisionsLoad'>,
  moduleOwned: boolean = decisionsReadMode() === 'moduleQuery',
): boolean =>
  !reconcileOwed(s, moduleOwned) && projectReady(s) && (s.decisionsLoad === 'ready' || s.decisionsLoad === 'idle');

/** Live bug 1b (Codex 4205058538) — the inspection slice, in either read mode: `moduleOwned` (the
 *  `moduleQuery` read) is settled by its own read, the snapshot mode by the project read, and either is
 *  unsettled while a committed command's reconcile is owed for it. */
export const inspectionsSliceSettled = (s: SliceSettledState, moduleOwned: boolean): boolean =>
  !reconcileOwed(s, moduleOwned) && (moduleOwned ? s.inspectionsLoad === 'ready' : projectReady(s));

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

/** The one notice that names an inspection by id: the re-inspection writer's own
 *  "Re-inspection <id> created for N item(s) — due …" (inspections.service). An id anywhere else is
 *  user text — a checklist titled "Follow-up INSP-21" names no record (Codex 4207530075). */
const REINSPECTION_CREATED = /^Re-inspection (INSP-\d+) created for /;
/** Codex 4209321875 — the checklist writer stamps the inspection it issued as the notice's LAST token,
 *  "New checklist issued: <title> — <zone> (<id>)" (inspections.service). A title or zone is user text,
 *  but nothing follows the writer's id, so the final "(INSP-N)" is always the writer's. */
const CHECKLIST_ISSUED_ID = /^New checklist issued: .+ \((INSP-\d+)\)$/;
/** The inspection notice prefixes: they decide the KIND before any keyword in the user text does. */
const INSPECTION_PREFIXES = ['New checklist issued: ', 'Re-inspection due: '];

function isInspectionNotice(text: string): boolean {
  return INSPECTION_PREFIXES.some((p) => text.startsWith(p) && text.length > p.length) || REINSPECTION_CREATED.test(text);
}

/**
 * An inspection notice names an inspection ONLY by the id its writer stamped. A legacy notice that
 * quotes a title and zone but no id names nothing: the inspection it announced may be decided, and a
 * later inspection may reuse the same title and zone (Codex 4209321875), so no current record is ever
 * matched to it — it opens its screen, where every outstanding inspection is listed.
 */
function inspectionLink(n: AppNotification, screen: ScreenKey): NotificationLink {
  const named = n.text.match(REINSPECTION_CREATED)?.[1] ?? n.text.match(CHECKLIST_ISSUED_ID)?.[1] ?? null;
  return { screen, item: named, missing: false, loading: false };
}

export function notificationLink(n: AppNotification, role: Role, records: NotificationRecords): NotificationLink | null {
  // structure decides the kind before any wording does: a decision id, or a decision or inspection
  // template — a quoted title may itself contain another kind's keyword ("…: Material selection")
  const kind = n.decisionId !== undefined || decisionTemplateOf(n.text)
    ? 'decision'
    : isInspectionNotice(n.text) ? 'inspection' : notificationKind(n.text);
  if (!kind) return null;
  if (kind === 'decision') return decisionLink(n, role, records);
  const screen = screenForKind(kind, role);
  if (!screen) return null;
  // a screen that cannot show one record (the daily log, the drawings register until unit 1c) opens as before
  if (kind !== 'inspection' || !ITEM_SCREENS.has(screen)) return { screen, item: null, missing: false, loading: false };
  return inspectionLink(n, screen);
}
