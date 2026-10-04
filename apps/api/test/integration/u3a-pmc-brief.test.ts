import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import type { PmcBriefProject, PmcBriefResult } from '@vitan/shared';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, wipeDecisionEvents, wipeDecisionsVia, type TwoProjectFixture } from './fixtures';
import { DecisionsService } from '../../src/decisions/decisions.service';
import { CLOCK, type Clock } from '../../src/common/clock';
import { addCivilDays, civilDayStartInstant, fromIsoCivilDate } from '../../src/common/civil-date';
import type { AuthUser } from '../../src/common/auth';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * U3a — `GET /me/brief`, the PMC's cross-project daily brief, against live PostgreSQL.
 *
 * TENANCY: the route is identity-scoped, so the reach IS the access check. A PMC sees exactly the
 * projects they run — their active `pmc` memberships and their org owner/admin reach — and never
 * another org's project, a project they only hold another role on, a removed membership's project,
 * or an archived one. A user with no PMC standing gets an empty brief, never an error that leaks.
 *
 * FIGURES: each on the project's own civil calendar — today's log status, client-held decisions
 * waiting, client approvals / progress photos / rejected inspections since the site's midnight
 * yesterday.
 */
describe('U3a — the PMC brief (GET /me/brief, live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let clock: Clock;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    clock = t.app.get<Clock>(CLOCK);
  });
  afterEach(async () => {
    await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor', 'ProjectionGeneration', 'DecisionProjection', 'DecisionApprovalRevision', 'CommandExecution'], { cascade: true });
    const scope = { projectId: { in: [f.projectA.id, f.projectB.id] } };
    // an approval leaves undeletable evidence (events) and frozen options: torn down through the
    // fixtures' sanctioned bypasses, as the decisions suites do
    await wipeDecisionEvents(t.prisma, { decision: scope });
    await wipeDecisionsVia(t.prisma, async (tx) => {
      await tx.decisionOption.deleteMany({ where: { decision: scope } });
      await tx.decision.deleteMany({ where: scope });
    });
    await t.prisma.auditLog.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
    await t.prisma.media.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
    await t.prisma.dailyLog.deleteMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } } });
    await t.prisma.project.updateMany({ where: { id: { in: [f.projectA.id, f.projectB.id] } }, data: { archivedAt: null } });
    await t.prisma.membership.updateMany({ where: { projectId: { in: [f.projectA.id, f.projectB.id] } }, data: { status: 'active' } });
  });
  afterAll(async () => {
    await f?.cleanup();
    await t?.close();
  });

  const brief = async (userId: string, projectId: string, role: 'pmc' | 'client' = 'pmc'): Promise<PmcBriefResult> => {
    const r = await request(t.app.getHttpServer()).get('/me/brief').set('Authorization', `Bearer ${t.issueProjectToken(userId, projectId, role)}`);
    expect(r.status).toBe(200);
    return r.body as PmcBriefResult;
  };
  const ids = (b: PmcBriefResult) => b.projects.map((p) => p.projectId).sort();
  const rowA = async (): Promise<PmcBriefProject> => (await brief(f.memberUser.id, f.projectA.id)).projects.find((p) => p.projectId === f.projectA.id)!;

  describe('who sees what', () => {
    it('a PMC sees exactly the projects they run; the other org never sees them', async () => {
      expect(ids(await brief(f.memberUser.id, f.projectA.id))).toEqual([f.projectA.id]);
      expect(ids(await brief(f.otherUser.id, f.projectB.id))).toEqual([f.projectB.id]);
    });

    it('an org owner reaches every project of their org as PMC, with no membership', async () => {
      const r = await request(t.app.getHttpServer()).get('/me/brief').set('Authorization', `Bearer ${t.issueOrgOwnerToken(f.ownerUser.id, f.projectA.id, f.orgA.id)}`);
      expect(r.status).toBe(200);
      expect(ids(r.body as PmcBriefResult)).toEqual([f.projectA.id]);
    });

    it('a client, a stranger, a removed PMC and an archived project get nothing', async () => {
      expect((await brief(f.clientUser.id, f.projectA.id, 'client')).projects).toEqual([]);
      expect((await brief(f.strangerUser.id, f.projectA.id)).projects).toEqual([]);
      await t.prisma.membership.updateMany({ where: { projectId: f.projectA.id, userId: f.memberUser.id }, data: { status: 'removed' } });
      expect((await brief(f.memberUser.id, f.projectA.id)).projects).toEqual([]);
      await t.prisma.membership.updateMany({ where: { projectId: f.projectA.id, userId: f.memberUser.id }, data: { status: 'active' } });
      await t.prisma.project.update({ where: { id: f.projectA.id }, data: { archivedAt: new Date() } });
      expect((await brief(f.memberUser.id, f.projectA.id)).projects).toEqual([]);
    });

    it('unauthenticated is refused', async () => {
      expect((await request(t.app.getHttpServer()).get('/me/brief')).status).toBe(401);
    });
  });

  describe("the figures, on the site's own calendar", () => {
    it("today's log: missing, then open, then sent", async () => {
      const today = clock.today('Asia/Kolkata');
      expect(await rowA()).toMatchObject({ today, logToday: 'missing' });
      const log = await t.prisma.dailyLog.create({ data: { projectId: f.projectA.id, date: today, logDate: fromIsoCivilDate(today) } });
      expect((await rowA()).logToday).toBe('open');
      await t.prisma.dailyLog.update({ where: { id: log.id }, data: { submitted: true } });
      expect((await rowA()).logToday).toBe('sent');
      // yesterday's sent log is not today's
      await t.prisma.dailyLog.deleteMany({ where: { projectId: f.projectA.id } });
      await t.prisma.dailyLog.create({ data: { projectId: f.projectA.id, date: 'y', logDate: fromIsoCivilDate(addCivilDays(today, -1)), submitted: true } });
      expect((await rowA()).logToday).toBe('missing');
    });

    it('progress photos and rejected inspections count from the site\'s midnight yesterday', async () => {
      const since = civilDayStartInstant(addCivilDays(clock.today('Asia/Kolkata'), -1), 'Asia/Kolkata');
      const before = new Date(since.getTime() - 60_000);
      await t.prisma.media.createMany({
        data: [
          { projectId: f.projectA.id, kind: 'progress', mime: 'image/png', uploadedBy: 'x' },
          { projectId: f.projectA.id, kind: 'progress', mime: 'image/png', uploadedBy: 'x', createdAt: since },
          { projectId: f.projectA.id, kind: 'progress', mime: 'image/png', uploadedBy: 'x', createdAt: before }, // before the window
          { projectId: f.projectA.id, kind: 'inspection', mime: 'image/png', uploadedBy: 'x' }, // not a progress photo
          { projectId: f.projectB.id, kind: 'progress', mime: 'image/png', uploadedBy: 'x' }, // another org's
        ],
      });
      const reject = (entityId: string, at?: Date) => ({ projectId: f.projectA.id, actor: 'pmc', action: 'inspection.reject', entity: 'Inspection', entityId, ...(at ? { at } : {}) });
      await t.prisma.auditLog.createMany({
        data: [reject('insp-1'), reject('insp-1'), reject('insp-2'), reject('insp-old', before),
          { projectId: f.projectA.id, actor: 'pmc', action: 'inspection.approve', entity: 'Inspection', entityId: 'insp-3' }],
      });
      expect((await rowA()).sinceYesterday).toMatchObject({ photos: 2, rejectedInspections: 2 });
    });

    it('a client-held decision waits on the client until they approve it; the approval is counted', async () => {
      const publishedAt = new Date(Date.now() - 3 * 86_400_000);
      await t.prisma.$transaction(async (tx) => {
        await tx.decision.create({
          data: {
            id: `it-u3a-dec-${f.projectA.id}`, projectId: f.projectA.id, title: 'Kitchen countertop', room: 'Kitchen', status: 'pending', ageDays: 0, photoSwatch: 'marble', publishedAt: null, authorId: f.memberUser.id,
            options: { createMany: { data: [
              { label: 'Option A', optionKey: 'a', material: 'Granite', delta: 0, swatch: 'teak', recommended: true, order: 0 },
              { label: 'Option B', optionKey: 'b', material: 'Quartz', delta: 20000, swatch: 'oak', recommended: false, order: 1 },
            ] } },
          },
        });
        await tx.decision.update({ where: { id: `it-u3a-dec-${f.projectA.id}` }, data: { publishedAt } });
      });
      expect(await rowA()).toMatchObject({ waitingOnClient: 1, oldestWaitingSince: publishedAt.toISOString(), sinceYesterday: { approvals: 0 } });

      const client = { sub: f.clientUser.id, role: 'client', projectId: f.projectA.id } as AuthUser;
      await t.app.get(DecisionsService).approve(f.projectA.id, `it-u3a-dec-${f.projectA.id}`, { optionIndex: 0 }, client, 'it-u3a-approve-1');
      expect(await rowA()).toMatchObject({ waitingOnClient: 0, oldestWaitingSince: null, sinceYesterday: { approvals: 1 } });
      // the other org's PMC sees none of it
      expect((await brief(f.otherUser.id, f.projectB.id)).projects[0]).toMatchObject({ waitingOnClient: 0, sinceYesterday: { approvals: 0, photos: 0, rejectedInspections: 0 } });
    });
  });
});
