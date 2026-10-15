import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import type { Checklist } from '@vitan/shared';

/**
 * #482 QA item 4 (live visual QA, 15 Oct) — on the engineer's checklist a failed item's evidence photo showed
 * only its alt text, and its note was cut off. The server sends each photo as a relative, signed
 * `/media/:id?t=…` path, which must be resolved against the API (as Inspection Review already does), and the
 * note must show in full.
 */

const LONG_NOTE =
  'Cover blocks missing along the east beam for about two metres; rebar sits directly on the shuttering, needs 25 mm blocks before the pour.';

const checklist = (over: Partial<Checklist> = {}): Checklist => ({
  id: 'INSP-1',
  title: 'Slab casting',
  zone: 'Ground floor',
  date: '01 Jun 2026',
  submitted: false,
  items: [
    { id: 'i1', name: 'Rebar spacing', state: 'pass', photos: 1, note: '', evidence: ['data:image/png;base64,AA=='] },
    { id: 'i2', name: 'Cover blocks', state: 'fail', photos: 1, note: LONG_NOTE, evidence: ['/media/m-7?t=123.abc'] },
  ],
  ...over,
});

async function mount(c: Checklist) {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.stubEnv('VITE_INSPECTIONS_READ', 'snapshot');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  useStore.setState({
    ...getInitialState(),
    projectLoadState: 'ready', role: 'engineer', lang: 'en',
    openChecklists: [c], checklist: c, selectedChecklistId: null,
  });
  const { EngineerChecklistScreen } = await import('@/screens/EngineerChecklistScreen');
  return render(<EngineerChecklistScreen />);
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('#482 a failed checklist item shows its photo and its whole note', () => {
  it('loads a server evidence photo from the API, not the web app', async () => {
    const view = await mount(checklist());
    const img = view.getByAltText('Evidence 1 — Cover blocks') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('http://api.test/media/m-7?t=123.abc');
  });

  it('leaves a photo taken on this phone (a data URL) as it is', async () => {
    const view = await mount(checklist());
    expect(view.getByAltText('Evidence 1 — Rebar spacing').getAttribute('src')).toBe('data:image/png;base64,AA==');
  });

  it('shows the whole note in a box that wraps, sized to the text', async () => {
    const view = await mount(checklist());
    const note = view.getByTestId('fail-note-1') as HTMLTextAreaElement;
    expect(note.tagName).toBe('TEXTAREA');
    expect(note.value).toBe(LONG_NOTE);
    expect(note.rows).toBe(4);
  });

  it('keeps the whole note readable after the checklist is submitted', async () => {
    const view = await mount(checklist({ submitted: true }));
    const note = view.getByTestId('fail-note-1') as HTMLTextAreaElement;
    expect(note.tagName).toBe('TEXTAREA');
    expect(note.value).toBe(LONG_NOTE);
    expect(note.rows).toBe(4);
    // Codex 4278142781 — read-only, not disabled, so it can still be focused and scrolled
    expect(note.disabled).toBe(false);
    expect(note.readOnly).toBe(true);
  });

  it('a submitted note longer than eight rows shows every row', async () => {
    const veryLong = Array.from({ length: 12 }, (_, k) => `Line ${k + 1} of the issue`).join('\n');
    const view = await mount(checklist({ submitted: true, items: [{ id: 'i2', name: 'Cover blocks', state: 'fail', photos: 1, note: veryLong, evidence: [] }] }));
    expect((view.getByTestId('fail-note-0') as HTMLTextAreaElement).rows).toBe(12);
  });

  it('a note being written stops growing at eight rows', async () => {
    const veryLong = Array.from({ length: 12 }, (_, k) => `Line ${k + 1} of the issue`).join('\n');
    const view = await mount(checklist({ items: [{ id: 'i2', name: 'Cover blocks', state: 'fail', photos: 1, note: veryLong, evidence: [] }] }));
    const note = view.getByTestId('fail-note-0') as HTMLTextAreaElement;
    expect(note.rows).toBe(8);
    expect(note.readOnly).toBe(false);
  });

  it('an empty note still offers two lines to write in', async () => {
    const view = await mount(checklist({ items: [{ id: 'i2', name: 'Cover blocks', state: 'fail', photos: 0, note: '', evidence: [] }] }));
    const note = view.getByTestId('fail-note-0') as HTMLTextAreaElement;
    expect(note.rows).toBe(2);
    expect(note.placeholder).toBe('Describe the issue…');
  });
});
