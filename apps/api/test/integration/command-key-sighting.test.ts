import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { SIGHTED_COMMANDS } from '../../src/platform/command-key-sighting';

/**
 * Idempotency-Key Unit 2a (notes/idempotency-key/u2/plan.md §2, §5): each of the five routes counts a request with no key
 * or a `legacy-` key in "CommandKeySighting" before anything can refuse it, never counts any other key, never lets the
 * count change what the command does, and the operator door reads the count (RUNBOOK §IDK).
 *
 * Reproduce-first: on 28bb9cce (2a-m, the table with nothing writing it) every count here reads zero and
 * `/ops/compat/client-keys` is 404.
 */
describe('Idempotency-Key 2a: the key-sighting count (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let token: string;
  const OPS = 'client-keys-test-token-0123456789abcdef';
  const opsBefore = process.env.OPS_TOKEN;
  const p = () => f.projectA.id;
  const run = randomUUID().slice(0, 8);

  /** POST to a route of project A, with `key` as the `Idempotency-Key` header when given */
  const post = (path: string, body: object, key?: string) => {
    const r = request(t.app.getHttpServer()).post(`/projects/${p()}${path}`).set('Authorization', `Bearer ${token}`);
    if (key !== undefined) r.set('Idempotency-Key', key);
    return r.send(body);
  };
  /** each of the five routes, by its command type, sent at something that does not exist (refused after the count) */
  const ROUTE: Record<string, { path: string; body: object }> = {
    'activities.start': { path: '/activities/ACT-none/start', body: {} },
    'activities.complete': { path: '/activities/ACT-none/complete', body: {} },
    'inspections.decide': { path: '/inspections/INSP-none/decide', body: { approve: true, rejectedItemIds: [] } },
    'daily-log.flagMismatch': { path: '/daily-log/flag-mismatch', body: { decisionId: 'DEC-none' } },
    'daily-log.submit': { path: '/daily-log/submit', body: { checkedIn: true, checkinTime: '09:00', progress: 0, crew: [] } },
  };
  const counts = async () => (await t.prisma.$queryRawUnsafe<Array<{ route: string; class: string; count: number }>>(
    `SELECT "route", "class", "count" FROM "CommandKeySighting" ORDER BY "route" COLLATE "C", "class"`));
  const readyActivity = async (label: string) => {
    const id = `ACT-cks-${label}-${run}`;
    await t.prisma.activity.create({ data: { id, projectId: p(), name: label, zone: 'GF', status: 'not_started', plannedStart: 0, plannedEnd: 3, gateMaterial: 'na', gateTeam: 'na' } });
    return id;
  };
  const ops = (query: string, auth: string | null = `Bearer ${OPS}`) => {
    const r = request(t.app.getHttpServer()).get(`/ops/compat/client-keys${query}`);
    return auth === null ? r : r.set('Authorization', auth);
  };

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    token = t.issueProjectToken(f.memberUser.id, p(), 'pmc');
  });
  // other suites on this database call the services with no key, which counts too
  beforeEach(async () => { await t.prisma.$executeRawUnsafe(`DELETE FROM "CommandKeySighting"`); });
  afterAll(async () => {
    if (opsBefore === undefined) delete process.env.OPS_TOKEN;
    else process.env.OPS_TOKEN = opsBefore;
    await t?.prisma.$executeRawUnsafe(`DELETE FROM "CommandKeySighting"`).catch(() => undefined);
    await f?.cleanup().catch(() => undefined);
    await t?.close();
  });

  it('each route counts no key and a blank key as absent and a legacy key as legacy, and a fresh key writes nothing', async () => {
    for (const route of SIGHTED_COMMANDS) {
      const { path, body } = ROUTE[route]!;
      const statuses = [
        (await post(path, body)).status,
        (await post(path, body, '   ')).status,
        (await post(path, body, `legacy-${'a'.repeat(64)}`)).status,
        (await post(path, body, `fresh-${randomUUID()}`)).status,
      ];
      // each is refused by the route (nothing it names exists), after the count
      expect([route, statuses.every((s) => s >= 400 && s < 500)]).toEqual([route, true]);
    }
    expect(await counts()).toEqual(SIGHTED_COMMANDS.flatMap((route) => [
      { route, class: 'absent', count: 2 },
      { route, class: 'legacy', count: 1 },
    ]).sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0)));
  });

  it('counts a keyless start that commits and its keyless resend that is refused 409', async () => {
    const id = await readyActivity('resend');
    expect((await post(`/activities/${id}/start`, {})).status).toBe(201);
    expect((await post(`/activities/${id}/start`, {})).status).toBe(409);
    expect(await counts()).toEqual([{ route: 'activities.start', class: 'absent', count: 2 }]);
    // the row's day is the UTC date of its own newest time (both from the request's one instant), so a run across
    // 00:00Z still holds
    const [row] = await t.prisma.$queryRawUnsafe<Array<{ day: string; lastAt: Date }>>(`SELECT "day"::text AS "day", "lastAt" FROM "CommandKeySighting"`);
    expect(row!.day).toBe(row!.lastAt.toISOString().slice(0, 10));
  });

  it('a counter write that fails leaves the command, its result and its effects as they were', async () => {
    await t.prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION public.cks_test_refuse() RETURNS trigger LANGUAGE plpgsql
      SET search_path = pg_catalog, public, pg_temp AS $$ BEGIN RAISE EXCEPTION 'cks test: refused'; END $$`);
    await t.prisma.$executeRawUnsafe(`CREATE TRIGGER cks_test_refuse BEFORE INSERT ON public."CommandKeySighting" FOR EACH ROW EXECUTE FUNCTION public.cks_test_refuse()`);
    const warn = vi.spyOn(Logger.prototype, 'warn');
    try {
      const id = await readyActivity('refused-count');
      const res = await post(`/activities/${id}/start`, {});
      expect(res.status).toBe(201);
      expect((await t.prisma.activity.findUniqueOrThrow({ where: { id } })).status).toBe('in_progress');
      expect(await t.prisma.auditLog.count({ where: { projectId: p(), action: 'activity.start', entityId: id } })).toBe(1);
      expect(await counts()).toEqual([]);
      // logged with Prisma's code and PostgreSQL's (P0001, the trigger's RAISE), and nothing about the request's key
      expect(warn.mock.calls.map((c) => c[0])).toContain('not counted: activities.start absent (PrismaClientKnownRequestError P2010 P0001)');
    } finally {
      warn.mockRestore();
      await t.prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS cks_test_refuse ON public."CommandKeySighting"`);
      await t.prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public.cks_test_refuse()`);
    }
  });

  it('a counter held by another transaction delays the command by the bound at most, and the command commits', async () => {
    const id = await readyActivity('held-row');
    const day = new Date().toISOString().slice(0, 10);
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "CommandKeySighting" ("route", "class", "day", "count", "lastAt") VALUES ('activities.start', 'absent', $1::date, 5, now() AT TIME ZONE 'UTC')`, day);
    // the holder keeps the table from any insert until the start has answered, so the start's upsert can only time out,
    // whichever UTC day it lands on (a run across 00:00Z would miss a lock on today's row alone)
    const res = await t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`LOCK TABLE public."CommandKeySighting" IN SHARE MODE`);
      return post(`/activities/${id}/start`, {});
    }, { timeout: 30_000 });
    expect(res.status).toBe(201);
    expect((await t.prisma.activity.findUniqueOrThrow({ where: { id } })).status).toBe('in_progress');
    expect(await counts()).toEqual([{ route: 'activities.start', class: 'absent', count: 5 }]);
  });

  it('GET /ops/compat/client-keys lists all five routes with zeros, sums from since\'s UTC day, and refuses a bad since', async () => {
    process.env.OPS_TOKEN = OPS;
    const zero = await ops(`?since=${encodeURIComponent('2026-11-01T00:00:00Z')}`);
    expect(zero.status).toBe(200);
    expect(zero.body).toEqual({
      since: '2026-11-01T00:00:00.000Z', fromDay: '2026-11-01',
      routes: SIGHTED_COMMANDS.map((route) => ({ route, absent: 0, legacy: 0, lastAbsent: null, lastLegacy: null })),
    });
    const row = (route: string, cls: string, day: string, count: number, lastAt: string) => t.prisma.$executeRawUnsafe(
      `INSERT INTO "CommandKeySighting" ("route", "class", "day", "count", "lastAt") VALUES ($1, $2, $3::date, $4, $5::timestamp)`, route, cls, day, count, lastAt);
    await row('daily-log.submit', 'legacy', '2026-11-01', 2, '2026-11-01 08:00:00');
    await row('daily-log.submit', 'legacy', '2026-11-03', 3, '2026-11-03 23:59:00');
    await row('daily-log.submit', 'absent', '2026-11-02', 1, '2026-11-02 10:00:00');
    await row('inspections.decide', 'absent', '2026-10-31', 7, '2026-10-31 12:00:00');
    // `since` inside 1 Nov reads the whole of 1 Nov; 31 Oct is before it
    const read = await ops(`?since=${encodeURIComponent('2026-11-01T18:30:00+05:30')}`);
    expect(read.status).toBe(200);
    expect(read.body.fromDay).toBe('2026-11-01');
    expect(read.body.routes.find((r: { route: string }) => r.route === 'daily-log.submit')).toEqual({
      route: 'daily-log.submit', absent: 1, legacy: 5, lastAbsent: '2026-11-02T10:00:00.000Z', lastLegacy: '2026-11-03T23:59:00.000Z',
    });
    expect(read.body.routes.find((r: { route: string }) => r.route === 'inspections.decide')).toMatchObject({ absent: 0, legacy: 0 });
    expect((await ops(`?since=${encodeURIComponent('2026-10-31T00:00:00Z')}`)).body.routes
      .find((r: { route: string }) => r.route === 'inspections.decide')).toMatchObject({ absent: 7, lastAbsent: '2026-10-31T12:00:00.000Z' });
    // the earliest `since` the door admits reads every row (PostgreSQL has no year 0)
    expect((await ops(`?since=${encodeURIComponent('0000-01-01T00:00:00Z')}`)).body.fromDay).toBe('0001-01-01');
    for (const bad of ['', '?since=', '?since=yesterday', '?since=2026-11-01', `?since=${encodeURIComponent('2026-11-01T00:00:00+24:00')}`, '?since=2026-11-01T00:00:00Z&extra=1']) {
      expect([bad, (await ops(bad)).status]).toEqual([bad, 400]);
    }
  });

  it('GET /ops/compat/client-keys is closed without the token and refuses a wrong or user token', async () => {
    const since = `?since=${encodeURIComponent(new Date().toISOString())}`;
    delete process.env.OPS_TOKEN;
    expect((await ops(since)).status).toBe(404);
    process.env.OPS_TOKEN = OPS;
    expect((await ops(since, null)).status).toBe(401);
    expect((await ops(since, `Bearer ${token}`)).status).toBe(401);
  });
});
