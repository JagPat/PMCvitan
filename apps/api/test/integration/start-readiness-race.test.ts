import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { ActivitiesService } from '../../src/activities/activities.service';

/**
 * Phase 1 gate finding 1 (P1) — reproduce-first probes, written to assert the
 * CORRECT behavior and run RED against the pre-fix head:
 *
 *   1. two simultaneous starts of one ready activity have EXACTLY ONE winner
 *      (one 201, one 409, one audit command — never two);
 *   2. a readiness-affecting write cannot land BETWEEN start's readiness
 *      evaluation and its commit: the write serializes strictly before the
 *      start (start then refuses) or strictly after it (the write waits for
 *      start's commit) — a torn "201 with a failed gate" is impossible;
 *   3. the same protocol covers writes on OTHER tables (an override revoke),
 *      not just the Activity row itself;
 *   4. control: a gate flip committed BEFORE start always refuses with zero
 *      side effects (no status change, no actualStart, no audit command).
 */
describe('start vs readiness concurrency (integration)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let pmcToken: string;
  let svc: ActivitiesService;
  let origLoadReadiness: ActivitiesService['loadReadiness'];

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    pmcToken = t.issueProjectToken(f.memberUser.id, f.projectA.id); // pmc
    svc = t.app.get(ActivitiesService);
    origLoadReadiness = svc.loadReadiness.bind(svc);
  });

  afterEach(() => {
    // every probe restores the un-instrumented service
    svc.loadReadiness = origLoadReadiness;
  });

  afterAll(async () => {
    const projectId = f.projectA.id;
    await t.prisma.gateOverride.deleteMany({ where: { projectId } });
    await t.prisma.activity.deleteMany({ where: { projectId } });
    await f?.cleanup();
    await t?.close();
  });

  const http = () => request(t.app.getHttpServer());
  const as = (token: string) => (path: string, body: object = {}) => http().post(path).set('Authorization', `Bearer ${token}`).send(body);
  const patchAs = (token: string) => (path: string, body: object) => http().patch(path).set('Authorization', `Bearer ${token}`).send(body);

  async function makeActivity(name: string, extra: object = {}): Promise<string> {
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/activities`, { name, plannedStart: 0, plannedEnd: 5, ...extra })).status).toBe(201);
    return (await t.prisma.activity.findFirstOrThrow({ where: { projectId: f.projectA.id, name } })).id;
  }

  /** Instrument the service so start() parks at its readiness evaluation until
   *  released — the deterministic window the review's probe raced a write into. */
  function holdAtReadiness() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let arrived!: () => void;
    const held = new Promise<void>((r) => (arrived = r));
    svc.loadReadiness = async (...args: Parameters<ActivitiesService['loadReadiness']>) => {
      arrived();
      await gate;
      return origLoadReadiness(...args);
    };
    return { held, release };
  }

  /** Race a dispatched request against a timer: 'pending' means it had NOT
   *  settled — the serialization evidence the fixed protocol must show. */
  function settledWithin(p: Promise<unknown>, ms: number): Promise<'settled' | 'pending'> {
    return Promise.race([
      p.then(() => 'settled' as const, () => 'settled' as const),
      new Promise<'pending'>((r) => setTimeout(() => r('pending'), ms)),
    ]);
  }

  it('two simultaneous starts have exactly one winner and exactly one audited command', async () => {
    const actId = await makeActivity('Race: double start');

    const [r1, r2] = await Promise.all([
      Promise.resolve(as(pmcToken)(`/projects/${f.projectA.id}/activities/${actId}/start`)),
      Promise.resolve(as(pmcToken)(`/projects/${f.projectA.id}/activities/${actId}/start`)),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);

    const after = await t.prisma.activity.findUniqueOrThrow({ where: { id: actId } });
    expect(after.status).toBe('in_progress');
    const audits = await t.prisma.auditLog.count({ where: { projectId: f.projectA.id, action: 'activity.start', entityId: actId } });
    expect(audits).toBe(1); // the loser must leave NO duplicate command in the record
  });

  it('a stored-gate flip cannot land inside the start window — it strictly precedes (start refuses) or strictly follows (it waits for the commit)', async () => {
    const actId = await makeActivity('Race: gate flip vs start');

    const { held, release } = holdAtReadiness();
    const startReq = Promise.resolve(as(pmcToken)(`/projects/${f.projectA.id}/activities/${actId}/start`));
    await held; // start is now mid-evaluation, its transition not yet committed

    // the readiness-affecting write dispatched INTO the window
    const patchReq = Promise.resolve(patchAs(pmcToken)(`/projects/${f.projectA.id}/activities/${actId}`, { gateMaterial: 'fail' }));

    // THE FINDING: pre-fix this settles 200 inside the window and start still
    // commits 201 over a gate it never saw — the torn outcome. The protocol
    // must make the write WAIT until start's transaction ends.
    expect(await settledWithin(patchReq, 300)).toBe('pending');

    release();
    const [startRes, patchRes] = await Promise.all([startReq, patchReq]);
    expect(startRes.status).toBe(201); // start held the protocol first — it wins its serialized slot
    expect(patchRes.status).toBe(200); // ...and the flip lands strictly AFTER it

    const after = await t.prisma.activity.findUniqueOrThrow({ where: { id: actId } });
    expect(after.status).toBe('in_progress');
    expect(after.gateMaterial).toBe('fail'); // applied after the start, as a NEW fact
    expect(await t.prisma.auditLog.count({ where: { projectId: f.projectA.id, action: 'activity.start', entityId: actId } })).toBe(1);
  });

  it('the protocol covers writes beyond the Activity row: an override revoke waits for the start window too', async () => {
    // ready ONLY via an override: stored material gate says fail, an unexpired
    // override says ok — revoking it makes the activity unstartable
    const actId = await makeActivity('Race: revoke vs start', { gateMaterial: 'fail' });
    const future = new Date(Date.now() + 3600_000).toISOString();
    expect((await as(pmcToken)(`/projects/${f.projectA.id}/activities/${actId}/override`, { gate: 'material', state: 'ok', reason: 'stock verified at yard', expiresAt: future })).status).toBe(201);
    const override = await t.prisma.gateOverride.findFirstOrThrow({ where: { projectId: f.projectA.id, activityId: actId } });

    const { held, release } = holdAtReadiness();
    const startReq = Promise.resolve(as(pmcToken)(`/projects/${f.projectA.id}/activities/${actId}/start`));
    await held;

    const revokeReq = Promise.resolve(
      http().delete(`/projects/${f.projectA.id}/activities/${actId}/override/${override.id}`).set('Authorization', `Bearer ${pmcToken}`),
    );
    expect(await settledWithin(revokeReq, 300)).toBe('pending'); // a DIFFERENT table's write — still serialized

    release();
    const [startRes, revokeRes] = await Promise.all([startReq, revokeReq]);
    expect(startRes.status).toBe(201);
    expect(revokeRes.status).toBe(200);
    expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: actId } })).status).toBe('in_progress');
  });

  it('control: a flip committed BEFORE start refuses it with zero side effects', async () => {
    const actId = await makeActivity('Race control: committed flip');
    expect((await patchAs(pmcToken)(`/projects/${f.projectA.id}/activities/${actId}`, { gateMaterial: 'fail' })).status).toBe(200);

    const res = await as(pmcToken)(`/projects/${f.projectA.id}/activities/${actId}/start`);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/material/);

    const after = await t.prisma.activity.findUniqueOrThrow({ where: { id: actId } });
    expect(after.status).toBe('not_started');
    expect(after.actualStartDate).toBeNull();
    expect(await t.prisma.auditLog.count({ where: { projectId: f.projectA.id, action: 'activity.start', entityId: actId } })).toBe(0);
  });
});
