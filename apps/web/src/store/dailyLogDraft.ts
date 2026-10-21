import type { DailyLog } from '@vitan/shared';

/**
 * The engineer's UNSENT work on the day's log — check-in, crew counts and the progress photos taken —
 * as a project- and log-scoped pending draft.
 *
 * Why this exists (the #669 Today regression, Field Lab QA 2026-09-30): the server persists check-in,
 * crew and `progress` only when the log is SENT (`submitDailyLog` carries them); until then they live
 * in the client's `dailyLog` alone. Every other write on the way to Send — a material recorded, a
 * progress photo uploaded — reconciles the store from the server (the command's own snapshot, or the
 * module read under module ownership), and that reconcile REPLACED the client log with the server's
 * unsent values: the engineer who had checked in and counted a crew was back at "Check in", and Today
 * could never reach Send through the four steps. The draft is the canonical owner of that unsent work:
 * the writers record into it, every reconcile overlays it onto the server's log, and it is durable
 * across a reload (persisted beside the outbox, under the same user + project key).
 *
 * The draft never invents a completed step: it holds only what the engineer did on THIS device for
 * THIS log, and it is DROPPED — never carried — when the server's log is no longer the one it was
 * written against: the log was sent (the send landed; the server now holds the values), a new day's
 * log replaced it, or the project has no log. Two logs can start on the same civil day, so the key is
 * the civil date of the UNSENT log the draft was written against; a sent log drops the draft first.
 * A reconcile can also jump straight from one unsent log to ANOTHER of the same civil day (another
 * device sent the first and started a second), with no sent state in between, so the draft also
 * records the server's id for its log and applies to no log with a different id (U1, #690).
 */
export type DailyLogDraft = {
  /** the project the draft belongs to — applied to no other project's log */
  projectId: string;
  /** the log the draft was written against: its civil date (`logDate`), or the legacy display date */
  logKey: string;
  /** that log's server id, when the server sent one — a draft never applies to a log with another id */
  logId?: string;
  /** the engineer's check-in (or check-out) on this device, when recorded */
  checkIn?: { checkedIn: boolean; checkinTime: string | null };
  /** LEGACY (drafts written before U1 round 4): crew counts keyed by trade text. Still read, for the
   *  first row of each trade only; never written. */
  crew?: Record<string, number>;
  /** the crew counts the engineer set, by ROW POSITION (absolute — the latest count, not a delta),
   *  each with the trade it was set on: a free-text trade can never collide with another row's key,
   *  and a count is applied only where that position still holds that trade */
  crewRows?: Record<string, { trade: string; count: number }>;
  /** progress photos taken for this log on this device, beyond what the server holds: the count every release reads
   *  and writes */
  photosAdded?: number;
  /** the identities of the photos counted in `photosAdded` (each pick's key), so two tabs' drafts merge to the photos
   *  either took, counted once each (Codex 4336713260). Absent from a draft an earlier release wrote, and dropped by an
   *  earlier release's write: a count with fewer keys holds that many photos with none (`unkeyedPhotos`) */
  photoKeys?: string[];
  /** how many of its photos had no key when this release first counted a photo on it (`unkeyedPhotos` then): the
   *  base two tabs' drafts share, so their keyed photos are added to it, not compared (#1051 r1 re-check G4). Dropped
   *  by an earlier release's write */
  unkeyedBase?: number;
  /** the engineer answered every crew question for this log (a no-crew day is an answer, not a gap) */
  crewConfirmed?: boolean;
};

/** the identity a draft is written against: the civil date of the log, or its legacy display date */
export function dailyLogKey(log: Pick<DailyLog, 'date' | 'logDate'>): string {
  return log.logDate ? `civil:${log.logDate}` : `date:${log.date}`;
}

/** THIS log's identity: its server id when it has one (two logs can share a civil day), else the
 *  civil-date key. */
export function dailyLogIdentity(log: Pick<DailyLog, 'id' | 'date' | 'logDate'>): string {
  return log.id ? `id:${log.id}` : dailyLogKey(log);
}

/** A draft that still applies to the server's log: same project, same log, and the log is unsent.
 *  When both carry a server id the ids must match. A draft WITHOUT an id (written by a release before
 *  the log carried one) never applies to a log that has one: nothing in it can tell that log from
 *  another log of the same civil day, so it is set aside as a legacy draft for the engineer to
 *  confirm or discard (`isLegacyDraftFor`), never attached on its own (owner ruling, #692). Only when
 *  neither carries an id (an older server) is the civil date the match, as before. */
export function draftAppliesTo(draft: DailyLogDraft | null, serverLog: DailyLog | null, projectId: string): boolean {
  if (!draft || draft.projectId !== projectId) return false;
  if (!serverLog || serverLog.submitted) return false;
  if (serverLog.id) return draft.logId === serverLog.id;
  return dailyLogKey(serverLog) === draft.logKey;
}

/** A draft written before the log carried an id, met by a log that has one: it cannot be proven to be
 *  this log's, so it is kept aside (recoverable), never laid over the log. */
export function isLegacyDraftFor(draft: DailyLogDraft | null, serverLog: DailyLog | null, projectId: string): boolean {
  return !!draft && draft.projectId === projectId && !draft.logId && !!serverLog?.id;
}

/** A draft held in this tab's memory meets the one storage holds now (another tab wrote it while this tab could not
 *  read the key). Neither replaces the other (#1028 r1): drafts of one log merge, the held draft's fields winning where
 *  it set them (its edits are this tab's latest) and the stored draft's kept where it set none. Crew rows merge by
 *  identity, a row being its position and its trade: the same row takes the held count; two rows at one position (their
 *  trades differ) keep the one whose trade the log on screen still holds there (the held one when the screen cannot
 *  say), and the other comes back for the caller to keep aside (G2 re-check G-c): in `rows` when it is the stored
 *  draft's, in `heldRows` when it is the held one's, so the person is told whose was kept aside (#1037 r1 check gap 6). The photos taken are
 *  counted by their keys, each once, whichever draft holds it (Codex 4336713260); photos an earlier release counted
 *  with no key are added when `disjoint` (this tab could not read the key, so its count started at nothing and the
 *  stored count never held its photos), else the larger count stands where it is above the keys (each tab counted from
 *  the same start, and a count with no keys may hold a keyed photo it read) (G-e). Drafts of different logs cannot
 *  both apply: the one that applies to the log on screen is kept (else the held one), and the other comes back as
 *  `loser`, for the caller to keep aside (r1 check G2). `applies` says which draft applies; by default a draft applies
 *  when it may be laid over the log (`draftAppliesTo`). Legacy drafts are judged by `canAdoptLegacyDraft` instead, both
 *  of them, so the one the open log may adopt is kept (#1037 r1, Codex 4331862674). */
export function mergeHeldDraft(
  stored: DailyLogDraft | null,
  held: DailyLogDraft | null,
  serverLog: DailyLog | null,
  projectId: string,
  disjoint = false,
  applies: (draft: DailyLogDraft) => boolean = (draft) => draftAppliesTo(draft, serverLog, projectId),
): { draft: DailyLogDraft | null; loser: DailyLogDraft | null; rows: DailyLogDraft | null; heldRows: DailyLogDraft | null } {
  if (!held) return { draft: stored, loser: null, rows: null, heldRows: null };
  if (!stored) return { draft: held, loser: null, rows: null, heldRows: null };
  const sameLog = stored.projectId === held.projectId && stored.logKey === held.logKey && (stored.logId ?? null) === (held.logId ?? null);
  if (!sameLog) {
    const keepStored = !applies(held) && applies(stored);
    return keepStored ? { draft: stored, loser: held, rows: null, heldRows: null } : { draft: held, loser: stored, rows: null, heldRows: null };
  }
  const set = Object.fromEntries(Object.entries(held).filter(([, v]) => v !== undefined)) as Partial<DailyLogDraft>;
  const out: DailyLogDraft = { ...stored, ...set };
  if (stored.crew || held.crew) out.crew = { ...stored.crew, ...held.crew };
  const lost: Record<string, { trade: string; count: number }> = {};
  const lostHeld: Record<string, { trade: string; count: number }> = {};
  if (stored.crewRows || held.crewRows) {
    const rows: Record<string, { trade: string; count: number }> = { ...stored.crewRows };
    for (const [at, mine] of Object.entries(held.crewRows ?? {})) {
      const theirs = rows[at];
      if (!theirs || theirs.trade === mine.trade) { rows[at] = mine; continue; }
      const trade = serverLog?.crew[Number(at)]?.trade;
      const keepTheirs = trade !== undefined && theirs.trade === trade && mine.trade !== trade;
      rows[at] = keepTheirs ? theirs : mine;
      if (keepTheirs) lostHeld[at] = mine;
      else lost[at] = theirs;
    }
    out.crewRows = rows;
  }
  // a photo is counted once by its key, whichever draft holds it (Codex 4336713260). Photos an earlier release counted
  // with no key are added when `disjoint`. Otherwise both counts started from the same draft: its photos with no key
  // are the larger of the two drafts' bases, and the keyed photos are added to it (re-check G4). Only when a draft an
  // earlier release wrote holds photos with no base does the larger count stand above the keys, as before keys: one
  // tab's photo can then go uncounted. Where an earlier release's write dropped a keyed draft's keys and a tab of this
  // release then took a photo on it, that tab's base holds those photos, and a held draft that still has their keys
  // counts them twice: at most one per such photo, until the draft is sent (re-cut check N2; the larger base is kept,
  // since a photo shown as missing may be taken again)
  const keys = [...new Set([...(stored.photoKeys ?? []), ...(held.photoKeys ?? [])])];
  const bases = [baseOf(stored), baseOf(held)];
  const known = bases.every((b) => b !== undefined);
  const photos = disjoint
    ? keys.length + unkeyedPhotos(stored) + unkeyedPhotos(held)
    : known ? keys.length + Math.max(...(bases as number[]))
    : Math.max(keys.length, stored.photosAdded ?? 0, held.photosAdded ?? 0);
  delete out.photosAdded;
  delete out.photoKeys;
  delete out.unkeyedBase;
  if (photos) out.photosAdded = photos;
  if (keys.length) out.photoKeys = keys;
  if ((disjoint || known) && photos > keys.length) out.unkeyedBase = photos - keys.length;
  const aside = (crewRows: Record<string, { trade: string; count: number }>): DailyLogDraft | null => (Object.keys(crewRows).length === 0 ? null
    : { projectId: out.projectId, logKey: out.logKey, ...(out.logId ? { logId: out.logId } : {}), crewRows });
  return { draft: out, loser: null, rows: aside(lost), heldRows: aside(lostHeld) };
}

/** the photos a draft counts that no key names: those an earlier release counted */
export function unkeyedPhotos(draft: DailyLogDraft): number {
  return Math.max(0, (draft.photosAdded ?? 0) - (draft.photoKeys?.length ?? 0));
}

/** the photos with no key a draft shares with any draft read from it: its recorded base, none when every photo has a
 *  key, and unknown for a draft an earlier release wrote over photos with none */
function baseOf(draft: DailyLogDraft): number | undefined {
  return draft.unkeyedBase ?? (unkeyedPhotos(draft) === 0 ? 0 : undefined);
}

/** Does a draft hold any of the engineer's work? (An empty one is not worth keeping aside.) */
export function draftHoldsWork(draft: DailyLogDraft): boolean {
  return !!draft.checkIn
    || (!!draft.crew && Object.keys(draft.crew).length > 0)
    || (!!draft.crewRows && Object.keys(draft.crewRows).length > 0)
    || (draft.photosAdded ?? 0) > 0
    || !!draft.crewConfirmed;
}

/** What a legacy draft holds, for the engineer to recognise before choosing: the check-in, the crew
 *  counts it set (by trade, the latest per row) and the photos taken. */
export function legacyDraftSummary(draft: DailyLogDraft): { checkinTime: string | null; crew: { trade: string; count: number }[]; photos: number } {
  const crew = new Map<string, number>();
  for (const [trade, count] of Object.entries(draft.crew ?? {})) crew.set(trade, count);
  for (const row of Object.values(draft.crewRows ?? {})) crew.set(row.trade, row.count);
  return {
    checkinTime: draft.checkIn?.checkedIn ? draft.checkIn.checkinTime : null,
    crew: [...crew].map(([trade, count]) => ({ trade, count })),
    photos: draft.photosAdded ?? 0,
  };
}

/** May a legacy draft be added to this log, on the engineer's confirmation? Only to an unsent log of
 *  the same project and the same civil day it was written for — never to another day's log. */
export function canAdoptLegacyDraft(legacy: DailyLogDraft | null, serverLog: DailyLog | null, projectId: string): boolean {
  return !!legacy && !!serverLog && !serverLog.submitted && legacy.projectId === projectId && dailyLogKey(serverLog) === legacy.logKey;
}

/** The engineer confirmed: the legacy draft becomes this log's draft, bound to its id. Work already
 *  recorded on this log (the current draft) is the engineer's later word and stays; the legacy draft
 *  only fills what the current one does not hold. `null` when it may not be adopted. */
export function adoptLegacyDraft(
  legacy: DailyLogDraft | null,
  current: DailyLogDraft | null,
  serverLog: DailyLog | null,
  projectId: string,
): DailyLogDraft | null {
  if (!canAdoptLegacyDraft(legacy, serverLog, projectId)) return null;
  const mine = current && draftAppliesTo(current, serverLog, projectId) ? current : null;
  const out: DailyLogDraft = { projectId, logKey: legacy!.logKey, ...(serverLog!.id ? { logId: serverLog!.id } : {}) };
  const checkIn = mine?.checkIn ?? legacy!.checkIn;
  if (checkIn) out.checkIn = checkIn;
  const crew = { ...(legacy!.crew ?? {}), ...(mine?.crew ?? {}) };
  if (Object.keys(crew).length) out.crew = crew;
  const crewRows = { ...(legacy!.crewRows ?? {}), ...(mine?.crewRows ?? {}) };
  if (Object.keys(crewRows).length) out.crewRows = crewRows;
  const photos = (legacy!.photosAdded ?? 0) + (mine?.photosAdded ?? 0);
  if (photos) out.photosAdded = photos;
  const keys = [...new Set([...(legacy!.photoKeys ?? []), ...(mine?.photoKeys ?? [])])];
  if (keys.length) out.photoKeys = keys;
  if (photos > keys.length) out.unkeyedBase = photos - keys.length;
  if (mine?.crewConfirmed ?? legacy!.crewConfirmed) out.crewConfirmed = true;
  return out;
}

/** What adopting a legacy draft ADDS on top of the log on screen (which already carries the current
 *  draft): the check-in if none is recorded, the crew counts for rows the current draft never set,
 *  and the photos it took. Laid over the on-screen log, so nothing the current draft holds counts
 *  twice; the next reconcile lays the whole adopted draft over the server's own log. */
export function legacyDraftExtras(legacy: DailyLogDraft, current: DailyLogDraft | null, log: DailyLog): DailyLogDraft {
  const mine = current ?? { projectId: legacy.projectId, logKey: legacy.logKey };
  const out: DailyLogDraft = { projectId: legacy.projectId, logKey: legacy.logKey, ...(log.id ? { logId: log.id } : {}) };
  if (legacy.checkIn && !mine.checkIn) out.checkIn = legacy.checkIn;
  const setByMine = (i: number, trade: string): boolean =>
    !!mine.crewRows?.[String(i)] || (log.crew.findIndex((c) => c.trade === trade) === i && !!mine.crew && Object.hasOwn(mine.crew, trade));
  const rows: Record<string, { trade: string; count: number }> = {};
  log.crew.forEach((c, i) => {
    if (setByMine(i, c.trade)) return;
    const row = legacy.crewRows?.[String(i)];
    if (row && row.trade === c.trade) rows[String(i)] = row;
    else if (log.crew.findIndex((x) => x.trade === c.trade) === i && legacy.crew && Object.hasOwn(legacy.crew, c.trade)) {
      rows[String(i)] = { trade: c.trade, count: legacy.crew[c.trade]! };
    }
  });
  if (Object.keys(rows).length) out.crewRows = rows;
  if (legacy.photosAdded) out.photosAdded = legacy.photosAdded;
  return out;
}

/**
 * The server's log with the engineer's unsent work laid over it. Pure: returns the merged log and the
 * draft that survives — `null` when the draft no longer applies (sent, superseded by a new day, or no
 * log) — and never touches the inputs. The server's own truth wins where it is stronger: a log the
 * server already holds as checked in stays checked in, and a trade the draft never touched keeps the
 * server's count. `progress` is the server's count plus the photos taken here since.
 */
export function overlayDailyLogDraft(
  serverLog: DailyLog | null,
  draft: DailyLogDraft | null,
  projectId: string,
): { log: DailyLog | null; draft: DailyLogDraft | null; legacy?: DailyLogDraft } {
  // a draft written for another project is not this project's business — leave it as it is
  if (draft && draft.projectId !== projectId) return { log: serverLog, draft };
  // a draft written before the log carried an id is never laid over a log that has one: it is set
  // aside, intact, for the engineer to confirm or discard (owner ruling, #692)
  if (isLegacyDraftFor(draft, serverLog, projectId)) {
    return { log: serverLog, draft: null, ...(draftHoldsWork(draft!) ? { legacy: draft! } : {}) };
  }
  if (!draft || !serverLog || !draftAppliesTo(draft, serverLog, projectId)) return { log: serverLog, draft: null };
  const kept = draft;
  const log: DailyLog = {
    ...serverLog,
    checkedIn: serverLog.checkedIn || (kept.checkIn?.checkedIn ?? false),
    checkinTime: serverLog.checkinTime ?? (kept.checkIn?.checkedIn ? kept.checkIn.checkinTime : null),
    crew: serverLog.crew.map((c, i) => {
      const row = kept.crewRows?.[String(i)];
      if (row && row.trade === c.trade) return { ...c, count: row.count };
      // a legacy trade-keyed count applies to the first row of that trade only
      const first = serverLog.crew.findIndex((x) => x.trade === c.trade) === i;
      return first && kept.crew && Object.hasOwn(kept.crew, c.trade) ? { ...c, count: kept.crew[c.trade]! } : c;
    }),
    progress: serverLog.progress + (kept.photosAdded ?? 0),
  };
  // a check-OUT recorded here after the server never saw the check-in: the engineer's latest word stands
  if (kept.checkIn && !kept.checkIn.checkedIn && !serverLog.checkedIn) {
    log.checkedIn = false;
    log.checkinTime = null;
  }
  return { log, draft: kept };
}

/** Parse a persisted draft, admitting only the shape this module writes (anything else is dropped). */
export function parseDailyLogDraft(raw: unknown): DailyLogDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.projectId !== 'string' || typeof d.logKey !== 'string') return null;
  const draft: DailyLogDraft = { projectId: d.projectId, logKey: d.logKey };
  if (typeof d.logId === 'string' && d.logId) draft.logId = d.logId;
  if (d.checkIn && typeof d.checkIn === 'object') {
    const c = d.checkIn as Record<string, unknown>;
    if (typeof c.checkedIn === 'boolean' && (c.checkinTime === null || typeof c.checkinTime === 'string')) {
      draft.checkIn = { checkedIn: c.checkedIn, checkinTime: c.checkinTime };
    }
  }
  if (d.crew && typeof d.crew === 'object') {
    const crew: Record<string, number> = {};
    for (const [trade, count] of Object.entries(d.crew as Record<string, unknown>)) {
      if (typeof count === 'number' && Number.isInteger(count) && count >= 0) crew[trade] = count;
    }
    draft.crew = crew;
  }
  if (typeof d.photosAdded === 'number' && Number.isInteger(d.photosAdded) && d.photosAdded >= 0) draft.photosAdded = d.photosAdded;
  // the keys are read only beside a count that holds them all, so the count stays what every release reads
  if (Array.isArray(d.photoKeys) && d.photoKeys.every((k) => typeof k === 'string') && new Set(d.photoKeys).size === d.photoKeys.length
    && d.photoKeys.length > 0 && d.photoKeys.length <= (draft.photosAdded ?? 0)) draft.photoKeys = [...d.photoKeys];
  // and the base only when it is exactly the photos the keys leave
  if (typeof d.unkeyedBase === 'number' && Number.isInteger(d.unkeyedBase) && d.unkeyedBase > 0 && d.unkeyedBase === unkeyedPhotos(draft)) draft.unkeyedBase = d.unkeyedBase;
  if (d.crewRows && typeof d.crewRows === 'object') {
    const rows: Record<string, { trade: string; count: number }> = {};
    for (const [at, v] of Object.entries(d.crewRows as Record<string, unknown>)) {
      const r = v as Record<string, unknown> | null;
      if (/^\d+$/u.test(at) && r && typeof r.trade === 'string' && typeof r.count === 'number' && Number.isInteger(r.count) && r.count >= 0) {
        rows[at] = { trade: r.trade, count: r.count };
      }
    }
    draft.crewRows = rows;
  }
  if (d.crewConfirmed === true) draft.crewConfirmed = true;
  return draft;
}
