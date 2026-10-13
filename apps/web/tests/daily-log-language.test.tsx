import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import type { DailyLog, Lang } from '@vitan/shared';
import { leftoverEnglish } from './leftover-english';

/**
 * #827 (Top 10 #5) — the daily site log, a path Board named: in Hindi and Gujarati every state of the
 * screen shows no English (loading, unavailable, not started, the log before and after check-in, a
 * mismatch, a stale log, the sent log, and the demo build's simulator and QR rows). English stays
 * byte-identical. Crew trades, the date, materials and places are project data, shown as recorded.
 */

const log = (over: Partial<DailyLog> = {}): DailyLog => ({
  date: '01 Jun 2026', logDate: '2026-06-01', checkedIn: true, checkinTime: '09:00', submitted: false, progress: 3,
  crew: [{ trade: 'Mason', count: 2 }],
  materials: [
    { name: 'Cement', decisionId: 'DL-1', qty: '10 bags', zone: 'GF', matched: true, swatch: 'tile', photo: false },
    { name: 'Granite', decisionId: 'DL-2', qty: '4 slabs', zone: 'GF', matched: false, swatch: 'tile', photo: false },
  ],
  photos: [{ id: 'p1', url: 'data:image/png;base64,AA==' }],
  ...over,
} as DailyLog);

// project data the people on the project typed, and the acronyms Indian sites use as they are
const DATA = ['Villa Bodakdev', '01 Jun 2026', 'Mason', 'Cement', 'Granite', 'DL-1', 'DL-2', '10 bags', '4 slabs', 'GF', 'PMC', 'GPS', 'QR'];

async function screen(lang: Lang, over: Record<string, unknown>, { demo = false, mode = 'snapshot' } = {}) {
  vi.stubEnv('VITE_API_URL', demo ? '' : 'http://api.test');
  vi.stubEnv('VITE_DAILYLOG_READ', mode);
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({
    ...scope.emptyProjectData(),
    activeProjectId: 'villa-b', projectLoadState: 'ready', role: 'engineer', short: 'Villa Bodakdev', lang,
    ...over,
  });
  const { DailyLogScreen } = await import('@/screens/DailyLogScreen');
  return render(<DailyLogScreen />);
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

const STATES: [string, Record<string, unknown>, { demo?: boolean; mode?: string }?][] = [
  ['loading', { dailyLog: null, dailyLogLoad: 'loading' }, { mode: 'moduleQuery' }],
  ['unavailable', { dailyLog: null, dailyLogLoad: 'error' }, { mode: 'moduleQuery' }],
  ['not started', { dailyLog: null }],
  ['checked in, one mismatch', { dailyLog: log() }],
  ['before check-in', { dailyLog: log({ checkedIn: false, checkinTime: null }) }],
  ['stale last-known log', { dailyLog: log(), dailyLogLoad: 'error' }, { mode: 'moduleQuery' }],
  ['sent to the PMC', { dailyLog: log({ submitted: true }) }],
  ['demo build, offline with a queue', { dailyLog: log(), online: false }, { demo: true }],
  ['demo build, online', { dailyLog: log() }, { demo: true }],
];

describe('the daily site log in Hindi and Gujarati', () => {
  for (const lang of ['hi', 'gu'] as const) {
    for (const [name, over, opts] of STATES) {
      it(`${lang}, ${name}: no leftover English`, async () => {
        const r = await screen(lang, over, opts);
        expect(leftoverEnglish(r.container, DATA)).toEqual([]);
      });
    }
  }
});

const NODES = [
  { id: 'z1', parentId: null, name: 'Ground Floor', kind: 'zone', order: 0 },
  { id: 'r1', parentId: 'z1', name: 'Kitchen', kind: 'room', order: 0 },
  { id: 'e1', parentId: 'z1', name: 'Main Door', kind: 'element', order: 1 },
];
const PLACES = [...DATA, 'Ground Floor', 'Kitchen', 'Main Door'];

describe('placing a photo, in Hindi and Gujarati', () => {
  for (const lang of ['hi', 'gu'] as const) {
    it(`${lang}: the place picker and the next-photo line show no English`, async () => {
      const r = await screen(lang, { dailyLog: log(), nodes: NODES });
      expect(leftoverEnglish(r.container, PLACES)).toEqual([]);
      fireEvent.change(r.getByTestId('photo-loc-select-zone'), { target: { value: 'z1' } });
      expect(r.container.textContent).toContain('Ground Floor');
      expect(leftoverEnglish(r.container, PLACES)).toEqual([]);
      fireEvent.change(r.getByTestId('photo-loc-select-d1'), { target: { value: '__new_room__' } });
      expect(leftoverEnglish(r.container, PLACES)).toEqual([]);
    });
  }

  it('English reads as before', async () => {
    const r = await screen('en', { dailyLog: log(), nodes: NODES });
    fireEvent.change(r.getByTestId('photo-loc-select-zone'), { target: { value: 'z1' } });
    const text = r.container.textContent ?? '';
    for (const s of ['PLACE THIS PHOTO', 'Next photo → Ground Floor', 'Room / Object…', 'Main Door (object)', '+ New room…', '+ New object…']) expect(text).toContain(s);
    fireEvent.change(r.getByTestId('photo-loc-select-d1'), { target: { value: '__new_room__' } });
    expect(r.getByTestId('photo-loc-new-room-d1').getAttribute('placeholder')).toBe('New room name');
  });
});

describe('English is unchanged', () => {
  it('the log reads as before', async () => {
    const r = await screen('en', { dailyLog: log() });
    const text = r.container.textContent ?? '';
    for (const s of ['DAILY SITE LOG', 'Checked in · 09:00', 'Villa Bodakdev · within 60 m · GPS + selfie', 'CREW PRESENT TODAY', '2 workers',
      'MATERIAL ON SITE', '✓ Matches locked decision DL-1', '⚠ MISMATCH — not the approved DL-2', "TODAY'S PROGRESS", '3 progress photos', 'Submit Daily Log to PMC']) {
      expect(text).toContain(s);
    }
    expect(r.getByLabelText('Add Mason')).toBeTruthy();
    expect(r.getByAltText('Progress photo 1')).toBeTruthy();
  });

  it('the empty and demo states read as before', async () => {
    const empty = await screen('en', { dailyLog: null });
    expect(empty.container.textContent).toContain('No daily log started');
    cleanup();
    const demo = await screen('en', { dailyLog: log(), online: false, syncQueue: [{}] }, { demo: true });
    expect(demo.getByTestId('conn-text').textContent).toBe('Offline · 1 update queued');
  });
});
