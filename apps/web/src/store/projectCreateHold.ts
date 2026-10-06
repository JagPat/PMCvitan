import { newIdempotencyKey, type NewProjectInput } from '@/data/apiGateway';

/**
 * Legacy-copy recovery — the project-create HOLD ENGINE (replaces #718's store-bound hold).
 *
 * A project create carries ONE idempotency key per attempt, and the server answers a retry under that key
 * with the first create's project (`orgs.createProject.receipt`, #717/#719). The client must never lose an
 * attempt whose outcome is unknown, and never mint a second key while one may still commit.
 *
 * #718 kept that state twice — a per-tab in-memory hold AND a per-user localStorage mirror — and every
 * finding on its last heads (Codex 4192001251, 4192524377, 4192524383, 4192524390) was one more interleaving
 * in which the two disagreed. Here there is ONE source of truth:
 *
 * - the RECORD, per identity scope in localStorage: `held` (an attempt and the lease that holds it now) or
 *   `settled` (the attempt finished — confirmed, or definitely refused). A settled record is how another tab
 *   tells "finished elsewhere" from "storage was cleared" (a missing record), which releases nothing live;
 * - every TRANSITION — reserve, send, settle, release — runs under one exclusive Web Lock per scope, shared by
 *   every tab of the origin, and checks the record's lease before it writes (a compare-and-set);
 * - the only per-tab state is the LIVE set: the reservations this document holds, from the moment one is
 *   taken (so its own capability check reads as in flight here) until it is settled, released or fenced
 *   off. What a dialog shows is
 *   {@link createHoldView} — derived from the record and the live set for the CURRENT scope, so it changes
 *   with the record (another tab), with the live set (a reply) and with the identity (a sign-in).
 *
 * Every helper here is free of store state. The store binds them to its session, gateway and rendering.
 */

/** One create attempt's durable record. */
export type CreateRecord =
  | {
      state: 'held';
      attempt: string; // the create's idempotency key
      lease: string; // the reservation that holds the attempt NOW; only it may send, release or settle it
      phase: 'in_flight' | 'unknown';
      orgId: string;
      input: NewProjectInput;
      message?: string;
    }
  | { state: 'settled'; attempt: string };

/** What the dialog shows: nothing held, a create of THIS tab still out, or an attempt only "Try again" finishes. */
export type CreateHoldView =
  | null
  | { phase: 'in_flight'; attempt: string; scope: string; orgId: string; input: NewProjectInput }
  | { phase: 'unknown'; attempt: string; scope: string; orgId: string; input: NewProjectInput; message: string };

/** A reservation this document holds — reserved, or sent and awaiting its reply. */
export type LiveSend = { scope: string; attempt: string; lease: string; orgId: string; input: NewProjectInput };

export const FOREIGN_CREATE_HOLD = 'A project create from another tab, or from before this page reloaded, was not confirmed. Try again to finish it — it is safe: the server answers a retry of that same request without making a second project.';
/** Durable or nothing (Codex 4187372392, 4187663033): the record is the only thing that carries an attempt
 *  and its key past this document, so when site storage refuses it, no create is sent at all. */
export const NO_DURABLE_HOLD = 'This browser is blocking site storage, so a project create could not be recovered if this page closed. Nothing was sent — allow site storage for this site, then try again.';
/** No cross-tab lock, no create (Codex 4187821139). */
export const NO_CROSS_TAB_LOCK = 'This browser cannot keep a project create safe across tabs (it lacks Web Locks). Nothing was sent — update the browser, then try again.';
export const CREATE_IN_FLIGHT = 'A project is already being created — wait for it to finish.';
export const NOTHING_TO_RETRY = 'There is no unconfirmed project create to try again.';

const KEY_PREFIX = 'vitan.projectCreateHold.';
const recordKey = (scope: string): string => `${KEY_PREFIX}${scope}`;

/** Whether a `storage` event names a create record (any scope); `null` is a whole-storage clear. */
export const isCreateHoldStorageKey = (key: string | null): boolean => key === null || key.startsWith(KEY_PREFIX);

/** The scope a record and its lock are kept under: the token's subject, or — under passwordless dev auth,
 *  which keeps no token — the session user, so two identities never share an attempt (Codex 4187372380). */
export function createHoldScope(tokenSubject: string | null, sessionUserId: string | null): string {
  if (tokenSubject) return tokenSubject;
  return sessionUserId ? `dev:${sessionUserId}` : 'anon';
}

/** The record for `scope`: `null` when there is none, `undefined` when storage cannot be read. */
export function readCreateRecord(scope: string): CreateRecord | null | undefined {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return undefined;
    const raw = storage.getItem(recordKey(scope));
    if (!raw) return null;
    const rec = JSON.parse(raw) as Partial<CreateRecord>;
    return rec.state === 'held' || rec.state === 'settled' ? (rec as CreateRecord) : null;
  } catch {
    return undefined;
  }
}

/** The ONE writer of the record; `false` when site storage refused it. */
function writeCreateRecord(scope: string, rec: CreateRecord): boolean {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return false;
    storage.setItem(recordKey(scope), JSON.stringify(rec));
    return true;
  } catch {
    return false;
  }
}

const newKey = newIdempotencyKey; // the attempt's key, and each reservation's lease

// ── the live set: this document's sends ─────────────────────────────────────────────────────────────
const live: LiveSend[] = [];
const dropLive = (lease: string): void => {
  const i = live.findIndex((l) => l.lease === lease);
  if (i >= 0) live.splice(i, 1);
};
/** This document's reservations (a copy). */
export const liveCreateSends = (): LiveSend[] => live.map((l) => ({ ...l }));
/** Tests only: a fresh document (a reload) starts with no reservations of its own. */
export const resetLiveCreateSendsForTests = (): void => { live.length = 0; };

/**
 * What the dialog shows for `scope`, from the record and this document's live sends. Pure.
 *
 * - `held` by a lease this document has out → `in_flight` (its own reply settles it);
 * - `held` otherwise → `unknown`: nothing here owns it, so only "Try again" finishes it, under its own key;
 * - `settled`, or no record, while this document still has a send of ANOTHER attempt out → that send stays
 *   `in_flight` (a missing record is storage loss, never a release);
 * - `settled` for the attempt this document has out → nothing: another tab finished it (Codex 4192524383);
 * - unreadable storage → only this document's own send, if any.
 */
export function createHoldView(scope: string, record: CreateRecord | null | undefined, sends: readonly LiveSend[]): CreateHoldView {
  const mine = sends.filter((l) => l.scope === scope);
  if (record?.state === 'held') {
    const owner = mine.find((l) => l.lease === record.lease);
    if (owner) return { phase: 'in_flight', attempt: record.attempt, scope, orgId: record.orgId, input: record.input };
    return {
      phase: 'unknown', attempt: record.attempt, scope, orgId: record.orgId, input: record.input,
      message: record.phase === 'unknown' && record.message ? record.message : FOREIGN_CREATE_HOLD,
    };
  }
  const settledAttempt = record?.state === 'settled' ? record.attempt : null;
  const out = mine.find((l) => l.attempt !== settledAttempt);
  return out ? { phase: 'in_flight', attempt: out.attempt, scope, orgId: out.orgId, input: out.input } : null;
}

/** The current view for `scope`. */
export const currentCreateHoldView = (scope: string): CreateHoldView => createHoldView(scope, readCreateRecord(scope), live);

/** Run `fn` under the scope's exclusive Web Lock; `null` when there is no lock or the browser refused it. */
async function underLock<T>(scope: string, fn: () => T | Promise<T>): Promise<T | null> {
  const locks = (globalThis.navigator as (Navigator & { locks?: LockManager }) | undefined)?.locks;
  if (typeof locks?.request !== 'function') return null;
  try {
    return (await locks.request(`vitan.projectCreate.${scope}`, { mode: 'exclusive' }, async () => fn())) as T;
  } catch {
    return null;
  }
}

export type Reservation = { attempt: string; lease: string; orgId: string; input: NewProjectInput };
export type ReserveResult =
  | { kind: 'reserved'; reservation: Reservation; was: Extract<CreateRecord, { state: 'held' }> | null }
  | { kind: 'held'; message: string }
  | { kind: 'refused'; message: string };

/**
 * Reserve a NEW attempt (Codex 4187151998): read the record, mint the key and write `held` — one step under
 * the lock, so two tabs cannot both read "nothing held". Refused while any attempt is held, by this tab or
 * another, or while this document still has a send out for this scope.
 */
export async function reserveNewCreate(scope: string, orgId: string, input: NewProjectInput): Promise<ReserveResult> {
  const out = await underLock(scope, (): ReserveResult => {
    const view = currentCreateHoldView(scope);
    if (view?.phase === 'in_flight') return { kind: 'held', message: CREATE_IN_FLIGHT };
    if (view?.phase === 'unknown') return { kind: 'held', message: view.message };
    const reservation = { attempt: newKey(), lease: newKey(), orgId, input };
    if (!writeCreateRecord(scope, { state: 'held', phase: 'in_flight', ...reservation })) return { kind: 'refused', message: NO_DURABLE_HOLD };
    live.push({ scope, ...reservation });
    return { kind: 'reserved', reservation, was: null };
  });
  return out ?? { kind: 'refused', message: NO_CROSS_TAB_LOCK };
}

/** Reserve the HELD attempt again under a NEW lease, to resend it as itself (Codex 4185707835, 4190271480):
 *  every earlier reservation of it can then no longer send, release or settle it. */
export async function reserveCreateRetry(scope: string): Promise<ReserveResult> {
  const out = await underLock(scope, (): ReserveResult => {
    const rec = readCreateRecord(scope);
    const view = createHoldView(scope, rec, live);
    if (view?.phase === 'in_flight') return { kind: 'held', message: CREATE_IN_FLIGHT };
    if (rec?.state !== 'held') return { kind: 'held', message: NOTHING_TO_RETRY };
    const reservation = { attempt: rec.attempt, lease: newKey(), orgId: rec.orgId, input: rec.input };
    if (!writeCreateRecord(scope, { ...rec, lease: reservation.lease, phase: 'in_flight' })) return { kind: 'held', message: NO_DURABLE_HOLD };
    live.push({ scope, ...reservation });
    return { kind: 'reserved', reservation, was: rec };
  });
  return out ?? { kind: 'held', message: NO_CROSS_TAB_LOCK };
}

/**
 * The FENCE before a POST (Codex 4192524390): under the lock, send only while this reservation's lease is
 * still the record's. `send` must start the request synchronously; the lock is released once it has started,
 * not held across the reply. `superseded` — another tab retried, settled or released the attempt meanwhile —
 * sends nothing, and the reservation leaves this document's live set.
 */
export async function beginCreateSend<T>(scope: string, r: Reservation, send: () => Promise<T>): Promise<{ kind: 'sent'; reply: Promise<T> } | { kind: 'superseded' } | { kind: 'refused'; message: string }> {
  const out = await underLock(scope, () => {
    const rec = readCreateRecord(scope);
    if (rec?.state !== 'held' || rec.lease !== r.lease) {
      dropLive(r.lease);
      return { kind: 'superseded' as const };
    }
    let promise: Promise<T>;
    try {
      promise = send();
    } catch (err) {
      promise = Promise.reject(err); // a send that throws at once is still this attempt's reply
    }
    // wrapped, so the lock is released once the request has started rather than when it answers
    return { kind: 'sent' as const, reply: { promise } };
  });
  if (out === null) {
    dropLive(r.lease); // nothing was sent; the record, still held, reads as unknown and "Try again" finishes it
    return { kind: 'refused', message: NO_CROSS_TAB_LOCK };
  }
  if (out.kind === 'superseded') return out;
  return { kind: 'sent', reply: out.reply.promise };
}

/** How a sent attempt came out. `confirmed` finishes the attempt under ANY lease — the server committed that
 *  key; `refused` (a definite 4xx: nothing was made) and `unknown` only under the current lease. */
export type CreateSettlement = { kind: 'confirmed' } | { kind: 'refused' } | { kind: 'unknown'; message: string };

/** Settle a sent attempt from its reply, and drop it from this document's live set. Under the lock, so it
 *  cannot overwrite a reservation another tab takes meanwhile. Without a lock the live send is still dropped
 *  and the record left as it is: it then reads as unknown, which "Try again" finishes safely. */
export async function settleCreate(scope: string, r: Reservation, outcome: CreateSettlement): Promise<void> {
  await underLock(scope, () => {
    const rec = readCreateRecord(scope);
    if (rec?.state === 'held') {
      if (outcome.kind === 'confirmed' && rec.attempt === r.attempt) writeCreateRecord(scope, { state: 'settled', attempt: r.attempt });
      else if (rec.lease === r.lease) {
        if (outcome.kind === 'refused') writeCreateRecord(scope, { state: 'settled', attempt: r.attempt });
        else if (outcome.kind === 'unknown') writeCreateRecord(scope, { ...rec, phase: 'unknown', message: outcome.message });
      }
    }
  });
  dropLive(r.lease);
}

/** Put back a reservation that was never SENT (the server keeps no receipts, or the click's user left):
 *  a new attempt is released; a retried one returns to the unknown record it was. Current lease only. */
export async function releaseCreate(scope: string, r: Reservation, was: Extract<CreateRecord, { state: 'held' }> | null): Promise<void> {
  await underLock(scope, () => {
    const rec = readCreateRecord(scope);
    if (rec?.state !== 'held' || rec.lease !== r.lease) return;
    writeCreateRecord(scope, was ? { ...was, lease: r.lease, phase: 'unknown', message: was.message ?? FOREIGN_CREATE_HOLD } : { state: 'settled', attempt: r.attempt });
  });
  dropLive(r.lease);
}

/** The feature #717's `/health` advertises: a keyed create keeps a receipt and replays it. */
export const PROJECT_CREATE_RECEIPTS = 'orgs.createProject.receipt';
export const SERVER_NOT_READY = 'The server is being updated and cannot take a new project yet. Nothing was sent — try again in a minute.';
export const SERVER_NOT_READY_RETRY = 'The server is being updated and cannot safely finish this create yet. Nothing was sent — try again in a minute.';

/** The web and API deploy separately (Codex 4187372404): nothing keyed is sent to a server that does not say
 *  it keeps receipts; a probe that fails says no. */
export async function serverKeepsCreateReceipts(serverFeatures: () => Promise<string[]>): Promise<boolean> {
  try {
    return (await serverFeatures()).includes(PROJECT_CREATE_RECEIPTS);
  } catch {
    return false;
  }
}
