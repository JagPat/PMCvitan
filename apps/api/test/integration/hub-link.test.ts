import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { DrawingsQueryService } from '../../src/drawings/drawings.query';
import { SnapshotService } from '../../src/snapshot/snapshot.service';

/**
 * #1118 U7a L1b — a company owner/admin links a project to its Hub project, against the real app, live PostgreSQL and a
 * stub Hub on loopback (notes/hub/u7a/plan.md §4): closed and other-company routes are 404; a member who is not an
 * owner or admin is 403 before Hub hears of anything; a link is written in Hub and then in PMC with Hub's number and
 * name; a repeat changes nothing in PMC; one Hub project goes to one PMC project of the company, also under
 * concurrency, and another company's links count for nothing here; Hub's failures map to codes and write nothing; an
 * unlink ends PMC's link even when Hub's removal fails, and a retry clears the Hub link that unlink ended (even after a
 * relink elsewhere), unless a project of the company holds that Hub project by then; and a Hub delivery sent while a
 * first link is still talking to Hub waits for the link and judges what it committed.
 *
 * The stub's token is random per run, never a real Hub token. Each linked project is this file's own, in the fixture's
 * company A; link events name the fixture's owner through a NO ACTION key, so `afterAll` deletes these projects (their
 * link and history go with them) before the fixture's cleanup removes the owner.
 *
 * Isolated automated-test fixtures only.
 */

type HubLinkRow = { externalId: string; url: string | null; label: string | null };
type Fault = number | 'drop';

/** A stub Hub `/api/v2`: the projects it lists, the `pmc` link per Hub project, and faults to answer with, in turn. */
function stubHub(token: string) {
  const projects = [
    { id: 12, number: '24-017', name: 'Vitan Farm', archived: false },
    { id: 13, number: '24-018', name: 'Old site', archived: true },
    { id: 14, number: '24-019', name: 'Riverside', archived: false },
    { id: 15, number: '24-020', name: 'Hill house', archived: false },
    { id: 16, number: '24-021', name: 'Lake view', archived: false },
    { id: 17, number: '24-022', name: 'Orchard', archived: false },
  ];
  const links = new Map<string, HubLinkRow>();
  const faults: Array<{ when: (method: string, path: string) => boolean; fault: Fault }> = [];
  const calls: string[] = [];
  // run as a DELETE or a link POST arrives, before Hub answers it
  const hooks: { onDelete: null | (() => Promise<void>); onPost: null | (() => Promise<void>) } = { onDelete: null, onPost: null };
  const answer = (res: ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const method = req.method ?? 'GET';
      const path = (req.url ?? '').split('?')[0]!;
      calls.push(`${method} ${path}`);
      const i = faults.findIndex((f) => f.when(method, path));
      if (i >= 0) {
        const [{ fault }] = faults.splice(i, 1);
        if (fault === 'drop') return void req.socket.destroy();
        return answer(res, fault, { error: 'stub fault', token });
      }
      if (req.headers.authorization !== `Bearer ${token}`) return answer(res, 401, { error: 'bad token' });
      if (method === 'GET' && path === '/api/v2/projects') return answer(res, 200, { projects });
      const m = /^\/api\/v2\/projects\/(\d+)\/links(\/pmc)?$/.exec(path);
      if (!m || !projects.some((p) => String(p.id) === m[1])) return answer(res, 404, { error: 'no such project' });
      const id = m[1]!;
      if (method === 'GET' && !m[2]) {
        const l = links.get(id);
        return answer(res, 200, { links: l ? [{ app: 'pmc', ...l }] : [] });
      }
      if (method === 'POST' && m[2]) {
        await hooks.onPost?.();
        const form = new URLSearchParams(raw);
        links.set(id, { externalId: form.get('externalId') ?? '', url: form.get('url'), label: form.get('label') });
        return answer(res, 200, { app: 'pmc' });
      }
      if (method === 'DELETE' && m[2]) {
        await hooks.onDelete?.();
        if (!links.has(id)) return answer(res, 400, { error: "That project isn't linked to that app." });
        links.delete(id);
        return answer(res, 204);
      }
      answer(res, 405);
    });
  });
  return { server, links, faults, calls, hooks };
}

describe('#1118 U7a L1 — Hub project link (live PG + stub Hub)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let hub: ReturnType<typeof stubHub>;
  let hubUrl = '';
  const run = randomUUID().slice(0, 8);
  const token = `office-${randomUUID()}`;
  const made: string[] = [];

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    hub = stubHub(token);
    await new Promise<void>((resolve) => hub.server.listen(0, '127.0.0.1', resolve));
    hubUrl = `http://127.0.0.1:${(hub.server.address() as AddressInfo).port}`;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    hub.faults.length = 0;
    hub.hooks.onDelete = null;
    hub.hooks.onPost = null;
  });

  afterAll(async () => {
    try {
      if (t) for (const id of made) await t.prisma.$executeRawUnsafe(`DELETE FROM "Project" WHERE "id" = $1`, id);
    } finally {
      await f?.cleanup();
      await t?.close();
      await new Promise((resolve) => hub?.server.close(resolve));
    }
  });

  /** Hub connected, for company A: the four client variables only (no webhook secret: the receiver stays closed). */
  const open = (orgId = f.orgA.id) => {
    vi.stubEnv('HUB_BASE_URL', hubUrl);
    vi.stubEnv('HUB_OFFICE_TOKEN', token);
    vi.stubEnv('HUB_ORG_ID', orgId);
    vi.stubEnv('HUB_OFFICE_ID', '7');
    vi.stubEnv('HUB_WEBHOOK_SECRET', '');
  };
  const project = async (tag: string, orgId = f.orgA.id, siteCode = 'VFP-01') => {
    const id = `it-hublink-${tag}-${run}`;
    await t.prisma.project.create({ data: {
      id, orgId, name: `Site ${tag}`, short: 'Hub', descriptor: '', stage: 'x', siteCode, projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0,
    } });
    made.push(id);
    return id;
  };
  const owner = () => `Bearer ${t.issueOrgOwnerToken(f.ownerUser.id, f.projectA.id, f.orgA.id)}`;
  const server = () => t.app.getHttpServer();
  const list = (pid: string, auth = owner(), orgId = f.orgA.id) => request(server()).get(`/orgs/${orgId}/projects/${pid}/hub/projects`).set('Authorization', auth);
  const link = (pid: string, hubProjectId: string, opts: { auth?: string; orgId?: string; key?: string } = {}) => {
    const r = request(server()).post(`/orgs/${opts.orgId ?? f.orgA.id}/projects/${pid}/hub/link`).set('Authorization', opts.auth ?? owner());
    if (opts.key) r.set('Idempotency-Key', opts.key);
    return r.send({ hubProjectId });
  };
  const unlink = (pid: string, opts: { auth?: string; key?: string } = {}) => {
    const r = request(server()).post(`/orgs/${f.orgA.id}/projects/${pid}/hub/unlink`).set('Authorization', opts.auth ?? owner());
    if (opts.key) r.set('Idempotency-Key', opts.key);
    return r.send({});
  };
  /** A link and its event 1 written straight to PMC's link tables (the schema refuses a link without its first event). */
  const seedLink = (projectId: string, hubProjectId: string, orgId: string) =>
    t.prisma.$transaction(async (tx) => {
      await tx.drawingHubLink.create({ data: { projectId, orgId } });
      await tx.drawingHubLinkEvent.create({ data: { projectId, seq: 1, prevSeq: null, kind: 'linked', hubProjectId, byUserId: f.ownerUser.id } });
    });
  const events = (projectId: string) => t.prisma.drawingHubLinkEvent.findMany({ where: { projectId }, orderBy: { seq: 'asc' } });
  const callsSince = (n: number) => hub.calls.slice(n);

  it('is 404 while Hub is not connected, and for another company', async () => {
    const p = await project('closed');
    expect((await list(p)).status).toBe(404);
    expect((await link(p, '12')).status).toBe(404);
    expect((await unlink(p)).status).toBe(404);
    // the receiver's secret alone opens nothing here
    vi.stubEnv('HUB_WEBHOOK_SECRET', 'whsec_' + Buffer.alloc(32, 1).toString('base64'));
    expect((await list(p)).status).toBe(404);
    open(f.orgB.id);
    expect((await list(p)).status).toBe(404);
    expect((await link(p, '12')).status).toBe(404);
    expect(hub.calls).toEqual([]);
  });

  it('refuses a member who is not a company owner or admin (403), and a project of another company (404), before Hub hears of it', async () => {
    open();
    const p = await project('authz');
    const member = `Bearer ${t.issueProjectToken(f.memberUser.id, f.projectA.id, 'pmc')}`;
    expect((await list(p, member)).status).toBe(403);
    expect((await link(p, '12', { auth: member })).status).toBe(403);
    expect((await unlink(p, { auth: member })).status).toBe(403);
    expect((await list(f.projectB.id)).status).toBe(404);
    expect((await link(f.projectB.id, '12')).status).toBe(404);
    expect((await link(`it-hublink-nothere-${run}`, '12')).status).toBe(404);
    expect((await link(p, '0012')).status).toBe(400);
    expect((await link(p, '12/links')).status).toBe(400);
    expect(hub.calls).toEqual([]);
    expect(await events(p)).toEqual([]);
  });

  it('lists the live Hub projects; links in Hub, then in PMC with the number and name; a repeat adds no event', async () => {
    open();
    const p = await project('main', f.orgA.id, 'VFP-01');
    const listed = await list(p);
    expect(listed.status).toBe(200);
    expect(listed.body.projects.map((x: { id: string }) => x.id)).not.toContain('13');
    expect(listed.body.projects.find((x: { id: string }) => x.id === '12')).toEqual({ id: '12', number: '24-017', name: 'Vitan Farm', linked: null });

    const r = await link(p, '12', { key: `k-main-${run}` });
    expect(r.status).toBe(200);
    expect(r.body.link).toMatchObject({ hubProjectId: '12', number: '24-017', name: 'Vitan Farm' });
    expect(hub.links.get('12')).toEqual({ externalId: p, url: null, label: 'VFP-01' });
    const ev = await events(p);
    expect(ev.map((e) => [e.seq, e.prevSeq, e.kind, e.hubProjectId, e.hubProjectNumber, e.hubProjectName, e.byUserId])).toEqual([
      [1, null, 'linked', '12', '24-017', 'Vitan Farm', f.ownerUser.id],
    ]);
    const audit = await t.prisma.auditLog.findMany({ where: { projectId: p, action: 'drawing.hub_linked' } });
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(token);

    // the same key replays: Hub is not called again
    const before = hub.calls.length;
    expect((await link(p, '12', { key: `k-main-${run}` })).status).toBe(200);
    expect(callsSince(before)).toEqual([]);
    // a new request for the same Hub project writes Hub's link again (a repair) and adds no PMC event
    hub.links.delete('12');
    expect((await link(p, '12')).status).toBe(200);
    expect(hub.links.get('12')?.externalId).toBe(p);
    expect(await events(p)).toHaveLength(1);

    const marked = await list(p);
    expect(marked.body.projects.find((x: { id: string }) => x.id === '12').linked).toBe('this');

    // the snapshot's project line reads PMC only, with Hub's address for "Open in Hub"
    const view = await t.app.get(DrawingsQueryService).hubLink(p);
    expect(view).toMatchObject({ hubProjectId: '12', number: '24-017', name: 'Vitan Farm', openUrl: hubUrl });
    const snap = await t.app.get(SnapshotService).build(p, 'pmc', f.ownerUser.id);
    expect(snap.project.hubLink).toEqual(view);
    vi.unstubAllEnvs();
    expect((await t.app.get(DrawingsQueryService).hubLink(p))?.openUrl).toBeNull();
    // Hub connected for another company: this company's link does not point at it
    open(f.orgB.id);
    expect((await t.app.get(DrawingsQueryService).hubLink(p))?.openUrl).toBeNull();
    vi.unstubAllEnvs();
    open();

    // linked elsewhere: unlink first; another PMC project may not take Hub project 12
    const other = await project('other');
    const n = hub.calls.length;
    const elsewhere = await link(p, '14');
    expect(elsewhere.status).toBe(409);
    expect(elsewhere.body.code).toBe('hub_linked_elsewhere');
    const taken = await link(other, '12');
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('hub_project_taken');
    expect(callsSince(n)).toEqual([]);
    expect((await list(other)).body.projects.find((x: { id: string }) => x.id === '12').linked).toBe('other');
    // archived or out of the token's reach in Hub: refused, nothing linked
    for (const id of ['13', '99']) {
      const gone = await link(other, id);
      expect(gone.status).toBe(400);
      expect(gone.body.code).toBe('hub_project_unavailable');
    }
    expect(await events(other)).toEqual([]);
    // an unlinked project's snapshot has no Hub key at all (the previous release's shape)
    expect('hubLink' in (await t.app.get(SnapshotService).build(other, 'pmc', f.ownerUser.id)).project).toBe(false);
  });

  it('maps Hub failures to codes and writes nothing in PMC', async () => {
    open();
    const p = await project('faults');
    const cases: Array<[Fault, (m: string, path: string) => boolean, number, string]> = [
      [503, (m, path) => m === 'GET' && path === '/api/v2/projects', 503, 'hub_unavailable'],
      ['drop', (m, path) => m === 'GET' && path === '/api/v2/projects', 503, 'hub_unavailable'],
      [401, (m, path) => m === 'POST', 503, 'hub_key_refused'],
      [403, (m, path) => m === 'POST', 503, 'hub_key_refused'],
      [404, (m, path) => m === 'POST', 502, 'hub_refused'],
    ];
    for (const [fault, when, status, code] of cases) {
      hub.faults.push({ when, fault });
      const r = await link(p, '15');
      expect([r.status, r.body.code]).toEqual([status, code]);
      expect(JSON.stringify(r.body)).not.toContain(token);
      expect(JSON.stringify(r.body)).not.toContain('stub fault');
      expect(JSON.stringify(r.body)).not.toContain('127.0.0.1');
    }
    expect(await events(p)).toEqual([]);
    expect(await t.prisma.drawingHubLink.findUnique({ where: { projectId: p } })).toBeNull();
    // a failed list answers the same codes
    hub.faults.push({ when: (m, path) => path === '/api/v2/projects', fault: 401 });
    const refused = await list(p);
    expect([refused.status, refused.body.code]).toEqual([503, 'hub_key_refused']);
  });

  it('unlinks: PMC ends the link even when Hub fails, and a retry clears Hub without a second event', async () => {
    open();
    const p = await project('unlink');
    expect((await unlink(p)).status).toBe(409);
    expect((await link(p, '14')).status).toBe(200);

    hub.faults.push({ when: (m) => m === 'DELETE', fault: 500 });
    const failed = await unlink(p);
    expect([failed.status, failed.body]).toEqual([200, { hubCleared: false }]);
    expect((await events(p)).map((e) => [e.seq, e.kind, e.hubProjectId])).toEqual([[1, 'linked', '14'], [2, 'unlinked', null]]);
    expect(await t.app.get(DrawingsQueryService).hubLink(p)).toBeNull();
    expect(hub.links.get('14')?.externalId).toBe(p);

    const retried = await unlink(p);
    expect([retried.status, retried.body]).toEqual([200, { hubCleared: true }]);
    expect(hub.links.has('14')).toBe(false);
    expect(await events(p)).toHaveLength(2);
    // Hub already clear: its 400 is read as done
    expect((await unlink(p)).body).toEqual({ hubCleared: true });
    const audit = await t.prisma.auditLog.findMany({ where: { projectId: p, action: 'drawing.hub_unlinked' } });
    expect(audit.map((a) => a.payload)).toEqual([{ hubProjectId: '14' }]);

    // linked again later: the next event links, the chain goes on
    expect((await link(p, '14')).status).toBe(200);
    expect((await events(p)).map((e) => [e.seq, e.prevSeq, e.kind])).toEqual([[1, null, 'linked'], [2, 1, 'unlinked'], [3, 2, 'linked']]);
    expect((await unlink(p)).body).toEqual({ hubCleared: true });
  });

  it('a retried unlink leaves Hub alone once another PMC project holds that Hub project', async () => {
    open();
    const first = await project('first');
    const second = await project('second');
    expect((await link(first, '16')).status).toBe(200);
    hub.faults.push({ when: (m) => m === 'DELETE', fault: 503 });
    expect((await unlink(first)).body).toEqual({ hubCleared: false });
    expect((await link(second, '16')).status).toBe(200);
    expect(hub.links.get('16')?.externalId).toBe(second);
    const n = hub.calls.length;
    expect((await unlink(first)).body).toEqual({ hubCleared: true });
    expect(callsSince(n)).toEqual([]);
    expect(hub.links.get('16')?.externalId).toBe(second);
    expect((await unlink(second)).body).toEqual({ hubCleared: true });
  });

  it("removes Hub's link only after PMC's unlink has committed", async () => {
    open();
    const p = await project('commit-first');
    expect((await link(p, '15')).status).toBe(200);
    const seen: string[][] = [];
    hub.hooks.onDelete = async () => {
      // another connection: it sees only what has committed
      seen.push((await events(p)).map((e) => e.kind));
    };
    expect((await unlink(p)).body).toEqual({ hubCleared: true });
    expect(seen).toEqual([['linked', 'unlinked']]);
    expect(hub.links.has('15')).toBe(false);
  });

  it('two projects racing for one Hub project: exactly one links, and Hub names that one', async () => {
    open();
    const a = await project('race-a');
    const b = await project('race-b');
    const [ra, rb] = await Promise.all([link(a, '15'), link(b, '15')]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    const winner = ra.status === 200 ? a : b;
    const loser = winner === a ? b : a;
    expect(hub.links.get('15')?.externalId).toBe(winner);
    expect(await events(winner)).toHaveLength(1);
    expect(await events(loser)).toEqual([]);
    expect((await unlink(winner)).body).toEqual({ hubCleared: true });
  });

  it('a committed keyed link or unlink replays, with its answer, after Hub is disconnected', async () => {
    open();
    const p = await project('replay');
    expect((await link(p, '14', { key: `k-rl-${run}` })).status).toBe(200);
    hub.faults.push({ when: (m) => m === 'DELETE', fault: 500 });
    expect((await unlink(p, { key: `k-ru-${run}` })).body).toEqual({ hubCleared: false });
    vi.unstubAllEnvs();
    const n = hub.calls.length;
    const relink = await link(p, '14', { key: `k-rl-${run}` });
    expect(relink.status).toBe(200);
    // the answer is the link that command committed, though the project has been unlinked since
    expect(relink.body.link).toMatchObject({ hubProjectId: '14', number: '24-019', name: 'Riverside' });
    expect((await unlink(p, { key: `k-ru-${run}` })).body).toEqual({ hubCleared: false });
    // unkeyed, or a new key: closed again
    expect((await unlink(p, { key: `k-ru2-${run}` })).status).toBe(404);
    expect(callsSince(n)).toEqual([]);
    open();
    expect((await unlink(p)).body).toEqual({ hubCleared: true });
  });

  it('takes its locks before Hub hears of anything: an archive in flight is waited for, and then nothing reaches Hub', async () => {
    open();
    const p = await project('archive');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const held = new Promise<void>((resolve) => (locked = resolve));
    const archiving = t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE "Project" SET "archivedAt" = now() WHERE "id" = $1`, p);
      locked();
      await gate;
    }, { timeout: 60_000 });
    await held;
    const n = hub.calls.length;
    const pending = link(p, '15').then((r) => r);
    // wait until the link is blocked on the project row (a lock wait, not a clock)
    for (;;) {
      const [row] = await t.prisma.$queryRawUnsafe<Array<{ waiting: bigint }>>(
        `SELECT count(*) AS waiting FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%FOR NO KEY UPDATE%'`);
      if (Number(row!.waiting) > 0) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(callsSince(n)).toEqual([]);
    release();
    await archiving;
    const r = await pending;
    expect(r.status).toBe(404);
    expect(callsSince(n)).toEqual([]);
    expect(hub.links.has('15')).toBe(false);
    expect(await events(p)).toEqual([]);
  });

  it("counts only this company's links: another company's site on the same Hub id neither marks, refuses nor keeps anything", async () => {
    open();
    const elsewhere = await project('elsewhere', f.orgB.id);
    await seedLink(elsewhere, '17', f.orgB.id);
    const p = await project('scoped');
    expect((await list(p)).body.projects.find((x: { id: string }) => x.id === '17').linked).toBeNull();
    const r = await link(p, '17');
    expect(r.status).toBe(200);
    expect(hub.links.get('17')?.externalId).toBe(p);
    expect((await list(p)).body.projects.find((x: { id: string }) => x.id === '17').linked).toBe('this');
    expect((await unlink(p)).body).toEqual({ hubCleared: true });
    expect(hub.links.has('17')).toBe(false);
  });

  it('a retried unlink clears the Hub link it ended, though the project was linked to another Hub project since', async () => {
    open();
    const p = await project('relink');
    expect((await link(p, '14')).status).toBe(200);
    hub.faults.push({ when: (m) => m === 'DELETE', fault: 503 });
    expect((await unlink(p, { key: `k-relink-${run}` })).body).toEqual({ hubCleared: false });
    expect(hub.links.get('14')?.externalId).toBe(p);
    // linked to another Hub project before the unlink's Hub clear went through
    expect((await link(p, '15')).status).toBe(200);
    // the same unlink, retried: it removes the Hub link it ended (14), and leaves the new one (15)
    expect((await unlink(p, { key: `k-relink-${run}` })).body).toEqual({ hubCleared: true });
    expect(hub.links.has('14')).toBe(false);
    expect(hub.links.get('15')?.externalId).toBe(p);
    expect((await events(p)).map((e) => [e.seq, e.kind, e.hubProjectId])).toEqual([[1, 'linked', '14'], [2, 'unlinked', null], [3, 'linked', '15']]);
    expect((await unlink(p)).body).toEqual({ hubCleared: true });
    expect(hub.links.has('15')).toBe(false);
  });

  it("a Hub delivery sent while a first link is talking to Hub waits for it, and judges the committed link", async () => {
    open();
    const key = randomBytes(32);
    vi.stubEnv('HUB_WEBHOOK_SECRET', `whsec_${key.toString('base64')}`);
    const p = await project('webhook');
    const deliver = () => {
      const body = Buffer.from(JSON.stringify({
        type: 'drawing.issued',
        timestamp: '2026-11-05T10:00:00Z',
        data: {
          fileId: 'f-1', fileNo: 'A-101', toStage: 'CONSTRUCTION', versionId: 'v-1',
          project: { id: 16, links: [{ app: 'pmc', externalId: p, url: 'https://pms.test' }] },
        },
      }));
      const id = `evt_${randomUUID().replace(/-/g, '')}`;
      const ts = Math.floor(Date.now() / 1000);
      const sig = `v1,${createHmac('sha256', key).update(`${id}.${ts}.`).update(body).digest('base64')}`;
      return request(server()).post(`/integrations/hub/${f.orgA.id}/events`).set('Content-Type', 'application/json')
        .set('webhook-id', id).set('webhook-timestamp', String(ts)).set('webhook-signature', sig).send(body.toString('utf8'));
    };
    let delivery!: Promise<request.Response>;
    hub.hooks.onPost = async () => {
      hub.hooks.onPost = null;
      let answered = false;
      delivery = deliver().then((r) => { answered = true; return r; });
      // Hub answers the link only once the delivery has an answer, or waits on a lock (a lock wait, not a clock)
      for (;;) {
        if (answered) break;
        const [row] = await t.prisma.$queryRawUnsafe<Array<{ waiting: bigint }>>(
          `SELECT count(*) AS waiting FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND wait_event = 'advisory'`);
        if (Number(row!.waiting) > 0) break;
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
    expect((await link(p, '16')).status).toBe(200);
    // judged after the link committed: resolved through it (503 until U5 applies it), never refused as not linked (204)
    expect((await delivery).status).toBe(503);
    expect(await t.prisma.hubWebhookReceipt.count({ where: { orgId: f.orgA.id, eventType: 'drawing.issued', hubVersionId: 'v-1' } })).toBe(0);
    expect((await unlink(p)).body).toEqual({ hubCleared: true });
  });
});
