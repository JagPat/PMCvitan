import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * Codex round-2 finding: mixed ISO/offset creates and partial updates validated
 * each representation separately — the FINAL merged window could be reversed and
 * persisted with 201/200. The services must validate the RESOLVED dates.
 * Probes reproduced verbatim from the round-2 review.
 */
describe('merged schedule windows are validated at the service (integration)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let token: string;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    // the schedule anchor the offsets resolve against
    await t.prisma.project.update({
      where: { id: f.projectA.id },
      data: { scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    token = t.issueProjectToken(f.memberUser.id, f.projectA.id);
  });

  afterAll(async () => {
    await t.prisma.activity.deleteMany({ where: { projectId: f.projectA.id } });
    await t.prisma.phase.deleteMany({ where: { projectId: f.projectA.id } });
    await f?.cleanup();
    await t?.close();
  });

  const http = () => request(t.app.getHttpServer());
  const auth = { Authorization: '' };
  const post = (path: string, body: object) => http().post(path).set('Authorization', `Bearer ${token}`).send(body);
  const patch = (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body);

  it('a phase created from ISO start + offset end resolving reversed is a 400, never persisted', async () => {
    // probe: ISO start 2026-08-01 with plannedEnd offset 0 → merged end 2026-06-01 < start
    const res = await post(`/projects/${f.projectA.id}/phases`, { name: 'Reversed Phase', plannedStartDate: '2026-08-01', plannedEnd: 0 });
    expect(res.status).toBe(400);
    expect(await t.prisma.phase.findFirst({ where: { projectId: f.projectA.id, name: 'Reversed Phase' } })).toBeNull();
  });

  it('an activity created from ISO start + offset end resolving reversed is a 400, never persisted', async () => {
    // offsets are ORDERED (0 ≤ 5) so the schema refine passes — but the ISO start
    // resolves past the offset-derived end (anchor+5 = 2026-06-06): merged = reversed
    const res = await post(`/projects/${f.projectA.id}/activities`, {
      name: 'Reversed Activity', plannedStartDate: '2026-08-01', plannedStart: 0, plannedEnd: 5,
    });
    expect(res.status).toBe(400);
    expect(await t.prisma.activity.findFirst({ where: { projectId: f.projectA.id, name: 'Reversed Activity' } })).toBeNull();
    void auth;
  });

  it('a partial update whose merged window is reversed is a 400, never persisted', async () => {
    // an activity honestly planned for January…
    const ok = await post(`/projects/${f.projectA.id}/activities`, {
      name: 'January Work', plannedStart: 0, plannedEnd: 0, plannedStartDate: '2026-01-01', plannedEndDate: '2026-01-01',
    });
    expect(ok.status).toBe(201);
    const created = await t.prisma.activity.findFirstOrThrow({ where: { projectId: f.projectA.id, name: 'January Work' } });

    // …probe: move ONLY the start to August — merged window 2026-08-01 → 2026-01-01
    const res = await patch(`/projects/${f.projectA.id}/activities/${created.id}`, { plannedStartDate: '2026-08-01' });
    expect(res.status).toBe(400);
    const after = await t.prisma.activity.findUniqueOrThrow({ where: { id: created.id } });
    expect(after.plannedStartDate?.toISOString().slice(0, 10)).toBe('2026-01-01'); // untouched
  });

  it('a valid start-only partial update never clears the stored end date', async () => {
    // pins the leak found while fixing the probe above: the start-only spread used
    // to carry plannedEndDate:null into the update, silently erasing the end date
    const ok = await post(`/projects/${f.projectA.id}/activities`, {
      name: 'February Work', plannedStart: 0, plannedEnd: 0, plannedStartDate: '2026-02-01', plannedEndDate: '2026-02-10',
    });
    expect(ok.status).toBe(201);
    const created = await t.prisma.activity.findFirstOrThrow({ where: { projectId: f.projectA.id, name: 'February Work' } });

    const res = await patch(`/projects/${f.projectA.id}/activities/${created.id}`, { plannedStartDate: '2026-02-05' });
    expect(res.status).toBe(200);
    const after = await t.prisma.activity.findUniqueOrThrow({ where: { id: created.id } });
    expect(after.plannedStartDate?.toISOString().slice(0, 10)).toBe('2026-02-05');
    expect(after.plannedEndDate?.toISOString().slice(0, 10)).toBe('2026-02-10'); // NOT cleared
  });
});
