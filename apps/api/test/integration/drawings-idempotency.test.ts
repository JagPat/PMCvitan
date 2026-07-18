import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { DrawingsService } from '../../src/drawings/drawings.service';
import type { AuthUser } from '../../src/common/auth';

const sha256Hex = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/**
 * Phase 2 Task 10 — the drawing COMMANDS are idempotent under the Task-5 CommandExecution ledger. A
 * retried command (network retry / offline write-ahead replay / double-tap) carrying the SAME
 * idempotency key applies EXACTLY ONCE and replays the same success; the SAME key with a DIFFERENT
 * payload is a 409; the receipt is ACTOR-scoped (two actors, same key = two independent executions);
 * and an UNKEYED command keeps working (additive rollout). Payload-based dedup is deliberately NOT used
 * — two legitimately-distinct issues are two records; only a same-key replay collapses.
 */

const TINY_PDF = Buffer.from('%PDF-1.4 idem').toString('base64');

describe('Phase 2 Task 10 — drawing commands are idempotent (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let svc: DrawingsService;
  let projSeq = 0;

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    svc = t.app.get(DrawingsService);
  });
  afterAll(async () => {
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    const pids = { startsWith: 'it-dwidem-' };
    // DomainEvent is append-only (DELETE is trigger-blocked); TRUNCATE the event/outbox/projection
    // tables wholesale (test-only), then delete the disposable project rows.
    await t.prisma.$executeRawUnsafe('TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DrawingsProjection"');
    await t.prisma.commandExecution.deleteMany({ where: { projectId: pids } });
    await t.prisma.drawingRecipient.deleteMany({ where: { projectId: pids } });
    await t.prisma.drawingRevision.deleteMany({ where: { projectId: pids } });
    await t.prisma.drawing.deleteMany({ where: { projectId: pids } });
    await t.prisma.auditLog.deleteMany({ where: { projectId: pids } });
    await t.prisma.membership.deleteMany({ where: { projectId: pids } });
    await t.prisma.user.deleteMany({ where: { id: { startsWith: 'it-dwidem-u-' } } });
    await t.prisma.project.deleteMany({ where: { id: pids } });
  });

  const freshProject = async (): Promise<{ p: string; engA: string; engB: string }> => {
    const p = `it-dwidem-${Date.now() % 1e6}-${projSeq++}`;
    await t.prisma.project.create({
      data: { id: p, orgId: f.orgA.id, name: p, short: 'O', descriptor: '', stage: 'x', siteCode: 'O', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    });
    await t.prisma.membership.create({ data: { projectId: p, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    const engA = `it-dwidem-u-engA-${projSeq}`;
    const engB = `it-dwidem-u-engB-${projSeq}`;
    for (const [id, name] of [[engA, 'Eng A'], [engB, 'Eng B']] as const) {
      await t.prisma.user.create({ data: { id, projectId: p, role: 'engineer', name, email: `${id}@t.local` } });
      await t.prisma.membership.create({ data: { projectId: p, userId: id, role: 'engineer', status: 'active' } });
    }
    return { p, engA, engB };
  };

  const issueInput = (over: Partial<{ number: string; rev: string }> = {}) => ({
    number: over.number ?? 'A-201', title: 'Plan', discipline: 'architectural' as const,
    rev: over.rev ?? 'A', status: 'for_construction' as const, mime: 'application/pdf', data: TINY_PDF, publish: true,
  });

  it('issue: the SAME key creates the drawing EXACTLY ONCE and replays (no duplicate drawing/revision/event/audit)', async () => {
    const { p } = await freshProject();
    const first = await svc.issue(p, pmc(p), issueInput(), 'k-issue-1');
    const replay = await svc.issue(p, pmc(p), issueInput(), 'k-issue-1'); // retry, same key + payload
    expect(replay.drawingId).toBe(first.drawingId); // replay returns the same ids
    expect(replay.revisionId).toBe(first.revisionId);
    // exactly one of everything — the replay short-circuited before any write
    expect(await t.prisma.drawing.count({ where: { projectId: p } })).toBe(1);
    expect(await t.prisma.drawingRevision.count({ where: { projectId: p } })).toBe(1);
    expect(await t.prisma.domainEvent.count({ where: { projectId: p, eventType: 'drawing.issued' } })).toBe(1);
    expect(await t.prisma.auditLog.count({ where: { projectId: p, action: 'drawing.issue' } })).toBe(1);
  });

  it('issue: the SAME key with a DIFFERENT payload is a 409 (never silently applies a different command)', async () => {
    const { p } = await freshProject();
    await svc.issue(p, pmc(p), issueInput({ number: 'A-201' }), 'k-issue-2');
    await expect(svc.issue(p, pmc(p), issueInput({ number: 'A-999' }), 'k-issue-2')).rejects.toBeInstanceOf(ConflictException);
    // the second (different) command did NOT create its drawing
    expect(await t.prisma.drawing.count({ where: { projectId: p, number: 'A-999' } })).toBe(0);
  });

  it('issue: the SAME key + same metadata + DIFFERENT same-length bytes is a 409 (content-bound identity, not length)', async () => {
    const { p } = await freshProject();
    // two DIFFERENT payloads of the SAME byte length — length alone cannot tell them apart, only a
    // content digest can. The first commits; a same-key retry carrying the OTHER file must 409.
    const bytesA = Buffer.from('%PDF-1.4 AAAAAAAA'); // 17 bytes
    const bytesB = Buffer.from('%PDF-1.4 BBBBBBBB'); // 17 bytes — same length, different content
    expect(bytesA.length).toBe(bytesB.length);
    const inputWith = (data: string) => ({ number: 'A-201', title: 'Plan', discipline: 'architectural' as const, rev: 'A', status: 'for_construction' as const, mime: 'application/pdf', data, publish: true });
    await svc.issue(p, pmc(p), inputWith(bytesA.toString('base64')), 'k-content');
    await expect(svc.issue(p, pmc(p), inputWith(bytesB.toString('base64')), 'k-content')).rejects.toBeInstanceOf(ConflictException);
    // exactly one revision — the different-bytes retry did NOT silently replay the first file's success
    expect(await t.prisma.drawingRevision.count({ where: { projectId: p } })).toBe(1);
  });

  it('issue (presigned): the SAME key + same storageKey + same contentSha256 replays; a DIFFERENT digest is a 409', async () => {
    const { p } = await freshProject();
    const storageKey = `${p}/drawings/fixture.pdf`; // must belong to the project (the service enforces the prefix)
    const digestA = sha256Hex(Buffer.from('the original large file bytes'));
    const digestB = sha256Hex(Buffer.from('a DIFFERENT large file uploaded to the same key'));
    const presign = (contentSha256: string) => ({ number: 'A-900', title: 'Big Plan', discipline: 'architectural' as const, rev: 'A', status: 'for_construction' as const, mime: 'application/pdf', storageKey, sizeBytes: 5_000_000, contentSha256, publish: true });
    const first = await svc.issue(p, pmc(p), presign(digestA), 'k-presign');
    // a retry reusing the SAME key + SAME storageKey + SAME digest replays the original success
    const replay = await svc.issue(p, pmc(p), presign(digestA), 'k-presign');
    expect(replay.drawingId).toBe(first.drawingId);
    expect(replay.revisionId).toBe(first.revisionId);
    expect(await t.prisma.drawingRevision.count({ where: { projectId: p } })).toBe(1);
    // a DIFFERENT content digest under the SAME key + metadata is a different file → 409
    await expect(svc.issue(p, pmc(p), presign(digestB), 'k-presign')).rejects.toBeInstanceOf(ConflictException);
    expect(await t.prisma.drawingRevision.count({ where: { projectId: p } })).toBe(1);
  });

  it('issue: two DISTINCT issues (different numbers) are two records — payload dedup is NOT used', async () => {
    const { p } = await freshProject();
    await svc.issue(p, pmc(p), issueInput({ number: 'A-1' }), 'k-a');
    await svc.issue(p, pmc(p), issueInput({ number: 'A-2' }), 'k-b');
    expect(await t.prisma.drawing.count({ where: { projectId: p } })).toBe(2);
  });

  it('acknowledge: the SAME key replays exactly once (one ack, one event, one audit)', async () => {
    const { p, engA } = await freshProject();
    const { revisionId } = await svc.issue(p, pmc(p), issueInput(), 'k-iss');
    const eng: AuthUser = { sub: engA, role: 'engineer', projectId: p } as AuthUser;
    const a1 = await svc.acknowledge(p, revisionId, eng, 'k-ack-1');
    const a2 = await svc.acknowledge(p, revisionId, eng, 'k-ack-1'); // keyed retry
    expect(a1.ackCount).toBe(1);
    expect(a2.ackCount).toBe(1);
    expect(await t.prisma.drawingAck.count({ where: { revisionId } })).toBe(1);
    expect(await t.prisma.domainEvent.count({ where: { projectId: p, eventType: 'drawing.acknowledged' } })).toBe(1);
    expect(await t.prisma.auditLog.count({ where: { projectId: p, action: 'drawing.ack' } })).toBe(1);
  });

  it('acknowledge: the SAME key from TWO actors is two independent executions (actor-scoped receipt)', async () => {
    const { p, engA, engB } = await freshProject();
    const { revisionId } = await svc.issue(p, pmc(p), issueInput(), 'k-iss2');
    await svc.acknowledge(p, revisionId, { sub: engA, role: 'engineer', projectId: p } as AuthUser, 'shared-key');
    const second = await svc.acknowledge(p, revisionId, { sub: engB, role: 'engineer', projectId: p } as AuthUser, 'shared-key');
    expect(second.ackCount).toBe(2); // engB's ack is NOT collapsed into engA's receipt
    expect(await t.prisma.drawingAck.count({ where: { revisionId } })).toBe(2);
  });

  it('publish: the SAME key publishes once and replays (no second published event)', async () => {
    const { p } = await freshProject();
    // issue as a DRAFT (publish:false), then publish it twice under one key
    const { drawingId } = await svc.issue(p, pmc(p), { ...issueInput(), publish: false }, 'k-draft');
    await svc.publish(p, drawingId, pmc(p), 'k-pub-1');
    await svc.publish(p, drawingId, pmc(p), 'k-pub-1'); // keyed retry → replay, not a second publish
    expect(await t.prisma.domainEvent.count({ where: { projectId: p, eventType: 'drawing.published' } })).toBe(1);
    expect(await t.prisma.auditLog.count({ where: { projectId: p, action: 'drawing.publish' } })).toBe(1);
  });

  it('legacy: an UNKEYED issue still works (additive rollout — unkeyed clients keep functioning)', async () => {
    const { p } = await freshProject();
    const r = await svc.issue(p, pmc(p), issueInput(), undefined);
    expect(r.drawingId).toBeTruthy();
    expect(await t.prisma.drawing.count({ where: { projectId: p } })).toBe(1);
  });
});
