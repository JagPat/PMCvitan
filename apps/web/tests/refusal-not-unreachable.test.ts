import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway } from '@/data/apiGateway';

/**
 * #482 F-C4.2 — a command routed through the online-or-queue path that the server REFUSES (a 4xx with its
 * reason) says the server's reason. Q4's C4 Send back was refused 400 and read "Could not reach the server",
 * which sends a user retrying a request that can never succeed. A real network failure still says so.
 */
const s = () => useStore.getState();
const settles = (cond: () => boolean) =>
  vi.waitFor(() => { if (!cond()) throw new Error('not settled'); }, { timeout: 5000, interval: 10 });

describe('#482 F-C4.2 — a refusal is not a network failure', () => {
  beforeEach(() => {
    globalThis.localStorage?.clear();
    useStore.setState(getInitialState());
    useStore.setState({ role: 'pmc', activeReviewId: 'INSP-21', online: true, activeProjectId: 'ambli', projectScopeGeneration: 1, outbox: [], syncQueue: [] });
  });

  it("a 400 on Send back shows the server's reason", async () => {
    const refusal = Object.assign(new Error('decide 400'), { status: 400, serverMessage: 'No items rejected. Use approve instead.' });
    const decideReview = vi.fn().mockRejectedValue(refusal);
    s()._setGateway({ decideReview } as unknown as ApiGateway);
    s().sendReinspection();
    await settles(() => s().toast !== null);
    expect(decideReview).toHaveBeenCalledTimes(1);
    expect(s().toast).toBe('The server refused this — No items rejected. Use approve instead.');
    expect(s().outbox).toHaveLength(0); // a refusal is never queued for a retry that would fail the same way
  });

  it('a refusal with no readable reason still says it was refused', async () => {
    s()._setGateway({ decideReview: vi.fn().mockRejectedValue(Object.assign(new Error('403'), { status: 403 })) } as unknown as ApiGateway);
    s().sendReinspection();
    await settles(() => s().toast !== null);
    expect(s().toast).toBe('The server refused this — the server refused it');
  });

  it('a network failure still says the server could not be reached', async () => {
    s()._setGateway({ decideReview: vi.fn().mockRejectedValue(new Error('Failed to fetch')) } as unknown as ApiGateway);
    s().sendReinspection();
    await settles(() => s().toast !== null);
    expect(s().toast).toBe('Could not reach the server — please try again.');
  });
});
