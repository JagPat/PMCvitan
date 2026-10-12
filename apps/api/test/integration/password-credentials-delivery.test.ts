import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * #806 (Codex on #807): the reset code's delivery is part of the request that issues it.
 *
 * - **Order.** Two requests for one person (two tabs, or "Send a new code" while a send is slow) are serialized on the
 *   per-user credential lock THROUGH the send, so the code mailed last is the code that works. A request whose send
 *   was detached could mail its consumed code after the newer one.
 * - **No orphaned challenge.** A send that fails rolls its challenge back: no stored code exists that never left. A
 *   detached send lost to a restart left exactly that.
 *
 * The provider is the test app's capture hook, held open or failed on purpose. Isolated automated test only.
 */

type Deferred = { promise: Promise<void>; resolve: () => void };
const deferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};

describe('#806 — reset-code delivery stays inside its request (live PostgreSQL)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  const sends: Array<{ email: string; code: string }> = [];
  /** When set, the NEXT send signals `started` and then waits for `release`. */
  let holdNext: { started: Deferred; release: Deferred } | null = null;
  let failNext = false;

  beforeAll(async () => {
    t = await createTestApp({
      capturePasswordCode: async (email, code) => {
        sends.push({ email, code });
        if (failNext) { failNext = false; throw new Error('smtp down'); }
        const hold = holdNext;
        if (hold) {
          holdNext = null;
          hold.started.resolve();
          await hold.release.promise;
        }
      },
    });
    f = await createTwoProjectFixture(t.prisma);
  });

  afterAll(async () => {
    await t?.prisma.passwordCredentialChallenge.deleteMany({ where: { userId: f.memberUser.id } });
    await f?.cleanup();
    await t?.close();
  });

  const http = () => request(t.app.getHttpServer());

  /** Sessions blocked on a Postgres lock while taking the per-user credential lock. */
  const waitersOnCredentialLock = async (): Promise<number> => {
    const rows = await t.prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND query ILIKE '%pg_advisory_xact_lock%' AND pid <> pg_backend_pid()`;
    return Number(rows[0]?.n ?? 0);
  };

  it('a second request waits for the first send, so the code mailed last is the one that verifies', async () => {
    const email = f.memberUser.email!;
    sends.length = 0;
    const hold = { started: deferred(), release: deferred() };
    holdNext = hold;

    const first = http().post('/auth/password/request').send({ email }).then((r) => r);
    await hold.started.promise; // the first send is in flight, inside its request

    const second = http().post('/auth/password/request').send({ email }).then((r) => r);
    // the second request is parked on the per-user credential lock: it has not sent anything
    for (let i = 0; i < 100 && (await waitersOnCredentialLock()) === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(await waitersOnCredentialLock()).toBeGreaterThanOrEqual(1);
    expect(sends).toHaveLength(1);

    hold.release.resolve();
    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(sends).toHaveLength(2);

    // the newer request consumed the older code; the code mailed last is the one that verifies
    await http().post('/auth/password/verify').send({ requestId: a.body.requestId, code: sends[0]!.code }).expect(400);
    await http().post('/auth/password/verify').send({ requestId: b.body.requestId, code: sends[1]!.code }).expect(201);
  });

  it('a failed send leaves no stored code behind, and the public answer is unchanged', async () => {
    const email = f.memberUser.email!;
    await t.prisma.passwordCredentialChallenge.deleteMany({ where: { userId: f.memberUser.id } });
    failNext = true;
    const res = await http().post('/auth/password/request').send({ email }).expect(201);
    expect(res.body).toEqual({ accepted: true, requestId: expect.any(String) });
    expect(await t.prisma.passwordCredentialChallenge.findUnique({ where: { id: res.body.requestId } })).toBeNull();
    expect(await t.prisma.passwordCredentialChallenge.count({ where: { userId: f.memberUser.id } })).toBe(0);
  });
});
