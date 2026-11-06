import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import type { OutboxOp } from '@/data/apiGateway';
import { putEvidence } from '@/data/evidenceStore';
import { putSitePhotoRow } from '@/data/sitePhotoStore';
import { putVisitPhoto } from '@/data/visitPhotoStore';
import { KEPT_KIND, keptOf, projectNameKey, queuedProjectsOf, readKeptElsewhere, readProjectName, rememberProjectName, type KeptKind } from '@/store/keptElsewhere';
import { doneName, frameOf, markName, recordBytes, recordName } from '@/store/queueLedger';
import { queueActIdent } from '@/store/queueActIdent';
import { QW, keptElsewhereLine } from '@/lib/queueWords';
import { ProjectSwitcher } from '@/layout/ProjectSwitcher';
import { ProjectSheet } from '@/layout/MobileSheet';

/**
 * #1388 unit 1 (read only): the changes this device keeps for projects the signed-in person no longer holds, listed at
 * the foot of the project switcher. A change is an owed act of the person's queue keys for that project (the key's and
 * its made records', less marks and done facts, as a load takes them) or an unsent row a project's load rebuilds an act
 * from; an act and its row are one change. A project the person holds, and another person's keys, are never listed.
 * Every wait here is on a signal (a store state, a settled read), never a clock.
 */

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
afterEach(() => { cleanup(); useStore.setState(getInitialState()); });

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
    expect(kept[0].items).toEqual([{ id: expect.any(String), kind: 'photo', count: 1, at: 1_700_000_000_000 }]);
  });

  it('a site visit’s acts and its unsent files are one line, counted together', async () => {
    const end: OutboxOp = { t: 'siteVisitEnd', visitId: 'v-1', claimedAt: '2026-11-06T10:00:00.000Z', idempotencyKey: 'sv-1' };
    localStorage.setItem(lane(SUB, 'p-gone'), JSON.stringify([end]));
    const file = { t: 'siteVisitAddFile', visitId: 'v-1', scope: SUB, file: { id: 'f-1', mime: 'image/jpeg' }, by: { name: 'Pat', role: 'pmc' }, placeName: null, idempotencyKey: 'sv-2' } as const;
    await putVisitPhoto(SUB, 'p-gone', file as never, 'AA==');
    const kept = await readKeptElsewhere(localStorage, SUB, new Set());
    expect(kept[0].items).toEqual([{ id: 'visit:v-1', kind: 'siteVisit', count: 2, at: expect.any(Number) }]);
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
});

describe('the store', () => {
  it('reads the list for the memberships held, and adopts it only for the memberships it read for', async () => {
    localStorage.setItem(outbox(SUB, 'p-gone'), JSON.stringify([approve('k-1')]));
    rememberProjectName(localStorage, SUB, 'p-gone', 'Gone Tower');
    useStore.setState({ sessionToken: jwt({ sub: SUB, role: 'pmc', projectId: 'p-a' }), memberships: [ALPHA] as never });
    await useStore.getState().loadKeptElsewhere();
    expect(useStore.getState().keptElsewhere).toEqual([expect.objectContaining({ projectId: 'p-gone', name: 'Gone Tower', total: 1 })]);

    // a newer memberships read lands while this one reads the rows: this one is not adopted
    useStore.setState({ keptElsewhere: [] });
    const reading = useStore.getState().loadKeptElsewhere();
    useStore.setState({ memberships: [ALPHA, { ...ALPHA, projectId: 'p-gone', name: 'Gone Tower' }] as never });
    await reading;
    expect(useStore.getState().keptElsewhere).toEqual([]);
  });

  it('reads nothing before the memberships are known, or with no session', async () => {
    localStorage.setItem(outbox(SUB, 'p-gone'), JSON.stringify([approve('k-1')]));
    useStore.setState({ sessionToken: jwt({ sub: SUB, role: 'pmc', projectId: 'p-a' }), memberships: [] });
    await useStore.getState().loadKeptElsewhere();
    expect(useStore.getState().keptElsewhere).toEqual([]);
    useStore.setState({ sessionToken: null, memberships: [ALPHA] as never });
    await useStore.getState().loadKeptElsewhere();
    expect(useStore.getState().keptElsewhere).toEqual([]);
  });

  it('a sign-out clears the list', async () => {
    localStorage.setItem(outbox(SUB, 'p-gone'), JSON.stringify([approve('k-1')]));
    useStore.setState({ sessionToken: jwt({ sub: SUB, role: 'pmc', projectId: 'p-a' }), memberships: [ALPHA] as never });
    await useStore.getState().loadKeptElsewhere();
    expect(useStore.getState().keptElsewhere).toHaveLength(1);
    useStore.getState().completeSignOut();
    expect(useStore.getState().keptElsewhere).toEqual([]);
  });
});

describe('the switcher', () => {
  async function seeded(lang: 'en' | 'hi' = 'en') {
    localStorage.setItem(outbox(SUB, 'p-gone'), JSON.stringify([approve('k-1'), approve('k-2', 'd-2')]));
    rememberProjectName(localStorage, SUB, 'p-gone', 'Gone Tower');
    useStore.setState({ sessionToken: jwt({ sub: SUB, role: 'pmc', projectId: 'p-a' }), memberships: [ALPHA] as never, activeProjectId: 'p-a', lang });
    await useStore.getState().loadKeptElsewhere();
    expect(useStore.getState().keptElsewhere).toHaveLength(1);
  }

  it('one project held and nothing to create: the switcher still opens, for the kept line, which opens the list', async () => {
    await seeded();
    render(<ProjectSwitcher />);
    fireEvent.click(screen.getByTestId('project-switcher'));
    fireEvent.click(screen.getByText(keptElsewhereLine(1, 'en')));
    const list = await screen.findByTestId('kept-elsewhere');
    expect(within(list).getByText('Gone Tower')).toBeTruthy();
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
    expect(within(list).getByText('2 बदलाव')).toBeTruthy();
  });

  it('a project with no name record is named as one the person no longer has access to', async () => {
    localStorage.setItem(outbox(SUB, 'p-gone'), JSON.stringify([approve('k-1')]));
    useStore.setState({ sessionToken: jwt({ sub: SUB, role: 'pmc', projectId: 'p-a' }), memberships: [ALPHA] as never, activeProjectId: 'p-a' });
    await useStore.getState().loadKeptElsewhere();
    render(<ProjectSwitcher />);
    fireEvent.click(screen.getByTestId('project-switcher'));
    fireEvent.click(screen.getByTestId('kept-elsewhere-line'));
    const list = await screen.findByTestId('kept-elsewhere');
    expect(within(list).getByText(QW.keptUnknownProject.en)).toBeTruthy();
    expect(within(list).getByText('1 change')).toBeTruthy();
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
    expect(keptElsewhereLine(3, 'gu')).toContain('3');
  });
});
