import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import type { Lang } from '@vitan/shared';
import { noticeTime } from '@/lib/notifications';
import { leftoverEnglish } from './leftover-english';
import { warmImports } from './warm-imports';

/**
 * #827 (Top 10 #5, the bell) — the notification panel in Hindi and Gujarati: its own words, each notice,
 * when it happened, and the "record isn't available" explanation with its Open button. The stored notice
 * text is unchanged, so the bell's links still read it (a tap still opens the same screen). English stays
 * byte-identical. Titles, names and materials the notices quote are shown as written.
 */

await warmImports(() => import('@/store/store'), () => import('@/layout/NotificationPanel'));

afterEach(() => {
  cleanup();
  vi.resetModules();
  vi.unstubAllEnvs();
});

const NOW = Date.parse('2026-06-01T12:00:00Z');
const NOTICES = [
  { id: 'n1', at: '2026-06-01T11:59:40Z', text: 'New decision issued for approval: Porch Tiles', time: 'just now', color: '#C08A2D' },
  { id: 'n2', at: '2026-06-01T11:55:00Z', text: 'Client approved Master Bath CP Fittings — Kohler', time: 'just now', color: '#3F7A54', decisionId: 'DL-009' },
  { id: 'n3', at: '2026-06-01T09:00:00Z', text: 'Material mismatch: Granite ≠ approved DL-2', time: 'just now', color: '#B23A34' },
  { id: 'n4', text: 'Re-inspection due: Waterproofing, Terrace', time: '2h ago', color: '#B23A34' },
  { id: 'n5', at: '2026-05-01T09:00:00Z', text: 'Drawing issued: A-101 — Ground floor plan', time: 'just now', color: '#C08A2D' },
];
const DATA = ['Client', 'Porch Tiles', 'Master Bath CP Fittings', 'Kohler', 'Granite', 'DL-2', 'Waterproofing', 'Terrace', 'A-101', 'Ground floor plan', 'PMC'];

async function mount(lang: Lang, notifications: typeof NOTICES, over: Record<string, unknown> = {}) {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  const { useStore, getInitialState } = await import('@/store/store');
  useStore.setState(getInitialState());
  useStore.setState({ notifOpen: true, notifications, role: 'pmc', screen: 'inbox', lang, projectLoadState: 'ready', ...over });
  const { NotificationPanel } = await import('@/layout/NotificationPanel');
  const view = render(<NotificationPanel />);
  vi.useRealTimers();
  return { useStore, view };
}

describe('the bell in Hindi and Gujarati', () => {
  for (const lang of ['hi', 'gu'] as const) {
    it(`${lang}: the notices and when they happened`, async () => {
      const { view } = await mount(lang, NOTICES);
      expect(leftoverEnglish(view.container, DATA)).toEqual([]);
    });

    it(`${lang}: a notice whose record is gone explains itself, and its Open button`, async () => {
      const { view } = await mount(lang, [NOTICES[0]]);
      fireEvent.click(view.getByTestId('notif-item'));
      expect(view.getByTestId('notif-missing')).toBeTruthy();
      expect(leftoverEnglish(view.container, DATA)).toEqual([]);
    });

    it(`${lang}: a notice still loading explains itself`, async () => {
      const { view } = await mount(lang, [NOTICES[0]], { decisionsLoad: 'loading' });
      fireEvent.click(view.getByTestId('notif-item'));
      expect(view.getByTestId('notif-loading')).toBeTruthy();
      expect(leftoverEnglish(view.container, DATA)).toEqual([]);
    });

    for (const [name, over] of [['empty', {}], ['loading', { projectLoadState: 'loading' }], ['unavailable', { projectLoadState: 'error' }]] as const) {
      it(`${lang}: ${name}`, async () => {
        const { view } = await mount(lang, [], over);
        expect(leftoverEnglish(view.container, DATA)).toEqual([]);
      });
    }

    it(`${lang}: the server's sign-off notice, stamped with its closing inspection, translates its ending`, async () => {
      const signOff = { id: 's1', text: "Sign-off requested: Slab casting — awaiting the PMC's closing inspection", time: 'just now', color: '#C08A2D', inspectionId: 'INSP-9' };
      const { view } = await mount(lang, [signOff as (typeof NOTICES)[number]]);
      expect(leftoverEnglish(view.container, [...DATA, 'Slab casting'])).toEqual([]);
    });

    it(`${lang}: a translated notice still opens its record`, async () => {
      const { view, useStore } = await mount(lang, [NOTICES[1]]);
      fireEvent.click(view.getByTestId('notif-item'));
      expect(useStore.getState().routeItem).toBe('DL-009');
    });
  }
});

describe('the bell in English is unchanged', () => {
  it('shows the stored text, the same times and the same Open button', async () => {
    const { view } = await mount('en', NOTICES);
    const text = view.container.textContent ?? '';
    for (const n of NOTICES) expect(text).toContain(n.text);
    for (const t of ['NOTIFICATIONS', 'just now', '5m ago', '3h ago', '2h ago']) expect(text).toContain(t);
    expect(view.getByRole('dialog').getAttribute('aria-label')).toBe('Notifications');
    cleanup();
    const missing = await mount('en', [NOTICES[0]]);
    fireEvent.click(missing.view.getByTestId('notif-item'));
    expect(missing.view.getByTestId('notif-missing-open').textContent).toBe('Open Decision Log');
  });

  it('the client\'s fallback names their one Decisions screen (#857 Codex 4269920634)', async () => {
    const missing = await mount('en', [NOTICES[0]], { role: 'client' });
    fireEvent.click(missing.view.getByTestId('notif-item'));
    expect(missing.view.getByTestId('notif-missing-open').textContent).toBe('Open Decisions');
  });

  it('noticeTime keeps its English shapes, and speaks Hindi when asked', () => {
    const at = (ms: number) => ({ at: new Date(NOW - ms).toISOString(), time: 'x' });
    expect(noticeTime(at(5 * 60_000), NOW)).toBe('5m ago');
    expect(noticeTime(at(5 * 60_000), NOW, 'hi')).toBe('5 मिनट पहले');
    expect(noticeTime({ time: 'just now' }, NOW, 'gu')).toBe('હમણાં');
    expect(noticeTime({ time: 'Yesterday' }, NOW, 'hi')).toBe('Yesterday');
  });
});
