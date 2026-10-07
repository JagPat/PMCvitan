import type { AppNotification, Role, ScreenKey } from '@vitan/shared';
import { screensFor } from './screens';

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
 *   viewer's decisions (never by substring: a near title is another record).
 *
 * A notice that names nothing opens its screen, as it always did (inspection and drawing notices are
 * resolved to their records by the later units of this bug). A named decision that the settled slice
 * does not hold is `missing`, and the bell says so; while that slice is still loading (or failed), it
 * is `loading` rather than wrongly missing. Two decisions that both match exactly name neither, and
 * the notice opens its screen.
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

/** The store fields that decide whether the decision slice can be trusted. */
export interface SliceSettledState {
  projectLoadState: string;
  commandReconcilePending: boolean;
  decisionsLoad: 'idle' | 'loading' | 'ready' | 'error';
}

/**
 * ONE definition of "settled" for every judge (the bell and the Decision Log). Codex 4204448859 — a
 * committed command whose reconcile is still owed (`commandReconcilePending`) has retained the
 * pre-command slice, so it is not settled until that reconcile lands.
 */
export const decisionsSliceSettled = (s: SliceSettledState): boolean =>
  !s.commandReconcilePending
  && (s.projectLoadState === 'ready' || s.projectLoadState === 'idle')
  && (s.decisionsLoad === 'ready' || s.decisionsLoad === 'idle');

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

export function notificationLink(n: AppNotification, role: Role, records: NotificationRecords): NotificationLink | null {
  // structure decides the kind before any wording does: a decision id, or a decision template — a
  // quoted title may itself contain another kind's keyword ("…: Material selection") (Codex 4206188328)
  const kind = n.decisionId !== undefined || decisionTemplateOf(n.text) ? 'decision' : notificationKind(n.text);
  if (!kind) return null;
  if (kind === 'decision') return decisionLink(n, role, records);
  const screen = screenForKind(kind, role);
  return screen ? { screen, item: null, missing: false, loading: false } : null;
}
