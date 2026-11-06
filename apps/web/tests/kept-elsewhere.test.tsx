import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, within, waitFor, act } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import type { OutboxOp } from '@/data/apiGateway';
import { EVIDENCE_READ_WAIT_MS, markEvidenceFailed, putEvidence } from '@/data/evidenceStore';
import { markSitePhotoSent, putSitePhotoRow } from '@/data/sitePhotoStore';
import { fileVisitPhoto, putVisitPhoto } from '@/data/visitPhotoStore';
import { KEPT_KIND, keptAnywhere, keptOf, projectNameKey, queuedProjectsOf, readKeptElsewhere, readProjectName, rememberProjectName, type KeptKind } from '@/store/keptElsewhere';
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
const evidence = vi.hoisted(() => ({ gate: null as Promise<void> | null, entered: null as (() => void) | null, scanGate: null as Promise<void> | null, scanEntered: null as (() => void) | null }));
vi.mock('@/data/evidenceStore', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/data/evidenceStore')>();
  return {
    ...real,
    listEvidence: async (...a: Parameters<typeof real.listEvidence>) => {
      const gate = evidence.gate;
      if (gate) { evidence.entered?.(); await gate; }
      return real.listEvidence(...a);
    },
    evidenceProjectsOf: async (...a: Parameters<typeof real.evidenceProjectsOf>) => {
      const gate = evidence.scanGate;
      if (gate) { evidence.scanEntered?.(); await gate; }
      return real.evidenceProjectsOf(...a);
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

  it('a key this version cannot read is listed by that line alone, never counted', async () => {
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
