import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { resolve } from 'node:path';

/**
 * The app shell and the app's files never keep an error response. A navigation is network-first and its page is
 * kept as the shell ('/') an offline phone opens; a hashed asset is cache-first, read from the cache from then on,
 * online too. A server error answered during a deploy must become neither: an offline phone would show the error
 * page, and a kept asset error would stop the app loading at all. A new release fills its own app cache with its
 * build from the network at install, drops what the last one kept without reading it, and leaves the offline
 * drawings and media alone.
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
type Server = (url: string) => Promise<Response>;

/** A turn of the event loop: the browser's cache writes land later than the call that starts them. */
const later = () => new Promise((done) => setTimeout(done, 0));

/**
 * The worker in a fake `self`, over a CacheStorage that keeps one store per cache name, in the order they were
 * made (as the browser's `caches.match` searches them). Opening a cache and writing to it are asynchronous, as in
 * the browser: a write lands a turn after it starts, and a cache deleted meanwhile takes it detached, gone.
 */
function loadWorker(
  held: Record<string, Entries> = {},
  shell: () => Promise<Response> = async () => basic('fresh app', 200),
  /** What the site answers for a fetch no test route sets: each URL's own answer, else a 404. */
  site: Record<string, () => Response> = {},
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
  /** Each open, put and delete, in the order they happen. */
  const log: string[] = [];
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
  const cacheOf = (name: string) => {
    const store = make(name);
    return {
      put: (key: Key, res: Response) => {
        return track(later().then(() => {
          if (name === full) throw new DOMException('storage is full', 'QuotaExceededError');
          store.set(href(key), res);
          log.push(`put:${name}`);
        }));
      },
      match: async (key: Key) => (store.has(href(key)) ? copy(store.get(href(key))!) : undefined),
      keys: async () => [...store.keys()].map((url) => ({ url })),
      addAll: async (urls: string[]) => {
        const answers = await Promise.all(urls.map(() => shell()));
        if (answers.some((res) => !res.ok)) throw new TypeError('Cache.addAll: a response is not ok');
        await later();
        urls.forEach((url, i) => store.set(href(url), answers[i]));
      },
    };
  };
  const caches = {
    open: (name: string) => {
      log.push(`open:${name}`);
      return track(later().then(() => cacheOf(name)));
    },
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
  let answerWith: Server = async (url) => (site[url] ? site[url]() : basic('not found', 404));
  const fetch = (req: string | { url: string }) => {
    const url = href(req);
    network.push(url);
    return answerWith(url);
  };
  runInNewContext(readFileSync(resolve('public/sw.js'), 'utf8'), { self, URL, caches, fetch, Response, Request });

  const lifecycle = async (type: 'install' | 'activate') => {
    let work: Promise<unknown> | undefined;
    handlers[type]({ waitUntil: (p: Promise<unknown>) => { work = p; } });
    await work;
  };
  /** A fetch event: the answer the page gets, and the work the worker extended the event with. */
  const dispatch = (url: string, mode: 'navigate' | 'no-cors', server: () => Promise<Response>) => {
    answerWith = server;
    let answer: Promise<Response> | undefined;
    const extended: Promise<unknown>[] = [];
    handlers.fetch({
      request: { url, method: 'GET', mode },
      respondWith: (p: Promise<Response>) => { answer = p; },
      waitUntil: (p: Promise<unknown>) => { extended.push(p); },
    });
    return { answer: answer!, extended };
  };
  /** Every cache operation the worker has started has finished, and so has every one those started. */
  const settled = async () => {
    while (pending.size) await Promise.all([...pending]);
  };
  /** The answer, once every write the worker started has landed: a kept copy is checked where it ends up. */
  const get = async (url: string, mode: 'navigate' | 'no-cors', server: () => Promise<Response>) => {
    const res = await dispatch(url, mode, server).answer;
    await settled();
    return res;
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
    dispatch,
    navigate: (server: () => Promise<Response>) => get(PAGE, 'navigate', server),
    asset: (server: () => Promise<Response>) => get(ASSET, 'no-cors', server),
    /** A write an earlier release's worker started into `name` and has not finished: it lands when `land` runs. */
    pendingWrite: async (name: string, url: string, res: Response) => {
      const store = make(name);
      let land!: () => void;
      const landed = new Promise<void>((done) => { land = done; }).then(() => { store.set(href(url), res); });
      return { land: () => { land(); return landed; } };
    },
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
const APP = `${ORIGIN}/assets/app-Ab12Cd34.js`;
async function running(text: string) {
  const worker = loadWorker({}, async () => basic(`${text}<script type="module" src="/assets/app-Ab12Cd34.js"></script>`, 200), { [APP]: () => basic('app', 200) });
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
    expect(await textOf('/')).toContain('good app');
    expect(await (await navigate(offline)).text()).toContain('good app');
  });

  it('a page from anywhere but this site (not a basic response) does not become the offline copy', async () => {
    const { navigate, textOf } = await running('good app');
    const other = new Response('elsewhere', { status: 200 });
    Object.defineProperty(other, 'type', { value: 'cors' });
    await navigate(async () => other);
    expect(await textOf('/')).toContain('good app');
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
    expect(network.filter((u) => u !== APP)).toEqual([ASSET, ASSET]);
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
    expect(network.filter((u) => u !== APP)).toEqual([ASSET]);
  });
});


describe('a kept copy is written within its fetch event', () => {
  it.each([
    ['a page', PAGE, 'navigate', '/'],
    ['an asset', ASSET, 'no-cors', ASSET],
  ] as const)('%s: the event lasts until the copy is in the app cache, so the worker is not stopped first', async (_, url, mode, key) => {
    const worker = await running('old app');
    const { answer, extended } = worker.dispatch(url, mode, async () => basic('new', 200));
    await answer;
    expect(extended).toHaveLength(1);
    await Promise.all(extended);
    expect(await worker.textOf(key)).toBe('new');
    inAppCache(worker.where(key));
  });
});

describe('a new release brings its own build and clears what the last one kept, keeping the offline drawings', () => {
  // this build's files, named the way Vite emits them: a hashed name with a known extension
  const ENTRY = `${ORIGIN}/assets/vendor-Ab12Cd34.js`;
  const LOGO = `${ORIGIN}/assets/logo-Ef56Gh78.jpeg`;
  const LAZY = `${ORIGIN}/assets/lazy-Ij90Kl_2.js`;
  const SHARED = `${ORIGIN}/assets/shared-Mn34-p56.js`;
  const STYLE = `${ORIGIN}/assets/index-Qr78St90.css`;
  const FONT = `${ORIGIN}/assets/archivo-latin-wght-normal-E0tuGl4L.woff2`;
  const BUILD = [ENTRY, LOGO, LAZY, SHARED, STYLE, FONT];
  // only the last release's cache holds these
  const BROKEN = `${ORIGIN}/assets/broken-Uv12Wx34.js`;
  const OLD_BUILD = `${ORIGIN}/assets/index-Yz56Ab78.js`;
  /** The new release's shell: it names its entry and stylesheet, and its icon beside it (not a hashed file). */
  const FRESH =
    'fresh app <script type="module" src="/assets/vendor-Ab12Cd34.js"></script>' +
    '<link rel="stylesheet" href="/assets/index-Qr78St90.css"><link rel="icon" href="./favicon.svg">';
  /**
   * The build on the server. The entry names a logo and a lazy chunk beside it, and holds text that looks like a
   * name but names no file, as the real bundle does ('./src', './u.test', './.exec', an unhashed 'assets/index').
   * The chunk names a shared chunk the way Vite's preload list does; the shared chunk names the entry back.
   */
  const files: Record<string, string> = {
    [ENTRY]:
      'vendor; var logo = "/assets/logo-Ef56Gh78.jpeg"; import("./lazy-Ij90Kl_2.js"); ' +
      'var a = "./src", b = "./u.test", c = "./.exec", d = "assets/index.js"',
    [LOGO]: 'jpeg',
    [LAZY]: 'lazy; __vite__mapDeps(["assets/shared-Mn34-p56.js"])',
    [SHARED]: 'shared; import("./vendor-Ab12Cd34.js")',
    [STYLE]: '@font-face { src: url(./archivo-latin-wght-normal-E0tuGl4L.woff2) }',
    [FONT]: 'woff2',
  };
  const site = (): Record<string, () => Response> =>
    Object.fromEntries(Object.entries(files).map(([url, body]) => [url, () => basic(body, 200)]));
  /**
   * A phone on the last release: its app cache holds an error page as the shell, a good icon, a kept 404 and an
   * older build's entry. An older release's files cache and a vitan-pmc- cache of no known kind are on it too.
   */
  const last = (): Record<string, Entries> => ({
    'vitan-pmc-v2': {
      '/': basic('deploying', 503),
      '/favicon.svg': basic('old icon', 200),
      [BROKEN]: basic('not found', 404),
      [OLD_BUILD]: basic('old build', 200),
    },
    'vitan-pmc-files-v1': { [`${ORIGIN}/media/m0`]: basic('old photo', 200) },
    'vitan-pmc-tmp': { '/x': basic('odd', 200) },
    'vitan-pmc-files-v2': { [`${ORIGIN}/media/m1`]: basic('photo', 200) },
    'other-app-cache': { '/x': basic('x', 200) },
  });

  const fresh = async () => basic(FRESH, 200);
  const installed = async (worker: ReturnType<typeof loadWorker>) => {
    await worker.lifecycle('install');
    await worker.lifecycle('activate');
    return worker;
  };

  it('install puts the shell and this whole build in a new app cache, from the network, reading no other cache', async () => {
    const { lifecycle, names, where, textOf, skipped, network, log } = loadWorker(last(), fresh, site());
    await lifecycle('install');
    const made = names().filter((n) => !Object.keys(last()).includes(n));
    expect(made).toHaveLength(1);
    inAppCache(made);
    expect(where('/')).toContain(made[0]);
    for (const file of BUILD) expect(where(file)).toEqual(made);
    // each file once, and nothing that only looks like a name
    expect([...network].sort()).toEqual([...BUILD].sort());
    expect(log.filter((e) => e.startsWith('open:'))).toEqual([`open:${made[0]}`]);
    expect(skipped()).toBe(true);
    await lifecycle('activate');
    expect(await textOf('/')).toBe(FRESH);
    expect(await textOf('/favicon.svg')).toBe(FRESH);
  });

  it('a file a build shares with the one already installed is not fetched again, and what it names still is', async () => {
    const { lifecycle, network, where } = loadWorker({ 'vitan-pmc-v3': { [LAZY]: basic(files[LAZY], 200) } }, fresh, site());
    await lifecycle('install');
    expect(network).not.toContain(LAZY);
    expect(network).toContain(SHARED);
    for (const file of BUILD) expect(where(file)).toEqual(['vitan-pmc-v3']);
  });

  it('a shell that names no emitted script (the file names changed shape) fails the install', async () => {
    const { lifecycle, skipped } = loadWorker(last(), async () => basic('<script type="module" src="/assets/index.js"></script>', 200), site());
    await expect(lifecycle('install')).rejects.toThrow('names no emitted script');
    expect(skipped()).toBe(false);
  });

  it('a shell the server will not give fails the install, so the last release keeps serving', async () => {
    const { lifecycle, skipped } = loadWorker(last(), async () => basic('deploying', 503), site());
    await expect(lifecycle('install')).rejects.toThrow();
    expect(skipped()).toBe(false);
  });

  it.each([
    ['answered 404', () => basic('not found', 404)],
    ['answered 503', () => basic('deploying', 503)],
    ['from elsewhere (not basic)', () => {
      const r = new Response('cdn', { status: 200 });
      Object.defineProperty(r, 'type', { value: 'cors' });
      return r;
    }],
  ])('a file of the build %s fails the install, so the last release keeps serving', async (_, answer) => {
    const { lifecycle, skipped } = loadWorker(last(), fresh, { ...site(), [SHARED]: answer });
    await expect(lifecycle('install')).rejects.toThrow();
    expect(skipped()).toBe(false);
  });

  it('a file of the build the network cannot fetch fails the install', async () => {
    const { lifecycle, skipped } = loadWorker(last(), fresh, { ...site(), [FONT]: () => { throw new TypeError('offline'); } });
    await expect(lifecycle('install')).rejects.toThrow('offline');
    expect(skipped()).toBe(false);
  });

  it('a build that cannot be written (a full phone) fails the install', async () => {
    const { lifecycle, skipped } = loadWorker(last(), fresh, site(), 'vitan-pmc-v3');
    await expect(lifecycle('install')).rejects.toThrow('storage is full');
    expect(skipped()).toBe(false);
  });

  it('activate deletes the last release caches without reading them, and nothing else', async () => {
    const worker = loadWorker(last(), fresh, site());
    await worker.lifecycle('install');
    const before = worker.log.length;
    await worker.lifecycle('activate');
    expect(worker.deleted.sort()).toEqual(['vitan-pmc-files-v1', 'vitan-pmc-tmp', 'vitan-pmc-v2']);
    expect(worker.names()).toContain('vitan-pmc-files-v2');
    expect(worker.names()).toContain('other-app-cache');
    expect(worker.log.slice(before).filter((e) => !e.startsWith('delete:'))).toEqual([]);
    for (const file of [BROKEN, OLD_BUILD]) expect(worker.where(file)).toEqual([]);
    expect(worker.claimed()).toBe(true);
  });

  it('offline right after the new release takes over, the app opens: the fresh shell and every file of its build', async () => {
    const worker = await installed(loadWorker(last(), fresh, site()));
    expect(await (await worker.navigate(offline)).text()).toBe(FRESH);
    for (const file of BUILD) expect(await (await worker.get(file, 'no-cors', offline)).text()).toBe(files[file]);
    await expect(worker.get(BROKEN, 'no-cors', offline)).rejects.toThrow('offline');
  });

  it('a write the last release worker has not finished when this one activates cannot cost the new build its entry', async () => {
    // the old worker served this build's entry and is still writing it into its own cache
    const worker = loadWorker(last(), fresh, site());
    const late = await worker.pendingWrite('vitan-pmc-v2', ENTRY, basic(files[ENTRY], 200));
    await worker.lifecycle('install');
    await worker.lifecycle('activate');
    expect(worker.deleted).toContain('vitan-pmc-v2');
    await late.land();
    // the late write landed in a cache that is gone, and the entry came from the network at install instead
    expect(worker.names()).not.toContain('vitan-pmc-v2');
    expect(worker.where(ENTRY)).toEqual(['vitan-pmc-v3']);
    expect(await (await worker.navigate(offline)).text()).toBe(FRESH);
    expect(await (await worker.get(ENTRY, 'no-cors', offline)).text()).toBe(files[ENTRY]);
  });
});
