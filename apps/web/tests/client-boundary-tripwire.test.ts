import { describe, it, expect, afterEach, vi } from 'vitest';
import gatewaySource from '@/data/apiGateway.ts?raw';
import { ApiGateway, DECISIONS_CONTRACT, DECISIONS_CONTRACT_HEADER } from '@/data/apiGateway';

/**
 * Phase 6 task 4d-ii-b / B1 (§A.2, "Browser tabs cannot be drained, so they stand behind a CLIENT CONTRACT
 * boundary") — the web gateway declares `x-vitan-decisions-contract: countersign-v1` on EVERY request that
 * reaches the API: the shared `req()` helper AND the direct `fetch('/auth/session')` in `connect()`. The
 * plan asks for a client-boundary tripwire that "enumerates every `fetch(` site in the gateway and asserts
 * the header on each API-bound one": a new `fetch(` added without the declaration would be served as a
 * lesser client — every 4d shape stripped, an architect session refused 409 — and nothing else would say so.
 *
 * Two halves: the SOURCE enumeration (every `fetch(` site in `apiGateway.ts` is either API-bound and
 * declares the contract, or is on the explicit exemption list — the presigned object-storage PUT, which
 * never reaches the API), and the BEHAVIOUR (the header, with the exact server value, is on the wire for
 * `connect()`, a public auth call and an authenticated call). P29c's web arm.
 */

/** Every `fetch(` site in the gateway source, with enough of the call to classify it. */
function fetchSites(): { index: number; line: number; call: string }[] {
  const sites: { index: number; line: number; call: string }[] = [];
  const re = /\bfetch\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(gatewaySource)) !== null) {
    // a `fetch(` NAMED in a comment is not a site: skip lines that are comment text
    const lineStart = gatewaySource.lastIndexOf('\n', m.index) + 1;
    const lineText = gatewaySource.slice(lineStart, m.index).trimStart();
    if (lineText.startsWith('//') || lineText.startsWith('*') || lineText.startsWith('/*')) continue;
    // the call text: from `fetch(` to the matching close paren (nesting-aware, template literals included)
    let depth = 0; let i = m.index + 'fetch'.length; let end = i;
    for (; i < gatewaySource.length; i += 1) {
      const ch = gatewaySource[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
    }
    sites.push({ index: m.index, line: gatewaySource.slice(0, m.index).split('\n').length, call: gatewaySource.slice(m.index, end) });
  }
  return sites;
}

/** The ONE site that is not API-bound: the presigned PUT straight to object storage (never reaches the API). */
const EXEMPT = [/fetch\(presigned\.uploadUrl,/];
const API_BOUND = /fetch\(`\$\{this\.base\}/;

describe('B1 — the client-boundary tripwire: every API-bound fetch( declares countersign-v1', () => {
  it('the contract constants are the server’s exact values', () => {
    // `declaredDecisionsContract` on the server counts ONLY the exact value; anything else non-empty
    // ranks as the 4b `recorded-v1`, so a typo here would silently demote every tab to a lesser client.
    expect(DECISIONS_CONTRACT).toBe('countersign-v1');
    expect(DECISIONS_CONTRACT_HEADER.toLowerCase()).toBe('x-vitan-decisions-contract');
  });

  it('enumerates every fetch( site: each is API-bound and declares the contract, or is the one exempt PUT', () => {
    const sites = fetchSites();
    // a NEW site fails here until it is classified — declared (API-bound) or added to EXEMPT with a reason
    expect(sites.length).toBe(3);
    const exempt = sites.filter((s) => EXEMPT.some((re) => re.test(s.call)));
    const apiBound = sites.filter((s) => API_BOUND.test(s.call));
    expect(exempt.length).toBe(1);
    expect(apiBound.length).toBe(2); // `req()` and `connect()`
    expect(exempt.length + apiBound.length).toBe(sites.length); // nothing unclassified
    for (const s of apiBound) {
      expect(s.call, `fetch( at line ${s.line} is API-bound but does not declare the contract`).toMatch(/\[DECISIONS_CONTRACT_HEADER\]: DECISIONS_CONTRACT/);
    }
    for (const s of exempt) {
      expect(s.call, `the presigned PUT at line ${s.line} must NOT carry the API contract header`).not.toMatch(/DECISIONS_CONTRACT/);
    }
  });

  it('the 4b literal is gone: nothing in the gateway still declares recorded-v1', () => {
    // the literal may be NAMED in a comment (history), never USED as a header value
    expect(gatewaySource).not.toMatch(/['"]recorded-v1['"]/);
  });
});

describe('B1 — the declaration is on the wire', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  /** capture every request the gateway makes: url + lower-cased headers */
  function captureFetch(reply: unknown = { token: 'h.e30.s' }) {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
      calls.push({ url, headers });
      return { ok: true, status: 200, json: async () => reply };
    }) as never);
    return calls;
  }

  it('connect() — the ONE token-minting call outside req() — declares countersign-v1', async () => {
    const calls = captureFetch({ token: 'h.e30.s' });
    const gw = new ApiGateway('http://api.test', 'ambli');
    await gw.connect('engineer');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://api.test/auth/session');
    expect(calls[0].headers['x-vitan-decisions-contract']).toBe('countersign-v1');
  });

  it('a public auth call and an authenticated project call both declare it (through req())', async () => {
    const calls = captureFetch({ token: 'h.e30.s', role: 'pmc', projectId: 'ambli' });
    const gw = new ApiGateway('http://api.test', 'ambli');
    await gw.login('test-pmc@vitan.in', 'x');
    gw.setToken('h.e30.s');
    await gw.shell();
    expect(calls.map((c) => c.url)).toEqual(['http://api.test/auth/login', 'http://api.test/projects/ambli/shell']);
    for (const c of calls) expect(c.headers['x-vitan-decisions-contract']).toBe('countersign-v1');
    expect(calls[1].headers.authorization).toBe('Bearer h.e30.s'); // the declaration rides beside the token, not instead of it
  });
});
