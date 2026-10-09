import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { resolve } from 'node:path';
import type { Drawing, DrawingRevision } from '@vitan/shared';

/**
 * Live bug 1c, option A (owner, #482 6063443276) — a drawing push opens the exact drawing:
 *   • the service worker takes an open window TO the notification's path (it used to only focus it), or opens
 *     one there; a path off this origin falls back to the app root;
 *   • the drawing screen, given a drawing id its register does not hold (missing, removed, unpublished or
 *     not visible to this viewer), says so once the register has settled — and shows the load boundary, not
 *     the whole register, while it has not.
 */

const ORIGIN = 'https://pms.example';

function loadWorker(clients: unknown[]) {
  const handlers: Record<string, (event: unknown) => void> = {};
  const opened: string[] = [];
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, handler: (event: unknown) => void) => { handlers[type] = handler; },
    skipWaiting: () => Promise.resolve(),
    registration: { showNotification: () => Promise.resolve() },
    clients: {
      claim: () => Promise.resolve(),
      matchAll: async () => clients,
      openWindow: async (url: string) => { opened.push(url); return { url }; },
    },
  };
  runInNewContext(readFileSync(resolve('public/sw.js'), 'utf8'), { self, URL, caches: {}, fetch: () => Promise.reject(new Error('no network')), Response, Request });
  const click = async (data: unknown) => {
    let pending: Promise<unknown> = Promise.resolve();
    handlers.notificationclick({ notification: { close: () => {}, data }, waitUntil: (p: Promise<unknown>) => { pending = p; } });
    await pending;
  };
  return { click, opened };
}

describe('the service worker opens the record a notification names', () => {
  it('an open window is focused AND taken to the drawing', async () => {
    const navigated: string[] = [];
    const win = { url: `${ORIGIN}/projects/ambli/today`, focus: async () => win, navigate: async (url: string) => { navigated.push(url); return { url }; } };
    const { click, opened } = loadWorker([win]);
    await click({ url: '/projects/ambli/drawings/d-1' });
    expect(navigated).toEqual([`${ORIGIN}/projects/ambli/drawings/d-1`]);
    expect(opened).toEqual([]);
  });

  it('with no open window, a new one opens on the drawing', async () => {
    const { click, opened } = loadWorker([]);
    await click({ url: '/projects/ambli/drawings/d-1' });
    expect(opened).toEqual([`${ORIGIN}/projects/ambli/drawings/d-1`]);
  });

  it('a window the worker cannot navigate gets the drawing in a new window', async () => {
    const win = { url: `${ORIGIN}/`, focus: async () => win, navigate: async () => { throw new TypeError('not controlled'); } };
    const { click, opened } = loadWorker([win]);
    await click({ url: '/projects/ambli/drawings/d-1' });
    expect(opened).toEqual([`${ORIGIN}/projects/ambli/drawings/d-1`]);
  });

  it('a target off this origin falls back to the app root', async () => {
    const { click, opened } = loadWorker([]);
    await click({ url: 'https://evil.example/phish' });
    expect(opened).toEqual([`${ORIGIN}/`]);
  });
});

const rev = (id: string): DrawingRevision => ({
  id, rev: 'A', status: 'for_construction', mime: 'application/pdf', url: `/drawings/rev/${id}?t=tok`, sizeBytes: 10, note: '', issuedBy: 'PMC', issuedAt: 'now', acks: [],
});
const dwg = (id: string, number: string, draft = false): Drawing => ({
  id, number, title: 'Plan', discipline: 'architectural', zone: 'GF', activityId: null, decisionId: null,
  draft, current: rev(`${id}-r`), ackedByMe: false, revisions: [rev(`${id}-r`)],
});

async function loadScreen(mode: 'snapshot' | 'moduleQuery', overrides: Record<string, unknown>) {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.stubEnv('VITE_DRAWINGS_READ', mode);
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({ ...scope.emptyProjectData(), activeProjectId: 'ambli', projectLoadState: 'ready', role: 'engineer', short: 'Ambli', ...overrides });
  const { DrawingsScreen } = await import('@/screens/DrawingsScreen');
  return { useStore, DrawingsScreen };
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('the drawing screen given a drawing it does not hold', () => {
  it('a drawing it holds opens', async () => {
    const { DrawingsScreen } = await loadScreen('snapshot', { drawings: [dwg('d-1', 'A-201')], routeItem: 'd-1' });
    const view = render(<DrawingsScreen />);
    expect(view.queryByTestId('item-not-found')).toBeNull();
    expect(view.getAllByText(/A-201/u).length).toBeGreaterThan(0);
  });

  it('a missing, removed or unpublished drawing says it is not available, and "Show all drawings" returns to the register', async () => {
    const { DrawingsScreen, useStore } = await loadScreen('snapshot', { drawings: [dwg('d-1', 'A-201'), dwg('d-draft', 'A-900', true)], routeItem: 'd-draft' });
    const view = render(<DrawingsScreen />);
    const notFound = view.getByTestId('item-not-found');
    expect(notFound.textContent).toMatch(/Drawing d-draft isn't available/u);
    fireEvent.click(view.getByTestId('item-not-found-show-all'));
    expect(useStore.getState().routeItem).toBeNull();
    expect(view.queryByTestId('item-not-found')).toBeNull();
    expect(view.getByText('DRAWINGS · REGISTER')).toBeTruthy();
  });

  it('while the register is still loading, the load boundary stands in — never "not available" or the whole register', async () => {
    const { DrawingsScreen } = await loadScreen('moduleQuery', { drawings: [], drawingsLoad: 'loading', routeItem: 'd-1' });
    const view = render(<DrawingsScreen />);
    expect(view.getByTestId('drawings-loading')).toBeTruthy();
    expect(view.queryByTestId('item-not-found')).toBeNull();
  });

  it('a failed register read shows the unavailable boundary with Retry, not "not available"', async () => {
    const { DrawingsScreen } = await loadScreen('moduleQuery', { drawings: [], drawingsLoad: 'error', routeItem: 'd-1' });
    const view = render(<DrawingsScreen />);
    expect(view.getByTestId('drawings-unavailable')).toBeTruthy();
    expect(view.getByTestId('drawings-retry')).toBeTruthy();
    expect(view.queryByTestId('item-not-found')).toBeNull();
  });

  it('a reconcile still owed for the register keeps it unsettled', async () => {
    const { DrawingsScreen, useStore } = await loadScreen('snapshot', { drawings: [dwg('d-1', 'A-201')], routeItem: 'd-2' });
    useStore.setState((s: { commandReconcileOwed: Record<string, boolean> }) => ({ commandReconcileOwed: { ...s.commandReconcileOwed, drawings: true } }));
    const view = render(<DrawingsScreen />);
    expect(view.getByTestId('drawings-loading')).toBeTruthy();
    expect(view.queryByTestId('item-not-found')).toBeNull();
  });
});
