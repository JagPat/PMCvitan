import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { emitEvent } from '../../src/platform/events';
import { OutboxRelay } from '../../src/platform/outbox/relay.service';
import { ProjectionRebuilder } from '../../src/platform/projections/rebuilder.service';
import { DrawingsService } from '../../src/drawings/drawings.service';
import { DrawingsQueryService } from '../../src/drawings/drawings.query';
import { DRAWINGS_PROJECTION } from '../../src/drawings/drawings.projection';
import type { AuthUser } from '../../src/common/auth';

/**
 * Phase 2 Task 10 — the MODULE-OWNED drawings read is tenant-isolated, RECIPIENT-isolated and
 * lifecycle-correct against live PostgreSQL. The module read (query + `GET …/drawings`) must:
 *   • never serve one project's register for another (cross-project) or across orgs (cross-org);
 *   • reject a caller whose membership was removed (membership-authoritative auth, SEC-01);
 *   • bake the CORRECT per-viewer distribution facts from the ONE shared projection row — a governing
 *     revision's frozen recipient sees `recipientOfCurrent`/`ackedByMe` for themselves, a non-recipient
 *     never does — so a projection is never a recipient/ack disclosure across viewers;
 *   • stay correct when a WRITE lands after catch-up (rebuild-while-writing) and upgrade a LEGACY project
 *     from the live fallback onto the projection.
 */

const TINY_PDF = Buffer.from('%PDF-1.4 iso').toString('base64');
const TRUNCATE = 'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DrawingsProjection"';

describe('Phase 2 Task 10 — drawings module read isolation + recipient isolation + lifecycle (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let relay: OutboxRelay;
  let rebuilder: ProjectionRebuilder;
  let svc: DrawingsService;
  let query: DrawingsQueryService;
  let projSeq = 0;

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    relay = t.app.get(OutboxRelay);
    rebuilder = t.app.get(ProjectionRebuilder);
    svc = t.app.get(DrawingsService);
    query = t.app.get(DrawingsQueryService);
  });
  afterAll(async () => {
    await t?.prisma.$executeRawUnsafe(TRUNCATE);
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe(TRUNCATE);
    const pids = { startsWith: 'it-dwiso-' };
    const both = { in: [f.projectA.id, f.projectB.id] };
    await t.prisma.drawingRecipient.deleteMany({ where: { OR: [{ projectId: pids }, { projectId: both }] } });
    await t.prisma.drawingRevision.deleteMany({ where: { OR: [{ projectId: pids }, { projectId: both }] } });
    await t.prisma.drawing.deleteMany({ where: { OR: [{ projectId: pids }, { projectId: both }] } });
    await t.prisma.membership.deleteMany({ where: { projectId: pids } });
    await t.prisma.user.deleteMany({ where: { id: { startsWith: 'it-dwiso-u-' } } });
    await t.prisma.project.deleteMany({ where: { id: pids } });
  });

  /** A fresh project with the pmc issuer + one active engineer recipient. Returns { p, engId }. */
  const freshProject = async (orgId: string = f.orgA.id): Promise<{ p: string; engId: string }> => {
    const p = `it-dwiso-${Date.now() % 1e6}-${projSeq++}`;
    await t.prisma.project.create({
      data: { id: p, orgId, name: p, short: 'O', descriptor: '', stage: 'x', siteCode: 'O', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    });
    await t.prisma.membership.create({ data: { projectId: p, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    const engId = `it-dwiso-u-eng-${projSeq}`;
    await t.prisma.user.create({ data: { id: engId, projectId: p, role: 'engineer', name: 'Eng Recipient', email: `${engId}@t.local` } });
    await t.prisma.membership.create({ data: { projectId: p, userId: engId, role: 'engineer', status: 'active' } });
    return { p, engId };
  };

  const issue = (projectId: string, number = 'A-201', rev = 'A') =>
    svc.issue(projectId, pmc(projectId), { number, title: 'Plan', discipline: 'architectural', rev, status: 'for_construction', mime: 'application/pdf', data: TINY_PDF, publish: true });

  const applyProjection = async (projectId: string): Promise<void> => {
    for (let pass = 0; pass < 50; pass++) {
      const ds = await t.prisma.outboxDelivery.findMany({ where: { consumer: DRAWINGS_PROJECTION, projectId, status: { in: ['pending', 'leased'] } }, orderBy: { streamPosition: 'asc' } });
      if (!ds.length) return;
      let progressed = false;
      for (const d of ds) {
        const o = await relay.dispatchOne(d.id);
        if (o === 'succeeded' || o === 'duplicate' || o === 'dead') progressed = true;
      }
      if (!progressed) return;
    }
  };

  // ── Cross-project / cross-org / membership isolation ───────────────────────────────────────────

  it('cross-project (query): moduleDrawings(A) returns ONLY A’s register, never B’s', async () => {
    const { p: a } = await freshProject();
    const { p: b } = await freshProject();
    await issue(a, 'A-only', 'A');
    await issue(b, 'B-only', 'A');
    await applyProjection(a);
    await applyProjection(b);
    const modA = await query.moduleDrawings(a, f.memberUser.id);
    const modB = await query.moduleDrawings(b, f.memberUser.id);
    expect(modA.drawings.map((d) => d.number)).toEqual(['A-only']);
    expect(modB.drawings.map((d) => d.number)).toEqual(['B-only']);
    expect(modA.drawings.some((d) => d.number === 'B-only')).toBe(false);
    expect(modB.drawings.some((d) => d.number === 'A-only')).toBe(false);
  });

  it('cross-org (HTTP): a member of org A cannot read org B’s project drawings (403)', async () => {
    const token = t.issueProjectToken(f.memberUser.id, f.projectB.id, 'pmc');
    await request(t.app.getHttpServer()).get(`/projects/${f.projectB.id}/drawings`).set('Authorization', `Bearer ${token}`).expect(403);
    const tokenB = t.issueProjectToken(f.otherUser.id, f.projectA.id, 'pmc');
    await request(t.app.getHttpServer()).get(`/projects/${f.projectA.id}/drawings`).set('Authorization', `Bearer ${tokenB}`).expect(403);
  });

  it('cross-project (HTTP): a same-org project the caller is NOT a member of is forbidden (403)', async () => {
    const { p: other } = await freshProject(f.orgA.id);
    await t.prisma.membership.deleteMany({ where: { projectId: other, userId: f.memberUser.id } }); // revoke the seeded pmc membership
    const token = t.issueProjectToken(f.memberUser.id, other, 'pmc');
    await request(t.app.getHttpServer()).get(`/projects/${other}/drawings`).set('Authorization', `Bearer ${token}`).expect(403);
  });

  it('removed-membership (HTTP): a caller whose membership was removed can no longer read (403)', async () => {
    const { p } = await freshProject(f.orgA.id);
    await issue(p, 'RM-1', 'A');
    const token = t.issueProjectToken(f.memberUser.id, p, 'pmc');
    await request(t.app.getHttpServer()).get(`/projects/${p}/drawings`).set('Authorization', `Bearer ${token}`).expect(200);
    await t.prisma.membership.deleteMany({ where: { projectId: p, userId: f.memberUser.id } });
    await request(t.app.getHttpServer()).get(`/projects/${p}/drawings`).set('Authorization', `Bearer ${token}`).expect(403);
  });

  // ── Recipient isolation: ONE projection row bakes DIFFERENT per-viewer distribution facts ───────

  it('recipient isolation: the frozen recipient sees recipientOfCurrent + their own ack; a non-recipient never does', async () => {
    const { p, engId } = await freshProject();
    const { revisionId } = await issue(p, 'REC-1', 'A'); // published for_construction → engineer frozen as recipient
    await applyProjection(p);

    // baked from the SAME projection row, per viewer:
    const asEng = (await query.moduleDrawings(p, engId)).drawings.find((d) => d.number === 'REC-1')!;
    const asPmc = (await query.moduleDrawings(p, f.memberUser.id)).drawings.find((d) => d.number === 'REC-1')!;
    expect(asEng.recipientOfCurrent).toBe(true); // the engineer IS on the governing revision's distribution
    expect(asPmc.recipientOfCurrent).toBe(false); // the pmc issuer is NOT a recipient
    expect(asEng.ackedByMe).toBe(false); // not acked yet
    // the current revision's recipient list shows the engineer, unacked
    expect(asEng.current?.recipients?.some((r) => r.role === 'engineer' && !r.acked)).toBe(true);

    // the engineer acknowledges → a fresh projection row bakes ackedByMe=true for THEM only
    await svc.acknowledge(p, revisionId, { sub: engId, role: 'engineer', projectId: p } as AuthUser);
    await applyProjection(p);
    const engAfter = (await query.moduleDrawings(p, engId)).drawings.find((d) => d.number === 'REC-1')!;
    const pmcAfter = (await query.moduleDrawings(p, f.memberUser.id)).drawings.find((d) => d.number === 'REC-1')!;
    expect(engAfter.ackedByMe).toBe(true);
    expect(pmcAfter.ackedByMe).toBe(false); // the pmc did not ack — never disclosed as theirs
    expect(engAfter.current?.recipients?.some((r) => r.role === 'engineer' && r.acked)).toBe(true);
  });

  // ── Lifecycle: rebuild-while-writing, legacy upgrade ───────────────────────────────────────────

  it('rebuild-while-writing: a write after catch-up lags the generation, then a rebuild catches up to head', async () => {
    const { p } = await freshProject();
    await issue(p, 'RW-1', 'A');
    await applyProjection(p);
    expect((await query.projectionSlice(p, f.memberUser.id)).generation).toBe(1);

    await issue(p, 'RW-2', 'A'); // committed, not yet applied → lags head
    expect((await query.projectionSlice(p, f.memberUser.id)).generation).toBeNull();
    expect((await query.moduleDrawings(p, f.memberUser.id)).source).toBe('live');

    const stream = await t.prisma.projectEventStream.findUniqueOrThrow({ where: { projectId: p } });
    const res = await rebuilder.rebuild(DRAWINGS_PROJECTION, p);
    expect(res.checkpoint).toBe(stream.nextPosition - 1n);
    const proj = await query.projectionSlice(p, f.memberUser.id);
    expect(proj.generation).toBe(2);
    expect(proj.drawings.map((d) => d.number).sort()).toEqual(['RW-1', 'RW-2']);
  });

  it('legacy-upgraded (HTTP): a legacy project reads LIVE, then serves the PROJECTION once its first drawing event lands', async () => {
    const { p } = await freshProject(f.orgA.id);
    // canonical drawing with NO drawing events — the pre-projection (legacy) shape
    const d = await t.prisma.drawing.create({ data: { projectId: p, number: 'LEG-1', title: 'Legacy', discipline: 'architectural', publishedAt: new Date(), authorId: f.memberUser.id } });
    await t.prisma.drawingRevision.create({ data: { projectId: p, drawingId: d.id, rev: 'A', status: 'for_construction', mime: 'application/pdf', data: Buffer.from('x'), sizeBytes: 1, issuedBy: 'PMC', issuedAt: '01 Jun 2026' } });
    const token = t.issueProjectToken(f.memberUser.id, p, 'pmc');

    const before = await request(t.app.getHttpServer()).get(`/projects/${p}/drawings`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(before.body.source).toBe('live'); // no stream/generation yet → live fallback
    expect(before.body.drawings.map((x: { number: string }) => x.number)).toEqual(['LEG-1']);

    // UPGRADE: the project's first drawing event drives the projection (the handler reads canonical, so
    // the pre-existing legacy drawing is captured) → now served from the rebuilt read model, same data.
    const sys = { actorId: f.memberUser.id, actorName: 'System', actorRole: 'system', actorKind: 'system' as const };
    await t.prisma.$transaction((tx) => emitEvent(tx, { projectId: p, actor: sys, eventType: 'drawing.published', entityType: 'Drawing', entityId: d.id, effectKey: 'drawing.published', dispatch: {} }));
    await applyProjection(p);
    const after = await request(t.app.getHttpServer()).get(`/projects/${p}/drawings`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(after.body.source).toBe('projection');
    expect(after.body.drawings.map((x: { number: string }) => x.number)).toEqual(['LEG-1']);
  });
});
