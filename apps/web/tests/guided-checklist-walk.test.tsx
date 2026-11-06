import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import type { Checklist, ItemGuide } from '@vitan/shared';
import { itemRecordings, judgeChecklist, type PendingCapture } from '@/lib/checklistRecordings';
import { warmImports } from './warm-imports';

/**
 * Guided site inspections step 4a (unit 3b) — each item's guidance on the engineer's checklist card, and the submit
 * guard asking the server's own evidence rule (the shared judge) about exactly the recordings the server will count,
 * before it sends or queues, so a held submit is never refused by a rule the phone did not know.
 */

const photos2Always: ItemGuide = { lookAt: 'Cover blocks under the bottom bars', passRule: 'Blocks every 1 m, 25 mm', record: { kind: 'photo', count: 2, when: 'always', hint: 'one wide, one close' } };
const photoOnFail: ItemGuide = { lookAt: null, passRule: null, record: { kind: 'photo', count: 1, when: 'fail', hint: null } };
const videoAlways: ItemGuide = { lookAt: 'Pour sequence', passRule: null, record: { kind: 'video', count: 1, when: 'always', hint: null } };

const checklist = (items: Checklist['items']): Checklist => ({
  id: 'INSP-1', title: 'Slab casting', zone: 'Ground floor', date: '01 Jun 2026', submitted: false, items,
});
const row = (clientKey: string, inspectionItemId: string, mime = 'image/jpeg', inspectionId = 'INSP-1'): PendingCapture => ({ clientKey, inspectionId, inspectionItemId, mime });

async function mount(c: Checklist, opts: { live?: boolean; pending?: PendingCapture[] } = {}) {
  vi.stubEnv('VITE_INSPECTIONS_READ', 'snapshot');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  useStore.setState({
    ...getInitialState(),
    projectLoadState: 'ready', role: 'engineer', lang: 'en',
    openChecklists: [c], checklist: c, selectedChecklistId: null,
  });
  if (opts.live) useStore.getState()._setGateway({} as never);
  // the screen reads the durable rows again when it opens; this test's rows are the answer that read gives
  useStore.setState({ pendingEvidenceRows: opts.pending ?? [], refreshPendingEvidence: async () => { useStore.setState({ pendingEvidenceRows: opts.pending ?? [] }); } });
  const { EngineerChecklistScreen } = await import('@/screens/EngineerChecklistScreen');
  return { view: render(<EngineerChecklistScreen />), useStore };
}

await warmImports(() => import('@/store/store'), () => import('@/screens/EngineerChecklistScreen'));

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('guided step 4a — the item card shows its guidance', () => {
  it('shows what to look at, when it passes, and what to record with its progress (served and pending, by kind)', async () => {
    const { view } = await mount(checklist([
      { id: 'a', name: 'Cover blocks', state: 'pass', photos: 1, note: '', evidence: ['/media/m1?t=1', '/media/m2?t=1'], evidenceKinds: ['photo', 'video'], evidenceClientKeys: [null, null], guide: photos2Always },
    ]), { pending: [] });
    expect(view.getByTestId('guide-look-0').textContent).toBe('Look at: Cover blocks under the bottom bars');
    expect(view.getByTestId('guide-pass-0').textContent).toBe('Passes when: Blocks every 1 m, 25 mm');
    const rec = view.getByTestId('guide-record-0');
    expect(rec.textContent).toContain('Record 2 photos — one wide, one close');
    expect(view.getByTestId('guide-have-0').textContent).toBe('1 of 2');
    expect(rec.getAttribute('data-short')).toBe('true');
    expect(view.getByTestId('guide-have-0').getAttribute('aria-label')).toBe('1 of 2 recorded');
  });

  it('counts a capture still waiting to upload in the progress', async () => {
    const { view } = await mount(checklist([
      { id: 'a', name: 'Cover blocks', state: 'pass', photos: 2, note: '', evidence: ['/media/m1?t=1', 'data:image/png;base64,AA=='], evidenceKinds: ['photo'], evidenceClientKeys: [null], guide: photos2Always },
    ]), { pending: [row('k1', 'a')] });
    expect(view.getByTestId('guide-have-0').textContent).toBe('2 of 2');
    expect(view.getByTestId('guide-record-0').getAttribute('data-short')).toBeNull();
  });

  it('shows the ask but no progress when the server serves no kinds (an API older than step 4a)', async () => {
    const { view } = await mount(checklist([
      { id: 'a', name: 'Cover blocks', state: 'pass', photos: 2, note: '', evidence: ['/media/m1?t=1', '/media/m2?t=1'], guide: photos2Always },
    ]));
    expect(view.getByTestId('guide-record-0').textContent).toContain('Record 2 photos');
    expect(view.queryByTestId('guide-have-0')).toBeNull();
  });

  it('shows a video ask the phone cannot record yet as muted guidance, not needed to submit', async () => {
    const { view } = await mount(checklist([
      { id: 'a', name: 'Pour', state: 'pass', photos: 0, note: '', evidenceKinds: [], guide: videoAlways },
    ]));
    const rec = view.getByTestId('guide-record-0');
    expect(rec.textContent).toBe('Record 1 video (not needed to submit yet)');
    expect(rec.getAttribute('data-enforced')).toBe('false');
    expect(view.queryByTestId('guide-have-0')).toBeNull();
  });

  it('shows no progress until the state holds the ask (a fail-only ask on a pass), and nothing for a plain item', async () => {
    const { view } = await mount(checklist([
      { id: 'a', name: 'Shuttering', state: 'pass', photos: 0, note: '', evidenceKinds: [], guide: photoOnFail },
      { id: 'b', name: 'Plain item', state: null, photos: 0, note: '' },
    ]));
    expect(view.getByTestId('guide-record-0').textContent).toBe('If it fails, record 1 photo');
    expect(view.queryByTestId('guide-have-0')).toBeNull();
    expect(view.queryByTestId('guide-1')).toBeNull();
  });

  it('asks a failed guided item for its reason; names photo evidence unless it asks for photos; a plain item keeps its line', async () => {
    const { view } = await mount(checklist([
      { id: 'a', name: 'Shuttering', state: 'fail', photos: 0, note: '', guide: photoOnFail },
      { id: 'b', name: 'Plain item', state: 'fail', photos: 0, note: '' },
      { id: 'c', name: 'Level', state: 'fail', photos: 0, note: '', guide: { lookAt: 'Spirit level', passRule: null, record: null } },
      { id: 'd', name: 'Pour', state: 'fail', photos: 0, note: '', guide: videoAlways },
    ]));
    expect(view.getAllByText('Fail requires a reason (a note) + the recordings asked for')).toHaveLength(1);
    expect(view.getAllByText('Fail requires a note + photo evidence')).toHaveLength(1);
    expect(view.getAllByText('Fail requires a reason (a note) + photo evidence')).toHaveLength(2);
  });
});

describe('guided step 4a — what the phone counts (the server\'s sources, each by identity)', () => {
  const base = { id: 'a', name: 'Cover blocks', state: 'pass' as const, photos: 0, note: '', guide: photos2Always };

  it('counts a served entry by its served kind: a video is not a photo', () => {
    expect(itemRecordings({ ...base, evidence: ['/media/m1?t=1', '/media/m2?t=1'], evidenceKinds: ['photo', 'video'] }, 'INSP-1', []).recordings).toEqual(['photo', 'video']);
  });

  it('never counts a local thumbnail nor the legacy counter (a refused or deleted capture has no pending row)', () => {
    const r = itemRecordings({ ...base, photos: 1_000_000_000, evidence: ['data:image/png;base64,AA=='], evidenceKinds: [] }, 'INSP-1', []);
    expect(r.recordings).toEqual([]);
  });

  it('counts a hidden linked file by its kind', () => {
    expect(itemRecordings({ ...base, evidence: ['/media/m1?t=1'], evidenceKinds: ['photo'], hiddenEvidenceKinds: ['photo'] }, 'INSP-1', []).recordings).toEqual(['photo', 'photo']);
  });

  it('counts a pending capture once: not again when a served entry carries its key', () => {
    const it0 = { ...base, evidence: ['/media/m1?t=1'], evidenceKinds: ['photo' as const], evidenceClientKeys: ['k1'] };
    expect(itemRecordings(it0, 'INSP-1', [row('k1', 'a'), row('k2', 'a')]).recordings).toEqual(['photo', 'photo']);
  });

  it('counts a pending capture only on its own checklist and item, and only of a type the upload sends', () => {
    const it0 = { ...base, evidenceKinds: [] as Array<'photo'>, evidenceClientKeys: [] as Array<string | null> };
    // a row kept before the type check (audio) would be refused on upload: it never counts, not even as a voice note
    expect(itemRecordings(it0, 'INSP-1', [row('k1', 'b'), row('k2', 'a', 'image/png', 'INSP-2'), row('k3', 'a', 'audio/webm'), row('k4', 'a', 'image/jpeg')]).recordings).toEqual(['photo']);
  });

  it('counts no pending capture on an item served with kinds but no keys (it cannot be told from its served file)', () => {
    const it0 = { ...base, evidence: ['/media/m1?t=1'], evidenceKinds: ['photo' as const] };
    expect(itemRecordings(it0, 'INSP-1', [row('k1', 'a')]).recordings).toEqual(['photo']);
  });
});

describe('guided step 4a — the judge', () => {
  it('holds a pass short of the photos its guidance always asks for, and names it', () => {
    const short = judgeChecklist([{ id: 'a', name: 'Cover blocks', state: 'pass', photos: 0, note: '', evidence: ['/media/m1?t=1'], evidenceKinds: ['photo'], guide: photos2Always }], 'INSP-1', []);
    expect(short.missingRecordings.map((m) => m.name)).toEqual(['Cover blocks']);
  });

  it('with no kinds served, judges only that a failed item has evidence: never counts a video as a photo (Codex 4492224945)', () => {
    // a photo and a video, served by an API older than step 4a: the phone cannot tell them apart, so it does not judge
    // the count at all and leaves it to the server (it never says two photos are there)
    const items: Checklist['items'] = [
      { id: 'a', name: 'Cover blocks', state: 'pass', photos: 2, note: '', evidence: ['/media/m1?t=1', '/media/m2?t=1'], guide: photos2Always },
      { id: 'b', name: 'Shuttering', state: 'fail', photos: 1, note: '', evidence: [], guide: photoOnFail },
    ];
    const short = judgeChecklist(items, 'INSP-1', []);
    expect(short).toEqual({ noEvidence: ['Shuttering'], missingRecordings: [], noReason: [] });
    // and with no keys served either, a pending capture cannot be told from a served file: it gives no evidence
    // (stricter than the server for an API that old, never looser)
    expect(judgeChecklist(items, 'INSP-1', [row('k1', 'b')]).noEvidence).toEqual(['Shuttering']);
  });
});

describe('guided step 4a — the submit guard asks the judge first, with a server', () => {
  it('holds a pass short of its photos, and names it', async () => {
    const { useStore } = await mount(checklist([
      { id: 'a', name: 'Cover blocks', state: 'pass', photos: 2, note: '', evidence: ['/media/m1?t=1', '/media/m2?t=1'], evidenceKinds: ['photo', 'video'], guide: photos2Always },
    ]), { live: true });
    await useStore.getState().submitInspection();
    expect(useStore.getState().toast).toBe('These items need the recordings they ask for before you can submit: Cover blocks');
    expect(useStore.getState().submission.status).toBe('idle');
  });

  it('holds a failed guided item with a photo but no reason', async () => {
    const { useStore } = await mount(checklist([
      { id: 'a', name: 'Shuttering', state: 'fail', photos: 1, note: '  ', evidence: ['/media/m1?t=1'], evidenceKinds: ['photo'], guide: photoOnFail },
    ]), { live: true });
    await useStore.getState().submitInspection();
    expect(useStore.getState().toast).toBe('A failed item needs a reason before you can submit: Shuttering');
    expect(useStore.getState().submission.status).toBe('idle');
  });

  it('keeps the old line for a failed item with no recording, whatever its counter or thumbnail says (#1370)', async () => {
    const { useStore } = await mount(checklist([{ id: 'a', name: 'Plain', state: 'fail', photos: 3, note: 'x', evidence: ['data:image/png;base64,AA=='], evidenceKinds: [] }]), { live: true });
    await useStore.getState().submitInspection();
    expect(useStore.getState().toast).toBe('A failed item needs a photo before you can submit.');
    expect(useStore.getState().submission.status).toBe('idle');
  });

  it('does not hold a video ask the phone cannot record yet (the server does not either)', async () => {
    const { useStore } = await mount(checklist([
      { id: 'a', name: 'Pour', state: 'pass', photos: 0, note: '', evidenceKinds: [], guide: videoAlways },
    ]), { live: true });
    useStore.setState({ online: false });
    await useStore.getState().submitInspection();
    expect(useStore.getState().submission.status).toBe('queued');
  });
});

describe('guided step 4a — only an image type the upload takes is attached (Codex 4490264665 on #1371)', () => {
  it('refuses audio, SVG or BMP before anything is kept or counted', async () => {
    const { useStore } = await mount(checklist([{ id: 'a', name: 'Cover blocks', state: 'pass', photos: 0, note: '', guide: photos2Always }]));
    for (const url of ['data:audio/webm;base64,AAAA', 'data:image/svg+xml;base64,AAAA', 'data:image/bmp;base64,AAAA']) {
      await useStore.getState().addChecklistEvidence(0, url, 'INSP-1');
      expect(useStore.getState().toast).toBe('Only a photo can be attached here — choose an image.');
    }
    expect(useStore.getState().checklist?.items[0].photos).toBe(0);
    expect(useStore.getState().checklist?.items[0].evidence ?? []).toEqual([]);
  });
});
