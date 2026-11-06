import { describe, it, expect, afterEach, beforeEach, onTestFinished, vi } from 'vitest';
import { PROJECT_ACCESS_CODES } from '@vitan/shared';
import { warmImports } from './warm-imports';

/**
 * #1373 — what the web does when the server refuses a session's token, decided once in `req()` for every caller:
 * - a 401 on a request that sent a bearer token signs the person out;
 * - a 403 carrying one of the three `PROJECT_ACCESS_CODES` (never branched on which) moves them off the lost project:
 *   back into it in a new role, to another project they hold, or, with none left, out with the sign-in's own words;
 * - any other refusal is the caller's own, as before, and a refused write re-reads the project.
 * A public sign-in or setup call never takes part, and a server from before the codes keeps today's behaviour.
 * Every request here goes through the real `ApiGateway` against a stubbed `fetch`.
 */

const b64url = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (payload: Record<string, unknown>) => `${b64url({ alg: 'HS256' })}.${b64url(payload)}.sig`;
const NOW = Date.parse('2026-11-06T12:00:00Z');
const exp = NOW / 1000 + 3600;
const tokA = jwt({ sub: 'u-1', role: 'pmc', projectId: 'p-a', exp });
const tokA2 = jwt({ sub: 'u-1', role: 'engineer', projectId: 'p-a', exp, v: 2 });
const tokB = jwt({ sub: 'u-1', role: 'client', projectId: 'p-b', exp });
const ALPHA = { projectId: 'p-a', name: 'Alpha', short: 'ALP', role: 'pmc', orgId: null, orgName: null };
const BETA = { projectId: 'p-b', name: 'Beta', short: 'BET', role: 'client', orgId: null, orgName: null };

const REMOVED = { message: 'Project access has been removed', error: 'Forbidden', statusCode: 403, code: PROJECT_ACCESS_CODES.accessRemoved };
const ROLE_CHANGED = { message: 'Project role changed; sign in again', error: 'Forbidden', statusCode: 403, code: PROJECT_ACCESS_CODES.roleChanged };
const UNAVAILABLE = { message: 'Project is unavailable', error: 'Forbidden', statusCode: 403, code: PROJECT_ACCESS_CODES.unavailable };
const PER_ACTION = { message: 'Only the PMC can remove a location', error: 'Forbidden', statusCode: 403 };
const GAMMA = { projectId: 'p-c', name: 'Gamma', short: 'GAM', role: 'client', orgId: null, orgName: null };
const tokC = jwt({ sub: 'u-1', role: 'client', projectId: 'p-c', exp });

/** Alpha as the server answers a command on it */
const ALPHA_SNAPSHOT = {
  project: { id: 'p-a', name: 'Alpha', short: 'ALP', descriptor: '', stage: '', siteCode: '', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
  decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
  drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
};

/** A reply the test lets go of when it chooses: the signal a test waits on, never a clock. `asked` settles once the
 *  request has reached the server */
function held() {
  let release!: (a: Answer) => void;
  let seen!: () => void;
  const answer = new Promise<Answer>((r) => { release = r; });
  const asked = new Promise<void>((r) => { seen = r; });
  return { reply: (): Promise<Answer> => { seen(); return answer; }, release, asked };
}

type Answer = { status: number; body: unknown };
type Route = (method: string, path: string, body: string) => Answer | Promise<Answer> | undefined;
const calls: Array<{ method: string; path: string; auth: string | null }> = [];
const hits = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path).length;

function stubFetch(route: Route) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.replace('http://api.test', '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method, path, auth: headers.Authorization ?? null });
    const a = (await route(method, path, typeof init?.body === 'string' ? init.body : '')) ?? { status: 599, body: { message: `unrouted ${method} ${path}` } };
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'Content-Type': 'application/json' } });
  }));
}

async function freshStore() {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const storeMod = await import('@/store/store');
  const gwMod = await import('@/data/apiGateway');
  storeMod.useStore.setState(storeMod.getInitialState());
  return { useStore: storeMod.useStore, ApiGateway: gwMod.ApiGateway };
}
type Loaded = Awaited<ReturnType<typeof freshStore>>;

await warmImports(() => import('@/store/store'), () => import('@/data/apiGateway'), () => import('@/lib/queueWords'));

/** A session on Alpha holding `tokA`, adopted the way the app adopts one: a fresh sign-in on this page, or a reload
 *  restoring the tab's saved session. The gateway carries the token, as `useApiSync` sets it. */
async function signedIn(how: 'fresh' | 'restored'): Promise<Loaded & { gw: InstanceType<Loaded['ApiGateway']> }> {
  const loaded = await freshStore();
  const { useStore, ApiGateway } = loaded;
  const gw = new ApiGateway('http://api.test', 'p-a');
  useStore.getState()._setGateway(gw);
  if (how === 'fresh') {
    stubFetch((m, p) => (m === 'POST' && p === '/auth/login' ? { status: 201, body: { token: tokA, role: 'pmc', projectId: 'p-a', name: 'Pat' } } : undefined));
    useStore.getState().login('pmc@example.com', 'a long passphrase');
    await vi.waitFor(() => expect(useStore.getState().sessionToken).toBe(tokA));
  } else {
    globalThis.sessionStorage.setItem('vitan.session.v1', JSON.stringify({ token: tokA, role: 'pmc', projectId: 'p-a' }));
    expect(useStore.getState().restoreSession()).toBe(true);
  }
  gw.setToken(tokA);
  useStore.setState({ memberships: [ALPHA, BETA] as never, online: true });
  calls.length = 0;
  return { ...loaded, gw };
}

/** The server: `/auth/login` signs in to Alpha, `refused` answers the project's own routes, `/me/memberships` lists
 *  `listed`, and `/auth/switch` mints a token for the project asked for. */
function server(refused: Answer, listed: unknown[], extra?: Route): Route {
  return (method, path, body) => {
    const own = extra?.(method, path, body);
    if (own) return own;
    if (method === 'POST' && path === '/auth/login') return { status: 201, body: { token: tokA, role: 'pmc', projectId: 'p-a', name: 'Pat' } };
    if (method === 'GET' && path === '/me/memberships') return { status: 200, body: listed };
    if (path.startsWith('/projects/p-a/')) return refused;
    return undefined;
  };
}
/** `/auth/switch` answers with the listed project's own token, in its listed role */
const switchTo = (to: 'p-a' | 'p-b'): Route => (method, path, body) => {
  if (method !== 'POST' || path !== '/auth/switch') return undefined;
  // only the project this server lets the person hold; any other is refused, as the server refuses it
  if ((JSON.parse(body) as { projectId?: string }).projectId !== to) return { status: 403, body: { message: 'Not a member of this project', error: 'Forbidden', statusCode: 403 } };
  return { status: 201, body: to === 'p-b' ? { token: tokB, role: 'client', projectId: 'p-b', name: 'Pat' } : { token: tokA2, role: 'engineer', projectId: 'p-a', name: 'Pat' } };
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  globalThis.sessionStorage.clear();
  globalThis.localStorage.clear();
  calls.length = 0;
});

afterEach(() => {
  window.history.replaceState(null, '', '/');
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('#1373 sessionRefusal: the one rule, from status and code alone', () => {
  it('401 ends the session; a 403 with any of the three codes is a lost project; everything else is the act\'s own', async () => {
    const { sessionRefusal, isTerminalOutboxError, isKeptQueuedRefusal, dropsQueuedAct } = await import('@/data/apiGateway');
    const err = (status: number, serverCode?: string, serverMessage?: string) => Object.assign(new Error('x'), { status, serverCode, serverMessage });
    expect(sessionRefusal(err(401))).toBe('session-ended');
    for (const code of Object.values(PROJECT_ACCESS_CODES)) {
      expect(sessionRefusal(err(403, code))).toBe('project-lost');
      // a final refusal for every direct command, as before; only a QUEUED act is kept through it, as through a 401
      expect(isTerminalOutboxError(err(403, code))).toBe(true);
      expect(isKeptQueuedRefusal(err(403, code))).toBe(true);
      expect(dropsQueuedAct(err(403, code))).toBe(false);
    }
    // never from the words: an uncoded 403 saying the same thing is the act's own refusal (a server from before the codes)
    expect(sessionRefusal(err(403, undefined, 'Project access has been removed'))).toBeNull();
    expect(sessionRefusal(err(403, 'setup-running'))).toBeNull();
    expect(sessionRefusal(err(409, PROJECT_ACCESS_CODES.accessRemoved))).toBeNull();
    expect(sessionRefusal(new TypeError('Failed to fetch'))).toBeNull();
    expect(sessionRefusal(null)).toBeNull();
    // and an uncoded 403 is dropped from the queue, as before
    expect(isTerminalOutboxError(err(403))).toBe(true);
    expect(dropsQueuedAct(err(403))).toBe(true);
    expect(dropsQueuedAct(err(401))).toBe(false);
  });
});

describe('#1373 req() tells the hook of a refused token-bearing request, and only of one', () => {
  async function gateway(route: Route, token: string | null) {
    const { ApiGateway } = await import('@/data/apiGateway');
    stubFetch(route);
    const gw = new ApiGateway('http://api.test', 'p-a');
    if (token) gw.setToken(token);
    const told: unknown[] = [];
    gw.onSessionRefused = (r) => told.push(r);
    return { gw, told };
  }

  it('a coded 403 on a read, an uncoded 403 on a write, a 401: each told once with the token sent, then thrown to the caller', async () => {
    const { gw, told } = await gateway((_m, p) => (
      p === '/projects/p-a/snapshot' ? { status: 403, body: REMOVED }
        : p === '/projects/p-a/nodes/n-1' ? { status: 403, body: PER_ACTION }
          : p === '/me/memberships' ? { status: 401, body: { message: 'Session expired', statusCode: 401 } } : undefined
    ), tokA);
    const read = await gw.snapshot().catch((e: unknown) => e);
    expect(read).toMatchObject({ status: 403, serverCode: PROJECT_ACCESS_CODES.accessRemoved, serverMessage: 'Project access has been removed' });
    const write = await gw.deleteNode('n-1').catch((e: unknown) => e);
    expect(write).toMatchObject({ status: 403, serverMessage: PER_ACTION.message });
    const me = await gw.listMemberships().catch((e: unknown) => e);
    expect(me).toMatchObject({ status: 401 });
    expect(told).toEqual([
      { kind: 'project-lost', token: tokA, projectWrite: false },
      { kind: 'refused', token: tokA, projectWrite: true },
      { kind: 'session-ended', token: tokA, projectWrite: false },
    ]);
  });

  it('a public sign-in or setup 401 is never told, even with an earlier session\'s token still on the gateway', async () => {
    const r401 = { status: 401, body: { message: 'Invalid credentials', statusCode: 401 } };
    for (const token of [null, tokA]) {
      const { gw, told } = await gateway(() => r401, token);
      await expect(gw.login('pmc@example.com', 'wrong')).rejects.toMatchObject({ status: 401 });
      await expect(gw.passwordCredentialComplete('setup-token', 'a long new passphrase')).rejects.toMatchObject({ status: 401 });
      await expect(gw.emailOtpVerify('pmc@example.com', '000000')).rejects.toMatchObject({ status: 401 });
      expect(told).toEqual([]);
    }
  });

  it('a request that sent no token is never told; nor is a 5xx, a 409 or a network failure', async () => {
    const { gw: bare, told: toldBare } = await gateway(() => ({ status: 401, body: {} }), null);
    await expect(bare.snapshot()).rejects.toMatchObject({ status: 401 });
    expect(toldBare).toEqual([]);
    const { gw, told } = await gateway((_m, p) => (p === '/projects/p-a/snapshot' ? { status: 503, body: {} } : { status: 409, body: { code: PROJECT_ACCESS_CODES.accessRemoved } }), tokA);
    await expect(gw.snapshot()).rejects.toMatchObject({ status: 503 });
    await expect(gw.deleteNode('n-1')).rejects.toMatchObject({ status: 409 });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(gw.snapshot()).rejects.toBeInstanceOf(TypeError);
    expect(told).toEqual([]);
  });

  it('only req() sends a bearer token, so no request can skip the hook', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '../src/data/apiGateway.ts'), 'utf8');
    expect(src.match(/Bearer /g)).toHaveLength(1);
    const reqStart = src.indexOf('private async req<T>(');
    const reqEnd = src.indexOf('\n  }\n', reqStart);
    const at = src.indexOf('Bearer ');
    expect(at > reqStart && at < reqEnd).toBe(true);
    // and nothing else in the app writes an Authorization header
    const { globSync } = await import('node:fs');
    const files = (globSync as (p: string, o: { cwd: string }) => string[])('src/**/*.{ts,tsx}', { cwd: resolve(__dirname, '..') });
    const writers = files.filter((f) => /Authorization/.test(readFileSync(resolve(__dirname, '..', f), 'utf8')));
    expect(writers).toEqual(['src/data/apiGateway.ts']);
  });
});

describe('#1373 a coded 403 moves the person off the lost project', () => {
  for (const how of ['fresh', 'restored'] as const) {
    for (const [label, body] of [['removed', REMOVED], ['archived', UNAVAILABLE], ['re-roled elsewhere', ROLE_CHANGED]] as const) {
      it(`${how} session, ${label}, on the snapshot read: moved to the other project they hold, still signed in`, async () => {
        const { useStore } = await signedIn(how);
        stubFetch(server({ status: 403, body }, [BETA], switchTo('p-b')));
        useStore.getState().retryProjectLoad();
        await vi.waitFor(() => expect(useStore.getState().sessionToken).toBe(tokB));
        const st = useStore.getState();
        expect(st.activeProjectId).toBe('p-b');
        expect(st.role).toBe('client');
        expect(st.toast).toBe('You no longer have access to Alpha.');
        expect(globalThis.sessionStorage.getItem('vitan.session.v1')).toContain(tokB);
        expect(hits('GET', '/me/memberships')).toBe(1);
        expect(hits('POST', '/auth/switch')).toBe(1);
        // the switch was asked with the lost project's own token, for the project read back
        const sw = calls.find((c) => c.path === '/auth/switch');
        expect(sw?.auth).toBe(`Bearer ${tokA}`);
      });
    }

    it(`${how} session, re-roled on the same project: switched back into it, in the new role`, async () => {
      const { useStore } = await signedIn(how);
      stubFetch(server({ status: 403, body: ROLE_CHANGED }, [{ ...ALPHA, role: 'engineer' }, BETA], switchTo('p-a')));
      useStore.getState().retryProjectLoad();
      await vi.waitFor(() => expect(useStore.getState().sessionToken).toBe(tokA2));
      const st = useStore.getState();
      expect(st.activeProjectId).toBe('p-a');
      expect(st.role).toBe('engineer');
      expect(st.toast).toBe('Your role on Alpha changed.');
      expect(st.projectLoadState).toBe('loading'); // the new role's snapshot is fetched; nothing of the old role shows
    });

    it(`${how} session, no project left: signed out, with the sign-in screen's own "access removed" words`, async () => {
      const { useStore } = await signedIn(how);
      stubFetch(server({ status: 403, body: REMOVED }, []));
      useStore.getState().retryProjectLoad();
      await vi.waitFor(() => expect(useStore.getState().sessionToken).toBeNull());
      const st = useStore.getState();
      expect(st.access.errorKey).toMatchObject({ key: 'accessRemoved' });
      expect(st.access.error).toBeTruthy();
      expect(globalThis.sessionStorage.getItem('vitan.session.v1')).toBeNull();
      expect(hits('POST', '/auth/switch')).toBe(0);
    });
  }

  it('on a command (runRemote): the server\'s words, then the move', async () => {
    const { useStore } = await signedIn('fresh');
    stubFetch(server({ status: 403, body: REMOVED }, [BETA], switchTo('p-b')));
    const toasts: string[] = [];
    const stop = useStore.subscribe((st, was) => { if (st.toast && st.toast !== was.toast) toasts.push(st.toast); });
    useStore.getState().deleteNode('n-1');
    await vi.waitFor(() => expect(useStore.getState().activeProjectId).toBe('p-b'));
    stop();
    // a refusal, in the server's words (never "could not reach the server"), then the move's own line
    expect(toasts.some((t) => t.includes('Project access has been removed'))).toBe(true);
    expect(toasts.some((t) => /reach the server/i.test(t))).toBe(false);
    expect(useStore.getState().toast).toBe('You no longer have access to Alpha.');
    expect(hits('DELETE', '/projects/p-a/nodes/n-1')).toBe(1);
    expect(hits('POST', '/auth/switch')).toBe(1);
  });

  it('on a queued act (the flush): the act is kept, never dropped, and the move says it is kept on this device', async () => {
    const { useStore } = await signedIn('fresh');
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    // the memberships read waits until the flush has settled, so the flush's own keep is what is counted
    stubFetch(server({ status: 403, body: REMOVED }, [BETA], switchTo('p-b')));
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/me/memberships')) await held;
      return (realFetch as typeof fetch)(url, init);
    }));
    const op = { t: 'approve', decisionId: 'DEC-1', optionIndex: 0, idempotencyKey: 'k-approve-1' };
    useStore.setState({ outbox: [op] as never, syncQueue: ['Approve DEC-1'] });
    const flushed = useStore.getState().flushOutbox();
    const result = await flushed;
    expect(result.droppedKeys).toEqual([]);
    expect(result.pendingKeys).toEqual(['k-approve-1']);
    expect(useStore.getState().outbox).toHaveLength(1);
    release();
    await vi.waitFor(() => expect(useStore.getState().activeProjectId).toBe('p-b'));
    expect(useStore.getState().toast).toBe('You no longer have access to Alpha. 1 change for Alpha is kept on this device and will be sent if your access returns.');
  });

  it('an act stored on this device stays in the lost project\'s key, and is sent once, under its own key, when access returns', async () => {
    const { useStore, gw } = await signedIn('fresh');
    let access = false;
    const approves: Array<{ auth: string | null; key: string | null }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace('http://api.test', '');
      const method = (init?.method ?? 'GET').toUpperCase();
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ method, path, auth: headers.Authorization ?? null });
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (method === 'POST' && path === '/projects/p-a/decisions/DEC-1/approve') {
        approves.push({ auth: headers.Authorization ?? null, key: headers['Idempotency-Key'] ?? null });
        return access ? json(201, ALPHA_SNAPSHOT) : json(403, REMOVED);
      }
      if (method === 'GET' && path === '/me/memberships') return json(200, access ? [ALPHA, BETA] : [BETA]);
      if (method === 'POST' && path === '/auth/switch') {
        const to = (JSON.parse(String(init?.body)) as { projectId: string }).projectId;
        if (to === 'p-b') return json(201, { token: tokB, role: 'client', projectId: 'p-b', name: 'Pat' });
        if (to === 'p-a' && access) return json(201, { token: tokA2, role: 'engineer', projectId: 'p-a', name: 'Pat' });
        return json(403, { message: 'Not a member of this project', error: 'Forbidden', statusCode: 403 });
      }
      return json(599, { message: `unrouted ${method} ${path}` });
    }));
    // made offline, the way the app queues it: written to this device before anything is sent
    useStore.setState({ online: false, modal: { type: 'approve', decId: 'DEC-1', optIdx: 0 } as never });
    useStore.getState().confirmApprove();
    await vi.waitFor(() => expect(globalThis.localStorage.getItem('vitan.outbox.u-1.p-a')).toContain('DEC-1'));
    const key = (useStore.getState().outbox[0] as { idempotencyKey: string }).idempotencyKey;
    useStore.setState({ online: true });
    await useStore.getState().flushOutbox();
    await vi.waitFor(() => expect(useStore.getState().activeProjectId).toBe('p-b'));
    expect(useStore.getState().toast).toBe('You no longer have access to Alpha. 1 change for Alpha is kept on this device and will be sent if your access returns.');
    // the move leaves it where it was stored: the lost project's own key, under this person
    expect(globalThis.localStorage.getItem('vitan.outbox.u-1.p-a')).toContain(key);
    expect(approves).toHaveLength(1);
    // access returns; they open Alpha again on this device, with a new token, and the flush sends it once
    access = true;
    await useStore.getState().switchProject('p-a');
    await vi.waitFor(() => expect(useStore.getState().sessionToken).toBe(tokA2));
    // what useApiSync does on the new session: the gateway carries its token, and the scope's queue is loaded
    gw.setToken(tokA2);
    useStore.getState().hydrateOutbox();
    expect(useStore.getState().outbox).toHaveLength(1);
    await useStore.getState().flushOutbox();
    await vi.waitFor(() => expect(useStore.getState().outbox).toHaveLength(0));
    expect(approves).toHaveLength(2);
    expect(approves[1]).toEqual({ auth: `Bearer ${tokA2}`, key });
    expect(globalThis.localStorage.getItem('vitan.outbox.u-1.p-a') ?? '').not.toContain(key);
  });

  it('an act no write could store on this device is not counted as kept', async () => {
    const { useStore } = await signedIn('fresh');
    stubFetch(server({ status: 403, body: REMOVED }, [BETA], switchTo('p-b')));
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    onTestFinished(() => setItem.mockRestore());
    useStore.setState({ online: false, modal: { type: 'approve', decId: 'DEC-1', optIdx: 0 } as never });
    useStore.getState().confirmApprove();
    await vi.waitFor(() => expect(useStore.getState().toast).toMatch(/Not saved on this phone yet/));
    expect(useStore.getState().outbox).toHaveLength(1);
    useStore.setState({ online: true });
    await useStore.getState().flushOutbox();
    await vi.waitFor(() => expect(useStore.getState().activeProjectId).toBe('p-b'));
    expect(useStore.getState().toast).toBe('You no longer have access to Alpha.');
  });

  it('no project left: the sign-in screen says how many changes this device keeps for the lost project', async () => {
    const { useStore } = await signedIn('fresh');
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace('http://api.test', '');
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ method, path, auth: null });
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      if (method === 'POST' && path.startsWith('/projects/p-a/decisions/')) return json(403, REMOVED);
      if (method === 'GET' && path === '/me/memberships') return json(200, []);
      return json(599, { message: `unrouted ${method} ${path}` });
    }));
    useStore.setState({ online: false });
    for (const decId of ['DEC-1', 'DEC-2']) {
      useStore.setState({ modal: { type: 'approve', decId, optIdx: 0 } as never });
      useStore.getState().confirmApprove();
    }
    await vi.waitFor(() => expect(globalThis.localStorage.getItem('vitan.outbox.u-1.p-a')).toContain('DEC-2'));
    const stored = globalThis.localStorage.getItem('vitan.outbox.u-1.p-a');
    useStore.setState({ online: true });
    await useStore.getState().flushOutbox();
    await vi.waitFor(() => expect(useStore.getState().sessionToken).toBeNull());
    const st = useStore.getState();
    expect(st.access.errorKey).toMatchObject({ key: 'accessRemoved' });
    expect(st.toast).toBe('2 changes for Alpha are kept on this device and will be sent if your access returns.');
    expect(globalThis.localStorage.getItem('vitan.outbox.u-1.p-a')).toBe(stored);
    expect(st.outbox).toEqual([]);
  });

  it('many refusals in flight move the person once', async () => {
    const { useStore, gw } = await signedIn('restored');
    stubFetch(server({ status: 403, body: REMOVED }, [BETA], switchTo('p-b')));
    await Promise.all([gw.snapshot(), gw.decisions(), gw.deleteNode('n-1'), gw.dailyLog()].map((p) => p.catch(() => undefined)));
    await vi.waitFor(() => expect(useStore.getState().sessionToken).toBe(tokB));
    expect(hits('GET', '/me/memberships')).toBe(1);
    expect(hits('POST', '/auth/switch')).toBe(1);
  });

  it('a memberships read that fails leaves the person where they are, and the next refusal reads again', async () => {
    const { useStore, gw } = await signedIn('fresh');
    let listed: Answer = { status: 503, body: {} };
    stubFetch(server({ status: 403, body: REMOVED }, [BETA], (m, p, b) => (m === 'GET' && p === '/me/memberships' ? listed : switchTo('p-b')(m, p, b))));
    await gw.snapshot().catch(() => undefined);
    await vi.waitFor(() => expect(hits('GET', '/me/memberships')).toBe(1));
    expect(useStore.getState().sessionToken).toBe(tokA);
    expect(hits('POST', '/auth/switch')).toBe(0);
    listed = { status: 200, body: [BETA] };
    // each later refusal reads again once the failed read has let go of the move: refused until it does
    await vi.waitFor(async () => {
      await gw.snapshot().catch(() => undefined);
      expect(useStore.getState().sessionToken).toBe(tokB);
    });
    expect(hits('GET', '/me/memberships')).toBeGreaterThanOrEqual(2);
    expect(hits('POST', '/auth/switch')).toBe(1);
  });

  it('a move that fails leaves the person where they are, and the next refusal tries again', async () => {
    const { useStore, gw } = await signedIn('fresh');
    let switchAnswer: Answer = { status: 503, body: {} };
    stubFetch(server({ status: 403, body: REMOVED }, [BETA], (m, p) => (m === 'POST' && p === '/auth/switch' ? switchAnswer : undefined)));
    await gw.snapshot().catch(() => undefined);
    await vi.waitFor(() => expect(hits('POST', '/auth/switch')).toBe(1));
    await vi.waitFor(() => expect(useStore.getState().projectLoadState).toBe('error'));
    expect(useStore.getState().sessionToken).toBe(tokA);
    switchAnswer = { status: 201, body: { token: tokB, role: 'client', projectId: 'p-b', name: 'Pat' } };
    await gw.snapshot().catch(() => undefined);
    await vi.waitFor(() => expect(useStore.getState().sessionToken).toBe(tokB));
    expect(hits('POST', '/auth/switch')).toBe(2);
  });
});

describe('#1373 the move never overrides what the person did meanwhile (Stage 1 G1, G2)', () => {
  it('P1: the person signs out while the move\'s switch is out; its late reply does not sign them back in', async () => {
    const { useStore, gw } = await signedIn('fresh');
    const sw = held();
    stubFetch(server({ status: 403, body: REMOVED }, [BETA], (m, p) => (m === 'POST' && p === '/auth/switch' ? sw.reply() : undefined)));
    // the store's own handler is attached to this promise first, so it has run once the test's await of it returns
    const switches = vi.spyOn(gw, 'switchProject');
    await gw.snapshot().catch(() => undefined);
    await sw.asked;
    useStore.getState().signOut();
    expect(useStore.getState().sessionToken).toBeNull();
    sw.release({ status: 201, body: { token: tokB, role: 'client', projectId: 'p-b', name: 'Pat' } });
    await switches.mock.results[0]?.value;
    expect(useStore.getState().sessionToken).toBeNull();
    expect(useStore.getState().activeProjectId).not.toBe('p-b');
    expect(globalThis.sessionStorage.getItem('vitan.session.v1')).toBeNull();
  });

  it('P2: the person picks another project while the move is out; the move\'s late reply does not take them elsewhere', async () => {
    const { useStore, gw } = await signedIn('fresh');
    useStore.setState({ memberships: [ALPHA, BETA, GAMMA] as never });
    const toBeta = held();
    const switches = vi.spyOn(gw, 'switchProject');
    stubFetch(server({ status: 403, body: REMOVED }, [BETA, GAMMA], (m, p, b) => {
      if (m !== 'POST' || p !== '/auth/switch') return undefined;
      return (JSON.parse(b) as { projectId: string }).projectId === 'p-b'
        ? toBeta.reply()
        : { status: 201, body: { token: tokC, role: 'client', projectId: 'p-c', name: 'Pat' } };
    }));
    await gw.snapshot().catch(() => undefined);
    await toBeta.asked;
    // the person's own pick, while the move to Beta is still out
    expect(await useStore.getState().switchProject('p-c')).toBe(true);
    expect(useStore.getState().activeProjectId).toBe('p-c');
    toBeta.release({ status: 201, body: { token: tokB, role: 'client', projectId: 'p-b', name: 'Pat' } });
    // the move's switch was the first asked; the store has judged its reply once this await returns
    expect(switches.mock.calls[0]?.[0]).toBe('p-b');
    await switches.mock.results[0]?.value;
    expect(useStore.getState().activeProjectId).toBe('p-c');
    expect(useStore.getState().sessionToken).toBe(tokC);
  });

  it('a refusal arriving after the person\'s own switch has started leaves that switch to decide', async () => {
    const { useStore, gw } = await signedIn('fresh');
    const toBeta = held();
    stubFetch(server({ status: 403, body: REMOVED }, [GAMMA], (m, p) => (m === 'POST' && p === '/auth/switch' ? toBeta.reply() : undefined)));
    const picked = useStore.getState().switchProject('p-b');
    await toBeta.asked;
    await gw.snapshot().catch(() => undefined);
    toBeta.release({ status: 201, body: { token: tokB, role: 'client', projectId: 'p-b', name: 'Pat' } });
    expect(await picked).toBe(true);
    expect(useStore.getState().activeProjectId).toBe('p-b');
    expect(hits('GET', '/me/memberships')).toBe(0);
    expect(hits('POST', '/auth/switch')).toBe(1);
  });

  it('the person\'s own switch starting while the move reads their projects: the move stands aside', async () => {
    const { useStore, gw } = await signedIn('fresh');
    const listed = held();
    const toGamma = held();
    stubFetch(server({ status: 403, body: REMOVED }, [], (m, p) => (
      m === 'GET' && p === '/me/memberships' ? listed.reply() : m === 'POST' && p === '/auth/switch' ? toGamma.reply() : undefined
    )));
    useStore.setState({ memberships: [ALPHA, BETA, GAMMA] as never });
    await gw.snapshot().catch(() => undefined);
    await listed.asked;
    const picked = useStore.getState().switchProject('p-c');
    await toGamma.asked;
    const reads = vi.spyOn(gw, 'switchProject');
    listed.release({ status: 200, body: [BETA, GAMMA] });
    toGamma.release({ status: 201, body: { token: tokC, role: 'client', projectId: 'p-c', name: 'Pat' } });
    expect(await picked).toBe(true);
    expect(useStore.getState().activeProjectId).toBe('p-c');
    // the move asked for no switch of its own
    expect(reads).not.toHaveBeenCalled();
    expect(hits('POST', '/auth/switch')).toBe(1);
  });

  it('a 401 on the move\'s own switch signs out, and nothing is adopted', async () => {
    const { useStore, gw } = await signedIn('fresh');
    stubFetch(server({ status: 403, body: REMOVED }, [BETA], (m, p) => (m === 'POST' && p === '/auth/switch' ? { status: 401, body: { message: 'Session expired', statusCode: 401 } } : undefined)));
    await gw.snapshot().catch(() => undefined);
    await vi.waitFor(() => expect(useStore.getState().sessionToken).toBeNull());
    expect(useStore.getState().activeProjectId).not.toBe('p-b');
    expect(hits('POST', '/auth/switch')).toBe(1);
  });

  it('the project moved to is picked by name, then id, whatever order the server lists them in', async () => {
    const ZETA = { projectId: 'p-0', name: 'Zeta', short: 'ZET', role: 'client', orgId: null, orgName: null };
    const AARDVARK = { projectId: 'p-c', name: 'Aardvark', short: 'AAR', role: 'client', orgId: null, orgName: null };
    const { useStore, gw } = await signedIn('fresh');
    stubFetch(server({ status: 403, body: REMOVED }, [ZETA, BETA, AARDVARK], (m, p, b) => (
      m === 'POST' && p === '/auth/switch'
        ? { status: 201, body: { token: jwt({ sub: 'u-1', role: 'client', projectId: (JSON.parse(b) as { projectId: string }).projectId, exp }), role: 'client', projectId: (JSON.parse(b) as { projectId: string }).projectId, name: 'Pat' } }
        : undefined
    )));
    await gw.snapshot().catch(() => undefined);
    await vi.waitFor(() => expect(useStore.getState().activeProjectId).toBe('p-c'));
    const asked = calls.find((c) => c.path === '/auth/switch');
    expect(asked).toBeTruthy();
  });

  it('another tab\'s stored acts for the lost project are left as they are', async () => {
    const { useStore, gw } = await signedIn('fresh');
    const stored = 'another tab\'s bytes';
    globalThis.localStorage.setItem('vitan.outbox.u-1.p-a', stored);
    globalThis.localStorage.setItem('vitan.siteVisitQueue.u-1.p-a', stored);
    stubFetch(server({ status: 403, body: REMOVED }, [BETA], switchTo('p-b')));
    await gw.snapshot().catch(() => undefined);
    await vi.waitFor(() => expect(useStore.getState().activeProjectId).toBe('p-b'));
    expect(globalThis.localStorage.getItem('vitan.outbox.u-1.p-a')).toBe(stored);
    expect(globalThis.localStorage.getItem('vitan.siteVisitQueue.u-1.p-a')).toBe(stored);
  });
});

describe('#1373 a direct command takes a coded 403 as the final refusal it is (Stage 1 G4)', () => {
  it('a drawing issue refused for a lost project is not sent again', async () => {
    const { useStore, gw } = await signedIn('fresh');
    stubFetch(server({ status: 403, body: REMOVED }, [BETA], (m, p) => (
      m === 'POST' && p === '/projects/p-a/drawings/prepare' ? { status: 201, body: {} } : switchTo('p-b')(m, p, '{"projectId":"p-b"}')
    )));
    const submit = vi.spyOn(gw, 'submitIssue');
    vi.spyOn(gw, 'prepareIssue').mockImplementation(async (i) => ({ ...i, contentSha256: 'digest' }) as never);
    useStore.getState().issueDrawing({ number: 'A-9', title: 'New', discipline: 'architectural', rev: 'A', mime: 'application/pdf', data: 'x', publish: true } as never);
    await vi.waitFor(() => expect(useStore.getState().activeProjectId).toBe('p-b'));
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

describe('#1373 a 401 on a token-bearing request signs out, once', () => {
  it('on a command, on a read and on a queued act alike; many in flight sign out once', async () => {
    const { useStore, gw } = await signedIn('fresh');
    // a push-capable browser: the teardown waits (bounded) for the push unlink, so the session is still held while the
    // other refusals land, and only the once-per-token guard keeps them from signing out again
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: new Promise(() => {}) } });
    Object.defineProperty(window, 'PushManager', { configurable: true, value: function PushManager() {} });
    onTestFinished(() => {
      delete (navigator as { serviceWorker?: unknown }).serviceWorker;
      delete (window as { PushManager?: unknown }).PushManager;
    });
    // every sign-out the rule asks for is counted as it is asked: the signal, never a wait
    let signOuts = 0;
    const realSignOut = useStore.getState().signOut;
    useStore.setState({ signOut: () => { signOuts += 1; realSignOut(); } });
    stubFetch(() => ({ status: 401, body: { message: 'Session expired', statusCode: 401 } }));
    useStore.setState({ outbox: [{ t: 'approve', decisionId: 'DEC-1', optionIndex: 0, idempotencyKey: 'k-1' }] as never, syncQueue: ['Approve DEC-1'] });
    const flushed = useStore.getState().flushOutbox();
    await Promise.all([gw.snapshot(), gw.listMemberships(), gw.deleteNode('n-1'), gw.decisions()].map((p) => p.catch(() => undefined)));
    await flushed;
    // all refused while the first sign-out still holds the session (its push unlink waits): one sign-out
    expect(useStore.getState().sessionToken).toBe(tokA);
    expect(signOuts).toBe(1);
    await vi.waitFor(() => expect(useStore.getState().sessionToken).toBeNull(), { timeout: 4000 });
    expect(signOuts).toBe(1);
    expect(globalThis.sessionStorage.getItem('vitan.session.v1')).toBeNull();
    expect(hits('POST', '/auth/switch')).toBe(0);
  });

  it('a late refusal of a token the session no longer holds does nothing', async () => {
    const { useStore, ApiGateway } = await signedIn('fresh');
    // the person switched meanwhile: the store holds Beta's token; a gateway still carrying Alpha's is refused
    useStore.setState({ sessionToken: tokB, activeProjectId: 'p-b' });
    const old = new ApiGateway('http://api.test', 'p-a');
    old.setToken(tokA);
    useStore.getState()._setGateway(old);
    stubFetch((_m, p) => (p === '/projects/p-a/snapshot' ? { status: 401, body: {} } : { status: 403, body: REMOVED }));
    await old.snapshot().catch(() => undefined);
    await old.deleteNode('n-1').catch(() => undefined);
    // the hook answers before each refusal is thrown, so by now anything it would start has started
    expect(useStore.getState().sessionToken).toBe(tokB);
    expect(hits('GET', '/me/memberships')).toBe(0);
    expect(hits('POST', '/auth/switch')).toBe(0);
  });

  it('a token-less sign-in that is refused (401) is a sign-in error only', async () => {
    const { useStore, ApiGateway } = await freshStore();
    const gw = new ApiGateway('http://api.test', 'p-a');
    useStore.getState()._setGateway(gw);
    stubFetch(() => ({ status: 401, body: { message: 'Invalid credentials', statusCode: 401 } }));
    const generation = useStore.getState().access.generation;
    useStore.getState().login('pmc@example.com', 'wrong');
    await vi.waitFor(() => expect(useStore.getState().access.errorKey).toMatchObject({ key: 'wrongPassword' }));
    expect(useStore.getState().access.generation).toBe(generation);
    expect(calls.map((c) => c.path)).toEqual(['/auth/login']);
  });
});

describe('#1373 any other refusal is the act\'s own, as before', () => {
  it('an uncoded 403 on a command: the server\'s words, still signed in on the project, and the project is read again', async () => {
    const { useStore } = await signedIn('restored');
    stubFetch((_m, p) => (p === '/projects/p-a/nodes/n-1' ? { status: 403, body: PER_ACTION } : p === '/projects/p-a/snapshot' ? { status: 503, body: {} } : undefined));
    useStore.getState().deleteNode('n-1');
    await vi.waitFor(() => expect(hits('GET', '/projects/p-a/snapshot')).toBe(1));
    const st = useStore.getState();
    expect(st.toast).toContain(PER_ACTION.message);
    expect(st.sessionToken).toBe(tokA);
    expect(st.activeProjectId).toBe('p-a');
    expect(hits('GET', '/me/memberships')).toBe(0);
  });

  it('an uncoded 403 on a queued act drops it, as before', async () => {
    const { useStore } = await signedIn('fresh');
    stubFetch((m, p) => (m === 'POST' && p.startsWith('/projects/p-a/decisions/') ? { status: 403, body: PER_ACTION } : { status: 503, body: {} }));
    useStore.setState({ outbox: [{ t: 'approve', decisionId: 'DEC-1', optionIndex: 0, idempotencyKey: 'k-2' }] as never, syncQueue: ['Approve DEC-1'] });
    const result = await useStore.getState().flushOutbox();
    expect(result.droppedKeys).toEqual(['k-2']);
    expect(useStore.getState().sessionToken).toBe(tokA);
  });

  it('a server from before the codes: an uncoded 403 on the snapshot signs a restored session out and keeps a fresh one, exactly as before', async () => {
    const before = { message: 'Project access has been removed', error: 'Forbidden', statusCode: 403 };
    const restored = await signedIn('restored');
    stubFetch((_m, p) => (p.startsWith('/projects/p-a/') ? { status: 403, body: before } : undefined));
    restored.useStore.getState().retryProjectLoad();
    await vi.waitFor(() => expect(restored.useStore.getState().sessionToken).toBeNull());
    expect(restored.useStore.getState().access.errorKey ?? null).toBeNull(); // today's sign-out: no words added
    expect(hits('GET', '/me/memberships')).toBe(0);

    const fresh = await signedIn('fresh');
    stubFetch((_m, p) => (p.startsWith('/projects/p-a/') ? { status: 403, body: before } : undefined));
    fresh.useStore.getState().retryProjectLoad();
    await vi.waitFor(() => expect(fresh.useStore.getState().projectLoadState).toBe('error'));
    expect(fresh.useStore.getState().sessionToken).toBe(tokA);
    expect(hits('GET', '/me/memberships')).toBe(0);
    expect(hits('POST', '/auth/switch')).toBe(0);
  });
});

describe('#1373 the lost-project lines exist in every language, with the same placeholders (Stage 1 G7)', () => {
  it('each QW entry has en, hi and gu, none empty, each with the same {placeholders}', async () => {
    const { QW } = await import('@/lib/queueWords');
    const marks = (t: string) => [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    for (const key of ['roleChanged', 'accessLost', 'keptForLost', 'keptForLostOne'] as const) expect(QW).toHaveProperty(key);
    for (const [key, w] of Object.entries(QW) as Array<[string, Record<string, string>]>) {
      expect(Object.keys(w).sort(), key).toEqual(['en', 'gu', 'hi']);
      for (const lang of ['hi', 'gu']) {
        expect(w[lang].trim().length, `${key}.${lang}`).toBeGreaterThan(0);
        expect(marks(w[lang]), `${key}.${lang}`).toBe(marks(w.en));
      }
    }
  });

  it('a lost project\'s line is said in the person\'s language', async () => {
    const { useStore, gw } = await signedIn('fresh');
    useStore.setState({ lang: 'gu' });
    stubFetch(server({ status: 403, body: REMOVED }, [BETA], switchTo('p-b')));
    await gw.snapshot().catch(() => undefined);
    await vi.waitFor(() => expect(useStore.getState().activeProjectId).toBe('p-b'));
    expect(useStore.getState().toast).toBe('હવે તમારી પાસે Alphaનો પ્રવેશ નથી.');
  });
});
