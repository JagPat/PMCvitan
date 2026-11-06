import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import type { Checklist, ItemGuide } from '@vitan/shared';
import { judgeEvidence } from '@vitan/shared';
import { warmImports } from './warm-imports';

/**
 * Guided site inspections step 4a — each item's guidance on the engineer's checklist card, and the submit guard asking
 * the server's own evidence rule (the shared judge) before it sends or queues, so a held submit is never refused by a
 * rule the phone did not know.
 */

const photos2Always: ItemGuide = { lookAt: 'Cover blocks under the bottom bars', passRule: 'Blocks every 1 m, 25 mm', record: { kind: 'photo', count: 2, when: 'always', hint: 'one wide, one close' } };
const photoOnFail: ItemGuide = { lookAt: null, passRule: null, record: { kind: 'photo', count: 1, when: 'fail', hint: null } };
const videoAlways: ItemGuide = { lookAt: 'Pour sequence', passRule: null, record: { kind: 'video', count: 1, when: 'always', hint: null } };

const checklist = (items: Checklist['items']): Checklist => ({
  id: 'INSP-1', title: 'Slab casting', zone: 'Ground floor', date: '01 Jun 2026', submitted: false, items,
});

async function mount(c: Checklist) {
  vi.stubEnv('VITE_INSPECTIONS_READ', 'snapshot');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  useStore.setState({
    ...getInitialState(),
    projectLoadState: 'ready', role: 'engineer', lang: 'en',
    openChecklists: [c], checklist: c, selectedChecklistId: null,
  });
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
  it('shows what to look at, when it passes, and what to record with its progress', async () => {
    const { view } = await mount(checklist([
      { id: 'a', name: 'Cover blocks', state: 'pass', photos: 1, note: '', evidence: ['data:image/png;base64,AA=='], guide: photos2Always },
    ]));
    expect(view.getByTestId('guide-look-0').textContent).toBe('Look at: Cover blocks under the bottom bars');
    expect(view.getByTestId('guide-pass-0').textContent).toBe('Passes when: Blocks every 1 m, 25 mm');
    const rec = view.getByTestId('guide-record-0');
    expect(rec.textContent).toContain('Record 2 photos — one wide, one close');
    expect(view.getByTestId('guide-have-0').textContent).toBe('1 of 2');
    expect(rec.getAttribute('data-short')).toBe('true');
    expect(view.getByTestId('guide-have-0').getAttribute('aria-label')).toBe('1 of 2 recorded');
  });

  it('shows a video ask the phone cannot record yet as muted guidance, not needed to submit', async () => {
    const { view } = await mount(checklist([
      { id: 'a', name: 'Pour', state: 'pass', photos: 0, note: '', guide: videoAlways },
    ]));
    const rec = view.getByTestId('guide-record-0');
    expect(rec.textContent).toBe('Record 1 video (not needed to submit yet)');
    expect(rec.getAttribute('data-enforced')).toBe('false');
    expect(view.queryByTestId('guide-have-0')).toBeNull();
  });

  it('shows no progress until the state holds the ask (a fail-only ask on a pass), and nothing for a plain item', async () => {
    const { view } = await mount(checklist([
      { id: 'a', name: 'Shuttering', state: 'pass', photos: 0, note: '', guide: photoOnFail },
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

describe('guided step 4a — the submit guard asks the server rule first', () => {
  it('holds a pass short of the photos its guidance always asks for, and names it', async () => {
    const { useStore } = await mount(checklist([
      { id: 'a', name: 'Cover blocks', state: 'pass', photos: 1, note: '', evidence: ['data:image/png;base64,AA=='], guide: photos2Always },
    ]));
    useStore.getState().submitInspection();
    expect(useStore.getState().toast).toBe('These items need the recordings they ask for before you can submit: Cover blocks');
    expect(useStore.getState().submission.status).toBe('idle');
  });

  it('holds a failed guided item with a photo but no reason', async () => {
    const { useStore } = await mount(checklist([
      { id: 'a', name: 'Shuttering', state: 'fail', photos: 1, note: '  ', evidence: ['data:image/png;base64,AA=='], guide: photoOnFail },
    ]));
    useStore.getState().submitInspection();
    expect(useStore.getState().toast).toBe('A failed item needs a reason before you can submit: Shuttering');
    expect(useStore.getState().submission.status).toBe('idle');
  });

  it('keeps the old line for a failed item with no photo', async () => {
    const { useStore } = await mount(checklist([{ id: 'a', name: 'Plain', state: 'fail', photos: 0, note: 'x' }]));
    useStore.getState().submitInspection();
    expect(useStore.getState().toast).toBe('A failed item needs a photo before you can submit.');
  });

  it('does not hold a video ask the phone cannot record yet (the server does not either)', async () => {
    const { useStore } = await mount(checklist([
      { id: 'a', name: 'Pour', state: 'pass', photos: 0, note: '', guide: videoAlways },
    ]));
    useStore.getState().submitInspection();
    expect(useStore.getState().toast).not.toMatch(/recordings they ask for/);
  });
});

describe('guided step 4a — only a photo is attached on this screen', () => {
  it('refuses a file that is not an image, so the guard never counts a recording the server would not', async () => {
    const { useStore } = await mount(checklist([{ id: 'a', name: 'Cover blocks', state: 'pass', photos: 0, note: '', guide: photos2Always }]));
    await useStore.getState().addChecklistEvidence(0, 'data:audio/webm;base64,AAAA', 'INSP-1');
    expect(useStore.getState().toast).toBe('Only a photo can be attached here — choose an image.');
    expect(useStore.getState().checklist?.items[0].photos).toBe(0);
    expect(useStore.getState().checklist?.items[0].evidence ?? []).toEqual([]);
  });
});

describe('guided step 4a — with a server, the guard counts what the server counts (Codex 4490264657 / 4490264671)', () => {
  const live = async (c: Checklist, pending: Array<{ clientKey: string; inspectionItemId: string; mime: string }> = []) => {
    const m = await mount(c);
    m.useStore.getState()._setGateway({} as never);
    m.useStore.setState({ pendingChecklistEvidence: pending });
    return m;
  };

  it('counts a served entry by its served kind: a video is not a photo', async () => {
    const { useStore } = await live(checklist([
      { id: 'a', name: 'Cover blocks', state: 'pass', photos: 2, note: '', evidence: ['/media/m1?t=1', '/media/m2?t=1'], evidenceKinds: ['photo', 'video'], guide: photos2Always },
    ]));
    expect(useStore.getState().judgeChecklistItem(useStore.getState().checklist!.items[0]).recordings).toEqual(['photo', 'video']);
    useStore.getState().submitInspection();
    expect(useStore.getState().toast).toBe('These items need the recordings they ask for before you can submit: Cover blocks');
  });

  it('never counts the legacy photos counter, nor a large one (no array of that length)', async () => {
    const { useStore } = await live(checklist([
      { id: 'a', name: 'Plain', state: 'fail', photos: 1_000_000_000, note: 'x' },
    ]));
    expect(useStore.getState().judgeChecklistItem(useStore.getState().checklist!.items[0]).recordings).toEqual([]);
    useStore.getState().submitInspection();
    expect(useStore.getState().toast).toBe('A failed item needs a photo before you can submit.');
  });

  it('counts a capture while it is pending, and not its local thumbnail once its upload is refused or deleted', async () => {
    const item = { id: 'a', name: 'Cover blocks', state: 'pass' as const, photos: 2, note: '', evidence: ['/media/m1?t=1', 'data:image/png;base64,AA=='], evidenceKinds: ['photo' as const], guide: photos2Always };
    const pending = await live(checklist([item]), [{ clientKey: 'k1', inspectionItemId: 'a', mime: 'image/jpeg' }]);
    expect(pending.useStore.getState().judgeChecklistItem(item).recordings).toEqual(['photo', 'photo']);
    cleanup();
    const refused = await live(checklist([item]), []);
    expect(refused.useStore.getState().judgeChecklistItem(item).recordings).toEqual(['photo']);
    refused.useStore.getState().submitInspection();
    expect(refused.useStore.getState().toast).toBe('These items need the recordings they ask for before you can submit: Cover blocks');
  });

  it('a pending capture for another item does not count here', async () => {
    const { useStore } = await live(checklist([{ id: 'a', name: 'Plain', state: 'fail', photos: 0, note: 'x' }]), [{ clientKey: 'k', inspectionItemId: 'b', mime: 'image/png' }]);
    expect(useStore.getState().judgeChecklistItem(useStore.getState().checklist!.items[0]).recordings).toEqual([]);
  });
});

describe('guided step 4a — only an image type the upload takes is attached (Codex 4490264665)', () => {
  it('refuses an SVG or a BMP before anything is kept or counted', async () => {
    const { useStore } = await mount(checklist([{ id: 'a', name: 'Cover blocks', state: 'pass', photos: 0, note: '', guide: photos2Always }]));
    for (const url of ['data:image/svg+xml;base64,AAAA', 'data:image/bmp;base64,AAAA']) {
      await useStore.getState().addChecklistEvidence(0, url, 'INSP-1');
      expect(useStore.getState().toast).toBe('Only a photo can be attached here — choose an image.');
    }
    expect(useStore.getState().checklist?.items[0].evidence ?? []).toEqual([]);
  });
});

describe('guided step 4a — a linked file this viewer is served no path for still counts (Codex 4490791994)', () => {
  it('counts the served hidden kinds, as the server rule counts every linked recording', async () => {
    const m = await mount(checklist([
      { id: 'a', name: 'Cover blocks', state: 'pass', photos: 2, note: '', evidence: ['/media/m1?t=1'], evidenceKinds: ['photo'], hiddenEvidenceKinds: ['photo'], guide: photos2Always },
    ]));
    m.useStore.getState()._setGateway({} as never);
    expect(m.useStore.getState().judgeChecklistItem(m.useStore.getState().checklist!.items[0]).recordings).toEqual(['photo', 'photo']);
    expect(judgeEvidence([m.useStore.getState().judgeChecklistItem(m.useStore.getState().checklist!.items[0])]).missingRecordings).toEqual([]);
  });
});
