import { describe, it, expect, afterEach, vi } from 'vitest';
import { ApiGateway, REMOVE_VISIT_FILE_WAIT_MS, replayOutboxOp, siteVisitListeners, type SiteVisit, type SiteVisitEvent } from '@/data/apiGateway';

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

/**
 * #1239 (Codex 4409903389 on #1232): a removal offer ends on the server's count of the time left, kept on this page's
 * steady clock from when the read was asked, so a phone whose own clock is off ends it when the server would.
 */
describe('#1239: a removal offer ends on the server\'s count', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); siteVisitListeners.clear(); });

  const file = (removable: unknown) => ({ mediaId: 'm-1', removable });
  const page = (files: unknown[]) => [{ id: 'v-1', files }] as unknown as SiteVisit[];

  it('marks each offer with its end, counted from when the read was asked; an offer with no count is left as it was', async () => {
    let steady = 5_000;
    let wall = 1_700_000_000_000;
    vi.spyOn(performance, 'now').mockImplementation(() => steady);
    vi.spyOn(Date, 'now').mockImplementation(() => wall);
    let answer!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((ok) => { answer = ok; })));
    const read = new ApiGateway('http://api.test', 'p-1').listSiteVisits();
    // the answer takes 2 seconds to come: the end still counts from the ask, so it is never late
    steady += 2_000;
    wall += 2_000;
    answer(new Response(JSON.stringify(page([
      file({ reasonRequired: false, until: '2026-10-14T05:50:00.000Z', remainingMs: 600_000 }),
      file({ reasonRequired: false, until: '2026-10-14T05:50:00.000Z' }),
      file({ reasonRequired: true, until: null, remainingMs: null }),
      file(null),
    ])), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const v = (await read)[0]!;
    expect((v.files ?? []).map((f) => f.removable)).toEqual([
      { reasonRequired: false, until: '2026-10-14T05:50:00.000Z', remainingMs: 600_000, endsAt: 605_000, endsAtWall: 1_700_000_600_000 },
      { reasonRequired: false, until: '2026-10-14T05:50:00.000Z' },
      { reasonRequired: true, until: null, remainingMs: null },
      null,
    ]);
  });

  it('an act\'s answer, which the screen shows in place of the visit, has its offers marked too (gap-check)', async () => {
    let steady = 5_000;
    vi.spyOn(performance, 'now').mockImplementation(() => steady);
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    let answer!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((ok) => { answer = ok; })));
    const told: SiteVisitEvent[] = [];
    siteVisitListeners.add((e) => told.push(e));
    const sent = replayOutboxOp(new ApiGateway('http://api.test', 'p-1'), {
      t: 'siteVisitAddPlace', visitId: 'v-1', body: { id: 'pl-1', nodeId: 'n-1', claimedAt: '2026-10-14T05:00:00.000Z' }, name: 'Slab', idempotencyKey: 'k-1',
    });
    steady += 2_000;
    answer(new Response(JSON.stringify(page([file({ reasonRequired: false, until: '2026-10-14T05:50:00.000Z', remainingMs: 600_000 })])[0]),
      { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await sent;
    const ev = told.find((e) => e.kind === 'answer') as Extract<SiteVisitEvent, { kind: 'answer' }>;
    expect(ev.visit.files?.[0]?.removable).toMatchObject({ endsAt: 605_000, endsAtWall: 1_700_000_600_000 });
  });
});
