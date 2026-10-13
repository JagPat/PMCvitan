import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { dailyLogToast, type DailyLog } from '@vitan/shared';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, ApiSnapshot } from '@/data/apiGateway';
import { RecordBoundary, ItemNotFound } from '@/components';
import { QrModal } from '@/screens/modals/QrModal';
import { leftoverEnglish } from './leftover-english';

/**
 * #835 — the three follow-ups the review cap moved off #833: a success line follows the language the
 * viewer has when it is shown, the shared "not found / retry" boxes speak the caller's language (so a
 * screen not yet translated stays wholly English), and the demo's QR check-in sheet is translated.
 */

const s = () => useStore.getState();
const settles = (cond: () => boolean) =>
  vi.waitFor(() => { if (!cond()) throw new Error('not settled'); }, { timeout: 5000, interval: 10 });

afterEach(() => {
  cleanup();
  s()._setGateway(null);
  useStore.setState(getInitialState());
});

const snapshot = (): ApiSnapshot => ({
  project: { id: 'ambli', name: 'Ambli', short: 'Ambli', descriptor: 'G+2', stage: 'x', siteCode: 'AMB', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
  decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
  drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
});

describe('a success line is said in the language the viewer has when it arrives', () => {
  it('switching English to Hindi while "start the log" is on its way gives the Hindi line', async () => {
    let answer!: (snap: ApiSnapshot) => void;
    const startDailyLog = vi.fn().mockReturnValue(new Promise<ApiSnapshot>((r) => { answer = r; }));
    useStore.setState(getInitialState());
    s()._setGateway({ startDailyLog, snapshot: vi.fn().mockResolvedValue(snapshot()) } as unknown as ApiGateway);
    useStore.setState({ online: true, activeProjectId: 'ambli', projectScopeGeneration: 1, dailyLog: null as DailyLog | null, outbox: [], syncQueue: [], lang: 'en' });

    s().startDailyLog();
    await settles(() => startDailyLog.mock.calls.length === 1);
    useStore.setState({ lang: 'hi' });
    answer(snapshot());
    await settles(() => s().outbox.length === 0);
    await settles(() => s().toast === dailyLogToast.started.hi);
  });
});

describe('the shared record boxes follow the caller', () => {
  const boundary = (lang?: 'hi') => (
    <>
      <RecordBoundary record={{ state: 'opening', id: 'M-4' }} prefix="m" what="Material" loadingText="Loading…" unavailableText="Unavailable"
        showAllLabel="Show all" onShowAll={() => {}} onRetry={() => {}} lang={lang} />
      <RecordBoundary record={{ state: 'missing', id: 'M-4' }} prefix="m" what="Material" loadingText="Loading…" unavailableText="Unavailable"
        showAllLabel="Show all" onShowAll={() => {}} onRetry={() => {}} lang={lang} />
      <ItemNotFound what="Decision" id="D-1" onShowAll={() => {}} showAllLabel="Show all decisions" lang={lang} />
    </>
  );

  it('a screen that passes English words gets an all-English box, even with Hindi chosen', () => {
    useStore.setState({ lang: 'hi' });
    const r = render(boundary());
    expect(r.container.textContent).not.toMatch(/[ऀ-ॿ]/);
    expect(r.container.textContent).toContain('Opening M-4…');
  });

  it('a screen that passes Hindi gets the box in Hindi', () => {
    const r = render(
      <RecordBoundary record={{ state: 'unavailable', id: 'M-4' }} prefix="m" what="सामान" loadingText="लोड हो रहा है…" unavailableText="अभी नहीं खुल रहा"
        showAllLabel="सब दिखाएँ" onShowAll={() => {}} onRetry={() => {}} lang="hi" />,
    );
    expect(leftoverEnglish(r.container, ['M-4'])).toEqual([]);
  });
});

describe('the demo QR check-in sheet', () => {
  for (const lang of ['hi', 'gu'] as const) {
    it(`${lang}: no English left`, () => {
      useStore.setState({ lang });
      render(<QrModal />);
      expect(leftoverEnglish(document.body, ['AMBLI', 'V', 'QR'])).toEqual([]);
    });
  }

  it('English reads as before', () => {
    useStore.setState({ lang: 'en' });
    render(<QrModal />);
    for (const t of ['WORKER SELF CHECK-IN', 'Ask the worker to scan this', 'SITE: AMBLI · VALID FOR TODAY ONLY', 'Done', 'Simulate a scan']) {
      expect(document.body.textContent).toContain(t);
    }
  });
});
