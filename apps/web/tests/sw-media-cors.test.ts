import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { resolve } from 'node:path';

/**
 * Photo markup (#1003): the photo editor reads a stored photo's bytes with a CORS fetch. The service worker keeps
 * the opaque copy an <img> fetched for offline viewing; handing that to a CORS fetch gives a response with no
 * bytes and `ok` false, so a photo already on screen could not be opened for marking.
 */

const ORIGIN = 'https://pms.example';
const PHOTO = 'https://api.example/media/m1/file?t=signed';

function loadWorker(cached: Response, online = true) {
  const handlers: Record<string, (event: unknown) => void> = {};
  const network: string[] = [];
  const cache = { match: async () => cached, put: async () => {} };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, handler: (event: unknown) => void) => { handlers[type] = handler; },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
  };
  const fetch = async (req: string | { url: string }) => {
    network.push(typeof req === 'string' ? req : req.url);
    if (!online) throw new TypeError('offline');
    return new Response('bytes', { status: 200 });
  };
  runInNewContext(readFileSync(resolve('public/sw.js'), 'utf8'), { self, URL, caches: { open: async () => cache }, fetch, Response, Request });
  const get = async (mode: 'cors' | 'no-cors') => {
    let answer: Promise<Response> | undefined;
    handlers.fetch({
      request: { url: PHOTO, method: 'GET', mode },
      respondWith: (p: Promise<Response>) => { answer = p; },
      waitUntil: () => {},
    });
    return answer!;
  };
  return { get, network };
}

/** What an <img> without crossorigin leaves in the cache: an opaque response. */
function opaque(): Response {
  const r = new Response(null, { status: 200 });
  Object.defineProperty(r, 'type', { value: 'opaque' });
  Object.defineProperty(r, 'ok', { value: false });
  return r;
}

describe('the service worker and stored photos', () => {
  it('a CORS read of a photo the cache holds only as opaque goes to the network for its bytes', async () => {
    const { get, network } = loadWorker(opaque());
    const res = await get('cors');
    expect(res.ok).toBe(true);
    expect(await res.text()).toBe('bytes');
    expect(network).toEqual([PHOTO]);
  });

  it('offline, an <img> still gets the cached opaque copy', async () => {
    const hit = opaque();
    const { get } = loadWorker(hit, false);
    expect(await get('no-cors')).toBe(hit);
  });
});
