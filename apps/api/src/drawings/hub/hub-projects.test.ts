import { describe, it, expect } from 'vitest';
import {
  HUB_CALL_MAX_BYTES,
  clipHubText,
  hubCallRetryable,
  linkHubProject,
  listHubProjects,
  unlinkHubProject,
} from './hub-projects';
import { HUB_ENV, readHubConfig, readHubClientConfig, type HubClientConfig } from './hub-config';

// Test-only values: never a real Hub address or token.
const config: HubClientConfig = { baseUrl: 'https://hub.example.test', officeToken: 'office-token-for-tests', orgId: 'org-t', officeId: '7' };

type Seen = { url: string; method: string; headers: Record<string, string>; body?: string; redirect?: string };

/** A fake fetch: answers each call in turn and records what it was asked. */
function fakeFetch(...answers: Array<Response | (() => Promise<Response>)>) {
  const seen: Seen[] = [];
  const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    seen.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === 'string' ? init.body : undefined,
      redirect: init?.redirect,
    });
    const next = answers.shift();
    if (!next) throw new Error('no answer left');
    return typeof next === 'function' ? next() : next;
  }) as typeof fetch;
  return { impl, seen };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

describe('#1118 U7a — Hub project calls (list, link, unlink)', () => {
  it('lists the live projects, in Hub order, with the office token, following no redirect', async () => {
    const { impl, seen } = fakeFetch(json({ projects: [
      { id: 12, number: '24-017', name: 'Vitan Farm', archived: false },
      { id: 13, number: '24-018', name: 'Old one', archived: true },
      { id: '14', number: null, name: '  ', archived: 0 },
      { id: 12, number: 'dup', name: 'dup', archived: false },
      { id: 'x1', number: 'bad id', name: 'n' },
      { id: 0, number: 'zero', name: 'n' },
      'not a project',
    ] }));
    const r = await listHubProjects(config, { fetchImpl: impl });
    expect(r).toEqual({ ok: true, value: [
      { id: '12', number: '24-017', name: 'Vitan Farm' },
      { id: '14', number: null, name: null },
    ] });
    expect(seen).toEqual([{
      url: 'https://hub.example.test/api/v2/projects',
      method: 'GET',
      headers: { Authorization: 'Bearer office-token-for-tests', Accept: 'application/json' },
      body: undefined,
      redirect: 'manual',
    }]);
  });

  it('maps Hub failures to codes, never to Hub words', async () => {
    const cases: Array<[Response | (() => Promise<Response>), { failure: string; status?: number }]> = [
      [new Response('nope', { status: 401 }), { failure: 'refused', status: 401 }],
      [new Response('nope', { status: 403 }), { failure: 'refused', status: 403 }],
      [new Response('down', { status: 503 }), { failure: 'http_status', status: 503 }],
      [new Response('', { status: 302, headers: { location: 'https://elsewhere.test/' } }), { failure: 'unreachable' }],
      [new Response('<html>', { status: 200 }), { failure: 'unreadable' }],
      [json({ items: [] }), { failure: 'unreadable' }],
      [async () => { throw new TypeError('fetch failed'); }, { failure: 'unreachable' }],
      [async () => { throw Object.assign(new Error('slow'), { name: 'TimeoutError' }); }, { failure: 'timeout' }],
    ];
    for (const [answer, expected] of cases) {
      const r = await listHubProjects(config, { fetchImpl: fakeFetch(answer).impl });
      expect(r).toEqual({ ok: false, ...expected });
    }
  });

  it('refuses an answer larger than it reads, declared or streamed', async () => {
    const big = 'x'.repeat(HUB_CALL_MAX_BYTES + 1);
    const declared = new Response('{}', { status: 200, headers: { 'content-length': String(HUB_CALL_MAX_BYTES + 1) } });
    expect(await listHubProjects(config, { fetchImpl: fakeFetch(declared).impl })).toEqual({ ok: false, failure: 'unreadable' });
    expect(await listHubProjects(config, { fetchImpl: fakeFetch(new Response(big, { status: 200 })).impl })).toEqual({ ok: false, failure: 'unreadable' });
  });

  it('times out a Hub that never answers', async () => {
    const hang = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as typeof fetch;
    expect(await listHubProjects(config, { fetchImpl: hang, timeoutMs: 20 })).toEqual({ ok: false, failure: 'timeout' });
  });

  it('links with the form Hub reads, and leaves the address out when there is none', async () => {
    const { impl, seen } = fakeFetch(json({ app: 'pmc' }), new Response(null, { status: 204 }));
    expect(await linkHubProject(config, '12', { externalId: 'proj-1', url: 'https://pms.example.test', label: 'VFP-01' }, { fetchImpl: impl })).toEqual({ ok: true, value: null });
    expect(await linkHubProject(config, '12', { externalId: 'proj-1', url: null, label: 'VFP-01' }, { fetchImpl: impl })).toEqual({ ok: true, value: null });
    expect(seen.map((s) => [s.method, s.url, s.headers['Content-Type'], s.body])).toEqual([
      ['POST', 'https://hub.example.test/api/v2/projects/12/links/pmc', 'application/x-www-form-urlencoded', 'externalId=proj-1&label=VFP-01&url=https%3A%2F%2Fpms.example.test'],
      ['POST', 'https://hub.example.test/api/v2/projects/12/links/pmc', 'application/x-www-form-urlencoded', 'externalId=proj-1&label=VFP-01'],
    ]);
  });

  it('never sends a malformed Hub id to Hub', async () => {
    const { impl, seen } = fakeFetch();
    for (const id of ['', '0', '012', '12/../1', '1e3', '-1']) {
      expect(await linkHubProject(config, id, { externalId: 'p', url: null, label: 'l' }, { fetchImpl: impl })).toEqual({ ok: false, failure: 'http_status', status: 400 });
      expect(await unlinkHubProject(config, id, { fetchImpl: impl })).toEqual({ ok: false, failure: 'http_status', status: 400 });
    }
    expect(seen).toEqual([]);
  });

  it('unlinks; a 400 counts as done only when Hub lists no pmc link', async () => {
    const gone = fakeFetch(new Response('not linked', { status: 400 }), json({ links: [{ app: 'other', externalId: 'x' }] }));
    expect(await unlinkHubProject(config, '12', { fetchImpl: gone.impl })).toEqual({ ok: true, value: null });
    expect(gone.seen.map((s) => [s.method, s.url])).toEqual([
      ['DELETE', 'https://hub.example.test/api/v2/projects/12/links/pmc'],
      ['GET', 'https://hub.example.test/api/v2/projects/12/links'],
    ]);
    const still = fakeFetch(new Response('bad', { status: 400 }), json({ links: [{ app: 'PMC', externalId: 'x' }] }));
    expect(await unlinkHubProject(config, '12', { fetchImpl: still.impl })).toEqual({ ok: false, failure: 'http_status', status: 400 });
    const unknown = fakeFetch(new Response('bad', { status: 400 }), new Response('down', { status: 502 }));
    expect(await unlinkHubProject(config, '12', { fetchImpl: unknown.impl })).toEqual({ ok: false, failure: 'http_status', status: 400 });
    const ok = fakeFetch(new Response(null, { status: 204 }));
    expect(await unlinkHubProject(config, '12', { fetchImpl: ok.impl })).toEqual({ ok: true, value: null });
    const down = fakeFetch(new Response('down', { status: 500 }));
    expect(await unlinkHubProject(config, '12', { fetchImpl: down.impl })).toEqual({ ok: false, failure: 'http_status', status: 500 });
    expect(down.seen).toHaveLength(1);
  });

  it('says which failures a later try may pass', () => {
    expect(hubCallRetryable('unreachable')).toBe(true);
    expect(hubCallRetryable('timeout')).toBe(true);
    expect(hubCallRetryable('http_status', 503)).toBe(true);
    expect(hubCallRetryable('http_status', 429)).toBe(true);
    expect(hubCallRetryable('http_status', 408)).toBe(true);
    expect(hubCallRetryable('http_status', 404)).toBe(false);
    expect(hubCallRetryable('refused', 401)).toBe(false);
    expect(hubCallRetryable('unreadable')).toBe(false);
  });

  it('clips Hub text to its column', () => {
    expect(clipHubText('  24-017 ', 128)).toBe('24-017');
    expect(clipHubText('a\u0000b\nc', 128)).toBe('a b c');
    expect(clipHubText(2417, 128)).toBe('2417');
    expect(clipHubText('   ', 128)).toBeNull();
    expect(clipHubText(null, 128)).toBeNull();
    expect(clipHubText({}, 128)).toBeNull();
    expect(clipHubText('abcdef', 3)).toBe('abc');
    expect(clipHubText('ab cdef', 3)).toBe('ab');
    expect(clipHubText('😀😀😀😀', 2)).toBe('😀😀');
  });

  it('reads its config from the four variables other than the webhook secret, the same way the receiver reads them', () => {
    const full = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
      HUB_BASE_URL: 'https://hub.example.test', HUB_OFFICE_TOKEN: 'office-token-for-tests', HUB_ORG_ID: 'org-hub-test', HUB_OFFICE_ID: '7', ...over,
    });
    expect(readHubClientConfig(full())).toEqual({ open: true, config: {
      baseUrl: 'https://hub.example.test', officeToken: 'office-token-for-tests', orgId: 'org-hub-test', officeId: '7',
    } });
    // no secret, or a bad one, keeps the receiver closed and the client open
    expect(readHubConfig(full()).open).toBe(false);
    expect(readHubClientConfig(full({ HUB_WEBHOOK_SECRET: 'whsec_short' })).open).toBe(true);
    expect(readHubClientConfig({})).toEqual({ open: false, faults: HUB_ENV.filter((n) => n !== 'HUB_WEBHOOK_SECRET').map((name) => ({ name, problem: 'unset' })) });
    expect(readHubClientConfig(full({ HUB_BASE_URL: 'https://hub.example.test/api', HUB_OFFICE_TOKEN: 'x y' }))).toEqual({ open: false, faults: [
      { name: 'HUB_BASE_URL', problem: 'malformed' }, { name: 'HUB_OFFICE_TOKEN', problem: 'malformed' },
    ] });
    expect(JSON.stringify(readHubClientConfig(full({ HUB_OFFICE_TOKEN: 'x y' })))).not.toContain('x y');
  });
});
