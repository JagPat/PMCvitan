import { describe, it, expect, afterEach, vi } from 'vitest';
import { ApiGateway, REMOVE_VISIT_FILE_WAIT_MS } from '@/data/apiGateway';

/**
 * #1273 (Codex 4437700410 on #1254): a visit file removal waits a bounded time for the server's answer, so a stalled
 * connection never leaves Remove busy. A removal given up has no status, which the screen says as no answer (or no
 * signal), and it reads the visit again.
 */
describe('#1273: a visit file removal is bounded', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('a server that never answers a removal fails it after its bound, with no status', async () => {
    expect(REMOVE_VISIT_FILE_WAIT_MS).toBe(20_000);
    // the limit is AbortSignal.timeout's; stand it in with a signal the test fires, as the clock would
    const limit = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(limit.signal);
    const fetch = vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    }));
    vi.stubGlobal('fetch', fetch);
    const removal = new ApiGateway('http://api.test', 'p-1').removeSiteVisitFile('m-1', 'Recorded by mistake');
    expect(timeout).toHaveBeenCalledWith(REMOVE_VISIT_FILE_WAIT_MS);
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST', signal: limit.signal });
    limit.abort(new DOMException('The operation timed out.', 'TimeoutError'));
    const err = await removal.then(() => null, (e: unknown) => e);
    expect(err).toMatchObject({ name: 'TimeoutError' });
    expect((err as { status?: unknown }).status).toBeUndefined();
  });
});
