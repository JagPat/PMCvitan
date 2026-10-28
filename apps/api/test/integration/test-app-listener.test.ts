import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';

/**
 * #1210 residual — the harness's app server is listening before any request, so no request owns it.
 *
 * Given a server that is not listening, supertest listens for the first request and closes the SHARED
 * server when that request ends. A second request built while the first was in flight reuses the
 * port without owning it, so if the first ends before the second connects, the second is refused
 * (ECONNREFUSED) or reset and never reaches the app. That is how one of the six concurrent marks in
 * `top10-4b-notifications-seen.test.ts` "no deadlock between marks…" rejected in CI (job 122786640774)
 * with no error on the server side.
 */
describe('#1210 residual — the test app server is shared by concurrent supertest requests (live PG)', () => {
  let t: TestApp;
  let server: Server;

  beforeAll(async () => {
    t = await createTestApp();
    server = t.app.getHttpServer();
  });
  afterAll(async () => { await t?.close(); });

  it('a request built while another is in flight still reaches the app after that one has ended (forced order)', async () => {
    expect(server.listening, 'the harness listens before any request').toBe(true);
    // B's address is fixed now, while A is in flight; B is sent only once A's response has come back.
    const a = request(server).get('/health/live');
    const b = request(server).get('/health/live');
    const first = await a;
    expect(first.status).toBe(200);
    expect(server.listening, 'ending A left the shared server listening').toBe(true);
    const second = await b.then((r) => ({ ok: true as const, r }), (e: unknown) => ({ ok: false as const, e: String(e) }));
    expect(second.ok, second.ok ? '' : second.e).toBe(true);
    expect(second.ok && second.r.status).toBe(200);
  });

  it('closing the test app closes its listener, keep-alive sockets included', async () => {
    const other = await createTestApp();
    let closing: Promise<void> | undefined;
    try {
      const otherServer: Server = other.app.getHttpServer();
      expect(otherServer.listening).toBe(true);
      const r = await request(otherServer).get('/health/live').set('Connection', 'keep-alive');
      expect(r.status).toBe(200);
      const closed = new Promise<void>((resolve) => otherServer.once('close', () => resolve()));
      closing = other.close();
      await closing;
      await closed;
      expect(otherServer.listening).toBe(false);
    } finally {
      // a failure before the close above must not leave this app's listener and pool to later files
      if (!closing) await other.close();
    }
  });
});
