import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { resolve } from 'node:path';

/**
 * The offline drawings and media never keep an error. A drawing or photo the field has opened is kept so it opens
 * offline. An <img> reads it without CORS, so the answer it gets is opaque: its status cannot be read, and an
 * expired link's 403, a 404 or a 5xx kept that way would replace the good copy. The worker reads each file in CORS mode
 * instead (the API and the bucket allow it) and keeps only a good answer. Reads of the app's own files look only in the
 * app cache, never in the files cache or another cache on the site.
 */

const ORIGIN = 'https://pms.example';
const API = 'https://api.example';
const DRAWING = `${API}/drawings/rev/r1?t=signed`;
const PHOTO = `${API}/media/m1?t=signed`;
const APP_CACHE = 'vitan-pmc-v3';
const FILES = 'vitan-pmc-files-v2';

/** A response as the browser hands it to the worker: its `type` (and an opaque one's status) survive a clone, as there. */
function typed(res: Response, type: string, props: { ok?: boolean; status?: number } = {}): Response {
  Object.defineProperty(res, 'type', { value: type });
  for (const [key, value] of Object.entries(props)) Object.defineProperty(res, key, { value });
  const clone = res.clone.bind(res);
  Object.defineProperty(res, 'clone', { value: () => typed(clone(), type, props) });
  return res;
}

/** An answer read in CORS mode: its status and bytes can be read. The server's answers vary on Origin. */
const cors = (body: string, status: number) => typed(new Response(body, { status, headers: { Vary: 'Origin' } }), 'cors');

/** An answer read without CORS (an <img>): no status, no bytes, `ok` false. */
const opaque = () => typed(new Response(null, { status: 200 }), 'opaque', { ok: false, status: 0 });

/** A stored response read back: a fresh copy, as the browser's cache gives. */
const copy = (res: Response) => res.clone();

type Mode = 'no-cors' | 'cors' | 'navigate';
type Req = { url: string; method: string; mode: Mode; headers: Map<string, string> };
type Stored = { res: Response; headers: Map<string, string> };
/** What the network does with one read: answer it, or fail it. */
type Server = (url: string, init: { mode: string; credentials?: string }) => Promise<Response>;

/** A turn of the event loop: the browser's cache operations land later than the call that starts them. */
const later = () => new Promise((done) => setTimeout(done, 0));

function request(url: string, mode: Mode): Req {
  // per Fetch, Origin is added after the worker's fetch event, so no request the worker sees carries it
  return { url, method: 'GET', mode, headers: new Map() };
}

/**
 * The worker in a fake `self`, over a CacheStorage that keeps one store per cache name, in the order they were made.
 * A stored answer that varies on a header matches only a request with the same value of it, unless the match ignores
 * Vary, as the browser's does.
 */
function loadWorker(held: Record<string, Record<string, Stored | Response>>, server: Server) {
  const handlers: Record<string, (event: unknown) => void> = {};
  const stores = new Map<string, Map<string, Stored>>();
  const make = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name)!;
  };
  for (const [name, entries] of Object.entries(held)) {
    const store = make(name);
    for (const [url, entry] of Object.entries(entries)) {
      store.set(new URL(url, ORIGIN).href, entry instanceof Response ? { res: entry, headers: new Map() } : entry);
    }
  }
  /** Every cache operation the worker has started and not finished. */
  const pending = new Set<Promise<unknown>>();
  const track = <T,>(work: Promise<T>): Promise<T> => {
    const done: Promise<unknown> = work.then(
      () => { pending.delete(done); },
      () => { pending.delete(done); },
    );
    pending.add(done);
    return work;
  };
  const keyOf = (key: string | Req) => new URL(typeof key === 'string' ? key : key.url, ORIGIN).href;
  const headersOf = (key: string | Req) => (typeof key === 'string' ? new Map<string, string>() : key.headers);
  const cacheOf = (name: string) => {
    const store = make(name);
    return {
      put: (key: string | Req, res: Response) =>
        track(later().then(() => { store.set(keyOf(key), { res, headers: headersOf(key) }); })),
      match: async (key: string | Req, options: { ignoreVary?: boolean } = {}) => {
        const entry = store.get(keyOf(key));
        if (!entry) return undefined;
        const vary = (entry.res.headers.get('Vary') || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
        const asked = headersOf(key);
        if (!options.ignoreVary && vary.some((h) => asked.get(h) !== entry.headers.get(h))) return undefined;
        return copy(entry.res);
      },
    };
  };
  const caches = {
    open: (name: string) => track(later().then(() => cacheOf(name))),
    /** Every cache on the site, as the browser's global match searches them. */
    match: async (key: string | Req) => {
      for (const store of stores.values()) if (store.has(keyOf(key))) return copy(store.get(keyOf(key))!.res);
      return undefined;
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, handler: (event: unknown) => void) => { handlers[type] = handler; },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
  };
  /** Each read the worker sent: the URL, and the mode and credentials it was read with. */
  const network: { url: string; mode: string; credentials?: string }[] = [];
  const fetch = (req: string | Req, init?: { mode: string; credentials?: string }) => {
    const url = typeof req === 'string' ? req : req.url;
    const how = init ?? { mode: (req as Req).mode };
    network.push({ url, ...how });
    return server(url, how);
  };
  runInNewContext(readFileSync(resolve('public/sw.js'), 'utf8'), { self, URL, caches, fetch, Response, Request });

  /** Every cache operation the worker has started has finished, and so has every one those started. */
  const settled = async () => {
    while (pending.size) await Promise.all([...pending]);
  };
  /** A read through the worker: what the page gets, and the work the worker extended the event with. */
  const dispatch = (url: string, mode: Mode) => {
    let answer: Promise<Response> | undefined;
    const extended: Promise<unknown>[] = [];
    handlers.fetch({
      request: request(url, mode),
      respondWith: (p: Promise<Response>) => { answer = p; },
      waitUntil: (p: Promise<unknown>) => { extended.push(p); },
    });
    return { answer: answer!, extended };
  };
  const get = async (url: string, mode: Mode) => {
    const { answer, extended } = dispatch(url, mode);
    const res = await answer;
    // the refresh the worker extended the event with, which may land after the page's answer
    await Promise.all(extended);
    await settled();
    return res;
  };
  const kept = (url: string) => stores.get(FILES)?.get(new URL(url, ORIGIN).href)?.res;
  return { get, dispatch, settled, kept, network };
}

const offline: Server = () => Promise.reject(new TypeError('offline'));
/** The network answers a turn later, as a real one does: after the worker has handed back a kept copy. */
const answers = (res: () => Response): Server => async () => {
  await later();
  return res();
};

describe('a drawing or photo is read in CORS mode, and only a good answer is kept', () => {
  it.each([
    ['an <img>', 'no-cors'],
    ['a CORS read (the photo editor)', 'cors'],
  ] as const)('%s with nothing kept: the file is read in CORS mode without cookies, and the good answer is kept', async (_, mode) => {
    const { get, kept, network } = loadWorker({}, answers(() => cors('drawing bytes', 200)));
    const res = await get(DRAWING, mode);
    expect(await res.text()).toBe('drawing bytes');
    expect(network).toEqual([{ url: DRAWING, mode: 'cors', credentials: 'omit' }]);
    expect(kept(DRAWING)?.type).toBe('cors');
  });

  it.each([403, 404, 500, 503])('an answer of %i is shown, and is not kept', async (status) => {
    const { get, kept } = loadWorker({}, answers(() => cors('error', status)));
    const res = await get(PHOTO, 'no-cors');
    expect(res.status).toBe(status);
    expect(kept(PHOTO)).toBeUndefined();
  });

  it.each([403, 404, 500, 503])('with a good copy kept, an answer of %i (an expired link, say) leaves it, and it is served', async (status) => {
    const { get, kept, network } = loadWorker({ [FILES]: { [DRAWING]: cors('good drawing', 200) } }, answers(() => cors('error', status)));
    expect(await (await get(DRAWING, 'no-cors')).text()).toBe('good drawing');
    expect(network).toHaveLength(1);
    expect(await kept(DRAWING)!.clone().text()).toBe('good drawing');
  });

  it('with a good copy kept, a newer good answer replaces it for next time (stale-while-revalidate)', async () => {
    const { get, kept } = loadWorker({ [FILES]: { [PHOTO]: cors('first', 200) } }, answers(() => cors('second', 200)));
    expect(await (await get(PHOTO, 'no-cors')).text()).toBe('first');
    expect(await kept(PHOTO)!.clone().text()).toBe('second');
  });

  it('an answer that is not readable (opaque) is never kept', async () => {
    const { get, kept } = loadWorker({}, answers(opaque));
    expect((await get(PHOTO, 'no-cors')).type).toBe('opaque');
    expect(kept(PHOTO)).toBeUndefined();
  });

  it('when the CORS read is refused, the page still gets its own read, and nothing is kept', async () => {
    const server: Server = async (_, how) => {
      if (how.mode === 'cors') throw new TypeError('CORS refused');
      return opaque();
    };
    const { get, kept, network } = loadWorker({}, server);
    const res = await get(PHOTO, 'no-cors');
    expect(res.type).toBe('opaque');
    expect(network.map((n) => n.mode)).toEqual(['cors', 'no-cors']);
    expect(kept(PHOTO)).toBeUndefined();
  });

  it('a kept copy is written within its fetch event, so the worker is not stopped first', async () => {
    const worker = loadWorker({}, answers(() => cors('drawing bytes', 200)));
    const { answer, extended } = worker.dispatch(DRAWING, 'no-cors');
    await answer;
    expect(extended).toHaveLength(1);
    await Promise.all(extended);
    expect(worker.kept(DRAWING)?.type).toBe('cors');
  });

  it('a copy kept for an <img> is found for a CORS read of the same file (a guard: the answer varies on Origin, which no request the worker sees carries)', async () => {
    // the network answers the <img>, then drops
    let reads = 0;
    const worker = loadWorker({}, async () => {
      reads += 1;
      if (reads > 1) throw new TypeError('offline');
      return cors('photo bytes', 200);
    });
    await worker.get(PHOTO, 'no-cors');
    const res = await worker.get(PHOTO, 'cors');
    expect(await res.text()).toBe('photo bytes');
  });
});

describe('an opaque copy an earlier release kept is trusted only when the network gives nothing', () => {
  const held = () => ({ [FILES]: { [DRAWING]: opaque() } });

  it('online, the file is read again and the good answer replaces the opaque copy', async () => {
    const { get, kept } = loadWorker(held(), answers(() => cors('drawing bytes', 200)));
    expect(await (await get(DRAWING, 'no-cors')).text()).toBe('drawing bytes');
    expect(kept(DRAWING)?.type).toBe('cors');
  });

  it.each([403, 503])('online, an answer of %i gives an <img> the opaque copy, and leaves it', async (status) => {
    const { get, kept } = loadWorker(held(), answers(() => cors('error', status)));
    expect((await get(DRAWING, 'no-cors')).type).toBe('opaque');
    expect(kept(DRAWING)?.type).toBe('opaque');
  });

  it('online, an error answer is shown to a CORS read, which cannot use the opaque copy', async () => {
    const { get, kept } = loadWorker(held(), answers(() => cors('expired', 403)));
    expect((await get(DRAWING, 'cors')).status).toBe(403);
    expect(kept(DRAWING)?.type).toBe('opaque');
  });

  it('online with the network failing, an <img> gets the opaque copy, and it is not stored again', async () => {
    // the CORS read fails, and so does the page's own read
    const { get, kept, network } = loadWorker(held(), offline);
    expect((await get(DRAWING, 'no-cors')).type).toBe('opaque');
    expect(network.map((n) => n.mode)).toEqual(['cors', 'no-cors']);
    expect(kept(DRAWING)?.type).toBe('opaque');
  });

  it('offline, an <img> gets the opaque copy', async () => {
    const { get } = loadWorker(held(), offline);
    expect((await get(DRAWING, 'no-cors')).type).toBe('opaque');
  });

  it('offline, a CORS read is never handed the opaque copy, whose bytes it cannot use', async () => {
    const { get } = loadWorker(held(), offline);
    expect((await get(DRAWING, 'cors')).type).toBe('error');
  });

  it('offline with nothing kept, the read fails as a network error', async () => {
    const { get } = loadWorker({}, offline);
    expect((await get(PHOTO, 'no-cors')).type).toBe('error');
  });
});

describe("the app's own files are read only from the app cache", () => {
  const ASSET = `${ORIGIN}/assets/index-Ab12Cd34.js`;
  /** Another cache on the site (an older files cache, another app's) holding the same names. */
  const elsewhere = () => ({
    [APP_CACHE]: {},
    [FILES]: { [ASSET]: cors('files-cache copy', 200) },
    'other-app-cache': { '/': cors('another app', 200), '/favicon.svg': cors('another icon', 200) },
  });

  it('a hashed asset held only in another cache is fetched, not served from there', async () => {
    const { get, network } = loadWorker(elsewhere(), answers(() => cors('this build', 200)));
    expect(await (await get(ASSET, 'no-cors')).text()).toBe('this build');
    expect(network.map((n) => n.url)).toEqual([ASSET]);
  });

  it('offline, a page whose shell is only in another cache is not served that page', async () => {
    const { get } = loadWorker(elsewhere(), offline);
    const res = await get(`${ORIGIN}/projects/p1`, 'navigate');
    expect(res).toBeUndefined();
  });

  it('an icon held only in another cache is fetched, not served from there', async () => {
    const { get, network } = loadWorker(elsewhere(), answers(() => cors('this icon', 200)));
    expect(await (await get(`${ORIGIN}/favicon.svg`, 'no-cors')).text()).toBe('this icon');
    expect(network.map((n) => n.url)).toEqual([`${ORIGIN}/favicon.svg`]);
  });

  it("the app cache's own copies are still served", async () => {
    const { get, network } = loadWorker({ [APP_CACHE]: { '/': cors('the shell', 200), [ASSET]: cors('kept build', 200) } }, offline);
    expect(await (await get(ASSET, 'no-cors')).text()).toBe('kept build');
    expect(await (await get(`${ORIGIN}/projects/p1`, 'navigate')).text()).toBe('the shell');
    expect(network.map((n) => n.url)).toEqual([`${ORIGIN}/projects/p1`]);
  });
});
