import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import net, { type AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
import { HUB_DELIVERY_ACTOR } from '../../src/drawings/hub/hub-receiver.service';

/**
 * #1118 U3 — Hub's webhook receiver, `POST /integrations/hub/:orgId/events`, against the real app and live PostgreSQL
 * (`notes/hub/1118-plan.md` U3). Closed without `HUB_*` or for another org; a bad signature writes nothing; a refused
 * delivery is recorded with no project and audited; an ignored one is recorded only; a delivery already applied is
 * skipped; a project resolves only through its active link; and a resolved delivery answers 503, writing nothing, until
 * U5 applies it.
 *
 * The webhook secret is random per run, never a real Hub secret. Each linked project is this file's own, and every link
 * event names this file's own user, homed on a project of its own (an event names its user through a NO ACTION key, as
 * in `hub-link-schema.test.ts`). `afterAll` clears the receipts with the sanctioned reset, then deletes the linked
 * projects (their link and history go with them), then the user and its home, then runs the fixture's cleanup.
 *
 * Isolated automated-test fixtures only.
 */
describe('#1118 U3 — Hub webhook receiver (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const run = randomUUID().slice(0, 8);
  const made: string[] = [];
  const key = randomBytes(32);
  const secret = `whsec_${key.toString('base64')}`;
  const officeToken = `office-${randomUUID()}`;
  const home = `it-hubrx-home-${run}`;
  let actor = '';

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    await t.prisma.project.create({ data: {
      id: home, orgId: f.orgA.id, name: home, short: 'Home', descriptor: '', stage: 'x', siteCode: 'HOM', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0,
    } });
    actor = (await t.prisma.user.create({ data: { email: `hubrx.actor.${run}@test.local`, name: 'Hub linker', role: 'pmc', projectId: home } })).id;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (!t) return;
    try {
      // the receipts and every Hub record that may name one (as hub-receipts-schema.test.ts clears them)
      await sanctionedReset(t.prisma, ['HubGoverningMark', 'HubRevision', 'HubDrawing', 'HubWebhookReceipt', 'HubVersionTombstone']);
      for (const id of made) await t.prisma.$executeRawUnsafe(`DELETE FROM "Project" WHERE "id" = $1`, id);
      if (actor) await t.prisma.user.delete({ where: { id: actor } });
      await t.prisma.$executeRawUnsafe(`DELETE FROM "Project" WHERE "id" = $1`, home);
    } finally {
      await f?.cleanup();
      await t.close();
    }
  });

  const open = (orgId = f.orgA.id) => {
    vi.stubEnv('HUB_BASE_URL', 'https://hub.test');
    vi.stubEnv('HUB_OFFICE_TOKEN', officeToken);
    vi.stubEnv('HUB_WEBHOOK_SECRET', secret);
    vi.stubEnv('HUB_ORG_ID', orgId);
  };
  const project = async (tag: string, orgId = f.orgA.id) => {
    const id = `it-hubrx-${tag}-${run}`;
    await t.prisma.project.create({ data: {
      id, orgId, name: id, short: 'Hub', descriptor: '', stage: 'x', siteCode: 'HUB', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0,
    } });
    made.push(id);
    return id;
  };
  /** U7's link, as the link tables take it: the link and its event 1 in one transaction. */
  const link = async (projectId: string, hubProjectId: string, orgId = f.orgA.id) => {
    await t.prisma.$transaction([
      t.prisma.$executeRawUnsafe(`INSERT INTO "DrawingHubLink" ("projectId", "orgId") VALUES ($1, $2)`, projectId, orgId),
      t.prisma.$executeRawUnsafe(`INSERT INTO "DrawingHubLinkEvent" ("projectId", "seq", "prevSeq", "kind", "hubProjectId", "byUserId")
        VALUES ($1, 1, NULL, 'linked', $2, $3)`, projectId, hubProjectId, actor),
    ]);
  };
  const unlinkSql = `INSERT INTO "DrawingHubLinkEvent" ("projectId", "seq", "prevSeq", "kind", "hubProjectId", "byUserId") VALUES ($1, 2, 1, 'unlinked', NULL, $2)`;

  const event = (externalIds: string[], hubProjectId: number | string = 42, data: Record<string, unknown> = {}, type = 'drawing.issued') => ({
    type,
    timestamp: '2026-10-27T10:00:00Z',
    data: {
      fileId: 'f-17', fileNo: 'A-101', toStage: 'CONSTRUCTION', versionId: 'v-9031',
      project: { id: hubProjectId, links: externalIds.map((externalId) => ({ app: 'pmc', externalId, url: 'https://pms.test' })) },
      ...data,
    },
  });
  const sign = (id: string, timestamp: number, body: Buffer, signingKey = key) =>
    `v1,${createHmac('sha256', signingKey).update(`${id}.${timestamp}.`).update(body).digest('base64')}`;
  /** Delivers `payload` as Hub does: JSON bytes, the three Standard Webhooks headers, signed now. */
  const deliver = (payload: unknown, options: { id?: string; orgId?: string; signature?: string; timestamp?: number; contentType?: string } = {}) => {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
    const id = options.id ?? `evt_${randomUUID().replace(/-/g, '')}`;
    const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
    const r = request(t.app.getHttpServer())
      .post(`/integrations/hub/${options.orgId ?? f.orgA.id}/events`)
      .set('Content-Type', options.contentType ?? 'application/json')
      .set('webhook-id', id)
      .set('webhook-timestamp', String(timestamp))
      .set('webhook-signature', options.signature ?? sign(id, timestamp, body))
      // as text: superagent would send a Buffer under a JSON type as `{"type":"Buffer",…}` (every body here is UTF-8)
      .send(body.toString('utf8'));
    return { id, r };
  };
  /**
   * One request on a raw socket, for what supertest can't send: a body in chunks with no `Content-Length`, or bytes
   * that aren't text. Resolves the status code once the answer's status line arrives.
   */
  const rawPost = async (path: string, headers: Record<string, string>, body: Buffer, chunked = false) => {
    const server = t.app.getHttpServer();
    if (!server.listening) await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;
    const framed = chunked
      ? Buffer.concat([...Array.from({ length: Math.ceil(body.length / 65536) }, (_, i) => body.subarray(i * 65536, (i + 1) * 65536))
        .flatMap((part) => [Buffer.from(`${part.length.toString(16)}\r\n`), part, Buffer.from('\r\n')]), Buffer.from('0\r\n\r\n')])
      : body;
    const head = [`POST ${path} HTTP/1.1`, 'Host: hub.test', 'Connection: close', chunked ? 'Transfer-Encoding: chunked' : `Content-Length: ${body.length}`,
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`)].join('\r\n');
    return new Promise<number>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      let answer = '';
      const settle = () => {
        const status = /^HTTP\/1\.1 (\d{3})/.exec(answer)?.[1];
        if (status) { resolve(Number(status)); socket.destroy(); }
        return Boolean(status);
      };
      socket.on('data', (data) => { answer += data.toString('latin1'); settle(); });
      // the server may close mid-upload once it has answered (a 413): only a close with no answer fails the request
      socket.on('error', () => undefined);
      socket.on('close', () => { if (!settle()) reject(new Error(`no answer from ${path}`)); });
      socket.write(`${head}\r\n\r\n`);
      socket.write(framed);
    });
  };
  /** The three Standard Webhooks headers for `body`, signed now. */
  const signedHeaders = (body: Buffer) => {
    const id = `evt_${randomUUID().replace(/-/g, '')}`;
    const timestamp = Math.floor(Date.now() / 1000);
    return { id, headers: { 'webhook-id': id, 'webhook-timestamp': String(timestamp), 'webhook-signature': sign(id, timestamp, body) } };
  };
  const receipts = (webhookId: string) => t.prisma.hubWebhookReceipt.findMany({
    where: { webhookId }, orderBy: { id: 'asc' }, select: { id: true, orgId: true, eventType: true, outcome: true, projectId: true, hubVersionId: true, appliedFact: true },
  });
  const audits = (receiptIds: bigint[]) => t.prisma.auditLog.findMany({
    where: { entity: 'HubWebhookReceipt', entityId: { in: receiptIds.map(String) } }, orderBy: { at: 'asc' },
  });

  it('is closed: Nest\'s unrouted 404 without every HUB_*, and for any org but HUB_ORG_ID; nothing is written', async () => {
    for (const name of ['HUB_BASE_URL', 'HUB_OFFICE_TOKEN', 'HUB_WEBHOOK_SECRET', 'HUB_ORG_ID']) vi.stubEnv(name, '');
    const unrouted = await request(t.app.getHttpServer()).post(`/integrations/hub/${f.orgA.id}/nothing-here`).send({});
    const { id, r } = deliver(event([]));
    const closed = await r;
    expect(closed.status).toBe(404);
    expect(closed.body).toEqual({ ...unrouted.body, message: `Cannot POST /integrations/hub/${f.orgA.id}/events` });

    open();
    vi.stubEnv('HUB_WEBHOOK_SECRET', 'whsec_short');
    expect((await deliver(event([]), { id }).r).status).toBe(404);
    open();
    const other = await deliver(event([]), { id, orgId: f.orgB.id }).r;
    expect(other.status).toBe(404);
    expect(other.body.message).toBe(`Cannot POST /integrations/hub/${f.orgB.id}/events`);
    expect(await receipts(id)).toEqual([]);
  });

  it('refuses (401) a missing, wrong, stale, other-secret or repeated signature, writing nothing for it', async () => {
    open();
    const id = `evt_unsigned_${run}`;
    const body = Buffer.from(JSON.stringify(event([])));
    const now = Math.floor(Date.now() / 1000);
    const bad = [
      sign(id, now, Buffer.from(JSON.stringify(event(['tampered'])))),
      sign(id, now, body, randomBytes(32)),
      'v1,' + 'A'.repeat(43) + '=',
    ];
    for (const signature of bad) expect((await deliver(body, { id, signature, timestamp: now }).r).status, signature).toBe(401);
    expect((await deliver(body, { id, timestamp: now - 301 }).r).status).toBe(401);
    const headerless = await request(t.app.getHttpServer()).post(`/integrations/hub/${f.orgA.id}/events`).set('Content-Type', 'application/json').send(body.toString('utf8'));
    expect(headerless.status).toBe(401);
    // a signature header sent twice, one of them valid, is refused whichever way it is read
    // superagent hands an array to Node's setHeader, which sends one header line per value; its types say string only
    const twoLines = ['v1,' + 'B'.repeat(43) + '=', sign(id, now, body)] as unknown as string;
    const twice = await request(t.app.getHttpServer()).post(`/integrations/hub/${f.orgA.id}/events`).set('Content-Type', 'application/json')
      .set('webhook-id', id).set('webhook-timestamp', String(now)).set('webhook-signature', twoLines)
      .send(body.toString('utf8'));
    expect(twice.status).toBe(401);
    const good = await deliver(body, { id, timestamp: now }).r;
    expect(good.status).toBe(204); // the same delivery, its header sent once
    expect((await receipts(id)).map((x) => x.outcome)).toEqual(['refused']);
  });

  it('checks the bytes as sent: odd spacing and escapes pass; a body not read raw is 400; an oversize body is 413', async () => {
    open();
    const spaced = Buffer.from(`{ "type" : "webhook.test" ,\n  "data" : { "message" : "caf\\u00e9 é" } }`, 'utf8');
    const { id, r } = deliver(spaced);
    expect((await r).status).toBe(204);
    expect(await receipts(id)).toMatchObject([{ outcome: 'ignored', eventType: 'webhook.test' }]);
    // a charset parameter is still JSON
    expect((await deliver(event([]), { contentType: 'application/json; charset=utf-8' }).r).status).toBe(204);

    const plain = deliver(JSON.stringify(event([])), { contentType: 'text/plain' });
    expect((await plain.r).status).toBe(400);
    expect(await receipts(plain.id)).toEqual([]);

    // 256 KiB is the most read: a body of exactly that is judged, one byte more is 413
    const sized = (bytes: number) => { const head = '{"type":"webhook.test","pad":"'; return Buffer.from(head + 'x'.repeat(bytes - head.length - 2) + '"}'); };
    const most = deliver(sized(256 * 1024));
    expect((await most.r).status).toBe(204);
    const big = deliver(sized(256 * 1024 + 1));
    expect((await big.r).status).toBe(413);
    expect(await receipts(big.id)).toEqual([]);
  });

  it('reads a chunked body raw up to 256 KiB (413 above), and never reads a compressed one raw (400); neither writes', async () => {
    open();
    const sized = (bytes: number) => { const head = '{"type":"webhook.test","pad":"'; return Buffer.from(head + 'x'.repeat(bytes - head.length - 2) + '"}'); };
    const path = `/integrations/hub/${f.orgA.id}/events`;
    const most = sized(256 * 1024);
    const judged = signedHeaders(most);
    expect(await rawPost(path, { 'Content-Type': 'application/json', ...judged.headers }, most, true)).toBe(204);
    expect(await receipts(judged.id)).toMatchObject([{ outcome: 'ignored' }]);
    const over = sized(256 * 1024 + 1);
    const refused = signedHeaders(over);
    expect(await rawPost(path, { 'Content-Type': 'application/json', ...refused.headers }, over, true)).toBe(413);
    expect(await receipts(refused.id)).toEqual([]);

    // signed over the compressed bytes: read raw, they would verify; the global parser inflates them, so no Buffer
    const gzipped = gzipSync(Buffer.from(JSON.stringify(event([]))));
    const compressed = signedHeaders(gzipped);
    expect(await rawPost(path, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', ...compressed.headers }, gzipped)).toBe(400);
    expect(await receipts(compressed.id)).toEqual([]);
  });

  it('reads a body raw only on the Hub org\'s events path while open: closed, another org and another path answer alike', async () => {
    // 300 KiB, over what the raw reader takes: anywhere it doesn't read, the global parser takes it and Nest answers 404
    const big = { type: 'webhook.test', pad: 'x'.repeat(300 * 1024) };
    const unrouted = (path: string, body: { message: string }) => expect(body).toMatchObject({ statusCode: 404, message: `Cannot POST ${path}` });
    for (const name of ['HUB_BASE_URL', 'HUB_OFFICE_TOKEN', 'HUB_WEBHOOK_SECRET', 'HUB_ORG_ID']) vi.stubEnv(name, '');
    const closed = await deliver(big).r;
    expect(closed.status).toBe(404);
    unrouted(`/integrations/hub/${f.orgA.id}/events`, closed.body);

    open();
    const other = await deliver(big, { orgId: f.orgB.id }).r;
    expect(other.status).toBe(404);
    unrouted(`/integrations/hub/${f.orgB.id}/events`, other.body);
    for (const path of ['/integrations/hub/x', `/integrations/hub/${f.orgA.id}/other`]) {
      const elsewhere = await request(t.app.getHttpServer()).post(path).set('Content-Type', 'application/json').send(JSON.stringify(big));
      expect(elsewhere.status, path).toBe(404);
      unrouted(path, elsewhere.body);
    }
    const own = deliver(big);
    expect((await own.r).status).toBe(413); // only the Hub org's own events path reads it raw
    expect(await receipts(own.id)).toEqual([]);
  });

  it('refuses an unreadable or malformed delivery: recorded with no project, audited by reason, answered 204', async () => {
    open();
    const unreadable = deliver('not json');
    expect((await unreadable.r).status).toBe(204);
    const malformed = deliver(event(['x'], 42, { toStage: 'WIP' }));
    expect((await malformed.r).status).toBe(204);

    const rows = [...await receipts(unreadable.id), ...await receipts(malformed.id)];
    expect(rows.map((x) => [x.orgId, x.eventType, x.outcome, x.projectId, x.hubVersionId, x.appliedFact])).toEqual([
      [f.orgA.id, '(unreadable)', 'refused', null, null, null],
      [f.orgA.id, 'drawing.issued', 'refused', null, 'v-9031', null],
    ]);
    const logged = await audits(rows.map((x) => x.id));
    expect(logged.map((a) => [a.projectId, a.actorId, a.action, a.payload])).toEqual([
      [null, HUB_DELIVERY_ACTOR, 'hub.delivery_refused', { eventType: '(unreadable)', reason: 'unreadable' }],
      [null, HUB_DELIVERY_ACTOR, 'hub.delivery_refused', { eventType: 'drawing.issued', reason: 'malformed' }],
    ]);
  });

  it('ignores an unsubscribed type and work in progress: recorded, not audited, answered 204', async () => {
    open();
    // one request at a time: supertest starts the server per request
    const test = deliver({ type: 'webhook.test', timestamp: 'x', data: { message: 'hi' } });
    expect((await test.r).status).toBe(204);
    const wip = deliver(event(['x'], 42, { toStage: null }, 'drawing.status_changed'));
    expect((await wip.r).status).toBe(204);
    const rows = [...await receipts(test.id), ...await receipts(wip.id)];
    expect(rows.map((x) => [x.eventType, x.outcome, x.projectId])).toEqual([['webhook.test', 'ignored', null], ['drawing.status_changed', 'ignored', null]]);
    expect(await audits(rows.map((x) => x.id))).toEqual([]);
  });

  it('resolves a project only through its active link to the Hub project the event is about', async () => {
    open();
    const linked = await project('linked');
    const twin = await project('twin'); // a second PMC project following the same Hub project
    const unlinked = await project('unlinked');
    const gone = await project('gone');
    const elsewhere = await project('elsewhere', f.orgB.id);
    await link(linked, '42');
    await link(twin, '42');
    await link(gone, '42');
    await t.prisma.$executeRawUnsafe(unlinkSql, gone, actor);
    await link(elsewhere, '42', f.orgB.id);

    const refused: Array<[string, unknown, string]> = [
      ['no PMC link in the event', event([]), 'not_linked'],
      ['two PMC projects named', event([linked, twin]), 'not_linked'],
      ['an unknown project', event([`nope-${run}`]), 'not_linked'],
      ['a project with no link', event([unlinked]), 'not_linked'],
      ['a link whose latest event is unlink', event([gone]), 'not_linked'],
      ['another org\'s linked project', event([elsewhere]), 'not_linked'],
      ['a mismatched Hub project', event([linked], 43), 'hub_project_mismatch'],
      ['a mismatched Hub project as a string', event([linked], '042'), 'hub_project_mismatch'],
    ];
    for (const [what, payload, reason] of refused) {
      const { id, r } = deliver(payload);
      expect((await r).status, what).toBe(204);
      const rows = await receipts(id);
      expect(rows.map((x) => [x.outcome, x.projectId]), what).toEqual([['refused', null]]);
      // the audit row names no project either, even when the PMC project Hub named exists and is linked
      expect((await audits(rows.map((x) => x.id))).map((a) => [a.projectId, a.payload]), what).toEqual([[null, { eventType: 'drawing.issued', reason }]]);
    }

    // each of two links to one Hub project resolves its own PMC project, by the id Hub names; a numeric Hub id matches
    for (const [payload, what] of [[event([linked]), 'linked'], [event([twin], '42'), 'twin'], [event([linked], 42, {}, 'drawing.superseded'), 'superseded'],
      [event([linked], 42, { toStage: 'SHARED' }, 'drawing.status_changed'), 'shared']] as const) {
      const { id, r } = deliver(payload);
      expect((await r).status, what).toBe(503);
      expect(await receipts(id), what).toEqual([]);
    }
  });

  it('judges a refused delivery again, and skips one already applied (no row written)', async () => {
    open();
    const p = await project('replay');
    // refused twice: each judgement is recorded, and a retry is never skipped on a refusal
    const id = `evt_retry_${run}`;
    expect((await deliver(event([p]), { id }).r).status).toBe(204);
    expect((await deliver(event([p]), { id }).r).status).toBe(204);
    expect((await receipts(id)).map((x) => x.outcome)).toEqual(['refused', 'refused']);
    // once linked, the same delivery resolves (503 until U5 applies it)
    await link(p, '42');
    expect((await deliver(event([p]), { id }).r).status).toBe(503);
    expect((await receipts(id)).length).toBe(2);

    // a delivery U5 applied (here, a withdrawal: its receipt and tombstone in one transaction) is skipped
    const applied = `evt_applied_${run}`;
    await t.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRawUnsafe<Array<{ id: bigint }>>(
        `INSERT INTO "HubWebhookReceipt" ("orgId", "webhookId", "eventType", "outcome", "projectId", "hubVersionId", "appliedFact")
         VALUES ($1, $2, 'drawing.superseded', 'applied', $3, 'v-old', 'tombstone') RETURNING "id"`, f.orgA.id, applied, p);
      await tx.$executeRawUnsafe(`INSERT INTO "HubVersionTombstone" ("projectId", "hubVersionId", "hubFileId", "sourceReceiptId") VALUES ($1, 'v-old', 'f-17', $2)`, p, row!.id);
    });
    for (const payload of [event([p]), 'not json', { type: 'webhook.test' }]) {
      expect((await deliver(payload, { id: applied }).r).status).toBe(204);
    }
    expect((await receipts(applied)).map((x) => x.outcome)).toEqual(['applied']);
  });

  // an unlink in flight, with or without its writer locking the link row first: the event insert alone takes KEY SHARE
  // on that row through its foreign key, which the delivery's FOR UPDATE waits for
  it.each([['locking the link row first', true], ['inserting only the event', false]] as const)(
    'waits for a link change in flight (%s): an unlink committing during the judgement is what it sees (barrier, no sleep)', async (_, lockFirst) => {
    open();
    const p = await project(lockFirst ? 'race' : 'race-bare');
    await link(p, '42');
    let pid = 0;
    let locked!: () => void;
    const lockedP = new Promise<void>((resolve) => { locked = resolve; });
    let release!: () => void;
    const releaseP = new Promise<void>((resolve) => { release = resolve; });
    const unlink = t.prisma.$transaction(async (tx) => {
      pid = Number((await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid'))[0]!.pid);
      if (lockFirst) await tx.$queryRawUnsafe(`SELECT 1 FROM "DrawingHubLink" WHERE "projectId" = $1 FOR UPDATE`, p);
      await tx.$executeRawUnsafe(unlinkSql, p, actor);
      locked();
      await releaseP;
    }, { maxWait: 10_000, timeout: 30_000 });
    await lockedP;
    const { id, r } = deliver(event([p]));
    const answer = r.then((x) => x);
    const deadline = Date.now() + 20_000;
    for (;;) {
      const [row] = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        'SELECT count(*)::bigint AS n FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', pid);
      if (row!.n > 0n) break;
      if (Date.now() > deadline) throw new Error('barrier not reached: the delivery waits on the unlink');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    release();
    await unlink;
    expect((await answer).status).toBe(204);
    const rows = await receipts(id);
    expect(rows.map((x) => [x.outcome, x.projectId])).toEqual([['refused', null]]);
    expect((await audits(rows.map((x) => x.id))).map((a) => a.payload)).toEqual([{ eventType: 'drawing.issued', reason: 'not_linked' }]);
  });

  it('puts no header, signature, token or secret in a log or an audit row', async () => {
    open();
    const p = await project('quiet');
    await link(p, '42');
    const out: string[] = [];
    const capture = (...args: unknown[]) => { out.push(args.map(String).join(' ')); };
    for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) vi.spyOn(console, level).mockImplementation(capture);
    for (const stream of [process.stdout, process.stderr]) {
      const write = stream.write.bind(stream);
      vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
        out.push(String(chunk));
        return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof stream.write);
    }
    const ids: string[] = [];
    const signatures: string[] = [];
    for (const payload of ['not json', event([p], 43), event([p]), { type: 'webhook.test' }]) {
      const id = `evt_quiet_${randomUUID().replace(/-/g, '')}`;
      const timestamp = Math.floor(Date.now() / 1000);
      const body = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
      const signature = sign(id, timestamp, body);
      ids.push(id);
      signatures.push(signature);
      await deliver(body, { id, timestamp, signature }).r;
      await deliver(body, { id, timestamp, signature: sign(id, timestamp, body, randomBytes(32)) }).r;
    }
    vi.restoreAllMocks();
    const rows = await t.prisma.hubWebhookReceipt.findMany({ where: { webhookId: { in: ids } }, select: { id: true } });
    expect(rows.length).toBe(3);
    const trail = JSON.stringify((await audits(rows.map((x) => x.id))).map((a) => [a.actor, a.actorId, a.actorRole, a.payload, a.entityId]));
    const written = out.join('\n');
    for (const value of [secret, key.toString('base64'), officeToken, ...ids, ...signatures, ...signatures.map((s) => s.slice(3))]) {
      expect(written.includes(value), 'log').toBe(false);
      expect(trail.includes(value), 'audit').toBe(false);
    }
  });
});
