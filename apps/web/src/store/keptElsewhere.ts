import { isSiteVisitOp, siteVisitOf, type OutboxOp } from '@/data/apiGateway';
import { evidenceProjectsOf, listEvidence } from '@/data/evidenceStore';
import { isSitePhotoSent, listSitePhotoRows, sitePhotoProjectsOf } from '@/data/sitePhotoStore';
import { listVisitPhotos, visitPhotoProjectsOf } from '@/data/visitPhotoStore';
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
 * person's keys and rows on a shared device are never read. Nothing here writes, holds or names an act: the discard is
 * unit 2.
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
 *  when it was saved, only where the change carries a time (a row's, or a visit file's `queuedAt`); acts carry none */
export type KeptItem = { id: string; kind: KeptKind; count: number; at: number | null };
/** One project's kept changes. `name`: the name this device last saw for it, or null. `unreadable`: one of its keys holds
 *  changes this version cannot read (they are listed by this line alone, never counted) */
export type KeptProject = { projectId: string; name: string | null; items: KeptItem[]; total: number; unreadable: Exclude<KeyRead, 'ok'> | null };
/** a row kept on this device, as the list needs it */
export type KeptRow = { clientKey: string; at: number; visitId: string | null };

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

/** one project's list, from what its two keys owe (`reads`, as `readOwedActs` gives them) and its rows */
export function keptOf(projectId: string, name: string | null, reads: ({ read: KeyRead; acts: OutboxOp[] } | null)[], rows: KeptRow[]): KeptProject {
  const items = new Map<string, KeptItem>();
  const rowAt = new Map(rows.map((r) => [r.clientKey, r]));
  const counted = new Set<string>();
  let unreadable: KeptProject['unreadable'] = null;
  for (const r of reads) {
    if (!r) continue;
    if (r.read !== 'ok') { unreadable = unreadable === 'damaged' || r.read === 'damaged' ? 'damaged' : 'newer'; continue; }
    for (const o of r.acts) {
      const file = fileOf(o);
      if (file !== null) counted.add(file);
      const fileAt = file !== null ? rowAt.get(file)?.at ?? null : null;
      const at = earliest(fileAt, o.t === 'siteVisitAddFile' ? timeOf(o.queuedAt) : null);
      const id = isSiteVisitOp(o) ? `visit:${siteVisitOf(o)}` : `act:${queueActIdent(o)}`;
      const was = items.get(id);
      if (was) { was.count += 1; was.at = earliest(was.at, at); } else items.set(id, { id, kind: KEPT_KIND[o.t], count: 1, at });
    }
  }
  // a row no act names: its act is rebuilt from it at the project's load, so it is a change of its own (a visit file
  // joins its visit's line)
  for (const r of rows) {
    if (counted.has(r.clientKey)) continue;
    counted.add(r.clientKey);
    const id = r.visitId !== null ? `visit:${r.visitId}` : `row:${r.clientKey}`;
    const was = items.get(id);
    if (was) { was.count += 1; was.at = earliest(was.at, r.at); } else items.set(id, { id, kind: r.visitId !== null ? 'siteVisit' : 'photo', count: 1, at: r.at });
  }
  const list = [...items.values()];
  return { projectId, name, items: list, total: list.reduce((n, i) => n + i.count, 0), unreadable };
}

/** the rows this device keeps unsent for (`sub`, `projectId`): evidence still to send or refused, visit files not yet
 *  filed, site photos still holding their bytes. A store that cannot be read gives none */
async function rowsOf(sub: string, projectId: string): Promise<KeptRow[]> {
  const [evidence, visit, site] = await Promise.all([
    listEvidence(sub, projectId).catch(() => []),
    listVisitPhotos(sub, projectId).catch(() => []),
    listSitePhotoRows(sub, projectId).catch(() => []),
  ]);
  return [
    ...evidence.map((e) => ({ clientKey: e.clientKey, at: e.createdAt, visitId: null })),
    ...visit.filter((v) => v.state !== 'filed').map((v) => ({ clientKey: v.clientKey, at: v.createdAt, visitId: v.op.visitId })),
    ...site.flatMap((e) => (isSitePhotoSent(e) ? [] : [{ clientKey: e.clientKey, at: e.createdAt, visitId: null }])),
  ];
}

/** Every project `sub` keeps changes for on this device and does not hold (`held`), each with its list; none listed has
 *  nothing kept. `storage`: the queue keys' storage. Read only */
export async function readKeptElsewhere(storage: Keys & Names, sub: string, held: ReadonlySet<string>): Promise<KeptProject[]> {
  const none = (): Set<string> => new Set();
  const [evidence, visit, site] = await Promise.all([
    evidenceProjectsOf(sub).catch(none), visitPhotoProjectsOf(sub).catch(none), sitePhotoProjectsOf(sub).catch(none),
  ]);
  const projects = new Set([...queuedProjectsOf(storage, sub), ...evidence, ...visit, ...site]);
  const scopes = { evidence: sub, visitPhoto: sub };
  const out: KeptProject[] = [];
  for (const p of [...projects].filter((x) => !held.has(x)).sort()) {
    const reads = [`vitan.outbox.${sub}.${p}`, `vitan.siteVisitQueue.${sub}.${p}`].map((k) => readOwedActs(storage, k, scopes));
    const kept = keptOf(p, readProjectName(storage, sub, p), reads, await rowsOf(sub, p));
    if (kept.total > 0 || kept.unreadable !== null) out.push(kept);
  }
  return out;
}
