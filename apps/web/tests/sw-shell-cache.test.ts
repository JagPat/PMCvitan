import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { resolve } from 'node:path';

/**
 * The app shell and the app's files never keep an error response. A navigation is network-first and its page is
 * kept as the shell ('/') an offline phone opens; a hashed asset is cache-first, read from the cache from then on,
 * online too. A server error answered during a deploy must become neither: an offline phone would show the error
 * page, and a kept asset error would stop the app loading at all. A new release's app cache drops what the last
 * one kept, carrying over only its good hashed files, and leaves the offline drawings and media alone.
 */

const ORIGIN = 'https://pms.example';
const PAGE = `${ORIGIN}/projects/p1`;
const ASSET = `${ORIGIN}/assets/index-abc123.js`;

/** A response as the browser hands a same-origin answer to the worker: `type` is 'basic' there. */
function basic(body: string, status: number): Response {
  const r = new Response(body, { status });
  Object.defineProperty(r, 'type', { value: 'basic' });
  return r;
}

/** A stored response read back, keeping its `type` as the browser's cache does (`clone` alone would reset it). */
function copy(res: Response): Response {
  const out = res.clone();
  Object.defineProperty(out, 'type', { value: res.type });
  return out;
}

type Key = string | { url: string };
const href = (key: Key) => new URL(typeof key === 'string' ? key : key.url, ORIGIN).href;
type Entries = Record<string, Response>;

/**
 * The worker in a fake `self`, over a CacheStorage that keeps one store per cache name, in the order they were
 * made (as the browser's `caches.match` searches them). `caches.open` runs its callback at once, so a put the
 * worker makes on a fetch is in its store by the time the worker answers.
 */
function loadWorker(
  held: Record<string, Entries> = {},
  shell: () => Promise<Response> = async () => basic('fresh app', 200),
  /** A cache whose puts fail, as a full origin's do. */
  full?: string,
) {
  const handlers: Record<string, (event: unknown) => void> = {};
  const stores = new Map<string, Map<string, Response>>();
  const make = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name)!;
  };
  for (const [name, entries] of Object.entries(held)) {
    const store = make(name);
    for (const [key, res] of Object.entries(entries)) store.set(href(key), res);
  }
  const deleted: string[] = [];
  /** Each put and delete, in the order they land. */
  const log: string[] = [];
  const cacheOf = (name: string) => {
    const store = make(name);
    return {
      put: (key: Key, res: Response) => {
        if (name === full) return Promise.reject(new DOMException('storage is full', 'QuotaExceededError'));
        store.set(href(key), res);
        log.push(`put:${name}`);
        return Promise.resolve();
      },
      match: async (key: Key) => (store.has(href(key)) ? copy(store.get(href(key))!) : undefined),
      keys: async () => [...store.keys()].map((url) => ({ url })),
      addAll: async (urls: string[]) => {
        const answers = await Promise.all(urls.map(() => shell()));
        if (answers.some((res) => !res.ok)) throw new TypeError('Cache.addAll: a response is not ok');
        urls.forEach((url, i) => store.set(href(url), answers[i]));
      },
    };
  };
  const caches = {
    open: (name: string) => ({ then: (next: (c: ReturnType<typeof cacheOf>) => unknown) => Promise.resolve(next(cacheOf(name))) }),
    match: async (key: Key) => {
      for (const store of stores.values()) if (store.has(href(key))) return copy(store.get(href(key))!);
      return undefined;
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => { deleted.push(name); log.push(`delete:${name}`); return stores.delete(name); },
  };
  let skipped = false;
  let claimed = false;
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, handler: (event: unknown) => void) => { handlers[type] = handler; },
    skipWaiting: () => { skipped = true; return Promise.resolve(); },
    clients: { claim: () => { claimed = true; return Promise.resolve(); } },
  };
  const network: string[] = [];
  let answerWith: () => Promise<Response> = () => Promise.reject(new TypeError('offline'));
  const fetch = (req: { url: string }) => { network.push(req.url); return answerWith(); };
  runInNewContext(readFileSync(resolve('public/sw.js'), 'utf8'), { self, URL, caches, fetch, Response, Request });

  const lifecycle = async (type: 'install' | 'activate') => {
    let work: Promise<unknown> | undefined;
    handlers[type]({ waitUntil: (p: Promise<unknown>) => { work = p; } });
    await work;
  };
  const get = async (url: string, mode: 'navigate' | 'no-cors', server: () => Promise<Response>) => {
    answerWith = server;
    let answer: Promise<Response> | undefined;
    handlers.fetch({ request: { url, method: 'GET', mode }, respondWith: (p: Promise<Response>) => { answer = p; } });
    return answer!;
  };
  /** The caches holding `url`, and the text of the first. */
  const where = (url: string) => [...stores].filter(([, store]) => store.has(href(url))).map(([name]) => name);
  const textOf = (url: string) => {
    const name = where(url)[0];
    return name === undefined ? undefined : stores.get(name)!.get(href(url))!.clone().text();
  };
  return {
    lifecycle,
    get,
    navigate: (server: () => Promise<Response>) => get(PAGE, 'navigate', server),
    asset: (server: () => Promise<Response>) => get(ASSET, 'no-cors', server),
    where,
    textOf,
    names: () => [...stores.keys()],
    network,
    deleted,
    log,
    skipped: () => skipped,
    claimed: () => claimed,
  };
}

/** A worker installed and running, its shell a good page saying `text`. */
async function running(text: string) {
  const worker = loadWorker({}, async () => basic(text, 200));
  await worker.lifecycle('install');
  await worker.lifecycle('activate');
  return worker;
}

const offline = () => Promise.reject(new TypeError('offline'));

/** A good copy sits only in the app's own cache: a `vitan-pmc-` one, never the files cache, which no bump clears. */
function inAppCache(names: string[]) {
  expect(names.length).toBeGreaterThan(0);
  for (const name of names) {
    expect(name.startsWith('vitan-pmc-')).toBe(true);
    expect(name.startsWith('vitan-pmc-files-')).toBe(false);
  }
}

describe('the service worker keeps only a good page as the offline copy of the app', () => {
  it.each([500, 502, 503, 404])('a page answered %i is shown, and the offline copy stays the last good one', async (status) => {
    const { navigate, textOf } = await running('good app');
    const res = await navigate(async () => basic('deploying', status));
    expect(res.status).toBe(status);
    expect(await textOf('/')).toBe('good app');
    expect(await (await navigate(offline)).text()).toBe('good app');
  });

  it('a page from anywhere but this site (not a basic response) does not become the offline copy', async () => {
    const { navigate, textOf } = await running('good app');
    const other = new Response('elsewhere', { status: 200 });
    Object.defineProperty(other, 'type', { value: 'cors' });
    await navigate(async () => other);
    expect(await textOf('/')).toBe('good app');
  });

  it('a good page from this site still becomes the offline copy, in the app cache', async () => {
    const { navigate, textOf, where } = await running('old app');
    const res = await navigate(async () => basic('new app', 200));
    expect(await res.text()).toBe('new app');
    expect(await textOf('/')).toBe('new app');
    inAppCache(where('/'));
    expect(await (await navigate(offline)).text()).toBe('new app');
  });
});

describe('the service worker keeps only a good hashed asset', () => {
  it.each([404, 503])('an asset answered %i is shown, not kept, and the next load asks the network again', async (status) => {
    const { asset, where, network } = await running('good app');
    const res = await asset(async () => basic('deploying', status));
    expect(res.status).toBe(status);
    expect(where(ASSET)).toEqual([]);
    const next = await asset(async () => basic('console.log(1)', 200));
    expect(await next.text()).toBe('console.log(1)');
    expect(network).toEqual([ASSET, ASSET]);
  });

  it('an asset that is not a basic response is not kept', async () => {
    const { asset, where } = await running('good app');
    const other = new Response('console.log(2)', { status: 200 });
    Object.defineProperty(other, 'type', { value: 'cors' });
    await asset(async () => other);
    expect(where(ASSET)).toEqual([]);
  });

  it('a good asset from this site is still kept, in the app cache, and the next load reads it from there', async () => {
    const { asset, textOf, where, network } = await running('good app');
    await asset(async () => basic('console.log(1)', 200));
    expect(await textOf(ASSET)).toBe('console.log(1)');
    inAppCache(where(ASSET));
    expect(await (await asset(offline)).text()).toBe('console.log(1)');
    expect(network).toEqual([ASSET]);
  });
});

describe('a new release clears what the last one kept, and keeps the offline drawings', () => {
  const GOOD = `${ORIGIN}/assets/vendor-abc.js`;
  const LOGO = `${ORIGIN}/assets/logo-123.jpeg`;
  const LAZY = `${ORIGIN}/assets/lazy-111.js`;
  const SHARED = `${ORIGIN}/assets/shared-222.js`;
  const BROKEN = `${ORIGIN}/assets/broken-def.js`;
  const CDN = `${ORIGIN}/assets/cdn-ghi.js`;
  const OLD_BUILD = `${ORIGIN}/assets/index-old.js`;
  // named by the fresh shell, but held only in caches the carry must never read: an older files cache, and a
  // vitan-pmc- cache of no known kind
  const STRAY = `${ORIGIN}/assets/stray-333.js`;
  const ODD = `${ORIGIN}/assets/odd-444.js`;
  /**
   * The new release's shell: it names its entry, a file the server lost, one served as cors, two files only other
   * kinds of cache hold, and its icon beside it (not a hashed file, so never carried over the fresh one).
   */
  const FRESH =
    'fresh app <script type="module" src="/assets/vendor-abc.js"></script><script src="/assets/broken-def.js"></script>' +
    '<script src="/assets/cdn-ghi.js"></script><script src="/assets/stray-333.js"></script>' +
    '<script src="/assets/odd-444.js"></script><link rel="icon" href="./favicon.svg">';
  const cors = (body: string) => {
    const r = new Response(body, { status: 200 });
    Object.defineProperty(r, 'type', { value: 'cors' });
    return r;
  };
  /**
   * A phone on the last release: its app cache holds an error page as the shell, a good icon, this build's files
   * (the entry names a logo and a lazy chunk beside it; the chunk names a shared chunk the way Vite's preload list
   * does; the shared chunk names the entry back), a kept 404, a cors copy, and an older build's entry. An older
   * release's files cache and a vitan-pmc- cache of no known kind are still on it too.
   */
  const last = (): Record<string, Entries> => ({
    'vitan-pmc-v2': {
      '/': basic('deploying', 503),
      '/favicon.svg': basic('old icon', 200),
      [GOOD]: basic('vendor; var logo = "/assets/logo-123.jpeg"; import("./lazy-111.js")', 200),
      [LOGO]: basic('jpeg', 200),
      [LAZY]: basic('lazy; __vite__mapDeps(["assets/shared-222.js"])', 200),
      [SHARED]: basic('shared; import("./vendor-abc.js")', 200),
      [BROKEN]: basic('not found', 404),
      [CDN]: cors('cdn'),
      [OLD_BUILD]: basic('old build', 200),
    },
    'vitan-pmc-files-v1': { [STRAY]: basic('stray', 200) },
    'vitan-pmc-tmp': { [ODD]: basic('odd', 200) },
    'vitan-pmc-files-v2': { [`${ORIGIN}/media/m1`]: basic('photo', 200) },
    'other-app-cache': { '/x': basic('x', 200) },
  });

  const fresh = async () => basic(FRESH, 200);

  it('install fills a new app cache with the shell from the network', async () => {
    const { lifecycle, names, where, textOf, skipped } = loadWorker(last(), fresh);
    await lifecycle('install');
    const made = names().filter((n) => !Object.keys(last()).includes(n));
    expect(made).toHaveLength(1);
    inAppCache(made);
    expect(where('/')).toContain(made[0]);
    expect(skipped()).toBe(true);
    await lifecycle('activate');
    expect(await textOf('/')).toBe(FRESH);
    expect(await textOf('/favicon.svg')).toBe(FRESH);
  });

  it('a shell the server will not give fails the install, so the last release keeps serving', async () => {
    const { lifecycle, skipped } = loadWorker(last(), async () => basic('deploying', 503));
    await expect(lifecycle('install')).rejects.toThrow();
    expect(skipped()).toBe(false);
  });

  it('activate deletes the last release caches and nothing else, carrying over only this build good hashed files', async () => {
    const { lifecycle, names, deleted, where, claimed, log } = loadWorker(last(), fresh);
    await lifecycle('install');
    const installed = log.length;
    await lifecycle('activate');
    expect(deleted.sort()).toEqual(['vitan-pmc-files-v1', 'vitan-pmc-tmp', 'vitan-pmc-v2']);
    expect(names()).toContain('vitan-pmc-files-v2');
    expect(names()).toContain('other-app-cache');
    for (const file of [GOOD, LOGO, LAZY, SHARED]) inAppCache(where(file));
    for (const file of [BROKEN, CDN, OLD_BUILD, STRAY, ODD]) expect(where(file)).toEqual([]);
    expect(claimed()).toBe(true);
    // every copy, down to the deepest chunk, lands before the cache it came from is deleted
    const activated = log.slice(installed);
    expect(activated.filter((e) => e === 'put:vitan-pmc-v3')).toHaveLength(4);
    expect(activated.indexOf('delete:vitan-pmc-v2')).toBeGreaterThan(activated.lastIndexOf('put:vitan-pmc-v3'));
  });

  it('offline right after the new release takes over, the app still opens: the fresh shell and the good asset', async () => {
    const worker = loadWorker(last(), fresh);
    await worker.lifecycle('install');
    await worker.lifecycle('activate');
    expect(await (await worker.navigate(offline)).text()).toBe(FRESH);
    expect(await (await worker.get(GOOD, 'no-cors', offline)).text()).toContain('vendor');
    expect(await (await worker.get(SHARED, 'no-cors', offline)).text()).toContain('shared');
    await expect(worker.get(BROKEN, 'no-cors', offline)).rejects.toThrow('offline');
  });

  it('a carry that cannot write still deletes the last release caches, so a kept error is not served', async () => {
    const worker = loadWorker(last(), fresh, 'vitan-pmc-v3');
    await worker.lifecycle('install');
    await worker.lifecycle('activate');
    expect(worker.deleted.sort()).toEqual(['vitan-pmc-files-v1', 'vitan-pmc-tmp', 'vitan-pmc-v2']);
    expect(worker.claimed()).toBe(true);
    expect(await (await worker.navigate(offline)).text()).toBe(FRESH);
    await expect(worker.get(BROKEN, 'no-cors', offline)).rejects.toThrow('offline');
    expect(worker.network).toEqual([PAGE, BROKEN]);
  });
});
