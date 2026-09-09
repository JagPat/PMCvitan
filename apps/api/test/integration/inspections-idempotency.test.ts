import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { InspectionsService } from '../../src/inspections/inspections.service';
import { InspectionsQueryService } from '../../src/inspections/inspections.query';
import { MediaService } from '../../src/media/media.service';
import { StorageService } from '../../src/media/storage.service';
import { InspectionParticipant } from '../../src/inspections/inspection.participant';
import type { AuthUser } from '../../src/common/auth';

import { sanctionedReset } from '../../prisma/sanctioned-reset';
/**
 * Phase 2 Task 10 (Module 3) — the inspection COMMANDS are idempotent under the Task-5 CommandExecution
 * ledger. A retried command (network retry / offline write-ahead replay / double-tap) carrying the SAME
 * idempotency key applies EXACTLY ONCE and replays the same success; the SAME key with a DIFFERENT payload
 * is a 409; the receipt is ACTOR-scoped (two actors, same key = two independent executions); a keyed
 * replay short-circuits BEFORE the terminal state-machine guards (so a retried submit/decide replays
 * cleanly instead of hitting "already submitted"/"already decided"); and an UNKEYED command keeps working
 * (additive rollout).
 */

describe('Phase 2 Task 10 (Module 3) — inspection commands are idempotent (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let svc: InspectionsService;
  let reads: InspectionsQueryService;
  let media: MediaService;
  let projSeq = 0;

  const asPmc = (sub: string, projectId: string): AuthUser => ({ sub, role: 'pmc', projectId }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    svc = t.app.get(InspectionsService);
    reads = t.app.get(InspectionsQueryService);
    media = t.app.get(MediaService);
  });
  afterAll(async () => {
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    const pids = { startsWith: 'it-inidem-' };
    await sanctionedReset(t.prisma, ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor', 'ProjectionGeneration', 'InspectionsProjection'], { cascade: true });
    await t.prisma.commandExecution.deleteMany({ where: { projectId: pids } });
    // #571 round 9 — this file's probes are the first here to create MEDIA (the evidence-authority
    // arms), and media/evidence rows reference the inspection items below. Cleared first, or the
    // item delete fails on its FK and every later test in the file inherits a dirty database.
    await t.prisma.inspectionEvidence.deleteMany({ where: { projectId: pids } });
    await t.prisma.media.deleteMany({ where: { projectId: pids } });
    await t.prisma.inspectionItem.deleteMany({ where: { inspection: { projectId: pids } } });
    await t.prisma.inspection.deleteMany({ where: { projectId: pids } });
    await t.prisma.notification.deleteMany({ where: { projectId: pids } });
    await t.prisma.auditLog.deleteMany({ where: { projectId: pids } });
    await t.prisma.membership.deleteMany({ where: { projectId: pids } });
    await t.prisma.user.deleteMany({ where: { id: { startsWith: 'it-inidem-u-' } } });
    await t.prisma.project.deleteMany({ where: { id: pids } });
  });

  /** A fresh project with TWO active pmc members (for the actor-scoping probe) + one engineer. */
  const freshProject = async (): Promise<{ p: string; pmcA: string; pmcB: string }> => {
    const p = `it-inidem-${Date.now() % 1e6}-${projSeq++}`;
    await t.prisma.project.create({
      data: { id: p, orgId: f.orgA.id, name: p, short: 'O', descriptor: '', stage: 'x', siteCode: 'O', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    });
    const pmcA = `it-inidem-u-pmcA-${projSeq}`;
    const pmcB = `it-inidem-u-pmcB-${projSeq}`;
    for (const [id, name] of [[pmcA, 'PMC A'], [pmcB, 'PMC B']] as const) {
      await t.prisma.user.create({ data: { id, projectId: p, role: 'pmc', name, email: `${id}@t.local` } });
      await t.prisma.membership.create({ data: { projectId: p, userId: id, role: 'pmc', status: 'active' } });
    }
    return { p, pmcA, pmcB };
  };

  const createInput = (over: Partial<{ title: string; items: string[] }> = {}) => ({
    title: over.title ?? 'Slab QA', zone: 'GF', items: over.items ?? ['Rebar', 'Cover'],
  });

  it('create: the SAME key creates the inspection EXACTLY ONCE and replays (no duplicate inspection/event/audit)', async () => {
    const { p, pmcA } = await freshProject();
    await svc.create(p, createInput(), asPmc(pmcA, p), 'k-create-1');
    await svc.create(p, createInput(), asPmc(pmcA, p), 'k-create-1'); // retry, same key + payload
    expect(await t.prisma.inspection.count({ where: { projectId: p } })).toBe(1);
    expect(await t.prisma.domainEvent.count({ where: { projectId: p, eventType: 'inspection.created' } })).toBe(1);
    expect(await t.prisma.auditLog.count({ where: { projectId: p, action: 'inspection.create' } })).toBe(1);
  });

  it('create: the SAME key with a DIFFERENT payload is a 409 (never silently applies a different command)', async () => {
    const { p, pmcA } = await freshProject();
    await svc.create(p, createInput({ title: 'Slab QA' }), asPmc(pmcA, p), 'k-create-2');
    await expect(svc.create(p, createInput({ title: 'Plaster QA' }), asPmc(pmcA, p), 'k-create-2')).rejects.toBeInstanceOf(ConflictException);
    expect(await t.prisma.inspection.count({ where: { projectId: p, title: 'Plaster QA' } })).toBe(0);
  });

  it('create: the SAME key from TWO actors is two independent executions (actor-scoped receipt)', async () => {
    const { p, pmcA, pmcB } = await freshProject();
    await svc.create(p, createInput({ title: 'A QA' }), asPmc(pmcA, p), 'shared-key');
    await svc.create(p, createInput({ title: 'B QA' }), asPmc(pmcB, p), 'shared-key'); // NOT collapsed into A's receipt
    expect(await t.prisma.inspection.count({ where: { projectId: p } })).toBe(2);
  });

  it('create: two DISTINCT creates (different titles) are two records — payload dedup is NOT used', async () => {
    const { p, pmcA } = await freshProject();
    await svc.create(p, createInput({ title: 'A-1' }), asPmc(pmcA, p), 'k-a');
    await svc.create(p, createInput({ title: 'A-2' }), asPmc(pmcA, p), 'k-b');
    expect(await t.prisma.inspection.count({ where: { projectId: p } })).toBe(2);
  });

  it('submit: the SAME key replays exactly once and never hits the "already submitted" guard', async () => {
    const { p, pmcA } = await freshProject();
    await svc.create(p, createInput({ items: ['Rebar'] }), asPmc(pmcA, p), 'k-c');
    const insp = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: p }, include: { items: true } });
    const items = insp.items.map((it) => ({ id: it.id, state: 'pass' as const, photos: 0, note: '' }));
    await svc.submit(p, insp.id, { items }, asPmc(pmcA, p), 'k-submit-1');
    await svc.submit(p, insp.id, { items }, asPmc(pmcA, p), 'k-submit-1'); // keyed retry → replay, not a 400
    expect(await t.prisma.domainEvent.count({ where: { projectId: p, eventType: 'inspection.submitted' } })).toBe(1);
    expect(await t.prisma.auditLog.count({ where: { projectId: p, action: 'inspection.submit' } })).toBe(1);
    const after = await t.prisma.inspection.findUniqueOrThrow({ where: { id: insp.id } });
    expect(after.submitted).toBe(true);
  });

  it('decide (approve): the SAME key approves once and replays (no second approved event)', async () => {
    const { p, pmcA } = await freshProject();
    await svc.create(p, createInput({ items: ['Rebar'] }), asPmc(pmcA, p), 'k-d');
    const insp = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: p }, include: { items: true } });
    await svc.submit(p, insp.id, { items: insp.items.map((it) => ({ id: it.id, state: 'pass' as const, photos: 0, note: '' })) }, asPmc(pmcA, p), 'k-sub');
    await svc.decide(p, insp.id, { approve: true, rejectedItemIds: [] }, asPmc(pmcA, p), 'k-decide-1');
    await svc.decide(p, insp.id, { approve: true, rejectedItemIds: [] }, asPmc(pmcA, p), 'k-decide-1'); // keyed retry → replay
    expect(await t.prisma.domainEvent.count({ where: { projectId: p, eventType: 'inspection.approved' } })).toBe(1);
    expect(await t.prisma.auditLog.count({ where: { projectId: p, action: 'inspection.approve' } })).toBe(1);
    const after = await t.prisma.inspection.findUniqueOrThrow({ where: { id: insp.id } });
    expect(after.decided).toBe(true);
  });

  it('legacy: an UNKEYED create still works (additive rollout — unkeyed clients keep functioning)', async () => {
    const { p, pmcA } = await freshProject();
    await svc.create(p, createInput(), asPmc(pmcA, p), undefined);
    expect(await t.prisma.inspection.count({ where: { projectId: p } })).toBe(1);
  });

  /**
   * A rejected inspection creates a re-inspection ASSIGNED to whoever submitted the original. The
   * submitter of record is the person who did the work, so a second engineer submitting it would put
   * the wrong name on somebody's corrective work. The read boundary keeps it off their field view;
   * this is the enforcement behind it, because a client is not an authorization boundary.
   */
  it('submit: assigned corrective work is refused for anyone but its assignee, and accepted for them', async () => {
    const { p, pmcA } = await freshProject();
    const engA = `it-inidem-u-engA-${projSeq}`;
    const engB = `it-inidem-u-engB-${projSeq}`;
    for (const [id, name] of [[engA, 'Eng A'], [engB, 'Eng B']] as const) {
      await t.prisma.user.create({ data: { id, projectId: p, role: 'engineer', name, email: `${id}@t.local` } });
      await t.prisma.membership.create({ data: { projectId: p, userId: id, role: 'engineer', status: 'active' } });
    }
    const asEng = (sub: string): AuthUser => ({ sub, role: 'engineer', projectId: p }) as AuthUser;

    await svc.create(p, createInput({ title: 'Assigned QA' }), asPmc(pmcA, p), 'k-assign-1');
    const insp = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: p }, include: { items: true } });
    // the work is named: this checklist is engineer A's
    await t.prisma.inspection.update({ where: { id: insp.id }, data: { assigneeId: engA } });
    const items = insp.items.map((it) => ({ id: it.id, state: 'pass' as const, photos: 0, note: '' }));

    await expect(svc.submit(p, insp.id, { items }, asEng(engB), 'k-assign-b'))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect((await t.prisma.inspection.findUniqueOrThrow({ where: { id: insp.id } })).submitted).toBe(false);

    // not merely strict: its assignee submits it
    await svc.submit(p, insp.id, { items }, asEng(engA), 'k-assign-a');
    expect((await t.prisma.inspection.findUniqueOrThrow({ where: { id: insp.id } })).submitted).toBe(true);
  });

  /**
   * A CONTRACTOR CANNOT BE ASSIGNED CORRECTIVE WORK, and that is the point rather than an omission.
   * `assigneeId` decides who may submit, so an assignee who cannot reach the submit route is work
   * nobody can hand back. An earlier head widened the route ceiling to admit contractors instead;
   * that left authority without a surface — no checklist screen, no inbox task, a redirected route
   * and no `media.upload` grant, so a FAILED item's mandatory photo is unattachable. The dead end is
   * closed at its source: `decide` refuses the assignment, naming the roles that can do the work.
   */
  it('decide: a CONTRACTOR cannot be named the assignee, and the refusal names the eligible role', async () => {
    const { p, pmcA } = await freshProject();
    const con = `it-inidem-u-conA-${projSeq}`;
    await t.prisma.user.create({ data: { id: con, projectId: p, role: 'contractor', name: 'Con A', email: `${con}@t.local` } });
    await t.prisma.membership.create({ data: { projectId: p, userId: con, role: 'contractor', status: 'active' } });

    await svc.create(p, createInput({ title: 'Rework QA' }), asPmc(pmcA, p), 'k-con-assign');
    const insp = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: p, title: 'Rework QA' }, include: { items: true } });
    await svc.submit(p, insp.id, { items: insp.items.map((it) => ({ id: it.id, state: 'fail' as const, photos: 0, note: 'x' })) }, asPmc(pmcA, p), 'k-con-sub')
      .catch(() => undefined); // a failed item needs evidence; the assignment guard below is what this probe is about
    await svc.submit(p, insp.id, { items: insp.items.map((it) => ({ id: it.id, state: 'pass' as const, photos: 0, note: '' })) }, asPmc(pmcA, p), 'k-con-sub2');

    await expect(svc.decide(p, insp.id, { approve: false, rejectedItemIds: [insp.items[0].id], assigneeId: con }, asPmc(pmcA, p), 'k-con-decide'))
      .rejects.toThrow(/active engineer/i);
    // and the refusal is precise, not merely strict: no re-inspection was created
    expect(await t.prisma.inspection.count({ where: { projectId: p, reinspectionOfId: insp.id } })).toBe(0);
  });

  /**
   * ROUND 4 — `assigneeId` IS AN AUTHORITY CLAIM, SO THE DATABASE FREEZES IT.
   *
   * The read gates on it and `submit` accepts only its holder, but the column was freely updateable:
   * an alternate writer could move it from A to B and B would then pass the guard and be recorded as
   * having done A's corrective work — the ownership claim rewritten with no attributable transition.
   * The service never updates it (it is set once, by the rejection that creates the re-inspection),
   * so the freeze costs no legitimate path and every other UPDATE on the row still passes.
   */
  it('assigneeId is frozen at the database: a hostile reassignment is rejected, ordinary updates are not', async () => {
    const { p, pmcA } = await freshProject();
    const engA = `it-inidem-u-frzA-${projSeq}`;
    const engB = `it-inidem-u-frzB-${projSeq}`;
    for (const [id, name] of [[engA, 'Frz A'], [engB, 'Frz B']] as const) {
      await t.prisma.user.create({ data: { id, projectId: p, role: 'engineer', name, email: `${id}@t.local` } });
      await t.prisma.membership.create({ data: { projectId: p, userId: id, role: 'engineer', status: 'active' } });
    }
    await svc.create(p, createInput({ title: 'Frozen QA' }), asPmc(pmcA, p), 'k-frz');
    const insp = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: p, title: 'Frozen QA' }, include: { items: true } });
    await t.prisma.inspection.update({ where: { id: insp.id }, data: { assigneeId: engA } }); // the one legitimate set

    // the forgery the guard depends on being impossible: substituting B for A, and erasing A
    await expect(t.prisma.inspection.update({ where: { id: insp.id }, data: { assigneeId: engB } }))
      .rejects.toThrow(/assigneeId is frozen/i);
    await expect(t.prisma.inspection.update({ where: { id: insp.id }, data: { assigneeId: null } }))
      .rejects.toThrow(/assigneeId is frozen/i);
    expect((await t.prisma.inspection.findUniqueOrThrow({ where: { id: insp.id } })).assigneeId).toBe(engA);

    // precise, not merely strict: the ordinary lifecycle write that leaves the column alone succeeds
    await svc.submit(p, insp.id, { items: insp.items.map((it) => ({ id: it.id, state: 'pass' as const, photos: 0, note: '' })) },
      { sub: engA, role: 'engineer', projectId: p } as AuthUser, 'k-frz-sub');
    expect((await t.prisma.inspection.findUniqueOrThrow({ where: { id: insp.id } })).submitted).toBe(true);
  });

  it('submit: an UNASSIGNED checklist is unchanged — the role gate is the whole guard, as before', async () => {
    const { p, pmcA } = await freshProject();
    const eng = `it-inidem-u-engC-${projSeq}`;
    await t.prisma.user.create({ data: { id: eng, projectId: p, role: 'engineer', name: 'Eng C', email: `${eng}@t.local` } });
    await t.prisma.membership.create({ data: { projectId: p, userId: eng, role: 'engineer', status: 'active' } });

    await svc.create(p, createInput({ title: 'Site QA' }), asPmc(pmcA, p), 'k-unassigned-1');
    const insp = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: p }, include: { items: true } });
    expect(insp.assigneeId).toBe(null);
    await svc.submit(p, insp.id, { items: insp.items.map((it) => ({ id: it.id, state: 'pass' as const, photos: 0, note: '' })) },
      { sub: eng, role: 'engineer', projectId: p } as AuthUser, 'k-unassigned-sub');
    expect((await t.prisma.inspection.findUniqueOrThrow({ where: { id: insp.id } })).submitted).toBe(true);
  });

  it('ROUND 6 — an assignment whose assignee can no longer act does not strand the checklist', async () => {
    // The guard protects ATTRIBUTION: a second engineer must not be recorded as having done
    // somebody's remedial work. That claim is meaningless once the named person cannot act at all,
    // and refusing everyone else then strands the work — the exact-assignee guard refuses every
    // replacement and the latch refuses to clear or transfer the value. Three ways in, one rule out.
    const { p, pmcA } = await freshProject();
    const gone = `it-inidem-u-gone-${projSeq}`;   // removed after being assigned
    const reroled = `it-inidem-u-rerole-${projSeq}`; // re-roled to contractor after being assigned
    const other = `it-inidem-u-otherE-${projSeq}`;
    for (const [id, name] of [[gone, 'Gone'], [reroled, 'Reroled'], [other, 'Other Eng']] as const) {
      await t.prisma.user.create({ data: { id, projectId: p, role: 'engineer', name, email: `${id}@t.local` } });
      await t.prisma.membership.create({ data: { projectId: p, userId: id, role: 'engineer', status: 'active' } });
    }

    for (const [assignee, mutate] of [
      [gone, async () => { await t.prisma.membership.updateMany({ where: { projectId: p, userId: gone }, data: { status: 'removed' } }); }],
      [reroled, async () => { await t.prisma.membership.updateMany({ where: { projectId: p, userId: reroled }, data: { role: 'contractor' } }); }],
      [pmcA, async () => { /* a PMC who took the work by naming themselves has no checklist screen */ }],
    ] as const) {
      await svc.create(p, createInput({ title: `Stranded ${assignee}` }), asPmc(pmcA, p), `k-strand-${assignee}`);
      const insp = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: p, title: `Stranded ${assignee}` }, include: { items: true } });
      await t.prisma.inspection.update({ where: { id: insp.id }, data: { assigneeId: assignee } });
      await mutate();

      // another engineer can do the work, and is recorded as having done it
      await svc.submit(p, insp.id, { items: insp.items.map((it) => ({ id: it.id, state: 'pass' as const, photos: 0, note: '' })) },
        { sub: other, role: 'engineer', projectId: p } as AuthUser, `k-strand-sub-${assignee}`);
      const done = await t.prisma.inspection.findUniqueOrThrow({ where: { id: insp.id } });
      expect(done.submitted).toBe(true);
      expect(done.submittedById).toBe(other);
      // …and the assignment is KEPT as the record of who was asked, never erased
      expect(done.assigneeId).toBe(assignee);
    }
  });

  it('ROUND 6 — an assignee who CAN still act keeps the work to themselves', async () => {
    // precise, not merely permissive: the rule must not read as "anyone may submit assigned work"
    const { p, pmcA } = await freshProject();
    const held = `it-inidem-u-held-${projSeq}`;
    const rival = `it-inidem-u-rival-${projSeq}`;
    for (const [id, name] of [[held, 'Held'], [rival, 'Rival']] as const) {
      await t.prisma.user.create({ data: { id, projectId: p, role: 'engineer', name, email: `${id}@t.local` } });
      await t.prisma.membership.create({ data: { projectId: p, userId: id, role: 'engineer', status: 'active' } });
    }
    await svc.create(p, createInput({ title: 'Held QA' }), asPmc(pmcA, p), 'k-held-1');
    const insp = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: p, title: 'Held QA' }, include: { items: true } });
    await t.prisma.inspection.update({ where: { id: insp.id }, data: { assigneeId: held } });

    await expect(svc.submit(p, insp.id, { items: insp.items.map((it) => ({ id: it.id, state: 'pass' as const, photos: 0, note: '' })) },
      { sub: rival, role: 'engineer', projectId: p } as AuthUser, 'k-held-rival'))
      .rejects.toBeInstanceOf(ForbiddenException);

    await svc.submit(p, insp.id, { items: insp.items.map((it) => ({ id: it.id, state: 'pass' as const, photos: 0, note: '' })) },
      { sub: held, role: 'engineer', projectId: p } as AuthUser, 'k-held-own');
    expect((await t.prisma.inspection.findUniqueOrThrow({ where: { id: insp.id } })).submittedById).toBe(held);
  });

  it('ROUND 5 — an assignment landing between the guard and the CAS does not let a stranger submit', async () => {
    // The guard reads `assigneeId` OUTSIDE the transaction, and the latch deliberately permits
    // `null -> someone` because that is assignment, not reassignment. So engineer B can read an
    // unassigned checklist, an alternate writer can assign it to engineer A, and B's transaction
    // then commits: the old CAS pinned only `submitted`/`decided`, so A's assignment survived while
    // B was recorded as the person who did the work — the precise misattribution the guard exists
    // to prevent, reached by racing it instead of by passing it.
    const { p, pmcA } = await freshProject();
    const engA = `it-inidem-u-casA-${projSeq}`;
    const engB = `it-inidem-u-casB-${projSeq}`;
    for (const [id, name] of [[engA, 'Cas A'], [engB, 'Cas B']] as const) {
      await t.prisma.user.create({ data: { id, projectId: p, role: 'engineer', name, email: `${id}@t.local` } });
      await t.prisma.membership.create({ data: { projectId: p, userId: id, role: 'engineer', status: 'active' } });
    }
    await svc.create(p, createInput({ title: 'Raced QA' }), asPmc(pmcA, p), 'k-cas-1');
    const insp = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: p, title: 'Raced QA' }, include: { items: true } });
    expect(insp.assigneeId).toBe(null);

    // The assignment lands in the window BETWEEN the guard's read and the transaction. The window is
    // reproduced by making the guard's own read return the pre-assignment row it legitimately could
    // have read a moment earlier, while the committed row already carries the assignment — which is
    // exactly the state the finding describes, and the only part of the interleaving that matters.
    // Waiting for a real scheduler to produce it would make the probe timing-dependent for no gain.
    await t.prisma.inspection.update({ where: { id: insp.id }, data: { assigneeId: engA } });
    const stale = { ...insp, assigneeId: null };
    const findUnique = vi.spyOn(t.prisma.inspection, 'findUnique').mockResolvedValueOnce(stale as never);

    try {
      await expect(svc.submit(p, insp.id, { items: insp.items.map((it) => ({ id: it.id, state: 'pass' as const, photos: 0, note: '' })) },
        { sub: engB, role: 'engineer', projectId: p } as AuthUser, 'k-cas-sub'))
        .rejects.toThrow(/changed while submitting/i);
    } finally {
      findUnique.mockRestore();
    }

    // nothing was recorded: the work is still A's, and still open for A to do
    const after = await t.prisma.inspection.findUniqueOrThrow({ where: { id: insp.id } });
    expect(after.submitted).toBe(false);
    expect(after.submittedById).toBe(null);
    expect(after.assigneeId).toBe(engA);

    // precise, not merely strict: the rightful assignee still submits it
    await svc.submit(p, insp.id, { items: insp.items.map((it) => ({ id: it.id, state: 'pass' as const, photos: 0, note: '' })) },
      { sub: engA, role: 'engineer', projectId: p } as AuthUser, 'k-cas-sub-a');
    const done = await t.prisma.inspection.findUniqueOrThrow({ where: { id: insp.id } });
    expect(done.submitted).toBe(true);
    expect(done.submittedById).toBe(engA);
  });


  /**
   * ROUND 7, FINDING 1 — the READ has to answer the assignment question the way `submit` does.
   *
   * Round 6 made a stranded assignment stop binding, so `submit` accepts a replacement engineer. The
   * read boundary went on filtering by the stored id, so the checklist stayed off every eligible
   * engineer's field view: submittable in principle by people who could not find it. This is the same
   * generator the previous three rounds produced — the rule written where the finding was reported,
   * not over the set of sites that carry it — so the fix is one function both sides call, and this
   * probe walks the LIVE read, not the pure baker.
   */
  it('ROUND 7 — a stranded assignee’s checklist is READABLE by the engineers who may submit it', async () => {
    const { p, pmcA } = await freshProject();
    const gone = `it-inidem-u-r7gone-${projSeq}`;
    const other = `it-inidem-u-r7other-${projSeq}`;
    const held = `it-inidem-u-r7held-${projSeq}`;
    for (const [id, name] of [[gone, 'Gone'], [other, 'Other'], [held, 'Held']] as const) {
      await t.prisma.user.create({ data: { id, projectId: p, role: 'engineer', name, email: `${id}@t.local` } });
      await t.prisma.membership.create({ data: { projectId: p, userId: id, role: 'engineer', status: 'active' } });
    }
    await svc.create(p, createInput({ title: 'Stranded read' }), asPmc(pmcA, p), 'k-r7r-1');
    await svc.create(p, createInput({ title: 'Held read' }), asPmc(pmcA, p), 'k-r7r-2');
    const stranded = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: p, title: 'Stranded read' } });
    const bound = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: p, title: 'Held read' } });
    await t.prisma.inspection.update({ where: { id: stranded.id }, data: { assigneeId: gone } });
    await t.prisma.inspection.update({ where: { id: bound.id }, data: { assigneeId: held } });
    await t.prisma.membership.updateMany({ where: { projectId: p, userId: gone }, data: { status: 'removed' } });

    const slice = await reads.snapshotSlice(p, 'engineer', other);
    const ids = slice.openChecklists.map((c) => c.id);
    // the stranded one is offered — RED before this round, where it was filtered out by id
    expect(ids).toContain(stranded.id);
    // and the one whose assignee CAN still act is still not this engineer's to see
    expect(ids).not.toContain(bound.id);

    // read and write agree, which is the whole point: exactly what the read offers, submit accepts
    await svc.submit(p, stranded.id, {
      items: (await t.prisma.inspectionItem.findMany({ where: { inspectionId: stranded.id } }))
        .map((it) => ({ id: it.id, state: 'pass' as const, photos: 0, note: '' })),
    }, { sub: other, role: 'engineer', projectId: p } as AuthUser, 'k-r7r-sub');
    expect((await t.prisma.inspection.findUniqueOrThrow({ where: { id: stranded.id } })).submittedById).toBe(other);
  });

  /**
   * ROUND 7, FINDING 2 — the binding check has to be re-taken under the project's readiness key.
   *
   * `MembersService.add`/`updateRole` take that key before they write, so an assignee observed
   * ineligible by the pre-transaction guard can be reactivated as an engineer and committed while
   * this command is still assembling. The CAS pins only `assigneeId`, which a reactivation never
   * touches, so the stranger would commit as the submitter of work that had become exclusive again.
   *
   * The window is reproduced the way round 5 reproduced its own: by making the EARLY guard's read
   * return the answer it legitimately could have read a moment before, while the committed row says
   * otherwise. Waiting on a real scheduler would make the probe timing-dependent for no gain.
   */
  it('ROUND 7 — a membership reactivation racing the guard cannot be committed past', async () => {
    const { p, pmcA } = await freshProject();
    const held = `it-inidem-u-r7racehold-${projSeq}`;
    const rival = `it-inidem-u-r7racerival-${projSeq}`;
    for (const [id, name] of [[held, 'Held'], [rival, 'Rival']] as const) {
      await t.prisma.user.create({ data: { id, projectId: p, role: 'engineer', name, email: `${id}@t.local` } });
      await t.prisma.membership.create({ data: { projectId: p, userId: id, role: 'engineer', status: 'active' } });
    }
    await svc.create(p, createInput({ title: 'Raced binding' }), asPmc(pmcA, p), 'k-r7race-1');
    const insp = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: p, title: 'Raced binding' }, include: { items: true } });
    await t.prisma.inspection.update({ where: { id: insp.id }, data: { assigneeId: held } });

    // The early, unlocked guard sees the assignee as ineligible; the committed truth (which the
    // in-transaction re-read under the readiness key will see) is that they are an active engineer.
    const findMany = vi.spyOn(t.prisma.membership, 'findMany').mockResolvedValueOnce([] as never);
    try {
      await expect(svc.submit(p, insp.id, { items: insp.items.map((it) => ({ id: it.id, state: 'pass' as const, photos: 0, note: '' })) },
        { sub: rival, role: 'engineer', projectId: p } as AuthUser, 'k-r7race-sub'))
        .rejects.toBeInstanceOf(ForbiddenException);
    } finally {
      findMany.mockRestore();
    }
    const after = await t.prisma.inspection.findUniqueOrThrow({ where: { id: insp.id } });
    expect(after.submitted).toBe(false);
    expect(after.submittedById).toBe(null);

    // precise, not merely strict: the rightful assignee still submits it
    await svc.submit(p, insp.id, { items: insp.items.map((it) => ({ id: it.id, state: 'pass' as const, photos: 0, note: '' })) },
      { sub: held, role: 'engineer', projectId: p } as AuthUser, 'k-r7race-own');
    expect((await t.prisma.inspection.findUniqueOrThrow({ where: { id: insp.id } })).submittedById).toBe(held);
  });

  /**
   * ROUND 7, FINDING 3 — the rule holds against a writer this deployment does not control.
   *
   * During a rolling deployment a previous-release replica keeps serving, and its `submit` has no
   * assignee guard — it never had one to keep. The raw UPDATEs below ARE that writer: the exact
   * statement the previous release issues, with none of this release's checks in front of it. The
   * freeze trigger waves them through because `assigneeId` is untouched, so the database is the only
   * place the authority can still be asserted.
   */
  it('ROUND 7 — a previous-release submit of assigned work is refused at the database', async () => {
    const { p, pmcA } = await freshProject();
    const held = `it-inidem-u-r7fenceheld-${projSeq}`;
    const gone = `it-inidem-u-r7fencegone-${projSeq}`;
    const rival = `it-inidem-u-r7fencerival-${projSeq}`;
    for (const [id, name] of [[held, 'Held'], [gone, 'Gone'], [rival, 'Rival']] as const) {
      await t.prisma.user.create({ data: { id, projectId: p, role: 'engineer', name, email: `${id}@t.local` } });
      await t.prisma.membership.create({ data: { projectId: p, userId: id, role: 'engineer', status: 'active' } });
    }
    await svc.create(p, createInput({ title: 'Fenced held' }), asPmc(pmcA, p), 'k-r7f-1');
    await svc.create(p, createInput({ title: 'Fenced stranded' }), asPmc(pmcA, p), 'k-r7f-2');
    await svc.create(p, createInput({ title: 'Fenced open' }), asPmc(pmcA, p), 'k-r7f-3');
    const bound = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: p, title: 'Fenced held' } });
    const stranded = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: p, title: 'Fenced stranded' } });
    const open = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: p, title: 'Fenced open' } });
    await t.prisma.inspection.update({ where: { id: bound.id }, data: { assigneeId: held } });
    await t.prisma.inspection.update({ where: { id: stranded.id }, data: { assigneeId: gone } });
    await t.prisma.membership.updateMany({ where: { projectId: p, userId: gone }, data: { status: 'removed' } });

    const legacySubmit = (id: string, by: string) => t.prisma.$executeRaw`
      UPDATE "Inspection" SET "submitted" = true, "submittedById" = ${by}, "submittedByName" = ${by}
       WHERE "id" = ${id}`;

    // 1. the forgery the finding describes: a stranger submitting BOUND work
    await expect(legacySubmit(bound.id, rival)).rejects.toThrow(/only its assignee may submit it/i);
    expect((await t.prisma.inspection.findUniqueOrThrow({ where: { id: bound.id } })).submitted).toBe(false);

    // 2. an UNATTRIBUTABLE submit of bound work is the same refusal, not a hole
    await expect(t.prisma.$executeRaw`UPDATE "Inspection" SET "submitted" = true WHERE "id" = ${bound.id}`)
      .rejects.toThrow(/only its assignee may submit it/i);

    // 3. …and it rejects ONLY what this release already rejects. The assignee's own submit passes,
    // a STRANDED assignment lets a replacement through, and an unassigned checklist never reaches
    // the membership lookup at all — otherwise the fence would break current replicas.
    await legacySubmit(bound.id, held);
    expect((await t.prisma.inspection.findUniqueOrThrow({ where: { id: bound.id } })).submittedById).toBe(held);
    await legacySubmit(stranded.id, rival);
    expect((await t.prisma.inspection.findUniqueOrThrow({ where: { id: stranded.id } })).submittedById).toBe(rival);
    await legacySubmit(open.id, rival);
    expect((await t.prisma.inspection.findUniqueOrThrow({ where: { id: open.id } })).submittedById).toBe(rival);
  });


  /**
   * ROUND 8, FINDING 1 — the trigger reads `Membership`, so it must hold the fence that makes that
   * read decidable.
   *
   * Round 7 moved the SERVICE's binding check under `lockProjectReadiness` for exactly this reason,
   * and then added a trigger that read membership under no lock at all — the same hole in the object
   * built to close it. An alternate writer taking no readiness key could be permitted while a
   * reactivation committed underneath it, leaving a binding active assignee and the wrong submitter
   * recorded forever.
   */
  it('ROUND 8 — the writer fence REFUSES rather than judging standing while the readiness key is held', async () => {
    const { p, pmcA } = await freshProject();
    const held = `it-inidem-u-r8held-${projSeq}`;
    const rival = `it-inidem-u-r8rival-${projSeq}`;
    for (const [id, name] of [[held, 'Held'], [rival, 'Rival']] as const) {
      await t.prisma.user.create({ data: { id, projectId: p, role: 'engineer', name, email: `${id}@t.local` } });
      await t.prisma.membership.create({ data: { projectId: p, userId: id, role: 'engineer', status: 'active' } });
    }
    await svc.create(p, createInput({ title: 'Fenced by key' }), asPmc(pmcA, p), 'k-r8f-1');
    const insp = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: p, title: 'Fenced by key' } });
    await t.prisma.inspection.update({ where: { id: insp.id }, data: { assigneeId: held } });

    // A concurrent transaction holds this project's readiness key — exactly what a membership
    // change does while it writes. The previous-release writer's UPDATE must be refused, NOT
    // permitted on the membership picture it happened to start with, and NOT blocked into a
    // deadlock (the trigger TRIES the lock; it never waits for it).
    const other = await import('@prisma/client').then((m) => new m.PrismaClient());
    try {
      await other.$transaction(async (tx2) => {
        await tx2.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended('readiness:' || $1, 0))`, p);
        await expect(t.prisma.$executeRaw`
          UPDATE "Inspection" SET "submitted" = true, "submittedById" = ${rival} WHERE "id" = ${insp.id}`)
          .rejects.toThrow(/readiness is held by another transaction/i);
      });
    } finally {
      await other.$disconnect();
    }
    expect((await t.prisma.inspection.findUniqueOrThrow({ where: { id: insp.id } })).submitted).toBe(false);

    // …and with the key free the SAME statement reaches the ordinary authority refusal, so the
    // fence is a serialization guard and not a second, stricter rule.
    await expect(t.prisma.$executeRaw`
      UPDATE "Inspection" SET "submitted" = true, "submittedById" = ${rival} WHERE "id" = ${insp.id}`)
      .rejects.toThrow(/only its assignee may submit it/i);

    // precise, not merely strict: the SHIPPED submit — which holds the key itself — still commits
    const items = await t.prisma.inspectionItem.findMany({ where: { inspectionId: insp.id } });
    await svc.submit(p, insp.id, { items: items.map((it) => ({ id: it.id, state: 'pass' as const, photos: 0, note: '' })) },
      { sub: held, role: 'engineer', projectId: p } as AuthUser, 'k-r8f-own');
    expect((await t.prisma.inspection.findUniqueOrThrow({ where: { id: insp.id } })).submittedById).toBe(held);
  });

  /**
   * ROUND 8, FINDING 2 — through the LIVE read, not the pure baker: a record stays readable to the
   * engineer who made it after its original assignee becomes binding again.
   */
  it('ROUND 8 — a reactivated assignee does not hide the record its replacement submitted', async () => {
    const { p, pmcA } = await freshProject();
    const gone = `it-inidem-u-r8gone-${projSeq}`;
    const other = `it-inidem-u-r8other-${projSeq}`;
    for (const [id, name] of [[gone, 'Gone'], [other, 'Other']] as const) {
      await t.prisma.user.create({ data: { id, projectId: p, role: 'engineer', name, email: `${id}@t.local` } });
      await t.prisma.membership.create({ data: { projectId: p, userId: id, role: 'engineer', status: 'active' } });
    }
    await svc.create(p, createInput({ title: 'Stranded then returned' }), asPmc(pmcA, p), 'k-r8r-1');
    const insp = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: p, title: 'Stranded then returned' }, include: { items: true } });
    await t.prisma.inspection.update({ where: { id: insp.id }, data: { assigneeId: gone } });
    await t.prisma.membership.updateMany({ where: { projectId: p, userId: gone }, data: { status: 'removed' } });

    await svc.submit(p, insp.id, { items: insp.items.map((it) => ({ id: it.id, state: 'pass' as const, photos: 0, note: '' })) },
      { sub: other, role: 'engineer', projectId: p } as AuthUser, 'k-r8r-sub');
    expect((await t.prisma.inspection.findUniqueOrThrow({ where: { id: insp.id } })).submittedById).toBe(other);

    // the assignee comes back — their assignment binds again
    await t.prisma.membership.updateMany({ where: { projectId: p, userId: gone }, data: { status: 'active' } });
    const slice = await reads.snapshotSlice(p, 'engineer', other);
    // RED before this round: the fallback applied the live assignment rule to a finished record and
    // the engineer who did the work was served `checklist: null`
    expect(slice.checklist?.id).toBe(insp.id);
    expect(slice.openChecklists).toEqual([]);
  });


  /**
   * ROUND 9, FINDING 1 — containment is not authority, and evidence was the third surface.
   *
   * `submit` refuses a non-assignee while the assignment binds and the read boundary keeps the
   * checklist off their field view — and evidence mutation checked neither. The window this PR
   * itself opens makes it reachable: a stranded assignment hands engineer B the checklist and its
   * item ids, the assignee is reactivated, and B's stale screen could still attach photos to, or
   * DELETE photos from, work that had become somebody else's again. Delete is the sharp end.
   */
  it('ROUND 9 — a binding assignment refuses another engineer’s evidence upload AND delete', async () => {
    const { p, pmcA } = await freshProject();
    const held = `it-inidem-u-r9held-${projSeq}`;
    const rival = `it-inidem-u-r9rival-${projSeq}`;
    for (const [id, name] of [[held, 'Held'], [rival, 'Rival']] as const) {
      await t.prisma.user.create({ data: { id, projectId: p, role: 'engineer', name, email: `${id}@t.local` } });
      await t.prisma.membership.create({ data: { projectId: p, userId: id, role: 'engineer', status: 'active' } });
    }
    await svc.create(p, createInput({ title: 'Evidence authority' }), asPmc(pmcA, p), 'k-r9e-1');
    const insp = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: p, title: 'Evidence authority' }, include: { items: true } });
    const item = insp.items[0]!;
    const asUser = (sub: string) => ({ sub, role: 'engineer', projectId: p }) as AuthUser;
    const upload = (sub: string) => media.create(p, asUser(sub), {
      kind: 'inspection', mime: 'image/png',
      data: Buffer.from('abcd').toString('base64'),
      inspectionId: insp.id, inspectionItemId: item.id,
    });

    // UNASSIGNED: unchanged — the route's role gate is the whole guard, as it always was
    const beforeAssign = await upload(rival);
    expect(beforeAssign.id).toBeTruthy();

    await t.prisma.inspection.update({ where: { id: insp.id }, data: { assigneeId: held } });

    // ASSIGNED and binding: the rival may neither add evidence…
    await expect(upload(rival)).rejects.toBeInstanceOf(ForbiddenException);
    // …nor destroy what is already there — RED before this round, where remove checked only the
    // media row's projectId and would have deleted the assignee's evidence permanently
    await expect(media.remove(beforeAssign.id, asUser(rival))).rejects.toBeInstanceOf(ForbiddenException);
    expect(await t.prisma.media.findUnique({ where: { id: beforeAssign.id } })).not.toBeNull();

    // precise, not merely strict: the ASSIGNEE does both on their own work
    const own = await upload(held);
    expect(own.id).toBeTruthy();
    expect(await media.remove(own.id, asUser(held))).toBe(true);

    // and once the assignment stops binding, the replacement engineer may act again
    await t.prisma.membership.updateMany({ where: { projectId: p, userId: held }, data: { status: 'removed' } });
    const afterStrand = await upload(rival);
    expect(afterStrand.id).toBeTruthy();
    expect(await media.remove(afterStrand.id, asUser(rival))).toBe(true);
  });

  /**
   * ROUND 9, FINDING 2 — the advisory key does not reach a direct ENGINEER reactivation.
   *
   * `phase6_t4b2_membership_guard` takes the readiness key only when its judged set is non-empty,
   * and an ordinary inactive -> active engineer transition adds to that set only for an org
   * owner/admin. So a raw reactivation holds no advisory key and the fence's try-lock succeeds while
   * it commits underneath. The row lock closes it without needing the other writer to cooperate.
   */
  it('ROUND 9 — the fence LOCKS the assignee’s membership row, so a raw reactivation cannot interleave', async () => {
    const { p, pmcA } = await freshProject();
    const gone = `it-inidem-u-r9gone-${projSeq}`;
    const rival = `it-inidem-u-r9rival2-${projSeq}`;
    for (const [id, name] of [[gone, 'Gone'], [rival, 'Rival']] as const) {
      await t.prisma.user.create({ data: { id, projectId: p, role: 'engineer', name, email: `${id}@t.local` } });
      await t.prisma.membership.create({ data: { projectId: p, userId: id, role: 'engineer', status: 'active' } });
    }
    await svc.create(p, createInput({ title: 'Row-locked fence' }), asPmc(pmcA, p), 'k-r9l-1');
    const insp = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: p, title: 'Row-locked fence' } });
    await t.prisma.inspection.update({ where: { id: insp.id }, data: { assigneeId: gone } });
    await t.prisma.membership.updateMany({ where: { projectId: p, userId: gone }, data: { status: 'removed' } });

    const { PrismaClient } = await import('@prisma/client');
    const other = new PrismaClient();
    // The blocked statement is STARTED inside the other transaction and AWAITED after it commits.
    // Awaiting it inside would hold that transaction open past Prisma's timeout, and the resulting
    // ROLLBACK would let the submit through for the wrong reason — the probe passing on a
    // reactivation that never happened.
    let blocked: Promise<number> | null = null;
    try {
      // The raw reactivation holds the assignee's membership ROW and takes no advisory key — the
      // writer shape the previous head's fence could not see.
      await other.$transaction(async (tx2) => {
        await tx2.$executeRawUnsafe(
          `UPDATE "Membership" SET "status" = 'active' WHERE "projectId" = $1 AND "userId" = $2`, p, gone,
        );
        blocked = t.prisma.$executeRaw`
          UPDATE "Inspection" SET "submitted" = true, "submittedById" = ${rival} WHERE "id" = ${insp.id}`;
        blocked.catch(() => {}); // the rejection is asserted below, not here
        // it is genuinely WAITING on the row, not deciding on the pre-reactivation picture
        await expect(Promise.race([
          blocked.then(() => 'decided', () => 'decided'),
          new Promise((r) => setTimeout(() => r('waiting'), 1200)),
        ])).resolves.toBe('waiting');
      });
      // the reactivation is committed; the fence now re-reads and finds A binding
      await expect(blocked!).rejects.toThrow(/only its assignee may submit it/i);
    } finally {
      await other.$disconnect();
    }
    const after = await t.prisma.inspection.findUniqueOrThrow({ where: { id: insp.id } });
    expect(after.submitted).toBe(false);
    expect(after.submittedById).toBe(null);
  });


  /**
   * ROUND 10, FINDING 1 — the evidence rule at the boundary the replicas SHARE.
   *
   * Round 9 put the evidence authority in `MediaService`. A previous-release replica is not running
   * `MediaService`, so during a rolling deployment it would still attach a photo to an inspection
   * whose assignment binds to somebody else. The submit path got this fence in round 7; evidence was
   * left in the position submit was fenced out of.
   *
   * The raw statements below ARE that writer: the exact rows the previous release writes, with none
   * of this release's guards in front of them and nothing declaring who is writing.
   *
   * ATTACH IS FENCED AT THE DATABASE; REMOVE IS NOT — and this probe pins that line from BOTH sides
   * (#571 round 10, after `api-e2e` on `29b9be8f`). An earlier spelling of the fence carried a DELETE
   * arm, and it refused the seed: `prisma/seed.ts` wipes `Media`, and the FK cascade issues a
   * statement byte-identical to the one the legacy unlink issues. A trigger cannot see intent, so
   * fencing DELETE refuses every reset in the repository. The migration states that measurement in
   * full and says where the remove half rests instead — `MediaService.remove`'s guard plus the drain
   * requirement. Both halves are asserted here, so neither can be quietly moved: the ADMITTED cascade
   * turns red the moment a DELETE arm comes back, and the refused rival delete turns red the moment
   * the service guard that now carries that half is dropped.
   */
  it('ROUND 10 — an unattributed evidence ATTACH on BINDING work is refused at the database', async () => {
    const { p, pmcA } = await freshProject();
    const held = `it-inidem-u-r10held-${projSeq}`;
    const rival = `it-inidem-u-r10riv-${projSeq}`;
    for (const [id, name] of [[held, 'Held'], [rival, 'Rival']] as const) {
      await t.prisma.user.create({ data: { id, projectId: p, role: 'engineer', name, email: `${id}@t.local` } });
      await t.prisma.membership.create({ data: { projectId: p, userId: id, role: 'engineer', status: 'active' } });
    }
    await svc.create(p, createInput({ title: 'Fenced evidence' }), asPmc(pmcA, p), 'k-r10e-1');
    const insp = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: p, title: 'Fenced evidence' }, include: { items: true } });
    const item = insp.items[0]!;
    const asUser = (sub: string) => ({ sub, role: 'engineer', projectId: p }) as AuthUser;
    const links = () => t.prisma.inspectionEvidence.count({ where: { projectId: p, inspectionId: insp.id } });

    // an UNASSIGNED checklist is untouched by the fence — the common case, unchanged
    const before = await media.create(p, asUser(held), {
      kind: 'inspection', mime: 'image/png', data: Buffer.from('abcd').toString('base64'),
      inspectionId: insp.id, inspectionItemId: item.id,
    });
    // `media.create` already linked it, so the legacy unlink comes first and the legacy attach
    // restores it — both while the inspection is unassigned, both admitted
    await t.prisma.$executeRaw`DELETE FROM "InspectionEvidence" WHERE "projectId" = ${p} AND "mediaId" = ${before.id}`;
    await t.prisma.$executeRaw`
      INSERT INTO "InspectionEvidence" ("id","projectId","inspectionId","inspectionItemId","mediaId")
      VALUES ('r10-legacy-open', ${p}, ${insp.id}, ${item.id}, ${before.id})`;
    expect(await links()).toBe(1);

    await t.prisma.inspection.update({ where: { id: insp.id }, data: { assigneeId: held } });

    // ASSIGNED and binding: a previous-release writer declares no actor and cannot attach — RED
    // before this round, where no trigger protected the evidence surface at all. The photo it
    // attaches is a FRESH one, deliberately: re-linking `before` would collide with the
    // (inspectionItemId, mediaId) unique index, and a probe the schema would have refused anyway
    // proves nothing about the fence.
    const stranger = await t.prisma.media.create({
      data: { projectId: p, kind: 'inspection', mime: 'image/png', data: Buffer.from('mnop'), uploadedBy: held },
    });
    await expect(t.prisma.$executeRaw`
      INSERT INTO "InspectionEvidence" ("id","projectId","inspectionId","inspectionItemId","mediaId")
      VALUES ('r10-legacy-1', ${p}, ${insp.id}, ${item.id}, ${stranger.id})`)
      .rejects.toThrow(/only its assignee may attach photo evidence/i);
    expect(await links()).toBe(1);

    // THE MEASURED LIMIT, asserted rather than described. This is the seed's own act: wiping `Media`
    // cascades the link away, and the fence ADMITS it, because the cascade's statement is the legacy
    // unlink's statement. Re-adding a DELETE arm makes this line fail here instead of in `api-e2e`.
    await t.prisma.media.deleteMany({ where: { projectId: p, id: before.id } });
    expect(await links()).toBe(0);

    // …so the remove half rests on the SERVICE guard, and that is what holds it: the assignee may
    // destroy the photos behind their own binding work, and a rival with the same role may not
    const own = await media.create(p, asUser(held), {
      kind: 'inspection', mime: 'image/png', data: Buffer.from('efgh').toString('base64'),
      inspectionId: insp.id, inspectionItemId: item.id,
    });
    await expect(media.remove(own.id, asUser(rival))).rejects.toBeInstanceOf(ForbiddenException);
    expect(await links()).toBe(1);
    expect(await media.remove(own.id, asUser(held))).toBe(true);
    expect(await links()).toBe(0);

    // …and a STRANDED assignment returns evidence to the ordinary role gate. This is the SAME
    // statement, on the same row, by the same unattributed writer as the refusal above — only the
    // assignee's standing differs, so nothing but the binding question can explain the two answers.
    await t.prisma.membership.updateMany({ where: { projectId: p, userId: held }, data: { status: 'removed' } });
    await t.prisma.$executeRaw`
      INSERT INTO "InspectionEvidence" ("id","projectId","inspectionId","inspectionItemId","mediaId")
      VALUES ('r10-legacy-1', ${p}, ${insp.id}, ${item.id}, ${stranger.id})`;
    expect(await links()).toBe(1);
  });

  /**
   * ROUND 11, FINDING 1 — reading the assignee is not holding it.
   *
   * `assertEvidenceMutable` returned early on an UNASSIGNED inspection, and the membership row lock
   * it takes when assigned protects the assignee's STANDING, never `Inspection.assigneeId`. The
   * freeze trigger is a one-way LATCH, so `null → A` is a permitted assignment: an alternate writer
   * could make it between the authorisation and the write, and B's delete then destroyed the
   * evidence — bytes included — of work that had just become A's.
   *
   * `submit` already answered this in round 5, by pinning the OBSERVED `assigneeId` in its CAS
   * predicate. Evidence has two writers rather than one, so the same fence is stated once in the
   * participant and taken by both. This probe is the interleaving itself, with the assignment
   * committed by a SECOND connection between the two halves.
   */
  it('ROUND 11 — an assignment landing mid-delete refuses the delete instead of destroying the evidence', async () => {
    const { p, pmcA } = await freshProject();
    const holder = `it-inidem-u-r11h-${projSeq}`;
    await t.prisma.user.create({ data: { id: holder, projectId: p, role: 'engineer', name: 'Holder', email: `${holder}@t.local` } });
    await t.prisma.membership.create({ data: { projectId: p, userId: holder, role: 'engineer', status: 'active' } });
    await svc.create(p, createInput({ title: 'Raced assignment' }), asPmc(pmcA, p), 'k-r11-1');
    const insp = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: p, title: 'Raced assignment' }, include: { items: true } });
    const asUser = (sub: string) => ({ sub, role: 'engineer', projectId: p }) as AuthUser;

    // UNASSIGNED when the photo is attached — the ordinary case, admitted
    const shot = await media.create(p, asUser(holder), {
      kind: 'inspection', mime: 'image/png', data: Buffer.from('r11a').toString('base64'),
      inspectionId: insp.id, inspectionItemId: insp.items[0]!.id,
    });
    expect(await t.prisma.inspectionEvidence.count({ where: { projectId: p, mediaId: shot.id } })).toBe(1);

    // THE RACE ITSELF. Setting the assignee beforehand would only exercise the ordinary guard —
    // `assertEvidenceMutable` would read it and refuse, and the fence would never matter (this
    // probe passed against the reverted fence until it was written this way). The assignment must
    // land BETWEEN the authorisation's unlocked read and the write it authorised, so it is
    // committed from a SECOND connection at exactly that point: the participant's own
    // `removeEvidence` is the seam, and a plain `t.prisma` call inside the running `$transaction`
    // takes a different pooled connection and commits independently of it.
    const participant = t.app.get(InspectionParticipant);
    const realRemove = participant.removeEvidence.bind(participant);
    const spy = vi.spyOn(participant, 'removeEvidence').mockImplementation(async (...args) => {
      await t.prisma.inspection.update({ where: { id: insp.id }, data: { assigneeId: holder } });
      return realRemove(...args);
    });
    try {
      await expect(media.remove(shot.id, asUser(`it-inidem-u-r11o-${projSeq}`)))
        .rejects.toBeInstanceOf(ConflictException);
    } finally {
      spy.mockRestore();
    }
    // the evidence, and its bytes, survive the assignment that landed mid-flight
    expect(await t.prisma.inspectionEvidence.count({ where: { projectId: p, mediaId: shot.id } })).toBe(1);
    expect(await t.prisma.media.count({ where: { projectId: p, id: shot.id } })).toBe(1);

    // precise, not merely strict: the assignee's own delete still succeeds
    expect(await media.remove(shot.id, asUser(holder))).toBe(true);
    expect(await t.prisma.inspectionEvidence.count({ where: { projectId: p, mediaId: shot.id } })).toBe(0);
  });

  /**
   * ROUND 11, FINDING 3 — a refusal after `storage.put` must not leave the object behind.
   *
   * Round 10 moved a preflight ahead of the upload, and said in the same breath that it is
   * ADVISORY. So the authoritative in-transaction check can still refuse a request whose bytes are
   * already stored — an assignee inactive at the preflight and reactivated before the transaction
   * is precisely that — and the rollback does not reach the bucket.
   */
  it('ROUND 11 — a refusal AFTER the upload removes the object it stored', async () => {
    const { p, pmcA } = await freshProject();
    const held = `it-inidem-u-r11bh-${projSeq}`;
    const rival = `it-inidem-u-r11br-${projSeq}`;
    for (const [id, name] of [[held, 'Held'], [rival, 'Rival']] as const) {
      await t.prisma.user.create({ data: { id, projectId: p, role: 'engineer', name, email: `${id}@t.local` } });
      await t.prisma.membership.create({ data: { projectId: p, userId: id, role: 'engineer', status: 'active' } });
    }
    await svc.create(p, createInput({ title: 'Refused upload' }), asPmc(pmcA, p), 'k-r11-2');
    const insp = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: p, title: 'Refused upload' }, include: { items: true } });
    // assigned to `held`, whose membership is INACTIVE — so the preflight admits the rival…
    await t.prisma.inspection.update({ where: { id: insp.id }, data: { assigneeId: held } });
    await t.prisma.membership.updateMany({ where: { projectId: p, userId: held }, data: { status: 'removed' } });

    const storage = t.app.get(StorageService);
    // captured BEFORE the spy replaces it — binding after `vi.spyOn` would bind the spy to itself
    const original = storage.put.bind(storage);
    const put = vi.spyOn(storage, 'put');
    const remove = vi.spyOn(storage, 'remove');
    try {
      // …and `held` is reactivated after the preflight, so the AUTHORITATIVE check refuses
      put.mockImplementation(async (...args: Parameters<StorageService['put']>) => {
        await t.prisma.membership.updateMany({ where: { projectId: p, userId: held }, data: { status: 'active' } });
        return original(...args);
      });
      await expect(media.create(p, { sub: rival, role: 'engineer', projectId: p } as AuthUser, {
        kind: 'inspection', mime: 'image/png', data: Buffer.from('r11c').toString('base64'),
        inspectionId: insp.id, inspectionItemId: insp.items[0]!.id,
      })).rejects.toBeInstanceOf(ForbiddenException);
      expect(put).toHaveBeenCalledTimes(1);
      // RED before this round: the object stayed, one orphan per refused request
      expect(remove).toHaveBeenCalledTimes(1);
      expect(remove.mock.calls[0]![0]).toBe(put.mock.calls[0]![0]);
    } finally {
      put.mockRestore();
      remove.mockRestore();
    }
  });

  /**
   * ROUND 10, FINDING 2 — the bytes must not be stored by a request the authority refuses.
   *
   * The authoritative check runs inside the transaction, but `storage.put` had already written the
   * object by then and the rollback does not reach the bucket: a refused caller could repeat with a
   * fresh `clientKey` indefinitely, each 403 leaving an unreferenced object behind.
   */
  it('ROUND 10 — a refused evidence upload stores no bucket object', async () => {
    const { p, pmcA } = await freshProject();
    const held = `it-inidem-u-r10bh-${projSeq}`;
    const rival = `it-inidem-u-r10br-${projSeq}`;
    for (const [id, name] of [[held, 'Held'], [rival, 'Rival']] as const) {
      await t.prisma.user.create({ data: { id, projectId: p, role: 'engineer', name, email: `${id}@t.local` } });
      await t.prisma.membership.create({ data: { projectId: p, userId: id, role: 'engineer', status: 'active' } });
    }
    await svc.create(p, createInput({ title: 'Preflight' }), asPmc(pmcA, p), 'k-r10p-1');
    const insp = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: p, title: 'Preflight' }, include: { items: true } });
    await t.prisma.inspection.update({ where: { id: insp.id }, data: { assigneeId: held } });

    const storage = t.app.get(StorageService);
    const put = vi.spyOn(storage, 'put');
    try {
      await expect(media.create(p, { sub: rival, role: 'engineer', projectId: p } as AuthUser, {
        kind: 'inspection', mime: 'image/png', data: Buffer.from('abcd').toString('base64'),
        inspectionId: insp.id, inspectionItemId: insp.items[0]!.id,
      })).rejects.toBeInstanceOf(ForbiddenException);
      // RED before this round: the refusal came AFTER the object was written
      expect(put).not.toHaveBeenCalled();
    } finally {
      put.mockRestore();
    }
  });

});
