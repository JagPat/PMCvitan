import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, act } from '@testing-library/react';
import type { Decision } from '@vitan/shared';

/**
 * #482 QA check (14 Oct 2026, item 4): the engineer, contractor and consultant see a read-only "Awaiting client"
 * list at the top of their decisions screen, so they can plan. It is the server's summary (title, place, how long
 * it has waited): no options, prices or decide button. The PMC's register and the client's screen do not show it.
 */

afterEach(() => {
  cleanup();
  vi.resetModules();
  vi.useRealTimers();
});

const dec = (id: string, over: Partial<Decision> = {}): Decision => ({
  id, title: `Countertop ${id}`, room: 'Kitchen', status: 'pending', deciderKind: 'client', ageDays: 4,
  options: [
    { label: 'Option A', key: 'A', material: 'Granite', delta: 0, swatch: 'stone', recommended: true },
    { label: 'Option B', key: 'B', material: 'Quartz', delta: 20000, swatch: 'marble', recommended: false },
  ],
  ...over,
} as unknown as Decision);

const served = [
  { id: 'D-1', title: 'Kitchen countertop', room: 'Kitchen', nodeId: null, status: 'pending' as const, waitingSince: new Date(Date.now() - 3 * 86_400_000 - 60_000).toISOString() },
  { id: 'D-2', title: 'Main door veneer', room: 'Entrance', nodeId: null, status: 'change' as const, waitingSince: new Date(Date.now() - 86_400_000 - 60_000).toISOString() },
];

async function load(role: string, fetchAwaitingClient: () => Promise<unknown>, overrides: Record<string, unknown> = {}) {
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({
    ...scope.emptyProjectData(), activeProjectId: 'ambli', projectLoadState: 'ready', role, lang: 'en',
    short: 'Ambli', screen: 'decision-log', decisions: [], fetchAwaitingClient, ...overrides,
  } as never);
  const { ScreenView } = await import('@/layout/ScreenView');
  return { useStore, r: render(<ScreenView />) };
}

describe('the read-only "Awaiting client" list', () => {
  for (const role of ['engineer', 'contractor', 'consultant']) {
    it(`${role}: lists what waits on the client, how long, and nothing to decide`, async () => {
      const { r } = await load(role, () => Promise.resolve(served));
      await waitFor(() => expect(r.getByTestId('awaiting-client-D-1')).toBeTruthy());
      expect(r.getByTestId('awaiting-client-count').textContent).toBe('2 DECISIONS');
      expect(r.getByTestId('awaiting-client-D-1').textContent).toContain('Kitchen countertop');
      expect(r.getByTestId('awaiting-client-D-1').textContent).toContain('Waiting 3 days');
      expect(r.getByTestId('awaiting-client-D-2').textContent).toContain('Reopened · Waiting 1 day');
      // read-only: no option, price or decide control anywhere in the list
      const list = r.getByTestId('awaiting-client');
      expect(list.querySelectorAll('button')).toHaveLength(0);
      expect(list.textContent).not.toMatch(/Approve|₹/);
    });
  }

  it('says so when nothing waits, and when the read fails', async () => {
    const empty = await load('engineer', () => Promise.resolve([]));
    await waitFor(() => expect(empty.r.getByTestId('awaiting-client-empty')).toBeTruthy());
    cleanup();
    const failing = await load('contractor', () => Promise.reject(new Error('503')));
    await waitFor(() => expect(failing.r.getByTestId('awaiting-client-failed')).toBeTruthy());
  });

  it('a failed refresh drops the earlier list rather than show it as current, and Try again reloads it', async () => {
    let reply: () => Promise<unknown> = () => Promise.resolve(served);
    const fetch = vi.fn(() => reply());
    const { useStore, r } = await load('engineer', fetch);
    await waitFor(() => expect(r.getByTestId('awaiting-client-D-1')).toBeTruthy());
    reply = () => Promise.reject(new Error('503'));
    // the client decides elsewhere; the refresh that follows the decisions slice fails
    act(() => { useStore.setState({ decisions: [dec('D-9', { status: 'approved' })] } as never); });
    await waitFor(() => expect(r.getByTestId('awaiting-client-failed')).toBeTruthy());
    expect(r.queryByTestId('awaiting-client-D-1')).toBeNull();
    reply = () => Promise.resolve([served[1]]);
    act(() => { r.getByTestId('awaiting-client-retry').click(); });
    await waitFor(() => expect(r.getByTestId('awaiting-client-D-2')).toBeTruthy());
    expect(r.queryByTestId('awaiting-client-D-1')).toBeNull();
    expect(r.queryByTestId('awaiting-client-failed')).toBeNull();
  });

  it('the waiting age moves on while the screen stays open', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const since = new Date(Date.now() - 86_400_000 + 30 * 60_000).toISOString(); // a day less half an hour ago
    const { r } = await load('engineer', () => Promise.resolve([{ ...served[0], waitingSince: since }]));
    await waitFor(() => expect(r.getByTestId('awaiting-client-D-1').textContent).toContain('Waiting 0 days'));
    act(() => { vi.advanceTimersByTime(31 * 60_000); });
    expect(r.getByTestId('awaiting-client-D-1').textContent).toContain('Waiting 1 day');
  });

  it('with no server (the demo) it reads the seeded client-held open decisions, never a draft or another decider\'s', async () => {
    const { r } = await load('engineer', () => Promise.resolve(null), {
      decisions: [
        dec('D-1'),
        dec('D-2', { status: 'change' }),
        dec('D-3', { draft: true } as Partial<Decision>),
        dec('D-4', { deciderKind: 'pmc' } as Partial<Decision>),
        dec('D-5', { status: 'approved' }),
      ],
    });
    await waitFor(() => expect(r.getByTestId('awaiting-client-D-1')).toBeTruthy());
    expect(r.getByTestId('awaiting-client-D-1').textContent).toContain('Waiting 4 days');
    expect(r.getByTestId('awaiting-client-D-2')).toBeTruthy();
    for (const id of ['D-3', 'D-4', 'D-5']) expect(r.queryByTestId(`awaiting-client-${id}`)).toBeNull();
  });

  it('a reply for a project the viewer has left is dropped', async () => {
    let answer!: (rows: unknown) => void;
    const fetch = vi.fn(() => new Promise((resolve) => { answer = resolve; }));
    const { useStore, r } = await load('engineer', fetch);
    const first = answer;
    act(() => { useStore.setState({ activeProjectId: 'other', projectScopeGeneration: 1 } as never); });
    await act(async () => { first(served); });
    expect(r.queryByTestId('awaiting-client-D-1')).toBeNull();
    await act(async () => { answer([]); });
    expect(r.getByTestId('awaiting-client-empty')).toBeTruthy();
  });

  it('the PMC\'s register and the client\'s screen do not show it', async () => {
    const fetch = vi.fn(() => Promise.resolve(served));
    const pmc = await load('pmc', fetch);
    expect(pmc.r.queryByTestId('awaiting-client')).toBeNull();
    cleanup();
    const client = await load('client', fetch);
    expect(client.r.queryByTestId('awaiting-client')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
