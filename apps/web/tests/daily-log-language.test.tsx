import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
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

// project data the people on the project typed, and the acronyms Indian sites use as they are; the
// log's date is not here: it is formatted in the viewer's language
const DATA = ['Villa Bodakdev', 'Mason', 'Cement', 'Granite', 'DL-1', 'DL-2', '10 bags', '4 slabs', 'GF', 'PMC', 'GPS', 'QR'];

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
    for (const s of ['DAILY SITE LOG', 'Checked in · 09:00', 'Villa Bodakdev · check-in time recorded', 'CREW PRESENT TODAY', '2 workers',
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

// #833 review: the places the daily log leads into speak the same language
const words = (text: string, allowed: readonly string[] = DATA) => {
  const el = document.createElement('div');
  el.textContent = text;
  return leftoverEnglish(el, allowed);
};

describe('what the daily log leads into, in Hindi and Gujarati', () => {
  for (const lang of ['hi', 'gu'] as const) {
    it(`${lang}: the material-delivery form, with its details open`, async () => {
      const r = await screen(lang, { dailyLog: log() });
      fireEvent.click(r.getByTestId('add-material'));
      fireEvent.click(r.getByTestId('mat-more-toggle'));
      expect(leftoverEnglish(document.body, DATA)).toEqual([]);
    });

    it(`${lang}: the photo viewer`, async () => {
      const r = await screen(lang, { dailyLog: log() });
      fireEvent.click(r.getByTestId('progress-thumb'));
      expect(leftoverEnglish(document.body, DATA)).toEqual([]);
    });

    it(`${lang}: a log opened by link, in every state the link can be in`, async () => {
      const { RecordBoundary } = await import('@/components/RecordBoundary');
      const states = [
        { state: 'opening', id: 'log-7' }, { state: 'returning' }, { state: 'loading', id: 'log-7' },
        { state: 'unavailable', id: 'log-7' }, { state: 'missing', id: 'log-7' },
      ] as const;
      const { useStore } = await import('@/store/store');
      useStore.setState({ lang });
      const { dailyLogLabels: L } = await import('@vitan/shared');
      for (const record of states) {
        const r = render(
          <RecordBoundary record={record} prefix="daily-log" lang={lang} what={L.what[lang]} loadingText={L.boundaryLoading[lang]}
            unavailableText={L.boundaryUnavailable[lang]} showAllLabel={L.openCurrent[lang]} onShowAll={() => {}} onRetry={() => {}} />,
        );
        expect(leftoverEnglish(r.container, [...DATA, 'log-7'])).toEqual([]);
        r.unmount();
      }
    });

    it(`${lang}: what every daily-log action says back`, async () => {
      await screen(lang, { dailyLog: log({ checkedIn: false, checkinTime: null, crew: [] }) }, { demo: true });
      const { useStore } = await import('@/store/store');
      const s = () => useStore.getState();
      const said: string[] = [];
      const run = (act: () => void) => { act(); said.push(s().toast ?? ''); };
      run(() => s().submitDailyLog()); // refused: not checked in
      run(() => s().checkIn());
      run(() => s().scanWorker()); // refused: no crew rows
      run(() => s().addProgressPhoto('not-a-photo'));
      run(() => s().addProgressPhoto('data:image/png;base64,AA=='));
      run(() => s().flagMismatch(0));
      run(() => s().submitDailyLog());
      run(() => s().submitDailyLog()); // refused: already sent
      run(() => s().checkOut());
      run(() => s().startDailyLog()); // needs the server
      run(() => s().addSiteMaterial({ name: 'Cement', qty: '1' })); // needs the server
      run(() => s().toggleOnline()); // signal lost
      run(() => s().toggleOnline()); // back: the queued updates sync
      expect(said.filter((t) => !t)).toEqual([]);
      for (const t of said) expect(words(t)).toEqual([]);
    });

    it(`${lang}: the check-in time the app records reads without AM/PM`, async () => {
      const r = await screen(lang, { dailyLog: log({ checkedIn: false, checkinTime: null }) }, { demo: true });
      const { useStore } = await import('@/store/store');
      // #482 D13 — the check-in is stamped with the tap's own time
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(2026, 5, 20, 8, 12));
      try {
        act(() => useStore.getState().checkIn());
      } finally {
        vi.useRealTimers();
      }
      expect(r.container.textContent).toContain('08:12');
      expect(leftoverEnglish(r.container, DATA)).toEqual([]);
    });
  }

  it('the log date reads in the language; English keeps the server\'s string', async () => {
    for (const [lang, month] of [['hi', 'जून'], ['gu', 'જૂન']] as const) {
      const r = await screen(lang, { dailyLog: log() });
      expect(r.container.textContent).toContain(month);
      expect(r.container.textContent).not.toContain('Jun 2026');
      cleanup();
    }
    const en = await screen('en', { dailyLog: log() });
    expect(en.container.textContent).toContain('01 Jun 2026');
    cleanup();
    const legacy = await screen('hi', { dailyLog: log({ logDate: null }) });
    expect(legacy.container.textContent).toContain('01 Jun 2026');
  });

  it('what a reconnect says about replayed offline work, and adding a place, in every language', async () => {
    const { syncResultText: S, locationResultText: P } = await import('@vitan/shared');
    for (const lang of ['hi', 'gu'] as const) {
      expect(words(S.join([S.synced(2, lang), S.dropped(1, lang), S.pending(3, lang)], lang))).toEqual([]);
      expect(words(P.needsServer[lang])).toEqual([]);
      expect(words(P.failed[lang])).toEqual([]);
      for (const k of ['zone', 'room', 'element']) expect(words(P.added(k, 'Kitchen', lang), ['Kitchen'])).toEqual([]);
    }
    expect(S.join([S.synced(2, 'en'), S.dropped(1, 'en'), S.pending(1, 'en')], 'en'))
      .toBe('2 offline updates synced; 1 could not be applied and was discarded; 1 still pending — will retry when you reconnect.');
    expect(P.added('element', 'Main Door', 'en')).toBe('Added element: Main Door.');
  });

  it('hi: adding a place with no server says so in Hindi', async () => {
    await screen('hi', { dailyLog: log() }, { demo: true });
    const { useStore } = await import('@/store/store');
    await useStore.getState().addLocationNode({ parentId: null, kind: 'zone', name: 'Terrace' } as never);
    expect(words(useStore.getState().toast ?? '')).toEqual([]);
    expect(useStore.getState().toast).toBeTruthy();
  });

  it('the offline line for each queued command names it in the language', async () => {
    const { dailyLogCommandLabels: C, dailyLogToastText: X } = await import('@vitan/shared');
    for (const lang of ['hi', 'gu'] as const) {
      for (const k of ['start', 'material', 'submit', 'flag'] as const) expect(words(X.savedOffline(C[k][lang], lang))).toEqual([]);
      expect(words(X.materialRecorded('Cement', lang))).toEqual([]);
    }
    expect(X.savedOffline(C.submit.en, 'en')).toBe('Submit daily log — saved offline, will sync when you reconnect.');
  });

  it('English: a check-in with no time says so without "null", and the recorded time reads as before', async () => {
    const { dailyLogText: T, clockTimeIn } = await import('@vitan/shared');
    expect(T.checkedIn(null, 'en')).toBe('Checked in');
    expect(T.checkedIn('8:12 AM', 'en')).toBe('Checked in · 8:12 AM');
    expect(clockTimeIn('8:12 AM', 'hi')).toBe('08:12');
    expect(clockTimeIn('12:05 AM', 'gu')).toBe('00:05');
    expect(clockTimeIn('1:30 PM', 'gu')).toBe('13:30');
    expect(clockTimeIn('09:00', 'hi')).toBe('09:00');
  });
});
