import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * #482 date guard — a claimed or expiry instant that Zod's offset check admits but Date cannot read (`+24:00`,
 * `+02:60`, `+2400`), or whose offset carries year 0000 or 9999 past the 4-digit years Prisma sends, used to reach
 * Prisma and answer 500. Each now gets the same one-issue 400 as any other malformed instant (`nope`, `+02`), as
 * #1045 does for the ops read's `since`; the earliest and latest instants Prisma can send still land.
 */
const REFUSED = [
  '2020-01-01T00:00:00+24:00', '2020-01-01T00:00:00+99:00', '2020-01-01T00:00:00-24:00', '2020-01-01T00:00:00+02:60',
  '2020-01-01T00:00:00+2400', '0000-01-01T00:00:00+01:00', '9999-12-31T23:59:59-23:59',
];
const EARLIEST = ['0000-01-01T00:00:00Z', '0000-01-01T01:00:00+01:00'];
const LATEST = ['9999-12-31T23:59:59.999Z', '9999-12-31T22:59:59-01:00'];
const refused = (field: string) => ({ statusCode: 400, error: 'Bad Request', message: [`${field}: Invalid datetime`] });

describe('#482 date guard — claimed and expiry instants Date or Prisma cannot read get the documented 400 (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let pmcToken: string;
  let place: string;
  let activityId: string;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    // the start window is [max(receipt − 7 days, project start), receipt]; give project A a month of history
    await t.prisma.$executeRaw`UPDATE "Project" SET "createdAt" = now() - interval '30 days' WHERE "id" = ${f.projectA.id}`;
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id);
    place = (await t.prisma.projectNode.create({
      data: { projectId: f.projectA.id, name: `Instant ${randomUUID().slice(0, 8)}`, kind: 'zone', order: 0, authorId: f.memberUser.id, publishedAt: new Date() },
    })).id;
    const name = `Instant guard ${randomUUID().slice(0, 8)}`;
    expect((await post(`/projects/${f.projectA.id}/activities`, { name, plannedStart: 0, plannedEnd: 5 })).status).toBe(201);
    activityId = (await t.prisma.activity.findFirstOrThrow({ where: { projectId: f.projectA.id, name } })).id;
  });

  afterAll(async () => {
    if (t) {
      await t.prisma.gateOverride.deleteMany({ where: { projectId: f.projectA.id } });
      await t.prisma.activity.deleteMany({ where: { projectId: f.projectA.id } });
      // the visit record is immutable; the disposable test DB clears it by the sanctioned reset, before the users it names
      await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor',
        'SiteVisitPlace', 'SiteVisitAttendee', 'SiteVisit', 'LabourDemandSlice', 'LabourRequirementSpec', 'MaterialRequirementSpec'], { cascade: true });
    }
    await f?.cleanup();
    await t?.close();
  });

  const post = (path: string, body: object) => request(t.app.getHttpServer()).post(path).set('Authorization', `Bearer ${pmcToken}`).send(body);
  const visits = () => `/projects/${f.projectA.id}/site-visits`;
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const open = async () => {
    const id = randomUUID();
    const r = await post(visits(), { id, claimedAt: ago(10) });
    expect(r.status, r.text).toBe(201);
    return id;
  };
  const end = async (id: string) => expect((await post(`${visits()}/${id}/end`, { claimedAt: ago(1) })).status).toBe(201);

  it('a visit start refuses such a `claimedAt` and writes nothing; the earliest and latest instants start one', async () => {
    for (const claimedAt of REFUSED) {
      const id = randomUUID();
      const r = await post(visits(), { id, claimedAt });
      expect({ claimedAt, status: r.status, body: r.body }).toEqual({ claimedAt, status: 400, body: refused('claimedAt') });
      expect(await t.prisma.siteVisit.count({ where: { id } }), claimedAt).toBe(0);
    }
    for (const claimedAt of [...EARLIEST, ...LATEST]) {
      const id = randomUUID();
      const r = await post(visits(), { id, claimedAt });
      expect(r.status, `${claimedAt}: ${r.text}`).toBe(201);
      await end(id);
    }
  });

  it('a visit start refuses such a device `location.at` and writes nothing; the earliest and latest instants start one', async () => {
    const location = (at: string) => ({ lat: 19.07, lng: 72.87, accuracyM: 8, at });
    for (const at of REFUSED) {
      const id = randomUUID();
      const r = await post(visits(), { id, claimedAt: ago(10), location: location(at) });
      expect({ at, status: r.status, body: r.body }).toEqual({ at, status: 400, body: refused('location.at') });
      expect(await t.prisma.siteVisit.count({ where: { id } }), at).toBe(0);
    }
    for (const at of [...EARLIEST, ...LATEST]) {
      const id = randomUUID();
      const r = await post(visits(), { id, claimedAt: ago(10), location: location(at) });
      expect(r.status, `${at}: ${r.text}`).toBe(201);
      await end(id);
    }
  });

  it('a visit end refuses such a `claimedAt` and leaves the visit open; the earliest and latest instants end it', async () => {
    const id = await open();
    try {
      for (const claimedAt of REFUSED) {
        const r = await post(`${visits()}/${id}/end`, { claimedAt });
        expect({ claimedAt, status: r.status, body: r.body }).toEqual({ claimedAt, status: 400, body: refused('claimedAt') });
      }
      expect((await t.prisma.siteVisit.findUniqueOrThrow({ where: { id } })).status).toBe('open');
    } finally {
      await end(id); // a failure above must not leave this visit open for the next test
    }
    for (const claimedAt of [...EARLIEST, ...LATEST]) {
      const visit = await open();
      const r = await post(`${visits()}/${visit}/end`, { claimedAt });
      expect(r.status, `${claimedAt}: ${r.text}`).toBe(201);
    }
  });

  it('a place walked refuses such a `claimedAt` and adds no place; the earliest and latest instants add one', async () => {
    const id = await open();
    try {
      for (const claimedAt of REFUSED) {
        const r = await post(`${visits()}/${id}/places`, { id: randomUUID(), nodeId: place, claimedAt });
        expect({ claimedAt, status: r.status, body: r.body }).toEqual({ claimedAt, status: 400, body: refused('claimedAt') });
      }
      expect(await t.prisma.siteVisitPlace.count({ where: { visitId: id } })).toBe(0);
    } finally {
      await end(id);
    }
    // a place is on a visit once, so each instant walks it on a visit of its own
    for (const claimedAt of [...EARLIEST, ...LATEST]) {
      const visit = await open();
      const r = await post(`${visits()}/${visit}/places`, { id: randomUUID(), nodeId: place, claimedAt });
      expect(r.status, `${claimedAt}: ${r.text}`).toBe(201);
      expect(await t.prisma.siteVisitPlace.count({ where: { visitId: visit } }), claimedAt).toBe(1);
      await end(visit);
    }
  });

  it('an override refuses such an `expiresAt` and writes none; the latest instant lands, and the earliest is past', async () => {
    const override = (expiresAt: string) => post(`/projects/${f.projectA.id}/activities/${activityId}/override`, { gate: 'drawing', state: 'ok', reason: 'Instant guard', expiresAt });
    for (const expiresAt of REFUSED) {
      const r = await override(expiresAt);
      expect({ expiresAt, status: r.status, body: r.body }).toEqual({ expiresAt, status: 400, body: refused('expiresAt') });
    }
    expect(await t.prisma.gateOverride.count({ where: { activityId } })).toBe(0);
    for (const expiresAt of LATEST) {
      const r = await override(expiresAt);
      expect(r.status, `${expiresAt}: ${r.text}`).toBe(201);
    }
    // the earliest instant passes the shape check and meets the route's own rule: an override always lapses forward
    for (const expiresAt of EARLIEST) {
      const r = await override(expiresAt);
      expect({ expiresAt, status: r.status, message: r.body.message }).toEqual({
        expiresAt, status: 400, message: 'An override must expire in the future — it is a temporary exception, never a permanent flag',
      });
    }
    expect(await t.prisma.gateOverride.count({ where: { activityId } })).toBe(LATEST.length);
  });
});
