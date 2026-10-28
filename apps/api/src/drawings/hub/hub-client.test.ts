import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { fetchHubContent, hubContentPath, sniffDrawingType, HUB_CONTENT_MAX_BYTES } from './hub-client';
import type { HubConfig } from './hub-config';

/**
 * #1118 U4 — the Hub content fetch against a stub Hub on a loopback port (never a real Hub). Each test sets what the
 * stub answers; the stub records every request it gets, so a refusal can be shown to have sent nothing.
 */
type Handler = (req: IncomingMessage, res: ServerResponse) => void;
const listen = async (handler: { current: Handler }, requests: IncomingMessage[]) => {
  const server = createServer((req, res) => { requests.push(req); handler.current(req, res); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
};
const close = (server: Server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });

describe('#1118 U4 — fetching a version from Hub', () => {
  const hub: { current: Handler } = { current: (_req, res) => res.end() };
  const elsewhere: { current: Handler } = { current: (_req, res) => res.end() };
  const hubRequests: IncomingMessage[] = [];
  const elsewhereRequests: IncomingMessage[] = [];
  let hubServer: Server;
  let elsewhereServer: Server;
  let config: HubConfig;
  let foreignOrigin = '';
  const token = `hub_${randomBytes(16).toString('hex')}`;

  beforeAll(async () => {
    const a = await listen(hub, hubRequests);
    const b = await listen(elsewhere, elsewhereRequests);
    hubServer = a.server;
    elsewhereServer = b.server;
    foreignOrigin = b.origin;
    config = { baseUrl: a.origin, officeToken: token, webhookSecrets: [randomBytes(32)], orgId: 'org-hub' };
  });
  afterAll(async () => {
    await close(hubServer);
    await close(elsewhereServer);
  });
  afterEach(() => {
    hubRequests.length = 0;
    elsewhereRequests.length = 0;
    vi.unstubAllEnvs();
  });

  const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(2048)]);
  const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const ref = (fileId = 'f-17', versionId = 'v-9031') => ({ fileId, versionId, contentPath: hubContentPath(fileId, versionId) });
  /** Hub's own answer: octet-stream, the hash, the bytes */
  const serve = (bytes: Buffer, headers: Record<string, string> = {}): Handler => (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-Sha256': sha(bytes), ...headers });
    res.end(bytes);
  };

  it('fetches the one path it builds, with the office token, and reads the type from the bytes', async () => {
    hub.current = serve(pdf);
    const got = await fetchHubContent(ref(), { config });
    expect(got).toEqual({ ok: true, bytes: pdf, mime: 'application/pdf', sha256: sha(pdf) });
    expect(hubRequests.map((r) => [r.method, r.url, r.headers.authorization])).toEqual([['GET', '/api/v2/drawings/f-17/content?versionId=v-9031', `Bearer ${token}`]]);
  });

  it('refuses an event whose contentPath is not the path it builds, or ids that need encoding, and sends nothing', async () => {
    hub.current = serve(pdf);
    for (const bad of [
      { fileId: 'f-17', versionId: 'v-9031', contentPath: '/api/v2/drawings/f-17/content?versionId=v-9032' },
      { fileId: 'f-17', versionId: 'v-9031', contentPath: 'https://evil.test/api/v2/drawings/f-17/content?versionId=v-9031' },
      { fileId: 'f-17', versionId: 'v-9031', contentPath: null },
      { fileId: 'f-17', versionId: 'v-9031', contentPath: '/api/v2/drawings/f-17/content?versionId=v-9031&x=1' },
      { fileId: '../me', versionId: 'v-9031', contentPath: '/api/v2/drawings/../me/content?versionId=v-9031' },
      { fileId: 'f 17', versionId: 'v-9031', contentPath: '/api/v2/drawings/f 17/content?versionId=v-9031' },
      { fileId: 'f-17', versionId: 'v&x=1', contentPath: '/api/v2/drawings/f-17/content?versionId=v&x=1' },
      { fileId: 'x'.repeat(257), versionId: 'v-9031', contentPath: `/api/v2/drawings/${'x'.repeat(257)}/content?versionId=v-9031` },
    ]) {
      expect(await fetchHubContent(bad, { config }), JSON.stringify(bad).slice(0, 80)).toEqual({ ok: false, failure: 'bad_reference', retryable: false });
    }
    expect(hubRequests).toEqual([]);
  });

  it('is closed without every HUB_* and sends nothing', async () => {
    for (const name of ['HUB_BASE_URL', 'HUB_OFFICE_TOKEN', 'HUB_WEBHOOK_SECRET', 'HUB_ORG_ID']) vi.stubEnv(name, '');
    expect(await fetchHubContent(ref())).toEqual({ ok: false, failure: 'closed', retryable: false });
    expect(hubRequests).toEqual([]);
  });

  it('follows a redirect only within Hub\'s origin, and never sends the token anywhere else', async () => {
    hub.current = (req, res) => {
      if (req.url!.startsWith('/api/')) { res.writeHead(302, { Location: '/files/v-9031' }); res.end(); return; }
      serve(pdf)(req, res);
    };
    expect(await fetchHubContent(ref(), { config })).toMatchObject({ ok: true, mime: 'application/pdf' });
    expect(hubRequests.map((r) => [r.url, r.headers.authorization])).toEqual([
      ['/api/v2/drawings/f-17/content?versionId=v-9031', `Bearer ${token}`], ['/files/v-9031', `Bearer ${token}`],
    ]);

    elsewhere.current = serve(pdf);
    const port = new URL(config.baseUrl).port;
    // another port on the same host is another origin, and so is the other scheme on the same host and port
    for (const location of [`${foreignOrigin}/files/v-9031`, `//127.0.0.2:${port}/x`, 'https://127.0.0.1/x', `https://127.0.0.1:${port}/x`, 'http://[::1', '']) {
      hubRequests.length = 0;
      hub.current = (_req, res) => { res.writeHead(307, location ? { Location: location } : {}); res.end(); };
      expect(await fetchHubContent(ref(), { config }), location).toEqual({ ok: false, failure: 'redirect_refused', retryable: false });
      expect(hubRequests, location).toHaveLength(1);
    }
    expect(elsewhereRequests).toEqual([]);

    // a refused redirect's body is cancelled, not left open on the connection
    const closed = new Promise<void>((resolve) => {
      hub.current = (_req, res) => {
        res.on('close', () => resolve());
        res.writeHead(302, { Location: `${foreignOrigin}/x` });
        res.write('a body that never ends');
      };
    });
    expect(await fetchHubContent(ref(), { config })).toEqual({ ok: false, failure: 'redirect_refused', retryable: false });
    await closed;

    // a loop is cut after three hops
    hubRequests.length = 0;
    hub.current = (_req, res) => { res.writeHead(302, { Location: '/again' }); res.end(); };
    expect(await fetchHubContent(ref(), { config })).toEqual({ ok: false, failure: 'redirect_refused', retryable: false });
    expect(hubRequests).toHaveLength(4);
  });

  it('reads at most the cap: a declared length over it is refused unread, and a chunked body as it passes the cap', async () => {
    const maxBytes = 4096;
    const at = Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(maxBytes - 9)]);
    hub.current = serve(at);
    expect(await fetchHubContent(ref(), { config, maxBytes })).toMatchObject({ ok: true, bytes: at });

    const over = Buffer.concat([at, Buffer.from('x')]);
    hub.current = serve(over); // Content-Length: 4097
    expect(await fetchHubContent(ref(), { config, maxBytes })).toEqual({ ok: false, failure: 'too_large', retryable: false });
    // refused on the declared length alone: this body never comes, so reading it would end in the timeout instead
    hub.current = (_req, res) => { res.writeHead(200, { 'Content-Length': String(maxBytes + 1), 'X-Sha256': sha(over) }); res.write('%PDF-'); };
    expect(await fetchHubContent(ref(), { config, maxBytes, timeoutMs: 5_000 })).toEqual({ ok: false, failure: 'too_large', retryable: false });

    // no length: sent in pieces, the last one taking it over the cap
    hub.current = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-Sha256': sha(over) });
      res.write(over.subarray(0, 2048));
      res.write(over.subarray(2048));
      res.end();
    };
    expect(await fetchHubContent(ref(), { config, maxBytes })).toEqual({ ok: false, failure: 'too_large', retryable: false });

    // the read is cancelled the moment it passes the cap, so Hub sees the transfer end
    const closed = new Promise<void>((resolve) => {
      hub.current = (_req, res) => {
        res.on('close', () => resolve());
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-Sha256': sha(over) });
        res.write(over);
      };
    });
    expect(await fetchHubContent(ref(), { config, maxBytes })).toEqual({ ok: false, failure: 'too_large', retryable: false });
    await closed;
  });

  it('accepts a version of exactly 25 MiB, declared as such', async () => {
    expect(HUB_CONTENT_MAX_BYTES).toBe(25 * 1024 * 1024);
    const exact = Buffer.alloc(HUB_CONTENT_MAX_BYTES, 0x20);
    exact.write('%PDF-1.7\n');
    hub.current = serve(exact, { 'Content-Length': String(exact.length) });
    const got = await fetchHubContent(ref(), { config });
    expect(got).toMatchObject({ ok: true, mime: 'application/pdf', sha256: sha(exact) });
    expect(got.ok && got.bytes.length).toBe(HUB_CONTENT_MAX_BYTES);
  });

  it('keeps only bytes that hash to X-Sha256: none, malformed or another hash is refused (retryable)', async () => {
    for (const headers of [{ 'X-Sha256': '' }, { 'X-Sha256': 'zz'.repeat(32) }, { 'X-Sha256': sha(Buffer.from('other')) }]) {
      hub.current = serve(pdf, headers);
      expect(await fetchHubContent(ref(), { config }), JSON.stringify(headers)).toEqual({ ok: false, failure: 'hash_mismatch', retryable: true });
    }
    // Hub's hex in upper case is the same hash
    hub.current = serve(pdf, { 'X-Sha256': sha(pdf).toUpperCase() });
    expect(await fetchHubContent(ref(), { config })).toMatchObject({ ok: true });
  });

  it('stores only a drawing type, read from the bytes whatever type Hub names', async () => {
    const html = Buffer.from('<!doctype html><script>alert(1)</script>');
    hub.current = serve(html, { 'Content-Type': 'application/pdf' });
    expect(await fetchHubContent(ref(), { config })).toEqual({ ok: false, failure: 'unsupported_type', retryable: false });
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(64)]);
    hub.current = serve(png, { 'Content-Type': 'text/html' });
    expect(await fetchHubContent(ref(), { config })).toMatchObject({ ok: true, mime: 'image/png' });
  });

  it('answers a status other than 200 with its code: a 5xx or 429 is retryable, a 404 is not', async () => {
    for (const [status, retryable] of [[404, false], [403, false], [500, true], [503, true], [429, true], [204, false]] as const) {
      hub.current = (_req, res) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(status === 204 ? undefined : '{"error":"x"}'); };
      expect(await fetchHubContent(ref(), { config }), String(status)).toEqual({ ok: false, failure: 'http_status', status, retryable });
    }
  });

  it('gives up on a body that stalls (timeout) and on a Hub it can\'t reach, both retryable', async () => {
    hub.current = (_req, res) => { res.writeHead(200, { 'X-Sha256': sha(pdf) }); res.write(pdf.subarray(0, 100)); };
    expect(await fetchHubContent(ref(), { config, timeoutMs: 300 })).toEqual({ ok: false, failure: 'timeout', retryable: true });

    // a port nothing listens on: bind one, then close it
    const spare = await listen({ current: (_req, res) => res.end() }, []);
    await close(spare.server);
    expect(await fetchHubContent(ref(), { config: { ...config, baseUrl: spare.origin } })).toEqual({ ok: false, failure: 'unreachable', retryable: true });

    // a body cut off mid-transfer
    hub.current = (req, res) => { res.writeHead(200, { 'X-Sha256': sha(pdf), 'Content-Length': String(pdf.length) }); res.write(pdf.subarray(0, 100), () => req.socket.destroy()); };
    expect(await fetchHubContent(ref(), { config })).toEqual({ ok: false, failure: 'unreachable', retryable: true });
  });

  it('puts no token, URL, header or body in what it returns', async () => {
    const results = [];
    hub.current = (_req, res) => { res.writeHead(302, { Location: `${foreignOrigin}/${token}` }); res.end(); };
    results.push(await fetchHubContent(ref(), { config }));
    hub.current = (_req, res) => { res.writeHead(500, { 'X-Detail': token }); res.end(token); };
    results.push(await fetchHubContent(ref(), { config }));
    const text = JSON.stringify(results);
    expect(text).not.toContain(token);
    expect(text).not.toContain('127.0.0.1');
  });

  it('reads each drawing type from its first bytes', () => {
    const cases: Array<[string | Buffer, string | null]> = [
      ['%PDF-1.4\n', 'application/pdf'],
      ['AC1032\0\0\0', 'image/vnd.dwg'],
      ['AC1015', 'image/vnd.dwg'],
      ['AC1012', 'image/vnd.dwg'],
      ['AC1009', null],
      ['AC1006', null],
      ['  0\nSECTION\n  2\nHEADER\n', 'image/vnd.dxf'],
      ['999\r\nmade by Hub\r\n  0\r\nSECTION\r\n', 'image/vnd.dxf'],
      [Buffer.from('AutoCAD Binary DXF\r\n\x1a\x00rest', 'latin1'), 'image/vnd.dxf'],
      [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), 'image/png'],
      [Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg'],
      ['', null],
      [' %PDF-1.4', null],
      ['AC1.50', null],
      ['0\nSECTIONS\n', null],
      ['<html>', null],
      [Buffer.from([0xff, 0xd8]), null],
      [Buffer.from([0xff, 0xd8, 0x00, 0xe0]), null],
      ['GIF89a', null],
    ];
    for (const [head, type] of cases) {
      expect(sniffDrawingType(Buffer.isBuffer(head) ? head : Buffer.from(head, 'latin1')), String(head)).toBe(type);
    }
  });
});
