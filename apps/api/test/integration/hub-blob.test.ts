import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { HubBlobService } from '../../src/drawings/hub/hub-blob.service';
import { hubContentPath } from '../../src/drawings/hub/hub-client';
import { StorageService } from '../../src/media/storage.service';

/**
 * #1118 U4 — fetching a Hub version into storage, against live PostgreSQL and a stub Hub on a loopback port (never a
 * real Hub). A refused fetch writes no ledger row and stores nothing; a good one commits its ledger row before the
 * upload starts, under a key in the Hub namespace, stored as the type read from the bytes; and an upload that fails
 * leaves its ledger row for the sweep.
 *
 * Storage is the app's own `StorageService`, its `put` watched: it reads the ledger from its own connection, so it sees
 * only what has committed.
 *
 * Isolated automated-test fixtures only.
 */
describe('#1118 U4 — a Hub version fetched into storage (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let blobs: HubBlobService;
  let storage: StorageService;
  let server: Server;
  let origin = '';
  const run = randomUUID().slice(0, 8);
  const made: string[] = [];
  const requests: IncomingMessage[] = [];
  const hub: { current: (req: IncomingMessage, res: ServerResponse) => void } = { current: (_req, res) => res.end() };

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    blobs = t.app.get(HubBlobService);
    storage = t.app.get(StorageService);
    server = createServer((req, res) => { requests.push(req); hub.current(req, res); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => {
    requests.length = 0;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
    if (!t) return;
    try {
      // each project takes its ledger rows with it (ON DELETE CASCADE)
      for (const id of made) await t.prisma.$executeRawUnsafe(`DELETE FROM "Project" WHERE "id" = $1`, id);
    } finally {
      await f?.cleanup();
      await t.close();
    }
  });

  const open = () => {
    vi.stubEnv('HUB_BASE_URL', origin);
    vi.stubEnv('HUB_OFFICE_TOKEN', `hub_${randomBytes(16).toString('hex')}`);
    vi.stubEnv('HUB_WEBHOOK_SECRET', `whsec_${randomBytes(32).toString('base64')}`);
    vi.stubEnv('HUB_ORG_ID', f.orgA.id);
  };
  const project = async (tag: string) => {
    const id = `it-hubf-${tag}-${run}`;
    await t.prisma.project.create({ data: {
      id, orgId: f.orgA.id, name: id, short: 'Hub', descriptor: '', stage: 'x', siteCode: 'HUB', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0,
    } });
    made.push(id);
    return id;
  };
  const ref = (versionId = 'v-9031', fileId = 'f-17') => ({ fileId, versionId, contentPath: hubContentPath(fileId, versionId) });
  const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  const serve = (bytes: Buffer, headers: Record<string, string> = {}) => (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-Sha256': sha(bytes), ...headers });
    res.end(bytes);
  };
  const ledger = (projectId: string) => t.prisma.hubFetchedBlob.findMany({ where: { projectId }, select: { storageKey: true, hubVersionId: true } });
  /** watches `put`: what it was given, and whether the ledger row for its key had committed when it was called */
  const watchPut = (then: () => Promise<{ url: string | null }> = async () => ({ url: null })) => {
    const calls: Array<{ key: string; mime: string; size: number; ledgered: boolean }> = [];
    vi.spyOn(storage, 'put').mockImplementation(async (key, bytes, mime) => {
      const committed = await t.prisma.hubFetchedBlob.findUnique({ where: { storageKey: key }, select: { id: true } });
      calls.push({ key, mime, size: bytes.length, ledgered: committed !== null });
      return then();
    });
    return calls;
  };

  it('commits the ledger row before the upload, under a Hub key, and stores the type read from the bytes', async () => {
    open();
    const p = await project('ok');
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(4096)]);
    hub.current = serve(pdf);
    const calls = watchPut();
    const got = await blobs.fetchIntoStorage(p, ref());
    expect(got).toMatchObject({ ok: true, url: null, mime: 'application/pdf', sizeBytes: pdf.length, sha256: sha(pdf) });
    if (!got.ok) throw new Error('unreachable');
    expect(got.bytes.equals(pdf)).toBe(true);
    expect(got.storageKey).toMatch(new RegExp(`^${p}/hub/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.pdf$`));
    expect(calls).toEqual([{ key: got.storageKey, mime: 'application/pdf', size: pdf.length, ledgered: true }]);
    expect(await ledger(p)).toEqual([{ storageKey: got.storageKey, hubVersionId: 'v-9031' }]);
  });

  it('writes nothing for a refused fetch: wrong path, foreign redirect, too large, bad hash, not a drawing, a 5xx', async () => {
    open();
    const p = await project('refused');
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(512)]);
    const calls = watchPut();
    const cases: Array<[string, () => Promise<unknown>, string]> = [
      ['wrong path', () => blobs.fetchIntoStorage(p, { ...ref(), contentPath: '/api/v2/drawings/f-17/content?versionId=v-1' }), 'bad_reference'],
      ['foreign redirect', async () => { hub.current = (_req, res) => { res.writeHead(302, { Location: 'https://elsewhere.test/x' }); res.end(); }; return blobs.fetchIntoStorage(p, ref()); }, 'redirect_refused'],
      ['too large', async () => { hub.current = serve(pdf); return blobs.fetchIntoStorage(p, ref(), { maxBytes: 100 }); }, 'too_large'],
      ['bad hash', async () => { hub.current = serve(pdf, { 'X-Sha256': sha(Buffer.from('x')) }); return blobs.fetchIntoStorage(p, ref()); }, 'hash_mismatch'],
      ['not a drawing', async () => { hub.current = serve(Buffer.from('<html>')); return blobs.fetchIntoStorage(p, ref()); }, 'unsupported_type'],
      ['a 5xx', async () => { hub.current = (_req, res) => { res.writeHead(503); res.end(); }; return blobs.fetchIntoStorage(p, ref()); }, 'http_status'],
    ];
    for (const [what, attempt, failure] of cases) {
      expect(await attempt(), what).toMatchObject({ ok: false, failure });
    }
    expect(calls).toEqual([]);
    expect(await ledger(p)).toEqual([]);
  });

  it('leaves the ledger row when the upload fails, for the sweep, and throws so the delivery is retried', async () => {
    open();
    const p = await project('putfail');
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(256)]);
    hub.current = serve(png);
    const calls = watchPut(async () => { throw new Error('storage down'); });
    await expect(blobs.fetchIntoStorage(p, ref('v-2'))).rejects.toThrow('storage down');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ mime: 'image/png', ledgered: true });
    expect(await ledger(p)).toEqual([{ storageKey: calls[0]!.key, hubVersionId: 'v-2' }]);
    expect(calls[0]!.key).toMatch(/\.png$/);
  });

  it('stores nothing when the ledger row can\'t be written (no such project), and throws', async () => {
    open();
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(64)]);
    hub.current = serve(pdf);
    const calls = watchPut();
    await expect(blobs.fetchIntoStorage(`it-hubf-gone-${run}`, ref())).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
