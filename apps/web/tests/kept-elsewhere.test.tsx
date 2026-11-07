import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within, waitFor, act } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import type { OutboxOp } from '@/data/apiGateway';
import { EVIDENCE_READ_WAIT_MS, markEvidenceFailed, putEvidence, type EvidenceEntry } from '@/data/evidenceStore';
import { markSitePhotoRefused, markSitePhotoSent, putSitePhotoRow } from '@/data/sitePhotoStore';
import { POSTER_WAIT_MS, failVisitPhoto, fileVisitPhoto, putVisitPhoto, type VisitPhotoRow } from '@/data/visitPhotoStore';
import { afterRowWrite, closeKeptSignals } from '@/data/keptSignal';
import { keyLegacyPhotos, putBackOf } from '@/store/loadTakes';
import { KEPT_KIND, keptAnywhere, keptOf, visitRowKept, projectNameKey, queuedProjectsOf, readKeptElsewhere, readProjectName, rememberProjectName, type KeptKind } from '@/store/keptElsewhere';
import { doneName, frameOf, markName, recordBytes, recordName } from '@/store/queueLedger';
import { queueActIdent } from '@/store/queueActIdent';
import { QW } from '@/lib/queueWords';
import { ProjectSwitcher } from '@/layout/ProjectSwitcher';
import { ProjectSheet } from '@/layout/MobileSheet';
import { TopBar } from '@/layout/TopBar';

/**
 * #1388 unit 1 (read only): the changes this device keeps for projects the signed-in person no longer holds, listed at
 * the foot of the project switcher. A change is an owed act of the person's queue keys for that project (the key's and
 * its made records', less marks and done facts, as a load takes them) or an unsent row a project's load rebuilds an act
 * from; an act and its row are one change. A project the person holds, and another person's keys, are never listed.
 * Every wait here is on a signal (a store state, a settled read), never a clock.
 */

// the evidence store's list read, held on purpose by a test (G3); every other call is the store's own
const evidence = vi.hoisted(() => ({
  gate: null as Promise<void> | null, entered: null as (() => void) | null, scanGate: null as Promise<void> | null, scanEntered: null as (() => void) | null,
  scans: 0, lists: 0, siteLists: 0, visitRowsRead: [] as number[],
}));
vi.mock('@/data/evidenceStore', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/data/evidenceStore')>();
  return {
    ...real,
    listEvidence: async (...a: Parameters<typeof real.listEvidence>) => {
      evidence.lists += 1;
      const gate = evidence.gate;
      if (gate) { evidence.entered?.(); await gate; }
      return real.listEvidence(...a);
    },
    evidenceProjectsOf: async (...a: Parameters<typeof real.evidenceProjectsOf>) => {
      evidence.scans += 1;
      const gate = evidence.scanGate;
      if (gate) { evidence.scanEntered?.(); await gate; }
      return real.evidenceProjectsOf(...a);
    },
  };
});

// the row reads of the site and visit stores, counted (Codex 4498679801: the line's check reads no row it need not)
vi.mock('@/data/sitePhotoStore', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/data/sitePhotoStore')>();
  return { ...real, listSitePhotoRows: (...a: Parameters<typeof real.listSitePhotoRows>) => { evidence.siteLists += 1; return real.listSitePhotoRows(...a); } };
});
vi.mock('@/data/visitPhotoStore', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/data/visitPhotoStore')>();
  return {
    ...real,
    readVisitPhotoRowsUntil: async (...a: Parameters<typeof real.readVisitPhotoRowsUntil>) => {
      const rows = await real.readVisitPhotoRowsUntil(...a);
      evidence.visitRowsRead.push(rows.length);
      return rows;
    },
  };
});

const b64url = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (payload: Record<string, unknown>) => `${b64url({ alg: 'HS256' })}.${b64url(payload)}.sig`;
const ALPHA = { projectId: 'p-a', name: 'Alpha', short: 'ALP', role: 'pmc', orgId: null, orgName: null };
const approve = (k: string, d = 'd-1'): OutboxOp => ({ t: 'approve', decisionId: d, optionIndex: 0, idempotencyKey: k });
const outbox = (sub: string, p: string) => `vitan.outbox.${sub}.${p}`;
const lane = (sub: string, p: string) => `vitan.siteVisitQueue.${sub}.${p}`;
// each test its own person, so the IndexedDB stores need no clearing between tests
let n = 0;
let SUB = '';
beforeEach(() => { n += 1; SUB = `u-${n}`; localStorage.clear(); });
afterEach(() => {
  cleanup();
  useStore.setState(getInitialState());
  evidence.gate = null; evidence.entered = null; evidence.scanGate = null; evidence.scanEntered = null;
  evidence.scans = 0; evidence.lists = 0; evidence.siteLists = 0; evidence.visitRowsRead = [];
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('what is listed', () => {
  it('a lost project: its key, its made record and an orphan site photo row are 3 changes; a held project is not listed', async () => {
    localStorage.setItem(outbox(SUB, 'p-gone'), JSON.stringify([approve('k-1')]));
    const rec = recordBytes([approve('k-2', 'd-2')], 'nonce1');
    localStorage.setItem(recordName(outbox(SUB, 'p-gone'), [], rec, 'nonce1'), rec);
    await putSitePhotoRow(SUB, 'p-gone', { clientKey: 'ph-1', kind: 'progress' } as never);
    localStorage.setItem(outbox(SUB, 'p-a'), JSON.stringify([approve('k-3')]));
    await putSitePhotoRow(SUB, 'p-a', { clientKey: 'ph-2', kind: 'progress' } as never);

    const kept = await readKeptElsewhere(localStorage, SUB, new Set(['p-a']));
    expect(kept.map((p) => p.projectId)).toEqual(['p-gone']);
    expect(kept[0].total).toBe(3);
    expect(kept[0].items.map((i) => i.kind).sort()).toEqual(['decision', 'decision', 'photo']);
    expect(kept[0].items.find((i) => i.kind === 'photo')?.at).toEqual(expect.any(Number));
    expect(kept[0].unreadable).toBeNull();
  });

  it('another person’s keys and rows on this device are never read', async () => {
    localStorage.setItem(outbox(`${SUB}-other`, 'p-gone'), JSON.stringify([approve('k-1')]));
    await putSitePhotoRow(`${SUB}-other`, 'p-gone', { clientKey: 'ph-1', kind: 'progress' } as never);
    expect(await readKeptElsewhere(localStorage, SUB, new Set(['p-a']))).toEqual([]);
  });

  it('an act a mark or a done fact says is settled is not kept', async () => {
    const key = outbox(SUB, 'p-gone');
    const marked = approve('k-1');
    const done = approve('k-2', 'd-2');
    const owed = approve('k-3', 'd-3');
    localStorage.setItem(key, JSON.stringify([marked, done, owed]));
    // the key carries no token: its positions are named from its bytes, as the ledger's fallback names them
    const kept0 = await readKeptElsewhere(localStorage, SUB, new Set());
    expect(kept0[0].total).toBe(3);
    const s = { key, raw: localStorage.getItem(key), acts: [marked, done, owed], sidecar: null, marks: { ids: new Set<string>(), legacy: new Set<string>() }, records: [], token: null, fence: true } as never;
    const first = frameOf(s).occs[0].oid;
    localStorage.setItem(markName(key, marked, first), queueActIdent(marked));
    localStorage.setItem(doneName(key, done), JSON.stringify({ i: queueActIdent(done), n: 1 }));
    const kept = await readKeptElsewhere(localStorage, SUB, new Set());
    expect(kept[0].total).toBe(1);
  });

  it('an act and the row it sends are one change, dated by the row', async () => {
    const op: OutboxOp = { t: 'uploadEvidence', scope: SUB, clientKey: 'ev-1' };
    localStorage.setItem(outbox(SUB, 'p-gone'), JSON.stringify([op]));
    await putEvidence({ userScope: SUB, projectId: 'p-gone', clientKey: 'ev-1', mime: 'image/jpeg', data: 'AA==', inspectionId: 'i-1', inspectionItemId: 'it-1', createdAt: 1_700_000_000_000 });
    const kept = await readKeptElsewhere(localStorage, SUB, new Set());
    expect(kept[0].total).toBe(1);
    expect(kept[0].items).toEqual([{ id: expect.any(String), kind: 'photo', count: 1, at: 1_700_000_000_000, failed: false }]);
  });

  it('a site visit’s acts and its unsent files are one line, counted together', async () => {
    const end: OutboxOp = { t: 'siteVisitEnd', visitId: 'v-1', claimedAt: '2026-11-06T10:00:00.000Z', idempotencyKey: 'sv-1' };
    localStorage.setItem(lane(SUB, 'p-gone'), JSON.stringify([end]));
    const file = { t: 'siteVisitAddFile', visitId: 'v-1', scope: SUB, file: { id: 'f-1', mime: 'image/jpeg' }, by: { name: 'Pat', role: 'pmc' }, placeName: null, idempotencyKey: 'sv-2' } as const;
    await putVisitPhoto(SUB, 'p-gone', file as never, 'AA==');
    const kept = await readKeptElsewhere(localStorage, SUB, new Set());
    expect(kept[0].items).toEqual([{ id: 'visit:v-1', kind: 'siteVisit', count: 2, at: expect.any(Number), failed: false }]);
  });

  it('a key this version cannot read, with no readable record beside it, is that line alone, never counted', async () => {
    localStorage.setItem(outbox(SUB, 'p-gone'), '{not a list');
    const kept = await readKeptElsewhere(localStorage, SUB, new Set());
    expect(kept).toEqual([expect.objectContaining({ projectId: 'p-gone', total: 0, unreadable: 'damaged', items: [] })]);
  });

  it('a project with nothing owed is not listed; a copy set aside is not a queue key', () => {
    localStorage.setItem(outbox(SUB, 'p-empty'), '[]');
    localStorage.setItem(`vitan.unreadable.${outbox(SUB, 'p-aside')}.3-abc`, '[]');
    localStorage.setItem(`vitan.occ.${outbox(SUB, 'p-side')}`, '{}');
    expect([...queuedProjectsOf(localStorage, SUB)]).toEqual(['p-empty']);
    expect(keptOf('p-empty', null, [{ read: 'ok', acts: [] }], []).total).toBe(0);
  });
});

describe('what is listed (Stage 1 gap-check)', () => {
  it('G1: reading a lost project’s visit files lets go of no held-photo record', async () => {
    const file = { t: 'siteVisitAddFile', visitId: 'v-1', scope: SUB, file: { id: 'f-1', mime: 'image/jpeg' }, by: { name: 'Pat', role: 'pmc' }, placeName: null, idempotencyKey: 'sv-2' } as const;
    await putVisitPhoto(SUB, 'p-gone', file as never, 'AA==');
    await fileVisitPhoto(SUB, 'p-gone', 'f-1', 'm-1');
    // a record another tab keeps for a file whose row is not queued: a pruning read (listVisitPhotos) would let it go
    const held = `vitan.visitPhotoHeld.${SUB}.p-gone.f-1`;
    localStorage.setItem(held, JSON.stringify(['v-1']));
    await readKeptElsewhere(localStorage, SUB, new Set());
    expect(localStorage.getItem(held)).toBe(JSON.stringify(['v-1']));
  });

  it('G2: store reads that never answer read as nothing found, each at its own bound', async () => {
    localStorage.setItem(outbox(SUB, 'p-gone'), JSON.stringify([approve('k-1')]));
    await putEvidence({ userScope: SUB, projectId: 'p-gone', clientKey: 'ev-1', mime: 'image/jpeg', data: 'AA==', inspectionId: 'i-1', inspectionItemId: 'it-1' });
    await putSitePhotoRow(SUB, 'p-row', { clientKey: 'ph-1', kind: 'progress' } as never);
    // every store opens its database per read: an open that never answers hangs all three, scans and row reads alike
    vi.spyOn(indexedDB, 'open').mockImplementation(() => ({}) as IDBOpenDBRequest);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let list: Awaited<ReturnType<typeof readKeptElsewhere>> | null = null;
    let any: boolean | null = null;
    void readKeptElsewhere(localStorage, SUB, new Set()).then((k) => { list = k; });
    void keptAnywhere(localStorage, SUB, new Set(['p-gone'])).then((a) => { any = a; });
    // the bound, advanced on purpose: each hung read gives up at EVIDENCE_READ_WAIT_MS and nothing waits past it
    for (let i = 0; i < 20 && (list === null || any === null); i += 1) await vi.advanceTimersByTimeAsync(EVIDENCE_READ_WAIT_MS);
    expect(any).toBe(false);
    expect(list).toEqual([expect.objectContaining({ projectId: 'p-gone', total: 1 })]);
  });

  it('G5: a made record this version cannot read is the unreadable line, not an empty list', async () => {
    localStorage.setItem(outbox(SUB, 'p-gone'), '[]');
    localStorage.setItem(`vitan.made.${outbox(SUB, 'p-gone')}.1.nonce1.t`, '{not a record');
    const kept = await readKeptElsewhere(localStorage, SUB, new Set());
    expect(kept).toEqual([expect.objectContaining({ projectId: 'p-gone', total: 0, unreadable: 'damaged' })]);
    expect(await keptAnywhere(localStorage, SUB, new Set())).toBe(true);
  });

  it('G6: a refused row, or one waiting for a retry, is a line of its own, marked so', async () => {
    const op: OutboxOp = { t: 'uploadEvidence', scope: SUB, clientKey: 'ev-1' };
    localStorage.setItem(outbox(SUB, 'p-gone'), JSON.stringify([op, approve('k-1')]));
    await putEvidence({ userScope: SUB, projectId: 'p-gone', clientKey: 'ev-1', mime: 'image/jpeg', data: 'AA==', inspectionId: 'i-1', inspectionItemId: 'it-1' });
    await markEvidenceFailed(SUB, 'p-gone', 'ev-1', 'refused');
    const kept = await readKeptElsewhere(localStorage, SUB, new Set());
    expect(kept[0].total).toBe(2);
    expect(kept[0].items.filter((i) => i.failed)).toEqual([expect.objectContaining({ id: 'row:ev-1', kind: 'photo', count: 1 })]);
    expect(kept[0].items.filter((i) => !i.failed)).toEqual([expect.objectContaining({ kind: 'decision' })]);
  });

  it('G7: a filed visit file and a site photo the server took are not kept', async () => {
    const file = { t: 'siteVisitAddFile', visitId: 'v-1', scope: SUB, file: { id: 'f-1', mime: 'image/jpeg' }, by: { name: 'Pat', role: 'pmc' }, placeName: null, idempotencyKey: 'sv-2' } as const;
    await putVisitPhoto(SUB, 'p-gone', file as never, 'AA==');
    await fileVisitPhoto(SUB, 'p-gone', 'f-1', 'm-1');
    await putSitePhotoRow(SUB, 'p-gone', { clientKey: 'ph-1', kind: 'progress' } as never);
    await markSitePhotoSent(SUB, 'p-gone', 'ph-1');
    expect(await readKeptElsewhere(localStorage, SUB, new Set())).toEqual([]);
  });

  it('G8: one act held in the key and in a made record is one change', async () => {
    const a = approve('k-1');
    localStorage.setItem(outbox(SUB, 'p-gone'), JSON.stringify([a]));
    const rec = recordBytes([a], 'nonce1');
    localStorage.setItem(recordName(outbox(SUB, 'p-gone'), [], rec, 'nonce1'), rec);
    const kept = await readKeptElsewhere(localStorage, SUB, new Set());
    expect(kept[0].total).toBe(1);
  });
});

describe('Codex round 1 (#1394)', () => {
  const visitFile = (id: string, visitId = 'v-1') =>
    ({ t: 'siteVisitAddFile', visitId, scope: SUB, file: { id, mime: 'video/mp4' }, by: { name: 'Pat', role: 'pmc' }, placeName: null, idempotencyKey: `sv-${id}` }) as never;
  const evidenceRow = (ck: string) => putEvidence({ userScope: SUB, projectId: 'p-gone', clientKey: ck, mime: 'image/jpeg', data: 'AA==', inspectionId: 'i-1', inspectionItemId: 'it-1' });

  // Stage 1 (d): the line's metadata-only check and the list agree, fixture by fixture
  const fixtures: [string, () => Promise<unknown>][] = [
    ['evidence pending', () => evidenceRow('ev-1')],
    ['evidence failed', async () => { await evidenceRow('ev-1'); await markEvidenceFailed(SUB, 'p-gone', 'ev-1', 'refused'); }],
    ['site photo unsent', () => putSitePhotoRow(SUB, 'p-gone', { clientKey: 'ph-1', kind: 'progress' } as never)],
    ['site photo sent', async () => { await putSitePhotoRow(SUB, 'p-gone', { clientKey: 'ph-1', kind: 'progress' } as never); await markSitePhotoSent(SUB, 'p-gone', 'ph-1'); }],
    ['site photo refused', async () => { await putSitePhotoRow(SUB, 'p-gone', { clientKey: 'ph-1', kind: 'progress' } as never); await markSitePhotoRefused(SUB, 'p-gone', 'ph-1'); }],
    ['visit unfiled', () => putVisitPhoto(SUB, 'p-gone', visitFile('f-1'), 'AA==')],
    ['visit failed', async () => { await putVisitPhoto(SUB, 'p-gone', visitFile('f-1'), 'AA=='); await failVisitPhoto(SUB, 'p-gone', 'f-1', 'refused'); }],
    ['visit filed', async () => { await putVisitPhoto(SUB, 'p-gone', visitFile('f-1'), 'AA=='); await fileVisitPhoto(SUB, 'p-gone', 'f-1'); }],
    ['visit filed, its still frame waiting', async () => { await putVisitPhoto(SUB, 'p-gone', visitFile('f-1'), 'AA==', null, undefined, 'BB=='); await fileVisitPhoto(SUB, 'p-gone', 'f-1', 'm-1'); }],
    ['visit filed, its still frame lapsed', async () => {
      // the wait is passed on purpose: the clock is set, not waited on
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(1_800_000_000_000);
      await putVisitPhoto(SUB, 'p-gone', visitFile('f-1'), 'AA==', null, undefined, 'BB=='); await fileVisitPhoto(SUB, 'p-gone', 'f-1', 'm-1');
      vi.setSystemTime(1_800_000_000_000 + POSTER_WAIT_MS);
    }],
    ['mixed: filed visit, sent site photo', async () => {
      await putVisitPhoto(SUB, 'p-gone', visitFile('f-1'), 'AA=='); await fileVisitPhoto(SUB, 'p-gone', 'f-1');
      await putSitePhotoRow(SUB, 'p-gone', { clientKey: 'ph-1', kind: 'progress' } as never); await markSitePhotoSent(SUB, 'p-gone', 'ph-1');
    }],
    ['mixed: filed visit, unfiled visit', async () => {
      await putVisitPhoto(SUB, 'p-gone', visitFile('f-1'), 'AA=='); await fileVisitPhoto(SUB, 'p-gone', 'f-1');
      await putVisitPhoto(SUB, 'p-gone', visitFile('f-2', 'v-2'), 'AA==');
    }],
  ];
  it.each(fixtures)('the line and the list agree: %s', async (_name, seed) => {
    await seed();
    const any = await keptAnywhere(localStorage, SUB, new Set());
    const list = await readKeptElsewhere(localStorage, SUB, new Set());
    expect(any).toBe(list.length > 0);
  });

  it('F5: one evidence act held in the key and a made record, with its row, is one change', async () => {
    const op: OutboxOp = { t: 'uploadEvidence', scope: SUB, clientKey: 'ev-1' };
    localStorage.setItem(outbox(SUB, 'p-gone'), JSON.stringify([op]));
    const rec = recordBytes([op], 'nonce1');
    localStorage.setItem(recordName(outbox(SUB, 'p-gone'), [], rec, 'nonce1'), rec);
    await evidenceRow('ev-1');
    const kept = await readKeptElsewhere(localStorage, SUB, new Set());
    expect(kept[0].total).toBe(1);
  });

  it('F6: a key this version cannot read still lists what its readable made records hold, as a load restores it', async () => {
    localStorage.setItem(outbox(SUB, 'p-gone'), '{not a list');
    const rec = recordBytes([approve('k-1')], 'nonce1');
    localStorage.setItem(recordName(outbox(SUB, 'p-gone'), [], rec, 'nonce1'), rec);
    const kept = await readKeptElsewhere(localStorage, SUB, new Set());
    expect(kept).toEqual([expect.objectContaining({ projectId: 'p-gone', total: 1, unreadable: 'damaged' })]);
    expect(kept[0].items).toEqual([expect.objectContaining({ kind: 'decision', count: 1 })]);
  });

  it('F2: the line decides evidence and site photos from keys alone, reading no row', async () => {
    await evidenceRow('ev-1');
    await putSitePhotoRow(SUB, 'p-other', { clientKey: 'ph-1', kind: 'progress' } as never);
    expect(await keptAnywhere(localStorage, SUB, new Set())).toBe(true);
    expect(await keptAnywhere(localStorage, SUB, new Set(['p-gone']))).toBe(true);
    expect([evidence.lists, evidence.siteLists]).toEqual([0, 0]);
  });

  it('F2: a filed visit file is read by the line once per tab, and again after a sign-out', async () => {
    await putVisitPhoto(SUB, 'p-gone', visitFile('f-1'), 'AA==');
    await fileVisitPhoto(SUB, 'p-gone', 'f-1');
    expect(await keptAnywhere(localStorage, SUB, new Set())).toBe(false);
    expect(await keptAnywhere(localStorage, SUB, new Set())).toBe(false);
    expect(evidence.visitRowsRead).toEqual([1, 0]);
    useStore.setState({ sessionToken: jwt({ sub: SUB, role: 'pmc', projectId: 'p-a' }) });
    useStore.getState().completeSignOut();
    expect(await keptAnywhere(localStorage, SUB, new Set())).toBe(false);
    expect(evidence.visitRowsRead).toEqual([1, 0, 1]);
  });

  it('Stage 1 (e): an evidence row is only ever unsent (a sent one is deleted: evidence.test.ts "confirmed upload cleans the bytes up")', () => {
    type Other = Exclude<EvidenceEntry['status'], 'pending' | 'failed'>;
    const none: [Other] extends [never] ? true : false = true;
    expect(none).toBe(true);
  });

  it('F3: a filed clip whose still frame waits is kept until the wait lapses', async () => {
    await putVisitPhoto(SUB, 'p-gone', visitFile('f-1'), 'AA==', null, undefined, 'BB==');
    await fileVisitPhoto(SUB, 'p-gone', 'f-1', 'm-1');
    const kept = await readKeptElsewhere(localStorage, SUB, new Set());
    expect(kept[0].items).toEqual([expect.objectContaining({ id: 'visit:v-1', kind: 'siteVisit', count: 1, failed: false })]);
    const row = { state: 'filed', poster: 'BB==', mediaId: 'm-1', filedAt: 1_000 } as VisitPhotoRow;
    expect(visitRowKept(row, 1_000 + POSTER_WAIT_MS - 1)).toBe(true);
    expect(visitRowKept(row, 1_000 + POSTER_WAIT_MS)).toBe(false);
  });

  describe('F1: another tab keeping a change, or the page shown again, checks again', () => {
    const signIn = () => useStore.setState({ sessionToken: jwt({ sub: SUB, role: 'pmc', projectId: 'p-a' }), memberships: [ALPHA] as never, activeProjectId: 'p-a' });
    const storageEvent = (key: string | null) => window.dispatchEvent(new StorageEvent('storage', { key }));

    it('a write to one of the person’s queue keys in another tab shows the line', async () => {
      signIn();
      localStorage.setItem(outbox(SUB, 'p-gone'), JSON.stringify([approve('k-1')]));
      storageEvent(outbox(SUB, 'p-gone'));
      await waitFor(() => expect(useStore.getState().keptElsewhereAny).toBe(true));
    });

    it('the page shown again checks again', async () => {
      signIn();
      localStorage.setItem(lane(SUB, 'p-gone'), JSON.stringify([{ t: 'siteVisitEnd', visitId: 'v-1', claimedAt: '2026-11-06T10:00:00.000Z', idempotencyKey: 'sv-1' }]));
      document.dispatchEvent(new Event('visibilitychange'));
      await waitFor(() => expect(useStore.getState().keptElsewhereAny).toBe(true));
    });

    it('another person’s keys, and other keys, start no check', () => {
      signIn();
      storageEvent(outbox(`${SUB}-other`, 'p-gone'));
      storageEvent(`vitan.settled.${outbox(SUB, 'p-gone')}.t.o1`);
      expect(evidence.scans).toBe(0);
    });

    it('(a) triggers while a check runs are coalesced: three give one more check, not three', async () => {
      signIn();
      let open!: () => void;
      evidence.scanGate = new Promise<void>((r) => { open = r; });
      const entered = new Promise<void>((r) => { evidence.scanEntered = r; });
      storageEvent(outbox(SUB, 'p-x'));
      expect(evidence.scans).toBe(1); // the check starts at once
      await entered;
      evidence.scanGate = null;
      storageEvent(outbox(SUB, 'p-x'));
      storageEvent(`vitan.made.${lane(SUB, 'p-x')}.1.n.t`);
      storageEvent(null);
      expect(evidence.scans).toBe(1);
      open();
      await waitFor(() => expect(evidence.scans).toBe(2));
    });
  });

  it('F4: a list read dropped by a memberships change while the list is open is read again', async () => {
    localStorage.setItem(outbox(SUB, 'p-gone'), JSON.stringify([approve('k-1')]));
    rememberProjectName(localStorage, SUB, 'p-gone', 'Gone Tower');
    useStore.setState({ sessionToken: jwt({ sub: SUB, role: 'pmc', projectId: 'p-a' }), memberships: [ALPHA] as never, activeProjectId: 'p-a', keptElsewhereAny: true });
    let open!: () => void;
    evidence.gate = new Promise<void>((r) => { open = r; });
    const entered = new Promise<void>((r) => { evidence.entered = r; });
    render(<ProjectSheet onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('kept-elsewhere-line'));
    await entered; // the first read waits on its rows
    evidence.gate = null;
    act(() => { useStore.setState({ memberships: [{ ...ALPHA }] as never }); });
    open();
    expect(await screen.findByText('Gone Tower')).toBeTruthy();
  });
});

describe('the project name', () => {
  it('is kept per person and project, and read back; a full storage keeps the last one', () => {
    rememberProjectName(localStorage, SUB, 'p-gone', 'Gone Tower');
    expect(readProjectName(localStorage, SUB, 'p-gone')).toBe('Gone Tower');
    expect(readProjectName(localStorage, `${SUB}-other`, 'p-gone')).toBeNull();
    const full = { getItem: (k: string) => localStorage.getItem(k), setItem: () => { throw new Error('quota'); } };
    rememberProjectName(full, SUB, 'p-gone', 'Renamed');
    expect(readProjectName(localStorage, SUB, 'p-gone')).toBe('Gone Tower');
  });

  it('is written where a snapshot names the project, for the signed-in person', () => {
    useStore.setState({ sessionToken: jwt({ sub: SUB, role: 'pmc', projectId: 'p-a' }), activeProjectId: 'p-a' });
    const snap = {
      project: { id: 'p-a', name: 'Alpha Heights', short: 'ALP', descriptor: '', stage: '', siteCode: '', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
      decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
      drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
    };
    useStore.getState().applySnapshot(snap as never);
    expect(localStorage.getItem(projectNameKey(SUB, 'p-a'))).toBe('Alpha Heights');
  });

  it('G7: with no one signed in, a snapshot writes no name record', () => {
    useStore.setState({ sessionToken: null, activeProjectId: 'p-a' });
    const snap = {
      project: { id: 'p-a', name: 'Alpha Heights', short: 'ALP', descriptor: '', stage: '', siteCode: '', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
      decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
      drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
    };
    useStore.getState().applySnapshot(snap as never);
    expect(Object.keys(localStorage).filter((k) => k.startsWith('vitan.projectName.'))).toEqual([]);
  });
});

describe('the store', () => {
  const signIn = (extra: Record<string, unknown> = {}) =>
    useStore.setState({ sessionToken: jwt({ sub: SUB, role: 'pmc', projectId: 'p-a' }), memberships: [ALPHA] as never, activeProjectId: 'p-a', ...extra });

  it('G10: the line comes from a keys-only check; the list is read only when asked for', async () => {
    localStorage.setItem(outbox(SUB, 'p-gone'), JSON.stringify([approve('k-1')]));
    signIn();
    await useStore.getState().checkKeptElsewhere();
    expect(useStore.getState().keptElsewhereAny).toBe(true);
    expect(useStore.getState().keptElsewhere).toBeNull();
  });

  it('reads the list for the memberships held, and adopts it only for the memberships it read for', async () => {
    localStorage.setItem(outbox(SUB, 'p-gone'), JSON.stringify([approve('k-1')]));
    rememberProjectName(localStorage, SUB, 'p-gone', 'Gone Tower');
    signIn();
    await useStore.getState().loadKeptElsewhere();
    expect(useStore.getState().keptElsewhere).toEqual([expect.objectContaining({ projectId: 'p-gone', name: 'Gone Tower', total: 1 })]);
    expect(useStore.getState().keptElsewhereAny).toBe(true);

    // a newer memberships read lands while this one reads the rows: this one is not adopted
    useStore.setState({ keptElsewhere: null });
    const reading = useStore.getState().loadKeptElsewhere();
    useStore.setState({ memberships: [ALPHA, { ...ALPHA, projectId: 'p-gone', name: 'Gone Tower' }] as never });
    await reading;
    expect(useStore.getState().keptElsewhere).toBeNull();
  });

  it('G3: an older read that lands after a newer one is not adopted', async () => {
    const key = outbox(SUB, 'p-gone');
    localStorage.setItem(key, JSON.stringify([approve('k-1')]));
    signIn();
    let open!: () => void;
    evidence.gate = new Promise<void>((r) => { open = r; });
    const entered = new Promise<void>((r) => { evidence.entered = r; });
    const older = useStore.getState().loadKeptElsewhere();
    await entered; // the older read has its keys and waits on its rows
    evidence.gate = null;
    localStorage.setItem(key, JSON.stringify([approve('k-1'), approve('k-2', 'd-2')]));
    await useStore.getState().loadKeptElsewhere();
    expect(useStore.getState().keptElsewhere?.[0].total).toBe(2);
    open();
    await older;
    expect(useStore.getState().keptElsewhere?.[0].total).toBe(2);
  });

  it('G3: an older check that lands after a newer one is not adopted', async () => {
    signIn();
    let open!: () => void;
    evidence.scanGate = new Promise<void>((r) => { open = r; });
    const entered = new Promise<void>((r) => { evidence.scanEntered = r; });
    const older = useStore.getState().checkKeptElsewhere();
    await entered; // the older check found no key owing and waits on the stores' row keys
    evidence.scanGate = null;
    localStorage.setItem(outbox(SUB, 'p-gone'), JSON.stringify([approve('k-1')]));
    await useStore.getState().checkKeptElsewhere();
    expect(useStore.getState().keptElsewhereAny).toBe(true);
    open();
    await older;
    expect(useStore.getState().keptElsewhereAny).toBe(true);
  });

  it('H1: a lost project whose rows are all gone since (a filed visit file, a sent site photo) shows no line', async () => {
    const file = { t: 'siteVisitAddFile', visitId: 'v-1', scope: SUB, file: { id: 'f-1', mime: 'image/jpeg' }, by: { name: 'Pat', role: 'pmc' }, placeName: null, idempotencyKey: 'sv-2' } as const;
    await putVisitPhoto(SUB, 'p-gone', file as never, 'AA==');
    await fileVisitPhoto(SUB, 'p-gone', 'f-1', 'm-1');
    await putSitePhotoRow(SUB, 'p-gone', { clientKey: 'ph-1', kind: 'progress' } as never);
    await markSitePhotoSent(SUB, 'p-gone', 'ph-1');
    signIn();
    await useStore.getState().checkKeptElsewhere();
    expect(useStore.getState().keptElsewhereAny).toBe(false);
    render(<ProjectSwitcher />);
    expect(screen.getByTestId('project-switcher').tagName).toBe('DIV');
    expect(screen.queryByTestId('kept-elsewhere-line')).toBeNull();
  });

  it('H2: a check started before a list read and landing after it does not overwrite the list’s answer', async () => {
    signIn({ keptElsewhereAny: true });
    let open!: () => void;
    evidence.scanGate = new Promise<void>((r) => { open = r; });
    const entered = new Promise<void>((r) => { evidence.scanEntered = r; });
    // the check finds no key owing and waits on the stores' row keys
    const check = useStore.getState().checkKeptElsewhere();
    await entered;
    evidence.scanGate = null;
    localStorage.setItem(outbox(SUB, 'p-gone'), JSON.stringify([approve('k-1')]));
    await useStore.getState().loadKeptElsewhere();
    expect(useStore.getState().keptElsewhereAny).toBe(true);
    open();
    await check;
    expect(useStore.getState().keptElsewhereAny).toBe(true);
  });

  it('G4: the project open now is never listed, even before the memberships name it', async () => {
    localStorage.setItem(outbox(SUB, 'p-new'), JSON.stringify([approve('k-1')]));
    signIn({ activeProjectId: 'p-new' });
    await useStore.getState().checkKeptElsewhere();
    await useStore.getState().loadKeptElsewhere();
    expect(useStore.getState().keptElsewhereAny).toBe(false);
    expect(useStore.getState().keptElsewhere).toEqual([]);
  });

  it('reads nothing before the memberships are known, or with no session', async () => {
    localStorage.setItem(outbox(SUB, 'p-gone'), JSON.stringify([approve('k-1')]));
    signIn({ memberships: [] });
    await useStore.getState().checkKeptElsewhere();
    await useStore.getState().loadKeptElsewhere();
    expect(useStore.getState().keptElsewhere).toBeNull();
    expect(useStore.getState().keptElsewhereAny).toBe(false);
    signIn({ sessionToken: null });
    await useStore.getState().checkKeptElsewhere();
    await useStore.getState().loadKeptElsewhere();
    expect(useStore.getState().keptElsewhere).toBeNull();
    expect(useStore.getState().keptElsewhereAny).toBe(false);
  });

  it('a sign-out clears the line and the list', async () => {
    localStorage.setItem(outbox(SUB, 'p-gone'), JSON.stringify([approve('k-1')]));
    signIn();
    await useStore.getState().loadKeptElsewhere();
    expect(useStore.getState().keptElsewhere).toHaveLength(1);
    useStore.getState().completeSignOut();
    expect(useStore.getState().keptElsewhere).toBeNull();
    expect(useStore.getState().keptElsewhereAny).toBe(false);
  });
});

describe('the switcher', () => {
  async function seeded(lang: 'en' | 'hi' = 'en') {
    localStorage.setItem(outbox(SUB, 'p-gone'), JSON.stringify([approve('k-1'), approve('k-2', 'd-2')]));
    rememberProjectName(localStorage, SUB, 'p-gone', 'Gone Tower');
    useStore.setState({ sessionToken: jwt({ sub: SUB, role: 'pmc', projectId: 'p-a' }), memberships: [ALPHA] as never, activeProjectId: 'p-a', lang });
    await useStore.getState().checkKeptElsewhere();
    expect(useStore.getState().keptElsewhereAny).toBe(true);
  }

  it('one project held and nothing to create: the switcher still opens, for the kept line, which opens the list', async () => {
    await seeded();
    render(<ProjectSwitcher />);
    fireEvent.click(screen.getByTestId('project-switcher'));
    fireEvent.click(screen.getByText(QW.keptElsewhere.en));
    const list = await screen.findByTestId('kept-elsewhere');
    expect(await within(list).findByText('Gone Tower')).toBeTruthy();
    expect(within(list).getByText('2 changes')).toBeTruthy();
    expect(within(list).getAllByTestId('kept-item').map((e) => e.textContent)).toEqual(['Decision', 'Decision']);
    expect(within(list).getByText(QW.keptIntro.en)).toBeTruthy();
  });

  it('nothing kept: no line, and one project with nothing to create is the plain name', () => {
    useStore.setState({ sessionToken: jwt({ sub: SUB, role: 'pmc', projectId: 'p-a' }), memberships: [ALPHA] as never, activeProjectId: 'p-a' });
    render(<ProjectSwitcher />);
    expect(screen.getByTestId('project-switcher').tagName).toBe('DIV');
    expect(screen.queryByTestId('kept-elsewhere-line')).toBeNull();
  });

  it('the phone’s project sheet shows the same line and opens the list, in the person’s language', async () => {
    await seeded('hi');
    render(<ProjectSheet onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('kept-elsewhere-line'));
    const list = await screen.findByTestId('kept-elsewhere');
    expect(within(list).getByText(QW.keptTitle.hi)).toBeTruthy();
    expect(await within(list).findByText('2 बदलाव')).toBeTruthy();
  });

  it('a project with no name record is named as one the person no longer has access to', async () => {
    localStorage.setItem(outbox(SUB, 'p-gone'), JSON.stringify([approve('k-1')]));
    useStore.setState({ sessionToken: jwt({ sub: SUB, role: 'pmc', projectId: 'p-a' }), memberships: [ALPHA] as never, activeProjectId: 'p-a' });
    await useStore.getState().checkKeptElsewhere();
    render(<ProjectSwitcher />);
    fireEvent.click(screen.getByTestId('project-switcher'));
    fireEvent.click(screen.getByTestId('kept-elsewhere-line'));
    const list = await screen.findByTestId('kept-elsewhere');
    expect(await within(list).findByText(QW.keptUnknownProject.en)).toBeTruthy();
    expect(within(list).getByText('1 change')).toBeTruthy();
  });
});

describe('the list (Stage 1 G6, G9)', () => {
  it('a refused row carries its own note, and the list’s items are a list', async () => {
    const op: OutboxOp = { t: 'uploadEvidence', scope: SUB, clientKey: 'ev-1' };
    localStorage.setItem(outbox(SUB, 'p-gone'), JSON.stringify([op]));
    await putEvidence({ userScope: SUB, projectId: 'p-gone', clientKey: 'ev-1', mime: 'image/jpeg', data: 'AA==', inspectionId: 'i-1', inspectionItemId: 'it-1' });
    await markEvidenceFailed(SUB, 'p-gone', 'ev-1', 'refused');
    useStore.setState({ sessionToken: jwt({ sub: SUB, role: 'pmc', projectId: 'p-a' }), memberships: [ALPHA] as never, activeProjectId: 'p-a', keptElsewhereAny: true });
    render(<ProjectSheet onClose={() => {}} />);
    fireEvent.click(screen.getByTestId('kept-elsewhere-line'));
    const list = await screen.findByTestId('kept-elsewhere');
    expect((await within(list).findByTestId('kept-failed')).textContent).toBe(QW.keptFailed.en);
    // a styled list loses its list role in Safari: it is named again
    expect(within(list).getByRole('list').getAttribute('role')).toBe('list');
  });

  it('G9: a list emptied since the line was read says nothing is kept, and its close returns focus to the switcher', async () => {
    useStore.setState({ sessionToken: jwt({ sub: SUB, role: 'pmc', projectId: 'p-a' }), memberships: [ALPHA] as never, activeProjectId: 'p-a', keptElsewhereAny: true });
    render(<ProjectSwitcher />);
    fireEvent.click(screen.getByTestId('project-switcher'));
    fireEvent.click(screen.getByTestId('kept-elsewhere-line'));
    const list = await screen.findByTestId('kept-elsewhere');
    expect((await within(list).findByTestId('kept-none')).textContent).toBe(QW.keptNone.en);
    // the line has gone with the list: one project, nothing to create, so the switcher is the plain name again
    await waitFor(() => expect(screen.getByTestId('project-switcher').tagName).toBe('DIV'));
    act(() => { fireEvent.click(within(list).getByText(QW.keptClose.en)); });
    expect(screen.queryByTestId('kept-elsewhere')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('project-switcher'));
  });

  it('G9, on the phone: the project button disabled by an emptied list, the close sends focus to the bar’s name', async () => {
    useStore.setState({ sessionToken: jwt({ sub: SUB, role: 'pmc', projectId: 'p-a' }), memberships: [ALPHA] as never, activeProjectId: 'p-a', keptElsewhereAny: true });
    render(<TopBar />);
    fireEvent.click(screen.getByTestId('mobile-project-switcher'));
    fireEvent.click(screen.getByTestId('kept-elsewhere-line'));
    const list = await screen.findByTestId('kept-elsewhere');
    await within(list).findByTestId('kept-none');
    await waitFor(() => expect((screen.getByTestId('mobile-project-switcher') as HTMLButtonElement).disabled).toBe(true));
    act(() => { fireEvent.click(within(list).getByText(QW.keptClose.en)); });
    expect(screen.queryByTestId('kept-elsewhere')).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId('mobile-project-switcher').parentElement);
  });
});

describe('words', () => {
  // a kind added to OutboxOp with no group fails the typecheck here, as KEPT_KIND's own type does
  type Missing = Exclude<OutboxOp['t'], keyof typeof KEPT_KIND>;
  const noneMissing: [Missing] extends [never] ? true : false = true;

  it('every act kind has a group, and every group a label in en, hi and gu', () => {
    expect(noneMissing).toBe(true);
    const groups = new Set<KeptKind>(Object.values(KEPT_KIND));
    const label: Record<KeptKind, keyof typeof QW> = {
      decision: 'keptKindDecision', drawing: 'keptKindDrawing', inspection: 'keptKindInspection', activity: 'keptKindActivity',
      dailyLog: 'keptKindDailyLog', siteVisit: 'keptKindSiteVisit', photo: 'keptKindPhoto', materials: 'keptKindMaterials',
      labour: 'keptKindLabour', commercial: 'keptKindCommercial', budget: 'keptKindBudget',
    };
    for (const g of groups) for (const l of ['en', 'hi', 'gu'] as const) expect(QW[label[g]][l].length).toBeGreaterThan(0);
  });

  it('each kept line has en, hi and gu with the same {placeholders}', () => {
    const marks = (t: string) => [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    for (const [k, w] of Object.entries(QW).filter(([k]) => k.startsWith('kept'))) {
      expect(marks(w.hi), k).toBe(marks(w.en));
      expect(marks(w.gu), k).toBe(marks(w.en));
    }
  });
});

describe('#1397: what a load takes, by the load\'s own rules (Codex round 2 on #1394)', () => {
  const visitFile = (id: string, visitId = 'v-1', start: unknown = null) =>
    [{ t: 'siteVisitAddFile', visitId, scope: SUB, file: { id, mime: 'image/jpeg' }, by: { name: 'Pat', role: 'pmc' }, placeName: null, idempotencyKey: `sv-${id}` }, start] as const;
  const startOf = (visitId: string, k = `st-${visitId}`) => ({ t: 'siteVisitStart', body: { id: visitId }, idempotencyKey: k }) as never;
  const both = async () => ({ any: await keptAnywhere(localStorage, SUB, new Set()), list: await readKeptElsewhere(localStorage, SUB, new Set()) });

  describe('R2-1 (Codex 4499008047): a file the server removed is not kept', () => {
    const removedKey = (ck: string) => `vitan.visitPhotoRemoved.${SUB}.p-gone.${ck}`;

    it('a queued visit file with a removal record is neither listed nor on the line', async () => {
      const [op] = visitFile('f-1');
      await putVisitPhoto(SUB, 'p-gone', op as never, 'AA==');
      localStorage.setItem(removedKey('f-1'), '1');
      expect(await both()).toEqual({ any: false, list: [] });
    });

    it('the line reads no removed row: it is skipped by its key', async () => {
      const [op] = visitFile('f-1');
      await putVisitPhoto(SUB, 'p-gone', op as never, 'AA==');
      localStorage.setItem(removedKey('f-1'), '1');
      expect(await keptAnywhere(localStorage, SUB, new Set())).toBe(false);
      expect(evidence.visitRowsRead).toEqual([0]);
    });

    it('a removed file beside a kept one: only the kept one is listed', async () => {
      const [a] = visitFile('f-1');
      const [b] = visitFile('f-2');
      await putVisitPhoto(SUB, 'p-gone', a as never, 'AA==');
      await putVisitPhoto(SUB, 'p-gone', b as never, 'AA==');
      localStorage.setItem(removedKey('f-1'), '1');
      const { any, list } = await both();
      expect(any).toBe(true);
      expect(list[0].items).toEqual([expect.objectContaining({ id: 'visit:v-1', count: 1 })]);
    });

    it('removal records that cannot be read fail closed: no visit file counted, the project says some changes cannot be read, the line shows', async () => {
      const [op] = visitFile('f-1');
      await putVisitPhoto(SUB, 'p-gone', op as never, 'AA==');
      vi.spyOn(Storage.prototype, 'key').mockImplementation(() => { throw new Error('blocked'); });
      const { any, list } = await both();
      expect(any).toBe(true);
      expect(list).toEqual([expect.objectContaining({ projectId: 'p-gone', total: 0, items: [], unreadable: 'damaged' })]);
    });

    it('a refused file the server has since removed is not listed either', async () => {
      const [op] = visitFile('f-1');
      await putVisitPhoto(SUB, 'p-gone', op as never, 'AA==');
      await failVisitPhoto(SUB, 'p-gone', 'f-1', 'refused');
      localStorage.setItem(removedKey('f-1'), '1');
      expect(await both()).toEqual({ any: false, list: [] });
    });

    it('another tab writing a removal record checks the line again; another person\'s does not', async () => {
      useStore.setState({ sessionToken: jwt({ sub: SUB, role: 'pmc', projectId: 'p-a' }), memberships: [ALPHA] as never, activeProjectId: 'p-a' });
      window.dispatchEvent(new StorageEvent('storage', { key: `vitan.visitPhotoRemoved.${SUB}-other.p-gone.f-1` }));
      expect(evidence.scans).toBe(0);
      window.dispatchEvent(new StorageEvent('storage', { key: removedKey('f-1') }));
      expect(evidence.scans).toBe(1);
    });
  });

  describe('R2-3 (Codex 4499008043): the start a queued visit file carries is counted, as the put-back puts it back', () => {
    it('a file whose row holds its visit\'s start, the lane holding none: two changes on the visit\'s line', async () => {
      const [op] = visitFile('f-1');
      await putVisitPhoto(SUB, 'p-gone', op as never, 'AA==', startOf('v-1'));
      const { any, list } = await both();
      expect(any).toBe(true);
      expect(list[0].items).toEqual([expect.objectContaining({ id: 'visit:v-1', kind: 'siteVisit', count: 2 })]);
    });

    it('a start the lane already holds is not counted again', async () => {
      localStorage.setItem(lane(SUB, 'p-gone'), JSON.stringify([startOf('v-1')]));
      const [op] = visitFile('f-1');
      await putVisitPhoto(SUB, 'p-gone', op as never, 'AA==', startOf('v-1'));
      expect((await readKeptElsewhere(localStorage, SUB, new Set()))[0].total).toBe(2);
    });

    it('two files carrying the same start: the start is one change', async () => {
      const [a] = visitFile('f-1');
      const [b] = visitFile('f-2');
      await putVisitPhoto(SUB, 'p-gone', a as never, 'AA==', startOf('v-1'));
      await putVisitPhoto(SUB, 'p-gone', b as never, 'AA==', startOf('v-1'));
      expect((await readKeptElsewhere(localStorage, SUB, new Set()))[0].total).toBe(3);
    });

    it('the put-back\'s own rule: a start already queued, or put back for an earlier file, is not put back again', () => {
      const [a] = visitFile('f-1');
      const [b] = visitFile('f-2');
      const row = (op: unknown, ck: string) => ({ key: ck, userScope: SUB, projectId: 'p-gone', clientKey: ck, op, start: startOf('v-1'), data: 'AA==', state: 'queued', reason: null, createdAt: 1 }) as never;
      const queued = new Set<string>();
      expect(putBackOf(row(a, 'f-1'), queued, new Set())).toEqual({ poster: false, start: startOf('v-1'), present: false });
      expect(putBackOf(row(b, 'f-2'), queued, new Set())).toEqual({ poster: false, start: null, present: false });
      expect(putBackOf(row(a, 'f-1'), new Set(['st-v-1']), new Set())).toEqual({ poster: false, start: null, present: false });
      expect(putBackOf(row(a, 'f-1'), new Set(), new Set(['f-1']))).toBeNull();
    });

    it('a refused file\'s start is not put back, so not counted: the file is its own line', async () => {
      const [op] = visitFile('f-1');
      await putVisitPhoto(SUB, 'p-gone', op as never, 'AA==', startOf('v-1'));
      await failVisitPhoto(SUB, 'p-gone', 'f-1', 'refused');
      const list = await readKeptElsewhere(localStorage, SUB, new Set());
      expect(list[0].items).toEqual([expect.objectContaining({ id: 'row:f-1', count: 1, failed: true })]);
    });
  });

  describe('R2-4 (Codex 4499008051): each key keeps only the acts a load takes from it', () => {
    const end = { t: 'siteVisitEnd', visitId: 'v-1', claimedAt: '2026-11-06T10:00:00.000Z', idempotencyKey: 'sv-1' };

    it('a visit act in the general key, and a general act in the visit lane, are not kept', async () => {
      localStorage.setItem(outbox(SUB, 'p-gone'), JSON.stringify([end]));
      localStorage.setItem(lane(SUB, 'p-gone'), JSON.stringify([approve('k-1')]));
      expect(await both()).toEqual({ any: false, list: [] });
    });

    it('a site photo act in the general key is not kept (its row is the record a load rebuilds it from)', async () => {
      localStorage.setItem(outbox(SUB, 'p-gone'), JSON.stringify([{ t: 'uploadSitePhoto', scope: SUB, clientKey: 'ph-1' }]));
      expect(await both()).toEqual({ any: false, list: [] });
    });

    it('a malformed materials act: the ledger cannot read the key, as the load cannot, so it is that line, never counted', async () => {
      localStorage.setItem(outbox(SUB, 'p-gone'), JSON.stringify([{ t: 'reserveStock', body: {} }, approve('k-1')]));
      const list = await readKeptElsewhere(localStorage, SUB, new Set());
      expect(list).toEqual([expect.objectContaining({ total: 0, unreadable: 'damaged' })]);
    });

    it('an earlier release\'s unkeyed photo in the key, and the same photo keyed in a made record, is one change', async () => {
      const unkeyed = { t: 'uploadMedia', input: { kind: 'progress', data: 'AA==', mime: 'image/jpeg' } } as never as OutboxOp;
      localStorage.setItem(outbox(SUB, 'p-gone'), JSON.stringify([unkeyed]));
      const listed1 = await readKeptElsewhere(localStorage, SUB, new Set());
      expect(listed1[0].total).toBe(1);
      // the load's own keying of it, kept in a made record by its write
      const keyed = keyLegacyPhotos([unkeyed], outbox(SUB, 'p-gone')).ops;
      const rec = recordBytes(keyed, 'nonce1');
      localStorage.setItem(recordName(outbox(SUB, 'p-gone'), [], rec, 'nonce1'), rec);
      expect((await readKeptElsewhere(localStorage, SUB, new Set()))[0].total).toBe(1);
    });

    it('a done fact for the photo as the load keys it settles it: not kept', async () => {
      const unkeyed = { t: 'uploadMedia', input: { kind: 'progress', data: 'AA==', mime: 'image/jpeg' } } as never as OutboxOp;
      localStorage.setItem(outbox(SUB, 'p-gone'), JSON.stringify([unkeyed]));
      const [keyed] = keyLegacyPhotos([unkeyed], outbox(SUB, 'p-gone')).ops;
      localStorage.setItem(doneName(outbox(SUB, 'p-gone'), keyed), JSON.stringify({ i: queueActIdent(keyed), n: 1 }));
      expect(await both()).toEqual({ any: false, list: [] });
    });
  });

  describe('R2-2 (Codex 4499008032): a row write in another tab checks the line again', () => {
    /** BroadcastChannel as the platform has it: a post reaches every other open channel of the name, never itself */
    class FakeChannel {
      static open = new Set<FakeChannel>();
      static posts: string[] = [];
      onmessage: ((e: { data: unknown }) => void) | null = null;
      closed = false;
      readonly name: string;
      constructor(name: string) { this.name = name; FakeChannel.open.add(this); }
      postMessage(data: unknown): void {
        FakeChannel.posts.push(this.name);
        for (const c of FakeChannel.open) if (c !== this && c.name === this.name) queueMicrotask(() => { if (!c.closed) c.onmessage?.({ data }); });
      }
      close(): void { this.closed = true; FakeChannel.open.delete(this); }
    }
    const signIn = () => useStore.setState({ sessionToken: jwt({ sub: SUB, role: 'pmc', projectId: 'p-a' }), memberships: [ALPHA] as never, activeProjectId: 'p-a' });
    beforeEach(() => { closeKeptSignals(); FakeChannel.open.clear(); FakeChannel.posts = []; vi.stubGlobal('BroadcastChannel', FakeChannel); });
    afterEach(() => { closeKeptSignals(); vi.unstubAllGlobals(); });

    it('each row write, landed or not, tells the person\'s other tabs, on their own channel', async () => {
      const otherTab = new FakeChannel(`vitan.kept.${SUB}`);
      let heard = 0;
      otherTab.onmessage = () => { heard += 1; };
      await putSitePhotoRow(SUB, 'p-gone', { clientKey: 'ph-1', kind: 'progress' } as never);
      await waitFor(() => expect(heard).toBe(1));
      await markSitePhotoSent(SUB, 'p-gone', 'ph-1');
      await putEvidence({ userScope: SUB, projectId: 'p-gone', clientKey: 'ev-1', mime: 'image/jpeg', data: 'AA==', inspectionId: 'i-1', inspectionItemId: 'it-1' });
      await markEvidenceFailed(SUB, 'p-gone', 'ev-1', 'refused');
      const [op] = visitFile('f-1');
      await putVisitPhoto(SUB, 'p-gone', op as never, 'AA==');
      await fileVisitPhoto(SUB, 'p-gone', 'f-1');
      await waitFor(() => expect(heard).toBe(6));
    });

    it('a row write in another tab, for a project this person no longer holds, shows the line', async () => {
      signIn();
      await useStore.getState().checkKeptElsewhere();
      expect(useStore.getState().keptElsewhereAny).toBe(false);
      await putSitePhotoRow(SUB, 'p-gone', { clientKey: 'ph-1', kind: 'progress' } as never);
      new FakeChannel(`vitan.kept.${SUB}`).postMessage('row');
      await waitFor(() => expect(useStore.getState().keptElsewhereAny).toBe(true));
    });

    it('another person\'s row writes start no check; after a sign-out nothing is heard', async () => {
      signIn();
      await useStore.getState().checkKeptElsewhere();
      const before = evidence.scans;
      new FakeChannel(`vitan.kept.${SUB}-other`).postMessage('row');
      await Promise.resolve(); await Promise.resolve();
      expect(evidence.scans).toBe(before);
      useStore.getState().completeSignOut();
      expect([...FakeChannel.open].filter((c) => c.name === `vitan.kept.${SUB}`)).toHaveLength(0);
      new FakeChannel(`vitan.kept.${SUB}`).postMessage('row');
      await Promise.resolve(); await Promise.resolve();
      expect(evidence.scans).toBe(before);
    });

    it('a channel heard after the session moved to another person starts no check for them', async () => {
      signIn();
      await useStore.getState().checkKeptElsewhere();
      const before = evidence.scans;
      useStore.setState({ sessionToken: jwt({ sub: `${SUB}-b`, role: 'pmc', projectId: 'p-a' }) });
      new FakeChannel(`vitan.kept.${SUB}`).postMessage('row');
      await Promise.resolve(); await Promise.resolve();
      expect(evidence.scans).toBe(before);
    });

    it('a page that cannot make the channel still writes, and a write that fails still fails, unchanged', async () => {
      vi.stubGlobal('BroadcastChannel', class { constructor() { throw new Error('no channel'); } });
      await expect(putSitePhotoRow(SUB, 'p-gone', { clientKey: 'ph-1', kind: 'progress' } as never)).resolves.toBeUndefined();
      // and the line's check, which listens, still runs and shows the line
      signIn();
      await useStore.getState().checkKeptElsewhere();
      expect(useStore.getState().keptElsewhereAny).toBe(true);
      vi.stubGlobal('BroadcastChannel', FakeChannel);
      const otherTab = new FakeChannel(`vitan.kept.${SUB}`);
      let heard = 0;
      otherTab.onmessage = () => { heard += 1; };
      const [op] = visitFile('f-1');
      await putVisitPhoto(SUB, 'p-gone', op as never, 'AA==');
      await waitFor(() => expect(heard).toBe(1));
      // a post that throws changes nothing for the write
      vi.spyOn(FakeChannel.prototype, 'postMessage').mockImplementation(() => { throw new Error('closed'); });
      await expect(fileVisitPhoto(SUB, 'p-gone', 'f-1')).resolves.toEqual({ state: 'filed', reason: null });
      // a write that fails still fails, with its own error, and is still told
      vi.mocked(FakeChannel.prototype.postMessage).mockRestore();
      const failing = Promise.reject(new Error('write refused'));
      await expect(afterRowWrite(SUB, failing)).rejects.toThrow('write refused');
      await waitFor(() => expect(heard).toBe(2));
    });
  });
});
