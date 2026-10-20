import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { sanctionedReset } from '../../prisma/sanctioned-reset';
import { vi } from 'vitest';
import { SnapshotService } from '../../src/snapshot/snapshot.service';
import { InventoryParticipant } from '../../src/inventory/inventory.participant';
import { InspectionParticipant } from '../../src/inspections/inspection.participant';
import { MediaService } from '../../src/media/media.service';
import { StorageService } from '../../src/media/storage.service';
import { ActivitiesService } from '../../src/activities/activities.service';

/**
 * #482 site photos (Board, 14 Oct 2026) — every member deletes a site photo they added, within an hour of adding it;
 * nobody else's, and not after the hour. The PMC and the engineer keep deleting any photo. Proven through the real
 * routes against PostgreSQL. Reproduce-first: on main a contractor's DELETE is refused by role, and `mine` is absent.
 */
describe('a member deletes their own site photo within the hour (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let contractor: string;
  let client: string;
  let pmc: string;
  const contractorId = () => `${f.projectA.id}-del-contractor`;
  const px = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

  const http = () => request(t.app.getHttpServer());
  const photo = async (uploadedBy: string, createdAt: Date, kind = 'progress') =>
    (await t.prisma.media.create({ data: { projectId: f.projectA.id, kind, mime: 'image/png', uploadedBy, data: px, createdAt } })).id;
  const del = (id: string, token: string) => http().delete(`/media/${id}`).set('Authorization', `Bearer ${token}`);
  const exists = async (id: string) => (await t.prisma.media.findUnique({ where: { id } })) !== null;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    await t.prisma.user.create({ data: { id: contractorId(), projectId: f.projectA.id, role: 'contractor', name: 'Ravi Patel', email: `${contractorId()}@test.local` } });
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: contractorId(), role: 'contractor', status: 'active' } });
    contractor = t.issueProjectToken(contractorId(), f.projectA.id, 'contractor');
    client = t.issueProjectToken(f.clientUser.id, f.projectA.id, 'client');
    pmc = t.issueProjectToken(f.memberUser.id, f.projectA.id);
  });

  afterAll(async () => {
    await t?.prisma.media.deleteMany({ where: { projectId: f.projectA.id } });
    await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor', 'MembershipTransition'], { cascade: true });
    await t?.prisma.membership.deleteMany({ where: { userId: contractorId() } });
    await t?.prisma.user.deleteMany({ where: { id: contractorId() } });
    await f?.cleanup();
    await t?.close();
  });

  it('deletes a site photo the member added ten minutes ago, and records the removal', async () => {
    const id = await photo(contractorId(), minutesAgo(10));
    expect((await del(id, contractor).expect(200)).body).toEqual({ ok: true, dailyLogId: null });
    expect(await exists(id)).toBe(false);
    expect(await t.prisma.domainEvent.count({ where: { projectId: f.projectA.id, eventType: 'media.removed', entityId: id } })).toBe(1);
  });

  it('keeps a photo the member added more than an hour ago', async () => {
    const id = await photo(contractorId(), minutesAgo(61));
    const res = await del(id, contractor).expect(403);
    expect(res.body.message).toMatch(/within an hour/);
    expect(await exists(id)).toBe(true);
  });

  it('never deletes a photo another member added, however recent', async () => {
    const id = await photo(f.clientUser.id, minutesAgo(1));
    await del(id, contractor).expect(403);
    expect(await exists(id)).toBe(true);
  });

  it('never deletes a photo of theirs that is not a plain site photo', async () => {
    const id = await photo(contractorId(), minutesAgo(1), 'inspection');
    await del(id, contractor).expect(403);
    expect(await exists(id)).toBe(true);
  });

  it('keeps a photo of theirs filed on a daily log that was since sent, and deletes one on a log still open', async () => {
    const sent = await t.prisma.dailyLog.create({ data: { projectId: f.projectA.id, date: 'sent', submitted: true } });
    const open = await t.prisma.dailyLog.create({ data: { projectId: f.projectA.id, date: 'open' } });
    const filed = async (dailyLogId: string) =>
      (await t.prisma.media.create({ data: { projectId: f.projectA.id, kind: 'progress', mime: 'image/png', uploadedBy: contractorId(), data: px, createdAt: minutesAgo(3), dailyLogId } })).id;
    const onSent = await filed(sent.id);
    const onOpen = await filed(open.id);
    const res = await del(onSent, contractor).expect(403);
    expect(res.body.message).toMatch(/already sent/);
    expect(await exists(onSent)).toBe(true);
    // the reply names the log that counted it, so the app takes it off that day's count (Codex 4317884791)
    expect((await del(onOpen, contractor).expect(200)).body).toEqual({ ok: true, dailyLogId: open.id });
    expect(await exists(onOpen)).toBe(false);
    await t.prisma.media.deleteMany({ where: { dailyLogId: { in: [sent.id, open.id] } } });
    await t.prisma.dailyLog.deleteMany({ where: { id: { in: [sent.id, open.id] } } });
  });

  it('a submit racing the delete is never overtaken: the delete waits for it and refuses (Codex 4316959509)', async () => {
    const log = await t.prisma.dailyLog.create({ data: { projectId: f.projectA.id, date: 'racing' } });
    const id = (await t.prisma.media.create({ data: { projectId: f.projectA.id, kind: 'progress', mime: 'image/png', uploadedBy: contractorId(), data: px, createdAt: minutesAgo(3), dailyLogId: log.id } })).id;
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let updated!: () => void;
    const isUpdated = new Promise<void>((r) => { updated = r; });
    // the submit has written `submitted` and not yet committed
    const submit = t.prisma.$transaction(async (tx) => {
      await tx.dailyLog.update({ where: { id: log.id }, data: { submitted: true } });
      updated();
      await held;
    }, { timeout: 20_000 });
    await isUpdated;
    const deleting = del(id, contractor).then((r) => r);
    // released only once PostgreSQL shows the delete waiting on the log row's lock, never after a guessed delay
    // (Codex 4317884816): without the lock the delete never waits, and this times out
    const blockedOnLog = async (): Promise<boolean> =>
      (await t.prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FROM "DailyLog"%FOR SHARE%'`)[0]!.n > 0;
    const deadline = Date.now() + 10_000;
    while (!(await blockedOnLog())) {
      if (Date.now() > deadline) { release(); await submit; throw new Error('the delete never waited on the log row lock'); }
      await new Promise((r) => setTimeout(r, 20));
    }
    release();
    await submit;
    expect((await deleting).status).toBe(403);
    expect(await exists(id)).toBe(true);
    await t.prisma.media.deleteMany({ where: { id } });
    await t.prisma.dailyLog.deleteMany({ where: { id: log.id } });
  });

  it('the client deletes their own new photo too', async () => {
    const id = await photo(f.clientUser.id, minutesAgo(5));
    await del(id, client).expect(200);
    expect(await exists(id)).toBe(false);
  });

  it('the PMC still deletes any photo, at any age', async () => {
    const id = await photo(contractorId(), minutesAgo(600));
    await del(id, pmc).expect(200);
    expect(await exists(id)).toBe(false);
  });

  it('the snapshot says until when the viewer may delete a photo, only where the server would allow it (Codex 4316959519)', async () => {
    const at = minutesAgo(2);
    const own = await photo(contractorId(), at);
    const other = await photo(f.clientUser.id, minutesAgo(2));
    const old = await photo(contractorId(), minutesAgo(70));
    const evidence = await photo(contractorId(), minutesAgo(2), 'inspection');
    const sent = await t.prisma.dailyLog.create({ data: { projectId: f.projectA.id, date: 'sent-snap', submitted: true } });
    const onSent = (await t.prisma.media.create({ data: { projectId: f.projectA.id, kind: 'progress', mime: 'image/png', uploadedBy: contractorId(), data: px, createdAt: minutesAgo(2), dailyLogId: sent.id } })).id;
    const res = await http().get(`/projects/${f.projectA.id}/snapshot`).set('Authorization', `Bearer ${contractor}`).expect(200);
    const byId = new Map((res.body.photos as Array<{ id: string; deletableUntil?: string }>).map((p) => [p.id, p]));
    expect(byId.get(own)?.deletableUntil).toBe(new Date(at.getTime() + 60 * 60_000).toISOString());
    for (const id of [other, old, evidence, onSent]) {
      expect(byId.get(id)).toBeDefined();
      expect(byId.get(id)).not.toHaveProperty('deletableUntil');
    }
    await t.prisma.media.deleteMany({ where: { id: onSent } });
    await t.prisma.dailyLog.deleteMany({ where: { id: sent.id } });
  });

  it('a photo a record keeps as evidence is never offered for delete, as the delete refuses it (Codex 4320129763)', async () => {
    const cited = await photo(contractorId(), minutesAgo(2));
    const free = await photo(contractorId(), minutesAgo(2));
    // the contractor's own plain photo, cited on an inspection assigned to the site engineer: only the assignee may
    // remove it now
    const engineerId = `${f.projectA.id}-del-engineer`;
    await t.prisma.user.create({ data: { id: engineerId, projectId: f.projectA.id, role: 'engineer', name: 'Asha Shah', email: `${engineerId}@test.local` } });
    await t.prisma.membership.create({ data: { projectId: f.projectA.id, userId: engineerId, role: 'engineer', status: 'active' } });
    const inspectionId = `${f.projectA.id}-del-insp`;
    await t.prisma.inspection.create({
      data: { id: inspectionId, projectId: f.projectA.id, kind: 'review', title: 'Slab check', zone: 'Zone A', date: '20 Oct', submitted: true },
    });
    const item = await t.prisma.inspectionItem.create({ data: { inspectionId, name: 'Cover', result: 'PASS' } });
    await t.prisma.inspectionEvidence.create({ data: { projectId: f.projectA.id, inspectionId, inspectionItemId: item.id, mediaId: cited } });
    // linked first, then assigned (the evidence trigger lets only an assignee link once one is set)
    await t.prisma.inspection.update({ where: { id: inspectionId }, data: { assigneeId: engineerId } });
    try {
      const snap = await t.app.get(SnapshotService).build(f.projectA.id, 'contractor', contractorId());
      expect(snap.photos.find((p) => p.id === cited)).toBeDefined();
      expect(snap.photos.find((p) => p.id === cited)).not.toHaveProperty('deletableUntil');
      expect(snap.photos.find((p) => p.id === free)?.deletableUntil).toBeDefined();
      // the delete agrees with what the snapshot offered
      expect((await del(cited, contractor)).status).toBe(403);
      expect(await exists(cited)).toBe(true);
      expect((await del(free, contractor)).status).toBe(200);
    } finally {
      await t.prisma.inspectionEvidence.deleteMany({ where: { inspectionId } });
      await t.prisma.inspectionItem.deleteMany({ where: { inspectionId } });
      await t.prisma.inspection.deleteMany({ where: { id: inspectionId } });
      await t.prisma.membership.deleteMany({ where: { userId: engineerId } });
      await t.prisma.user.deleteMany({ where: { id: engineerId } });
    }
  });

  it('a photo a gate override cites is never offered, and its delete is a controlled refusal (Codex 4320515416)', async () => {
    const cited = await photo(contractorId(), minutesAgo(2));
    const activityId = `${f.projectA.id}-del-act`;
    await t.prisma.activity.create({ data: { id: activityId, projectId: f.projectA.id, name: 'Slab', zone: 'GF', plannedStart: 0, plannedEnd: 1 } });
    const override = await t.prisma.gateOverride.create({
      data: { projectId: f.projectA.id, activityId, gate: 'material', state: 'ok', reason: 'site photo shows the delivery', actorId: f.memberUser.id, actorName: 'PMC', expiresAt: new Date(Date.now() + 7 * 864e5), evidenceMediaId: cited },
    });
    try {
      const snap = await t.app.get(SnapshotService).build(f.projectA.id, 'contractor', contractorId());
      expect(snap.photos.find((p) => p.id === cited)).toBeDefined();
      expect(snap.photos.find((p) => p.id === cited)).not.toHaveProperty('deletableUntil');
      // a 409 the app can show, not the database's key error
      expect((await del(cited, contractor)).status).toBe(409);
      expect(await exists(cited)).toBe(true);
    } finally {
      await t.prisma.gateOverride.deleteMany({ where: { id: override.id } });
      await t.prisma.activity.deleteMany({ where: { id: activityId } });
    }
  });

  it('the snapshot asks each evidence module once for the whole photo window, never once per photo (Codex 4320515415)', async () => {
    const inventory = t.app.get(InventoryParticipant);
    const inspections = t.app.get(InspectionParticipant);
    const spies = [vi.spyOn(inventory, 'assertMediaDisposable'), vi.spyOn(inspections, 'assertEvidenceDisposable')];
    const calls = async (photos: number): Promise<number> => {
      for (let i = 0; i < photos; i++) await photo(contractorId(), minutesAgo(1));
      spies.forEach((s) => s.mockClear());
      const batched = vi.spyOn(inventory as unknown as { pinnedMedia: () => Promise<Set<string>> }, 'pinnedMedia');
      const snap = await t.app.get(SnapshotService).build(f.projectA.id, 'contractor', contractorId());
      expect(snap.photos.filter((p) => p.deletableUntil).length).toBeGreaterThanOrEqual(photos);
      const n = batched.mock.calls.length;
      batched.mockRestore();
      // no single-photo guard ran for the snapshot
      expect(spies.reduce((sum, s) => sum + s.mock.calls.length, 0)).toBe(0);
      return n;
    };
    try {
      expect(await calls(2)).toBe(1);
      expect(await calls(8)).toBe(1);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });

  it('the PMC is offered every photo with no deadline, never one a record keeps (Codex 4320912804)', async () => {
    const othersRecent = await photo(contractorId(), minutesAgo(2));
    const ownOld = await photo(f.memberUser.id, minutesAgo(70));
    const pinned = await photo(contractorId(), minutesAgo(2));
    const activityId = `${f.projectA.id}-del-act-staff`;
    await t.prisma.activity.create({ data: { id: activityId, projectId: f.projectA.id, name: 'Slab', zone: 'GF', plannedStart: 0, plannedEnd: 1 } });
    const override = await t.prisma.gateOverride.create({
      data: { projectId: f.projectA.id, activityId, gate: 'material', state: 'ok', reason: 'delivery photo', actorId: f.memberUser.id, actorName: 'PMC', expiresAt: new Date(Date.now() + 7 * 864e5), evidenceMediaId: pinned },
    });
    try {
      const snap = await t.app.get(SnapshotService).build(f.projectA.id, 'pmc', f.memberUser.id);
      const byId = (id: string) => snap.photos.find((p) => p.id === id);
      for (const id of [othersRecent, ownOld]) {
        expect(byId(id)?.deletable).toBe(true);
        expect(byId(id)).not.toHaveProperty('deletableUntil');
      }
      expect(byId(pinned)).toBeDefined();
      expect(byId(pinned)).not.toHaveProperty('deletable');
      // what the snapshot offered, the delete takes
      expect((await del(othersRecent, pmc)).status).toBe(200);
      expect((await del(ownOld, pmc)).status).toBe(200);
      expect((await del(pinned, pmc)).status).toBe(409);
    } finally {
      await t.prisma.gateOverride.deleteMany({ where: { id: override.id } });
      await t.prisma.activity.deleteMany({ where: { id: activityId } });
    }
  });

  it('a citation that lands after the guards asked refuses the delete with a 409 and keeps the file (Codex 4320912811)', async () => {
    const id = await photo(contractorId(), minutesAgo(2));
    await t.prisma.media.update({ where: { id }, data: { storageKey: `site/${id}.png` } });
    const activityId = `${f.projectA.id}-del-act-race`;
    await t.prisma.activity.create({ data: { id: activityId, projectId: f.projectA.id, name: 'Slab', zone: 'GF', plannedStart: 0, plannedEnd: 1 } });
    // the guards answer "free", then a PMC's override cites the photo and commits before the row is deleted
    const disposability = (t.app.get(MediaService) as unknown as { disposability: { assertDisposable: (...a: unknown[]) => Promise<unknown> } }).disposability;
    const real = disposability.assertDisposable.bind(disposability);
    const guard = vi.spyOn(disposability, 'assertDisposable').mockImplementationOnce(async (...a: unknown[]) => {
      const observed = await real(...a);
      await t.prisma.gateOverride.create({
        data: { projectId: f.projectA.id, activityId, gate: 'material', state: 'ok', reason: 'late citation', actorId: f.memberUser.id, actorName: 'PMC', expiresAt: new Date(Date.now() + 864e5), evidenceMediaId: id },
      });
      return observed;
    });
    const removeObject = vi.spyOn(t.app.get(StorageService), 'remove');
    try {
      const res = await del(id, contractor);
      expect(res.status).toBe(409);
      expect(await exists(id)).toBe(true);
      expect(removeObject).not.toHaveBeenCalled();
    } finally {
      guard.mockRestore();
      removeObject.mockRestore();
      await t.prisma.gateOverride.deleteMany({ where: { activityId } });
      await t.prisma.activity.deleteMany({ where: { id: activityId } });
    }
  });

  it('an override citing a photo deleted a moment before is a 400, never a 500 (the delete-first order)', async () => {
    const activityId = `${f.projectA.id}-del-act-mirror`;
    await t.prisma.activity.create({ data: { id: activityId, projectId: f.projectA.id, name: 'Slab', zone: 'GF', plannedStart: 0, plannedEnd: 1 } });
    // the photo check saw it; its delete committed before the override row was written
    const check = vi.spyOn(t.prisma.media, 'findFirst').mockResolvedValueOnce({ id: 'just-deleted' } as never);
    try {
      await expect(t.app.get(ActivitiesService).override(f.projectA.id, activityId, {
        gate: 'material', state: 'ok', reason: 'delivery photo', expiresAt: new Date(Date.now() + 864e5).toISOString(), evidenceMediaId: 'just-deleted',
      } as never, { sub: f.memberUser.id, role: 'pmc', projectId: f.projectA.id } as never)).rejects.toMatchObject({ status: 400 });
      expect(await t.prisma.gateOverride.count({ where: { activityId } })).toBe(0);
    } finally {
      check.mockRestore();
      await t.prisma.activity.deleteMany({ where: { id: activityId } });
    }
  });

  it('a role the delete route refuses is never offered it, even on a photo it added (Codex 4319006650)', async () => {
    const own = await photo(contractorId(), minutesAgo(2));
    const asArchitect = await t.app.get(SnapshotService).build(f.projectA.id, 'architect', contractorId());
    expect(asArchitect.photos.find((p) => p.id === own)).not.toHaveProperty('deletableUntil');
    const asContractor = await t.app.get(SnapshotService).build(f.projectA.id, 'contractor', contractorId());
    expect(asContractor.photos.find((p) => p.id === own)?.deletableUntil).toBeDefined();
  });
});
