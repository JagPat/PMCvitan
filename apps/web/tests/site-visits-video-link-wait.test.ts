import { describe, it, expect, afterEach, vi } from 'vitest';
import { ApiGateway, REMOVE_VISIT_FILE_WAIT_MS, offersFrom, type SiteVisit } from '@/data/apiGateway';

/**
 * Video V2g-2 gap-check G1 and G4: a clip's link change waits the removal's bounded time for its answer (a stalled
 * connection never leaves the form busy), and a link offer ends on the server's count as a removal offer does.
 */
describe('video V2g-2: a link change is bounded, and its offer runs on the server\'s count', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  for (const act of ['set', 'end'] as const) {
    it(`a server that never answers a link ${act} fails it after its bound, with no status`, async () => {
      const limit = new AbortController();
      const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(limit.signal);
      const fetch = vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      }));
      vi.stubGlobal('fetch', fetch);
      const gw = new ApiGateway('http://api.test', 'p-1');
      const sent = act === 'set'
        ? gw.setSiteVisitFileLink('v-1', 'm-1', { id: 'l-1', url: 'https://drive.google.com/x', replaces: null }, 'k-1')
        : gw.endSiteVisitFileLink('v-1', 'm-1', { linkId: 'l-1' }, 'k-1');
      expect(timeout).toHaveBeenCalledWith(REMOVE_VISIT_FILE_WAIT_MS);
      expect(fetch.mock.calls[0]![1]).toMatchObject({ method: act === 'set' ? 'PUT' : 'DELETE', signal: limit.signal });
      limit.abort(new DOMException('The operation timed out.', 'TimeoutError'));
      const err = await sent.then(() => null, (e: unknown) => e);
      expect(err).toMatchObject({ name: 'TimeoutError' });
      expect((err as { status?: unknown }).status).toBeUndefined();
    });
  }

  it('marks a link offer with its end, counted from when the read was asked, as a removal offer is', () => {
    const v = [{ id: 'v-1', files: [{ mediaId: 'm-1', removable: null, fullVideoLinkOffer: { reasonRequired: false, until: 'x', remainingMs: 600_000 } }] }] as unknown as SiteVisit[];
    const [out] = offersFrom(v, { steady: 5_000, wall: 1_700_000_000_000 });
    expect(out!.files![0]!.fullVideoLinkOffer).toEqual({ reasonRequired: false, until: 'x', remainingMs: 600_000, endsAt: 605_000, endsAtWall: 1_700_000_600_000 });
  });
});
