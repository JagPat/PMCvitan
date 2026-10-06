import type { ApiGateway, NewProjectInput } from '@/data/apiGateway';

/**
 * Legacy-copy recovery — the pure parts of the project-create hold (replaces #716).
 *
 * A project create carries ONE idempotency key per attempt, and the server answers a retry under that
 * key with the first create's project (`orgs.createProject.receipt`, #717). The client's job is never to
 * lose an attempt whose outcome is unknown, and never to mint a second key while one may still commit.
 * The store binds these helpers to its session and state; everything here is free of store state so each
 * rule can be read, and tested, on its own:
 *
 * - the MIRROR: the attempt, its key and its request, kept per user in localStorage, so a reload, another
 *   tab or the same user's next sign-in still sees it and finishes it only as itself;
 * - the RESERVATION: reading the mirror, minting the key and writing the in-flight record under one
 *   exclusive Web Lock per user, so two tabs cannot both read "no hold";
 * - the CAPABILITY check: nothing is sent to a server that does not keep create receipts.
 */

/** The mirrored record of one create attempt. */
export type StoredCreateHold = {
  attempt: string;
  /** The reservation that holds the attempt now; only it may release or settle it (see the store). */
  lease?: string;
  phase: 'in_flight' | 'unknown';
  orgId: string;
  input: NewProjectInput;
  message?: string;
};

const createHoldKey = (scope: string): string => `vitan.projectCreateHold.${scope}`;

export const FOREIGN_CREATE_HOLD = 'A project create from another tab, or from before this page reloaded, was not confirmed. Try again to finish it — it is safe: the server answers a retry of that same request without making a second project.';

/** The mirror's record for this scope, or `null` when there is none or storage cannot be read (and then
 *  it cannot be written either, so {@link writeStoredCreateHold} refuses and nothing is sent). */
export function readStoredCreateHold(scope: string): StoredCreateHold | null {
  try {
    const raw = globalThis.localStorage?.getItem(createHoldKey(scope));
    return raw ? (JSON.parse(raw) as StoredCreateHold) : null;
  } catch {
    return null;
  }
}

/** Write (or clear) the mirror; `false` when site storage refused it. */
export function writeStoredCreateHold(scope: string, hold: StoredCreateHold | null): boolean {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return false;
    if (hold) storage.setItem(createHoldKey(scope), JSON.stringify(hold));
    else storage.removeItem(createHoldKey(scope));
    return true;
  } catch {
    return false;
  }
}

/** The scope a hold, its mirror and its lock are kept under: the token's subject, or — under passwordless
 *  dev auth, which keeps no token — the session user, so two dev identities never share one hold or one
 *  key (Codex 4187372380). */
export function createHoldScope(tokenSubject: string | null, sessionUserId: string | null): string {
  if (tokenSubject) return tokenSubject;
  return sessionUserId ? `dev:${sessionUserId}` : 'anon';
}

/** Durable or nothing (Codex 4187372392, 4187663033): the mirror is the only thing that carries an attempt
 *  and its key past this document. A live lock dies with the page while its request may still commit, so
 *  when site storage refuses the mirror, no create is sent at all. */
export const NO_DURABLE_HOLD = 'This browser is blocking site storage, so a project create could not be recovered if this page closed. Nothing was sent — allow site storage for this site, then try again.';

/** No cross-tab lock, no create (Codex 4187821139). */
export const NO_CROSS_TAB_LOCK = 'This browser cannot keep a project create safe across tabs (it lacks Web Locks). Nothing was sent — update the browser, then try again.';

/**
 * The cross-tab RESERVATION (Codex 4187151998): localStorage has no compare-and-set, so two tabs could
 * both read "no hold", each mint a key and each create a project. `fn` — read the mirror, mint the key,
 * write the in-flight record — runs under ONE exclusive Web Lock per scope, shared by every tab of this
 * origin; the next tab's turn reads the record this one wrote. The send runs after the lock is released
 * (the record, not the lock, holds other tabs off).
 *
 * `null` when there is no lock to reserve under, or the browser refuses it: without one, two tabs could
 * each read an empty mirror and mint a key, so the caller sends NOTHING — never a tab-local reservation.
 */
export async function withCreateReservation<T>(scope: string, fn: () => T | Promise<T>): Promise<T | null> {
  const locks = (globalThis.navigator as (Navigator & { locks?: LockManager }) | undefined)?.locks;
  if (typeof locks?.request !== 'function') return null;
  try {
    return (await locks.request(`vitan.projectCreate.${scope}`, { mode: 'exclusive' }, async () => fn())) as T;
  } catch {
    return null;
  }
}

/** The feature #717's `/health` advertises: a keyed create keeps a receipt and replays it. */
export const PROJECT_CREATE_RECEIPTS = 'orgs.createProject.receipt';
export const SERVER_NOT_READY = 'The server is being updated and cannot take a new project yet. Nothing was sent — try again in a minute.';
export const SERVER_NOT_READY_RETRY = 'The server is being updated and cannot safely finish this create yet. Nothing was sent — try again in a minute.';

/** The web and API deploy separately (Codex 4187372404): a bundle served ahead of its API would retry an
 *  unknown create against a server that ignores the key, and make it twice. So the server must say it
 *  keeps receipts before any keyed create or retry is sent; a probe that fails says no. */
export async function serverKeepsCreateReceipts(gw: ApiGateway): Promise<boolean> {
  try {
    return (await gw.serverFeatures()).includes(PROJECT_CREATE_RECEIPTS);
  } catch {
    return false;
  }
}
