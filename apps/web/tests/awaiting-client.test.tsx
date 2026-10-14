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
      expect(r.getByTestId('awaiting-client-count').textContent).toBe('1 DECISION');
      expect(r.getByTestId('awaiting-client-D-1').textContent).toContain('Kitchen countertop');
      expect(r.getByTestId('awaiting-client-D-1').textContent).toContain('Waiting 3 days');
      // a reopened decision is already a register row these roles read: listed once, there, never in the summary
      expect(r.queryByTestId('awaiting-client-D-2')).toBeNull();
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
    reply = () => Promise.resolve([{ ...served[0], id: 'D-3', title: 'Bathroom tiles' }]);
    act(() => { r.getByTestId('awaiting-client-retry').click(); });
    await waitFor(() => expect(r.getByTestId('awaiting-client-D-3')).toBeTruthy());
    expect(r.queryByTestId('awaiting-client-D-1')).toBeNull();
    expect(r.queryByTestId('awaiting-client-failed')).toBeNull();
  });

  it('a reopened decision shows once on the screen: in the register, not again in the summary', async () => {
    const { r } = await load('contractor', () => Promise.resolve(served), {
      decisions: [dec('D-2', { status: 'change', title: 'Main door veneer' })],
    });
    await waitFor(() => expect(r.getByTestId('awaiting-client-D-1')).toBeTruthy());
    expect(r.getByTestId('log-row-D-2')).toBeTruthy();
    expect(r.queryByTestId('awaiting-client-D-2')).toBeNull();
  });

  it('a pending decision the viewer is consulted on shows once: in the register, not again in the summary (#888)', async () => {
    const consulted = dec('D-1', {
      title: 'Kitchen countertop', approvalCycle: 0,
      consultations: [{ id: 'c1', consulteeMembershipId: 'm-u-con', consulteeUserId: 'u-con', requestedById: 'u-pmc', question: 'Lead time?', openCycle: 0, requestedAt: new Date().toISOString() }],
    } as Partial<Decision>);
    const { r } = await load('contractor', () => Promise.resolve(served), { decisions: [consulted], sessionUserId: 'u-con' });
    await waitFor(() => expect(r.getByTestId('log-row-D-1')).toBeTruthy());
    await waitFor(() => expect(r.getByTestId('awaiting-client-empty')).toBeTruthy());
    expect(r.queryByTestId('awaiting-client-D-1')).toBeNull();
  });

  it('the waiting age moves on while the screen stays open', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const since = new Date(Date.now() - 86_400_000 + 30 * 60_000).toISOString(); // a day less half an hour ago
    const { r } = await load('engineer', () => Promise.resolve([{ ...served[0], waitingSince: since }]));
    await waitFor(() => expect(r.getByTestId('awaiting-client-D-1').textContent).toContain('Waiting 0 days'));
    act(() => { vi.advanceTimersByTime(31 * 60_000); });
    expect(r.getByTestId('awaiting-client-D-1').textContent).toContain('Waiting 1 day');
  });

  it('with no server (the demo) it reads the seeded new client-held decisions, never a draft, a reopened one or another decider\'s', async () => {
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
    for (const id of ['D-2', 'D-3', 'D-4', 'D-5']) expect(r.queryByTestId(`awaiting-client-${id}`)).toBeNull();
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

describe('#888 — a stalled "Awaiting client" read gives up and offers Try again', () => {
  it('the read carries a time limit, and a read that runs past it fails instead of hanging', async () => {
    const { ApiGateway, AWAITING_CLIENT_TIMEOUT_MS } = await import('@/data/apiGateway');
    expect(AWAITING_CLIENT_TIMEOUT_MS).toBe(15_000);
    // the limit is AbortSignal.timeout's; stand it in with a signal the test fires, as the clock would
    const limit = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(limit.signal);
    // a server that never answers: the request only ends when its signal aborts it
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    })));
    try {
      const read = new ApiGateway('http://api.test', 'ambli').awaitingClient();
      expect(timeout).toHaveBeenCalledWith(AWAITING_CLIENT_TIMEOUT_MS);
      limit.abort(new DOMException('The operation timed out.', 'TimeoutError'));
      await expect(read).rejects.toMatchObject({ name: 'TimeoutError' });
    } finally {
      timeout.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
