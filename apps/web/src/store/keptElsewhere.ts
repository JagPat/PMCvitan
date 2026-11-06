import { isSiteVisitOp, siteVisitOf, type OutboxOp } from '@/data/apiGateway';
import { evidenceProjectsOf, evidenceWithinWait, listEvidence } from '@/data/evidenceStore';
import { isSitePhotoSent, listSitePhotoRows, sitePhotoKeptProjectsOf, sitePhotoProjectsOf } from '@/data/sitePhotoStore';
import { posterWaits, readVisitPhotoRows, readVisitPhotoRowsUntil, visitPhotoProjectsOf, type VisitPhotoRow } from '@/data/visitPhotoStore';
import { queueActIdent } from '@/store/queueActIdent';
import { readOwedActs, type KeyRead } from '@/store/queueKeyGuard';

/**
 * #1388 (unit 1, read only): the changes this device keeps for projects the signed-in person no longer holds.
 *
 * A change is kept on this device until it is sent: in the person's queue keys for that project
 * (`vitan.outbox.<sub>.<project>` and `vitan.siteVisitQueue.<sub>.<project>`, with their made records, read through the
 * ledger as a load would take them), or in a row of the three IndexedDB stores (evidence, visit photos, site photos)
 * whose op is rebuilt from it only when the project loads. The two are one change when they name the same file
 * (`clientKey`). A project the person still holds is never listed: its changes are sent when they open it. Another
 * person's queue keys and rows on a shared device are never read; the site photos' sent index is read by key alone
 * (`sitePhotoKeptProjectsOf`), and only this person's keys are kept from it. The list's read writes nothing (no queue key, made record,
 * mark, row or held-photo record) and holds or names no act: the discard is unit 2. The one write here is the name
 * record (`rememberProjectName`), which the snapshot makes. Every IndexedDB read is read only and bounded (a store's own
 * bound); one that fails or is too slow reads as nothing found.
 *
 * Cost (Stage 1, G10; Codex 4498679801): the switcher's line asks only whether there is anything (`keptAnywhere`: the
 * queue keys and what they owe, read from localStorage; evidence and site photos by their keys alone; a visit file of a
 * project not held by its value, once per tab at most when done); the rows of every store, bytes and all, are read only
 * when the list opens (`readKeptElsewhere`).
 */

/** what a kept change is about, as the list names it: one group per area, not one per act kind */
export type KeptKind =
  | 'decision' | 'drawing' | 'inspection' | 'activity' | 'dailyLog' | 'siteVisit' | 'photo' | 'materials' | 'labour' | 'commercial' | 'budget';

/** every act kind's group: a kind added to `OutboxOp` without one here fails the typecheck */
export const KEPT_KIND: Record<OutboxOp['t'], KeptKind> = {
  approve: 'decision', change: 'decision', changeWithdraw: 'decision', consultationRequest: 'decision', consultationRespond: 'decision',
  withdraw: 'decision', forwardDecision: 'decision', countersignDecision: 'decision', disagreeDecision: 'decision',
  resolveStrandedCountersign: 'decision',
  ackDrawing: 'drawing', publishDrawing: 'drawing', setDrawingNode: 'drawing',
  submitInspection: 'inspection', decideReview: 'inspection',
  startActivity: 'activity', completeActivity: 'activity',
  startDailyLog: 'dailyLog', addSiteMaterial: 'dailyLog', flagMismatch: 'dailyLog', submitDailyLog: 'dailyLog',
  reserveStock: 'materials', issueStock: 'materials', consumeStock: 'materials', createRequisition: 'materials',
  allocateLabour: 'labour', recordAttendance: 'labour', recordLabourWork: 'labour', createLabourRequisition: 'labour',
  releaseLabourAllocation: 'labour',
  setCommercialBudget: 'budget', defineCostHead: 'budget', reattributeCommitment: 'budget',
  takeMeasurement: 'commercial', correctMeasurement: 'commercial', recordVendorBill: 'commercial', beginVerification: 'commercial',
  verifyVendorBill: 'commercial', submitVendorBill: 'commercial', certifyBill: 'commercial', supersedeCertificate: 'commercial',
  grantSodException: 'commercial', recordDeduction: 'commercial', releaseDeduction: 'commercial', approvePayment: 'commercial',
  payAdvance: 'commercial', recordPayment: 'commercial', reversePayment: 'commercial', amendVendorBill: 'commercial',
  rejectVendorBill: 'commercial',
  siteVisitStart: 'siteVisit', siteVisitEnd: 'siteVisit', siteVisitClose: 'siteVisit', siteVisitAddPlace: 'siteVisit',
  siteVisitRetirePlace: 'siteVisit', siteVisitAddAttendee: 'siteVisit', siteVisitRetireAttendee: 'siteVisit', siteVisitAddFile: 'siteVisit',
  uploadMedia: 'photo', uploadEvidence: 'photo', uploadSitePhoto: 'photo',
};

/** One line of the list. A site visit's acts are one line (`count` of them): each depends on the ones before it. `at`:
 *  when it was saved, only where the change carries a time (a row's, or a visit file's `queuedAt`); acts carry none.
 *  `failed`: a refused row, or one waiting for a retry, on a line of its own */
export type KeptItem = { id: string; kind: KeptKind; count: number; at: number | null; failed: boolean };
/** One project's kept changes. `name`: the name this device last saw for it, or null. `unreadable`: one of its keys, or
 *  a made record, holds changes this version cannot read (those are this line alone, never counted; what readable made
 *  records beside such a key hold is listed and counted, as a load restores it) */
export type KeptProject = { projectId: string; name: string | null; items: KeptItem[]; total: number; unreadable: Exclude<KeyRead, 'ok'> | null };
/** a row kept on this device, as the list needs it. `failed`: the server refused it, or it waits for the person's retry;
 *  it is listed apart, as it is not sent of itself when access returns */
export type KeptRow = { clientKey: string; at: number; visitId: string | null; failed: boolean };

/** the name record of a project for a person: written wherever a snapshot names the project, read only by this list */
export const projectNameKey = (sub: string, projectId: string): string => `vitan.projectName.${sub}.${projectId}`;

type Names = Pick<Storage, 'getItem' | 'setItem'>;
/** keep `name` as the person's name for the project; best effort (a full or blocked storage keeps the last one) */
export function rememberProjectName(storage: Names | null, sub: string, projectId: string, name: string): void {
  if (!storage || !name) return;
  try { if (storage.getItem(projectNameKey(sub, projectId)) !== name) storage.setItem(projectNameKey(sub, projectId), name); } catch { /* not kept */ }
}
export function readProjectName(storage: Names, sub: string, projectId: string): string | null {
  try { return storage.getItem(projectNameKey(sub, projectId)) || null; } catch { return null; }
}

type Keys = Pick<Storage, 'getItem' | 'key'> & { readonly length: number };
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** the projects whose queue keys (or the made records of one) this device holds for `sub`. A copy set aside is not one:
 *  it belongs to the set-aside path */
export function queuedProjectsOf(storage: Keys, sub: string): Set<string> {
  const re = new RegExp(`^(?:vitan\\.made\\.)?vitan\\.(?:outbox|siteVisitQueue)\\.${escape(sub)}\\.([^.]+)(?:\\.|$)`);
  const out = new Set<string>();
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const m = re.exec(storage.key(i) ?? '');
      if (m) out.add(m[1]);
    }
  } catch { /* what was read so far */ }
  return out;
}

/** the file a row-backed act sends, by the key its row is kept under */
const fileOf = (o: OutboxOp): string | null =>
  o.t === 'uploadEvidence' || o.t === 'uploadSitePhoto' ? o.clientKey : o.t === 'siteVisitAddFile' ? o.file.id : null;
const timeOf = (iso: string | undefined): number | null => { if (!iso) return null; const t = Date.parse(iso); return Number.isNaN(t) ? null : t; };
const earliest = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.min(a, b));

/** an act whose identity no other act shares (it carries its own key): one act wherever this phone holds it */
const unique = (o: OutboxOp): boolean => !queueActIdent(o).startsWith('json:');
type OwedRead = { read: KeyRead; acts: OutboxOp[]; unread?: Exclude<KeyRead, 'ok'> | null } | null;
const worse = (a: KeptProject['unreadable'], b: Exclude<KeyRead, 'ok'>): Exclude<KeyRead, 'ok'> => (a === 'damaged' || b === 'damaged' ? 'damaged' : 'newer');

/** one project's list, from what its two keys owe (`reads`, as `readOwedActs` gives them) and its rows */
export function keptOf(projectId: string, name: string | null, reads: OwedRead[], rows: KeptRow[]): KeptProject {
  const items = new Map<string, KeptItem>();
  const rowOf = new Map(rows.map((r) => [r.clientKey, r]));
  const counted = new Set<string>();
  const once = new Set<string>();
  let unreadable: KeptProject['unreadable'] = null;
  const add = (id: string, kind: KeptKind, at: number | null, failed: boolean): void => {
    const was = items.get(id);
    if (was) { was.count += 1; was.at = earliest(was.at, at); } else items.set(id, { id, kind, count: 1, at, failed });
  };
  for (const r of reads) {
    if (!r) continue;
    // a key this version cannot read is the unreadable line; the acts its readable records still hold are listed, as a
    // load restores them (Codex 4498773111)
    if (r.read !== 'ok') unreadable = worse(unreadable, r.read);
    if (r.unread) unreadable = worse(unreadable, r.unread);
    for (const o of r.acts) {
      // the same act held twice (the key and a made record, or both lanes) is one change, as a load takes it once
      if (unique(o)) { const i = queueActIdent(o); if (once.has(i)) continue; once.add(i); }
      // a row-backed act names its file: the same file held twice (the key and a made record) is one change, its act
      // having no identity of its own (Codex 4498773117)
      const file = fileOf(o);
      if (file !== null) { if (counted.has(file)) continue; counted.add(file); }
      const row = file !== null ? rowOf.get(file) : undefined;
      const at = earliest(row?.at ?? null, o.t === 'siteVisitAddFile' ? timeOf(o.queuedAt) : null);
      if (row?.failed) add(`row:${row.clientKey}`, KEPT_KIND[o.t], at, true);
      else add(isSiteVisitOp(o) ? `visit:${siteVisitOf(o)}` : `act:${queueActIdent(o)}`, KEPT_KIND[o.t], at, false);
    }
  }
  // a row no act names: its act is rebuilt from it at the project's load, so it is a change of its own (a visit file
  // joins its visit's line; a refused one, or one waiting for a retry, is a line of its own)
  for (const r of rows) {
    if (counted.has(r.clientKey)) continue;
    counted.add(r.clientKey);
    const kind: KeptKind = r.visitId !== null ? 'siteVisit' : 'photo';
    if (r.failed) add(`row:${r.clientKey}`, kind, r.at, true);
    else add(r.visitId !== null ? `visit:${r.visitId}` : `row:${r.clientKey}`, kind, r.at, false);
  }
  const list = [...items.values()];
  return { projectId, name, items: list, total: list.reduce((n, i) => n + i.count, 0), unreadable };
}

/** A visit file still kept: not yet filed, or filed with its still frame still to send (a clip whose frame
 *  `putBackVisitPhotos` puts back, as #1390's kept count counts it; Codex 4498679819). */
export const visitRowKept = (row: VisitPhotoRow, now = Date.now()): boolean => row.state !== 'filed' || posterWaits(row, now);

/** Visit files this tab has read as done (filed, with no still frame to send), by `sub|project|clientKey`: the line's
 *  check never reads one again, bytes and all (Codex 4498679801). Done is terminal: a filed row is never put back to
 *  queued (`fileVisitPhoto` only ever writes `filed`; no write in visitPhotoStore.ts takes a filed row back), and a
 *  frame that waits past `POSTER_WAIT_MS` only lapses (`posterLapsed`), never waits again. Cleared on sign-out. */
const provenDone = new Set<string>();
const doneKey = (sub: string, p: string, clientKey: string): string => `${sub}|${p}|${clientKey}`;
const noteDone = (sub: string, p: string, rows: VisitPhotoRow[], now: number): void => {
  for (const r of rows) if (!visitRowKept(r, now)) provenDone.add(doneKey(sub, p, r.clientKey));
};
export function forgetKeptMemo(): void { provenDone.clear(); }

/** the rows this device keeps unsent for (`sub`, `projectId`): evidence still to send or refused, visit files not yet
 *  filed, site photos still holding their bytes. Read only and bounded: a store that cannot be read, or not in time,
 *  gives none */
async function rowsOf(sub: string, projectId: string): Promise<KeptRow[]> {
  const now = Date.now();
  const [evidence, visit, site] = await Promise.all([
    evidenceWithinWait(listEvidence(sub, projectId)).catch(() => []),
    readVisitPhotoRows(sub, projectId).catch(() => []),
    listSitePhotoRows(sub, projectId).catch(() => []),
  ]);
  return [
    ...evidence.map((e) => ({ clientKey: e.clientKey, at: e.createdAt, visitId: null, failed: e.status === 'failed' })),
    ...(noteDone(sub, projectId, visit, now), visit).filter((v) => visitRowKept(v, now)).map((v) => ({ clientKey: v.clientKey, at: v.createdAt, visitId: v.op.visitId, failed: v.state === 'failed' })),
    ...site.flatMap((e) => (isSitePhotoSent(e) ? [] : [{ clientKey: e.clientKey, at: e.createdAt, visitId: null, failed: false }])),
  ];
}

const keysOf = (sub: string, p: string): string[] => [`vitan.outbox.${sub}.${p}`, `vitan.siteVisitQueue.${sub}.${p}`];
/** the projects not `held` that this device keeps rows for, from the stores' row keys alone (bounded; none on a failure) */
async function rowProjectsOf(sub: string): Promise<Set<string>> {
  const none = (): Set<string> => new Set();
  const [evidence, visit, site] = await Promise.all([
    evidenceProjectsOf(sub).catch(none), visitPhotoProjectsOf(sub).catch(none), sitePhotoProjectsOf(sub).catch(none),
  ]);
  return new Set([...evidence, ...visit, ...site]);
}

/** Whether this device may keep changes for a project `sub` does not hold (`held`): a queue key that owes an act or that
 *  this version cannot read, or an unsent row kept for such a project. The queue keys are read from localStorage, evidence
 *  and site photos by their keys alone, and visit files (done only by their value) only for a project not held, never one
 *  this tab has read as done already. Every read bounded and read only */
export async function keptAnywhere(storage: Keys & Names, sub: string, held: ReadonlySet<string>): Promise<boolean> {
  const scopes = { evidence: sub, visitPhoto: sub };
  for (const p of queuedProjectsOf(storage, sub)) {
    if (held.has(p)) continue;
    for (const k of keysOf(sub, p)) {
      const r = readOwedActs(storage, k, scopes);
      if (r && (r.read !== 'ok' || r.unread || r.acts.length > 0)) return true;
    }
  }
  const none = (): Set<string> => new Set();
  // from keys alone: an evidence row is unsent by being there (a sent one is deleted: apiGateway's uploadEvidence
  // replay); a site photo is unsent unless the `sentAt` index names its marker
  const [evidence, site, visit] = await Promise.all([
    evidenceProjectsOf(sub).catch(none), sitePhotoKeptProjectsOf(sub).catch(none), visitPhotoProjectsOf(sub).catch(none),
  ]);
  for (const p of [...evidence, ...site]) if (!held.has(p)) return true;
  // a visit file is done only by its value: of a project not held (rare), the rows not already read as done are read,
  // one at a time, up to the first kept one
  const now = Date.now();
  for (const p of visit) {
    if (held.has(p)) continue;
    const rows = await readVisitPhotoRowsUntil(sub, p, (ck) => provenDone.has(doneKey(sub, p, ck)), (r) => visitRowKept(r, now)).catch(() => null);
    if (rows === null) continue;
    noteDone(sub, p, rows, now);
    if (rows.some((r) => visitRowKept(r, now))) return true;
  }
  return false;
}

/** Every project `sub` keeps changes for on this device and does not hold (`held`), each with its list; none listed has
 *  nothing kept. `storage`: the queue keys' storage. Read only */
export async function readKeptElsewhere(storage: Keys & Names, sub: string, held: ReadonlySet<string>): Promise<KeptProject[]> {
  const projects = new Set([...queuedProjectsOf(storage, sub), ...await rowProjectsOf(sub)]);
  const scopes = { evidence: sub, visitPhoto: sub };
  const out: KeptProject[] = [];
  for (const p of [...projects].filter((x) => !held.has(x)).sort()) {
    const reads = keysOf(sub, p).map((k) => readOwedActs(storage, k, scopes));
    const kept = keptOf(p, readProjectName(storage, sub, p), reads, await rowsOf(sub, p));
    if (kept.total > 0 || kept.unreadable !== null) out.push(kept);
  }
  return out;
}
