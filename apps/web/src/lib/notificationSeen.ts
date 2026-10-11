import type { AppNotification } from '@vitan/shared';

/**
 * Top 10 #4b unit D (#778) — the bell's per-notice read state on this device, for ONE project.
 *
 * The server owns read state: a notice is unread for this viewer until it holds a receipt, and the
 * snapshot serves that as `unread`. Opening the bell submits the displayed unread ids to
 * `POST /notifications/seen` (unit C), which answers `200 { confirmed }`: the submitted ids that were
 * served to the viewer at its eligibility read and now hold a durable receipt. Request success alone
 * confirms nothing, and a confirmation is not a promise that the notice is still visible.
 *
 * Each id moves `unread → pending(attempt) → confirmed | unacknowledged(attempt)`:
 * - a notice is suppressed (not counted unread) ONLY while its mark is in flight or once the server
 *   confirmed that id;
 * - an id missing from `confirmed` is `unacknowledged` and counts unread. It is never resent on its
 *   own: a later bell open resends it only after a snapshot applied since that answer still serves it
 *   `unread: true`, and a snapshot that no longer serves it drops it with no request;
 * - a failed request returns only the ids still owned by THAT attempt to unread, so an older failure
 *   or partial answer can never undo a newer confirmation;
 * - a stale `unread: true` snapshot overrides neither a pending nor a confirmed id, and never hides
 *   an unacknowledged one; a confirmed id is retired once a snapshot serves it `unread: false`, or
 *   once it leaves the feed.
 *
 * The state is project-owned and reset on every project switch (`projectScope.ts`); the store drops
 * a response that returns after a switch.
 */

/** Unit C's cap: at most this many ids per request. */
export const SEEN_CHUNK_SIZE = 200;

export type SeenEntry =
  | { kind: 'pending'; attempt: number }
  | { kind: 'confirmed' }
  /** `resendable`: a snapshot applied since the answer still serves the notice `unread: true`. */
  | { kind: 'unacknowledged'; attempt: number; resendable: boolean };

export interface NotifSeenState {
  entries: Record<string, SeenEntry>;
  nextAttempt: number;
}

export const emptyNotifSeen = (): NotifSeenState => ({ entries: {}, nextAttempt: 1 });

/**
 * Whether the bell counts this notice as unread. A notice the server marks `unread: false` is read; one
 * with no `unread` at all (a local or demo notice, or a server that predates unit C) keeps the
 * delivered behaviour and counts.
 */
export function showsUnread(n: AppNotification, state: NotifSeenState): boolean {
  if (n.unread === false) return false;
  const entry = n.id ? state.entries[n.id] : undefined;
  return !(entry?.kind === 'pending' || entry?.kind === 'confirmed');
}

export function unreadCount(notifications: readonly AppNotification[], state: NotifSeenState): number {
  let count = 0;
  for (const n of notifications) if (showsUnread(n, state)) count += 1;
  return count;
}

/**
 * The ids one bell open submits, in display order and in chunks of at most {@link SEEN_CHUNK_SIZE}:
 * each displayed notice the server serves `unread: true` that is not already in flight or confirmed,
 * and not an unacknowledged id no fresh snapshot has re-served.
 */
export function planSeenChunks(notifications: readonly AppNotification[], state: NotifSeenState): string[][] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const n of notifications) {
    if (!n.id || n.unread !== true || seen.has(n.id)) continue;
    seen.add(n.id);
    const entry = state.entries[n.id];
    if (!entry || (entry.kind === 'unacknowledged' && entry.resendable)) ids.push(n.id);
  }
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += SEEN_CHUNK_SIZE) chunks.push(ids.slice(i, i + SEEN_CHUNK_SIZE));
  return chunks;
}

/** A chunk is about to be sent: its ids become pending under a new attempt, which is returned. */
export function beginSeenAttempt(state: NotifSeenState, ids: readonly string[]): number {
  const attempt = state.nextAttempt;
  state.nextAttempt += 1;
  for (const id of ids) state.entries[id] = { kind: 'pending', attempt };
  return attempt;
}

/**
 * The server answered `confirmed` for a chunk sent as `attempt`. A confirmed id is durable, so it is
 * confirmed whatever attempt now owns it. An unconfirmed id becomes unacknowledged only while this
 * attempt still owns it: a newer attempt's state is never overwritten by an older answer.
 */
export function applySeenConfirmed(state: NotifSeenState, attempt: number, ids: readonly string[], confirmed: readonly string[]): void {
  const sent = new Set(ids);
  const ok = new Set(confirmed.filter((id) => sent.has(id)));
  for (const id of ids) {
    if (ok.has(id)) {
      state.entries[id] = { kind: 'confirmed' };
      continue;
    }
    const entry = state.entries[id];
    if (entry?.kind === 'pending' && entry.attempt === attempt) {
      state.entries[id] = { kind: 'unacknowledged', attempt, resendable: false };
    }
  }
}

/** The request for `attempt` failed: only the ids it still owns return to unread. */
export function applySeenFailure(state: NotifSeenState, attempt: number, ids: readonly string[]): void {
  for (const id of ids) {
    const entry = state.entries[id];
    if (entry?.kind === 'pending' && entry.attempt === attempt) delete state.entries[id];
  }
}

/**
 * A snapshot was applied. Pending ids wait for their answer. A confirmed id is retired once the server
 * serves it read, or once it leaves the feed; a stale `unread: true` leaves it suppressed. An
 * unacknowledged id leaves local state when the feed no longer serves it (no request) or serves it read,
 * and becomes resendable when the feed still serves it unread.
 */
export function reconcileSeen(state: NotifSeenState, notifications: readonly AppNotification[]): void {
  const byId = new Map<string, AppNotification>();
  for (const n of notifications) if (n.id) byId.set(n.id, n);
  for (const [id, entry] of Object.entries(state.entries)) {
    if (entry.kind === 'pending') continue;
    const n = byId.get(id);
    if (!n || n.unread === false) {
      delete state.entries[id];
      continue;
    }
    if (entry.kind === 'unacknowledged' && n.unread === true) entry.resendable = true;
  }
}
