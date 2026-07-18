import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import type { Drawing } from '@vitan/shared';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { emitEvent } from '../../src/platform/events';
import { OutboxRelay } from '../../src/platform/outbox/relay.service';
import { ProjectionRebuilder } from '../../src/platform/projections/rebuilder.service';
import { DrawingsService } from '../../src/drawings/drawings.service';
import { DrawingsQueryService } from '../../src/drawings/drawings.query';
import { DRAWINGS_PROJECTION } from '../../src/drawings/drawings.projection';
import type { AuthUser } from '../../src/common/auth';
import type { Actor } from '../../src/common/actor';

/**
 * Phase 2 Task 10 — the DRAWINGS read path moves onto its rebuildable projection, proven EQUIVALENT to
 * the live snapshot register (the Task-1 characterization) and proven live == rebuild.
 *
 * The `drawings.inbox` projection consumer (registered at boot) maintains ONE per-project
 * DrawingsProjection base row from canonical state on every `drawing.*` event. Like daily-log (a per-
 * PROJECT composite, not one row per entity), the module's `projectionSlice` bakes the whole register
 * from that base — and the baked register is byte-identical to `snapshotSlice`, before and after a full
 * rebuild. The finding-1 servability gate (never serve a lagging/blocked/no-row generation) is proven
 * exactly as for daily-log.
 */

const human: Actor = { actorId: '', actorName: 'System', actorRole: 'system', actorKind: 'system' };
const TINY_PDF = Buffer.from('%PDF-1.4 test drawing').toString('base64');

/** Normalize the short-lived signed `?t=` token out of every revision url so the comparison is stable
 *  across two reads (each read mints a fresh token; the PATH is what must match). */
function stripUrls(ds: readonly Drawing[]): Drawing[] {
  const bare = (u: string) => u.split('?')[0];
  return ds.map((d) => ({
    ...d,
    current: d.current ? { ...d.current, url: bare(d.current.url) } : null,
    revisions: d.revisions.map((r) => ({ ...r, url: bare(r.url) })),
  }));
}

describe('Phase 2 Task 10 — drawings projection == live register, live == rebuild (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let relay: OutboxRelay;
  let rebuilder: ProjectionRebuilder;
  let svc: DrawingsService;
  let query: DrawingsQueryService;
  let projSeq = 0;

  const TRUNCATE = 'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DrawingsProjection"';

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    relay = t.app.get(OutboxRelay);
    rebuilder = t.app.get(ProjectionRebuilder);
    svc = t.app.get(DrawingsService);
    query = t.app.get(DrawingsQueryService);
    human.actorId = f.memberUser.id;
  });
  afterAll(async () => {
    await t?.prisma.$executeRawUnsafe(TRUNCATE);
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe(TRUNCATE);
    await t.prisma.drawingRecipient.deleteMany({ where: { projectId: { startsWith: 'it-dwpj-' } } });
    await t.prisma.drawingRevision.deleteMany({ where: { projectId: { startsWith: 'it-dwpj-' } } });
    await t.prisma.drawing.deleteMany({ where: { projectId: { startsWith: 'it-dwpj-' } } });
    await t.prisma.membership.deleteMany({ where: { projectId: { startsWith: 'it-dwpj-' } } });
    await t.prisma.user.deleteMany({ where: { id: { startsWith: 'it-dwpj-u-' } } });
    await t.prisma.project.deleteMany({ where: { id: { startsWith: 'it-dwpj-' } } });
  });

  /** A fresh project with an active pmc issuer + one active engineer recipient (so a published issue
   *  freezes a real recipient). Returns the project id. */
  const freshProject = async (): Promise<string> => {
    const id = `it-dwpj-${Date.now() % 1e6}-${projSeq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'O', descriptor: '', stage: 'x', siteCode: 'O', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    const eng = `it-dwpj-u-eng-${projSeq}`;
    await t.prisma.user.create({ data: { id: eng, projectId: id, role: 'engineer', name: 'Eng One', email: `${eng}@t.local` } });
    await t.prisma.membership.create({ data: { projectId: id, userId: eng, role: 'engineer', status: 'active' } });
    return id;
  };

  type IssueOpts = { number?: string; rev?: string; status?: 'for_review' | 'for_construction'; publish?: boolean };
  const issue = (projectId: string, o: IssueOpts = {}) =>
    svc.issue(projectId, pmc(projectId), {
      number: o.number ?? 'A-201', title: 'Controlled Plan', discipline: 'architectural',
      rev: o.rev ?? 'A', status: o.status ?? 'for_construction', mime: 'application/pdf', data: TINY_PDF,
      publish: o.publish ?? true,
    });

  /** Seed a CANONICAL drawing WITHOUT emitting any drawing event — the legacy/pre-projection shape the
   *  finding-1 probe needs (real data, no drawing delivery to apply). */
  const seedLegacyDrawing = async (projectId: string, number: string): Promise<void> => {
    const d = await t.prisma.drawing.create({ data: { projectId, number, title: 'Legacy', discipline: 'architectural', publishedAt: new Date(), authorId: f.memberUser.id } });
    await t.prisma.drawingRevision.create({ data: { projectId, drawingId: d.id, rev: 'A', status: 'for_construction', mime: 'application/pdf', data: Buffer.from('x'), sizeBytes: 1, issuedBy: 'PMC', issuedAt: '01 Jun 2026' } });
  };

  /** Drain every pending drawings.inbox (and noop) delivery for a project. */
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

  it('the projection register is BYTE-IDENTICAL to the live snapshot register', async () => {
    const p = await freshProject();
    await issue(p, { number: 'A-201', rev: 'A', status: 'for_construction', publish: true });
    await issue(p, { number: 'A-201', rev: 'B', status: 'for_construction', publish: true }); // supersedes A
    await issue(p, { number: 'S-101', rev: 'A', status: 'for_review', publish: true }); // review-only → no governing
    await applyProjection(p);

    const live = await query.snapshotSlice(p, f.memberUser.id);
    const proj = await query.projectionSlice(p, f.memberUser.id);
    expect(proj.generation).toBe(1); // served from an ACTIVE generation
    expect(stripUrls(proj.drawings)).toEqual(stripUrls(live));
    // structure sanity: the governing revision is Rev B (for_construction), the review-only drawing has none
    const a201 = proj.drawings.find((d) => d.number === 'A-201')!;
    expect(a201.current?.rev).toBe('B');
    expect(proj.drawings.find((d) => d.number === 'S-101')!.current).toBeNull();
  });

  // ── Finding 1: serve a generation ONLY when healthy, caught up AND its row exists ──

  it('finding 1: legacy canonical data + only a no-op serves LIVE, never authoritative-empty projection', async () => {
    const p = await freshProject();
    await seedLegacyDrawing(p, 'L-001'); // canonical drawing, NO drawing event ever emitted
    await t.prisma.$transaction((tx) => emitEvent(tx, { projectId: p, actor: human, eventType: 'project.created', entityType: 'Project', entityId: p, effectKey: 'project.created', dispatch: {} }));
    await applyProjection(p);
    const gen = await t.prisma.projectionGeneration.findFirst({ where: { consumer: DRAWINGS_PROJECTION, projectId: p, status: 'active' } });
    expect(gen).not.toBeNull(); // an active, caught-up generation exists — but has no row for this project
    const mod = await query.moduleDrawings(p, f.memberUser.id);
    expect(mod.source).toBe('live'); // MUST fall back to canonical live, not serve the empty projection
    expect(mod.drawings.map((d) => d.number)).toEqual(['L-001']);
    expect((await query.projectionSlice(p, f.memberUser.id)).generation).toBeNull();
  });

  it('finding 1: no drawings AND only a no-op falls back to live (empty, generation null)', async () => {
    const p = await freshProject();
    await t.prisma.$transaction((tx) => emitEvent(tx, { projectId: p, actor: human, eventType: 'project.created', entityType: 'Project', entityId: p, effectKey: 'project.created', dispatch: {} }));
    await applyProjection(p);
    expect((await query.projectionSlice(p, f.memberUser.id)).generation).toBeNull();
    const mod = await query.moduleDrawings(p, f.memberUser.id);
    expect(mod.source).toBe('live');
    expect(mod.drawings).toEqual([]);
  });

  it('finding 1: a LAGGING checkpoint (a committed issue not yet applied) serves live', async () => {
    const p = await freshProject();
    await issue(p, { number: 'A-1', rev: 'A', publish: true });
    await applyProjection(p);
    expect((await query.projectionSlice(p, f.memberUser.id)).generation).toBe(1); // fully applied → servable
    await issue(p, { number: 'A-2', rev: 'A', publish: true }); // committed but NOT applied → checkpoint lags head
    const proj = await query.projectionSlice(p, f.memberUser.id);
    expect(proj.generation).toBeNull(); // appliedPosition < stream head → not current → fallback
    const mod = await query.moduleDrawings(p, f.memberUser.id);
    expect(mod.source).toBe('live');
    expect(mod.drawings.map((d) => d.number).sort()).toEqual(['A-1', 'A-2']); // live reflects newest canonical
  });

  it('finding 1: a BLOCKED generation serves live', async () => {
    const p = await freshProject();
    await issue(p, { number: 'B-1', rev: 'A', publish: true });
    await applyProjection(p);
    expect((await query.projectionSlice(p, f.memberUser.id)).generation).toBe(1);
    await t.prisma.projectionGeneration.updateMany({ where: { consumer: DRAWINGS_PROJECTION, projectId: p, status: 'active' }, data: { cursorStatus: 'blocked' } });
    expect((await query.projectionSlice(p, f.memberUser.id)).generation).toBeNull();
    expect((await query.moduleDrawings(p, f.memberUser.id)).source).toBe('live');
  });

  it('live == rebuild: a rebuild activates a new generation (checkpoint == H) whose register matches the live one', async () => {
    const p = await freshProject();
    await issue(p, { number: 'R-1', rev: 'A', publish: true });
    await applyProjection(p);
    const before = await query.projectionSlice(p, f.memberUser.id);
    expect(before.generation).toBe(1);

    const stream = await t.prisma.projectEventStream.findUniqueOrThrow({ where: { projectId: p } });
    const H = stream.nextPosition - 1n;

    const res = await rebuilder.rebuild(DRAWINGS_PROJECTION, p);
    expect(res.checkpoint).toBe(H);
    const after = await query.projectionSlice(p, f.memberUser.id);
    expect(after.generation).toBe(2);
    const live = await query.snapshotSlice(p, f.memberUser.id);
    expect(stripUrls(after.drawings)).toEqual(stripUrls(before.drawings));
    expect(stripUrls(after.drawings)).toEqual(stripUrls(live));
  });

  it('two projects are isolated: each has its own active drawings generation + register', async () => {
    const p1 = await freshProject();
    const p2 = await freshProject();
    await issue(p1, { number: 'P1-1', rev: 'A', publish: true });
    await issue(p2, { number: 'P2-1', rev: 'A', publish: true });
    await applyProjection(p1);
    await applyProjection(p2);
    const s1 = await query.projectionSlice(p1, f.memberUser.id);
    const s2 = await query.projectionSlice(p2, f.memberUser.id);
    expect(s1.drawings.map((d) => d.number)).toEqual(['P1-1']);
    expect(s2.drawings.map((d) => d.number)).toEqual(['P2-1']);
    expect(s1.generation).toBe(1);
    expect(s2.generation).toBe(1);
  });

  it('GET …/drawings serves the module read (live fallback while the projection has no generation)', async () => {
    const pid = f.projectA.id;
    const token = t.issueProjectToken(f.memberUser.id, pid, 'pmc');
    await svc.issue(pid, { sub: f.memberUser.id, role: 'pmc', projectId: pid } as AuthUser, { number: 'HTTP-1', title: 'Http', discipline: 'architectural', rev: 'A', status: 'for_construction', mime: 'application/pdf', data: TINY_PDF, publish: true });
    try {
      const res = await request(t.app.getHttpServer()).get(`/projects/${pid}/drawings`).set('Authorization', `Bearer ${token}`).expect(200);
      expect(res.body.source).toBe('live'); // no drawings.inbox generation for projectA yet → live fallback
      expect(res.body.drawings.map((d: { number: string }) => d.number)).toContain('HTTP-1');
    } finally {
      await t.prisma.drawingRevision.deleteMany({ where: { projectId: pid } });
      await t.prisma.drawing.deleteMany({ where: { projectId: pid } });
    }
  });
});
