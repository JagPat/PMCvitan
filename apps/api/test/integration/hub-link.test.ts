import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { DrawingsQueryService } from '../../src/drawings/drawings.query';
import { SnapshotService } from '../../src/snapshot/snapshot.service';

/**
 * #1118 U7a L1a — the read side of a project's Hub link, against the real app, live PostgreSQL and a stub Hub on
 * loopback (notes/hub/u7a/plan.md §4): the list route is 404 while Hub is not connected or for another company, 403
 * for a member who is not an owner or admin (before Hub hears of it), and lists Hub's live projects marked by PMC's
 * own link events; Hub's failures map to codes that carry none of Hub's words; the snapshot's project line carries the
 * active link, with "Open in Hub" only while Hub is connected for the link's company.
 *
 * L1a has no link command, so the links here are written straight to PMC's link tables (a link and its event 1 in one
 * transaction, as the schema requires). The stub's token is random per run, never a real Hub token. Each project is
 * this file's own, in the fixture's company A; link events name the fixture's owner through a NO ACTION key, so
 * `afterAll` deletes these projects (their link and history go with them) before the fixture's cleanup removes the
 * owner.
 *
 * Isolated automated-test fixtures only.
 */

type Fault = number | 'drop';

/** A stub Hub `/api/v2/projects`, with faults to answer with, in turn. */
function stubHub(token: string) {
  const projects = [
    { id: 12, number: '24-017', name: 'Vitan Farm', archived: false },
    { id: 13, number: '24-018', name: 'Old site', archived: true },
    { id: 14, number: '24-019', name: 'Riverside', archived: false },
  ];
  const faults: Array<{ fault: Fault }> = [];
  const calls: string[] = [];
  const answer = (res: ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on('end', () => {
      const method = req.method ?? 'GET';
      const path = (req.url ?? '').split('?')[0]!;
      calls.push(`${method} ${path}`);
      const next = faults.shift();
      if (next) {
        if (next.fault === 'drop') return void req.socket.destroy();
        return answer(res, next.fault, { error: 'stub fault', token });
      }
      if (req.headers.authorization !== `Bearer ${token}`) return answer(res, 401, { error: 'bad token' });
      if (method === 'GET' && path === '/api/v2/projects') return answer(res, 200, { projects });
      answer(res, 404, { error: 'no such route' });
    });
  });
  return { server, faults, calls };
}

describe('#1118 U7a L1a — Hub project list and the snapshot link (live PG + stub Hub)', () => {
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
  const project = async (tag: string, orgId = f.orgA.id) => {
    const id = `it-hublink-${tag}-${run}`;
    await t.prisma.project.create({ data: {
      id, orgId, name: `Site ${tag}`, short: 'Hub', descriptor: '', stage: 'x', siteCode: 'VFP-01', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0,
    } });
    made.push(id);
    return id;
  };
  /** A link and its event 1, written together (the schema refuses a link without its first event at commit). */
  const seedLink = (projectId: string, hubProjectId: string, number: string, name: string) =>
    t.prisma.$transaction(async (tx) => {
      await tx.drawingHubLink.create({ data: { projectId, orgId: f.orgA.id } });
      await tx.drawingHubLinkEvent.create({ data: {
        projectId, seq: 1, prevSeq: null, kind: 'linked', hubProjectId, hubProjectNumber: number, hubProjectName: name, byUserId: f.ownerUser.id,
      } });
    });
  const owner = () => `Bearer ${t.issueOrgOwnerToken(f.ownerUser.id, f.projectA.id, f.orgA.id)}`;
  const list = (pid: string, auth = owner(), orgId = f.orgA.id) =>
    request(t.app.getHttpServer()).get(`/orgs/${orgId}/projects/${pid}/hub/projects`).set('Authorization', auth);

  it('is 404 while Hub is not connected, and for another company', async () => {
    const p = await project('closed');
    expect((await list(p)).status).toBe(404);
    // the receiver's secret alone opens nothing here
    vi.stubEnv('HUB_WEBHOOK_SECRET', 'whsec_' + Buffer.alloc(32, 1).toString('base64'));
    expect((await list(p)).status).toBe(404);
    open(f.orgB.id);
    expect((await list(p)).status).toBe(404);
    expect(hub.calls).toEqual([]);
  });

  it('refuses a member who is not a company owner or admin (403), and a project of another company (404), before Hub hears of it', async () => {
    open();
    const p = await project('authz');
    const member = `Bearer ${t.issueProjectToken(f.memberUser.id, f.projectA.id, 'pmc')}`;
    expect((await list(p, member)).status).toBe(403);
    expect((await list(f.projectB.id)).status).toBe(404);
    expect((await list(`it-hublink-nothere-${run}`)).status).toBe(404);
    expect(hub.calls).toEqual([]);
  });

  it("lists Hub's live projects, marked by PMC's own links; the snapshot carries the active link", async () => {
    open();
    const p = await project('main');
    const other = await project('other');
    await seedLink(other, '14', '24-019', 'Riverside');

    const n = hub.calls.length;
    const listed = await list(p);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({ projects: [
      { id: '12', number: '24-017', name: 'Vitan Farm', linked: null },
      { id: '14', number: '24-019', name: 'Riverside', linked: 'other' },
    ] });
    expect(hub.calls.slice(n)).toEqual(['GET /api/v2/projects']);
    expect((await list(other)).body.projects.find((x: { id: string }) => x.id === '14').linked).toBe('this');

    // the snapshot's project line reads PMC only, with Hub's address for "Open in Hub"
    const query = t.app.get(DrawingsQueryService);
    const view = await query.hubLink(other);
    expect(view).toMatchObject({ hubProjectId: '14', number: '24-019', name: 'Riverside', openUrl: hubUrl });
    expect(typeof view?.linkedAt).toBe('string');
    const snap = await t.app.get(SnapshotService).build(other, 'pmc', f.ownerUser.id);
    expect(snap.project.hubLink).toEqual(view);
    // Hub not connected: no address
    vi.unstubAllEnvs();
    expect((await query.hubLink(other))?.openUrl).toBeNull();
    // Hub connected for another company: this company's link does not point at it
    open(f.orgB.id);
    expect((await query.hubLink(other))?.openUrl).toBeNull();
    // an unlinked project's snapshot has no Hub key at all (the previous release's shape)
    expect(await query.hubLink(p)).toBeNull();
    expect('hubLink' in (await t.app.get(SnapshotService).build(p, 'pmc', f.ownerUser.id)).project).toBe(false);
  });

  it("maps Hub's failures to codes that carry none of Hub's words", async () => {
    open();
    const p = await project('faults');
    const cases: Array<[Fault, number, string]> = [
      [503, 503, 'hub_unavailable'],
      ['drop', 503, 'hub_unavailable'],
      [401, 503, 'hub_key_refused'],
      [403, 503, 'hub_key_refused'],
      [404, 502, 'hub_refused'],
    ];
    for (const [fault, status, code] of cases) {
      hub.faults.push({ fault });
      const r = await list(p);
      expect([r.status, r.body.code]).toEqual([status, code]);
      expect(JSON.stringify(r.body)).not.toContain(token);
      expect(JSON.stringify(r.body)).not.toContain('stub fault');
      expect(JSON.stringify(r.body)).not.toContain('127.0.0.1');
    }
  });
});
