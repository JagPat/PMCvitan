import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import { ConflictException } from '@nestjs/common';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture, wipeDecisionsVia, seedPublishedDecision } from './fixtures';
import { InspectionsService } from '../../src/inspections/inspections.service';
import { ActivitiesService } from '../../src/activities/activities.service';
import { DailyLogService } from '../../src/daily-log/daily-log.service';
import { SnapshotService } from '../../src/snapshot/snapshot.service';
import type { AuthUser, Role } from '../../src/common/auth';
import type { CreateActivityInput } from '../../src/contracts';
import { sanctionedReset } from '../../prisma/sanctioned-reset';

/**
 * Top 10 #4 (#778) acceptance proofs — the EXISTING notice writers, characterized as they are on `6b372aa`
 * (owner record #482 6113732809). Nothing here changes a writer or invents a dedup rule: each proof pins
 * what one logical event writes today, which logical events are distinct, and who is served the result.
 *
 * - inspection reject: an unkeyed retry after commit is refused, and two decides held at a barrier
 *   after their pre-transaction read leave ONE re-inspection notice, stamped with the child it announces;
 * - checklist issue: two requests under one key, the second held at the same-key reservation while the
 *   first is uncommitted (observed), leave ONE checklist and ONE notice; two unkeyed requests are two
 *   checklists, so two notices, each stamped with its own checklist;
 * - material mismatch flag: a keyed replay, and two same-key requests contending at the reservation the
 *   same way, leave ONE notice and ONE event; the command has no state guard, so each unkeyed flag is a new act with its own notice and event;
 * - recipients: each writer's notice, by its stored id, is served to every project role whose feed
 *   carries kind-less notices (pmc, client, engineer, contractor, consultant) and is tied to the logical
 *   event that wrote it; a worker device and another project's member are refused the feed, and the other
 *   project's own feed does not carry it.
 *
 * Sign-off requests are proven in `closing-signoff.test.ts`, on its own completion barrier.
 *
 * Isolated automated-test fixtures only: none of this is production or role-live QA.
 */
describe('Top 10 #4 (#778) — the existing notice writers and their recipients (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let inspections: InspectionsService;
  let activities: ActivitiesService;
  let dailyLog: DailyLogService;
  let snapshot: SnapshotService;
  let seq = 0;
  const prefix = 'it-t4bw-';
  const RESET_TABLES = ['DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor', 'ProjectionGeneration',
    'ActivitiesProjection', 'InspectionsProjection', 'DailyLogProjection'] as const;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    inspections = t.app.get(InspectionsService);
    activities = t.app.get(ActivitiesService);
    dailyLog = t.app.get(DailyLogService);
    snapshot = t.app.get(SnapshotService);
  });
  afterAll(async () => {
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    const pids = { startsWith: prefix };
    await sanctionedReset(t.prisma, RESET_TABLES, { cascade: true });
    await t.prisma.commandExecution.deleteMany({ where: { projectId: pids } });
    await t.prisma.inspectionItem.deleteMany({ where: { inspection: { projectId: pids } } });
    await t.prisma.inspection.deleteMany({ where: { projectId: pids } });
    await t.prisma.activity.deleteMany({ where: { projectId: pids } });
    await t.prisma.siteMaterial.deleteMany({ where: { projectId: pids } });
    await t.prisma.crewRow.deleteMany({ where: { dailyLog: { projectId: pids } } });
    await t.prisma.dailyLog.deleteMany({ where: { projectId: pids } });
    await wipeDecisionsVia(t.prisma, async (tx) => {
      await tx.decisionOption.deleteMany({ where: { decision: { projectId: pids } } });
      await tx.decision.deleteMany({ where: { projectId: pids } });
    });
    await t.prisma.notification.deleteMany({ where: { projectId: pids } });
    await t.prisma.auditLog.deleteMany({ where: { projectId: pids } });
    await t.prisma.membership.deleteMany({ where: { projectId: pids } });
    await t.prisma.user.deleteMany({ where: { id: { startsWith: `${prefix}u-` } } });
    await t.prisma.project.deleteMany({ where: { id: pids } });
  });

  /** The project roles whose feed carries kind-less notices, each an active member of the fresh project. */
  const FEED_ROLES = ['pmc', 'client', 'engineer', 'contractor', 'consultant'] as const;
  type FeedRole = (typeof FEED_ROLES)[number];
  interface Fresh { p: string; users: Record<FeedRole, string>; pmcB: string; other: { p: string; pmc: string } }

  const project = async (p: string) => t.prisma.project.create({
    data: { id: p, orgId: f.orgA.id, name: p, short: 'W', descriptor: '', stage: 'x', siteCode: 'W', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
  });
  const memberOf = async (p: string, role: Role, label: string): Promise<string> => {
    const id = `${prefix}u-${label}-${seq}`;
    await t.prisma.user.create({ data: { id, projectId: p, role, name: `W ${label}`, email: `${id}@t.local` } });
    await t.prisma.membership.create({ data: { projectId: p, userId: id, role, status: 'active' } });
    return id;
  };
  /** A fresh project with one active member per feed role and a second pmc, plus ANOTHER project with its own pmc. */
  const fresh = async (): Promise<Fresh> => {
    seq += 1;
    const p = `${prefix}${Date.now() % 1e6}-${seq}`;
    await project(p);
    const users = {} as Record<FeedRole, string>;
    for (const role of FEED_ROLES) users[role] = await memberOf(p, role, role);
    const pmcB = await memberOf(p, 'pmc', 'pmcB');
    const op = `${p}-x`;
    await project(op);
    return { p, users, pmcB, other: { p: op, pmc: await memberOf(op, 'pmc', 'other') } };
  };
  const as = (p: string, sub: string, role: Role): AuthUser => ({ sub, role, projectId: p }) as AuthUser;

  /**
   * Who is served the notice `noticeId`: every feed role sees that stored row (same id, text, stamp and
   * instant, unread); a worker device and the other project's member are refused this project's feed; the
   * other project's own feed does not carry it.
   */
  const expectRecipients = async (w: Fresh, noticeId: string) => {
    const row = await t.prisma.notification.findUniqueOrThrow({ where: { id: noticeId } });
    for (const role of FEED_ROLES) {
      const served = (await snapshot.build(w.p, role, w.users[role])).notifications.filter((n) => n.id === noticeId);
      expect(served, `${role} is served notice ${noticeId} once`).toHaveLength(1);
      expect(served[0]).toMatchObject({ text: row.text, color: row.color, at: row.at.toISOString(), unread: true });
      expect(served[0].inspectionId).toBe(row.inspectionId ?? undefined);
    }
    const http = () => request(t.app.getHttpServer());
    // a worker DEVICE token, shaped as the device pairing issues it (`worker: true`)
    const device = t.app.get(JwtService).sign({ sub: `worker-${prefix}${seq}`, role: 'worker', projectId: w.p, worker: true });
    const worker = await http().get(`/projects/${w.p}/snapshot`).set('Authorization', `Bearer ${device}`);
    expect(worker.status, 'a worker device is refused the feed').toBe(403);
    const foreign = await http().get(`/projects/${w.p}/snapshot`).set('Authorization', `Bearer ${t.issueProjectToken(w.other.pmc, w.p, 'pmc')}`);
    expect([401, 403], 'another project\'s member is refused this feed').toContain(foreign.status);
    const otherFeed = (await snapshot.build(w.other.p, 'pmc', w.other.pmc)).notifications.map((n) => n.id);
    expect(otherFeed, 'another project\'s feed does not carry it').not.toContain(noticeId);
  };

  /** The ONE domain event of `eventType` for `entityId` in project `p` (throws on none or many). */
  const oneEvent = async (p: string, eventType: string, entityId: string) => {
    const rows = await t.prisma.domainEvent.findMany({ where: { projectId: p, eventType, entityId } });
    expect(rows, `${eventType} for ${entityId}`).toHaveLength(1);
    return rows[0]!;
  };

  /** Hold every `inspection.findUnique` of `id` until two have arrived (both decides read the undecided row). */
  const barrierOnInspection = (id: string) => {
    const delegate = t.prisma.inspection as unknown as { findUnique: (args: { where: { id?: string } }) => Promise<unknown> };
    const original = delegate.findUnique.bind(t.prisma.inspection);
    let release!: () => void;
    const both = new Promise<void>((resolve) => { release = resolve; });
    let reads = 0;
    delegate.findUnique = async (args: { where: { id?: string } }) => {
      const row = await original(args);
      if (args?.where?.id === id) {
        reads += 1;
        if (reads === 2) release();
        await both;
      }
      return row;
    };
    return { restore: () => { delegate.findUnique = original; }, reads: () => reads };
  };

  /** A promise resolvable from outside. */
  const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
  /** Subscribe at once and never reject. */
  const settle = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));
  const until = async (probe: () => Promise<boolean>, what: string, ms = 10_000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await probe()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`barrier not reached: ${what}`);
  };
  /** The backends waiting on a lock the backend `holder` holds, with the statement each is running. */
  const waitersOn = async (holder: number) =>
    t.prisma.$queryRawUnsafe<Array<{ pid: number; query: string }>>(
      'SELECT pid, query FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', holder);

  /**
   * Same-key contention at the ledger's admission boundary, made deterministic (#482 6114250767).
   *
   * The FIRST attempt runs until its command transaction holds this key's receipt (reserved, executed and
   * marked succeeded, all uncommitted), and is held there, before commit. Only then is the SECOND attempt
   * started. Nothing is committed, so its `peekReplay` and the ledger's committed-receipt fast path both find
   * no receipt and it goes on to reserve the same key, where PostgreSQL blocks it on the holder's
   * unique-index entry. The test observes exactly that (the contender's `CommandExecution` insert waiting on
   * the holder's backend, with still no committed receipt) before it releases the holder. A schedule in
   * which the two attempts ran one after the other cannot pass this.
   */
  const sameKeyContention = async <A, B>(projectId: string, key: string, first: () => Promise<A>, second: () => Promise<B>) => {
    const client = t.prisma as unknown as { $transaction: (arg: unknown, opts?: Record<string, unknown>) => Promise<unknown> };
    const original = client.$transaction.bind(t.prisma);
    const held = gate();
    const release = gate();
    let armed = true;
    let holder = 0;
    client.$transaction = (arg: unknown, opts?: Record<string, unknown>) => {
      if (!armed || typeof arg !== 'function') return original(arg, opts);
      return original(async (tx: TestApp['prisma']) => {
        const result = await (arg as (tx: TestApp['prisma']) => Promise<unknown>)(tx);
        // hold only the one command transaction that wrote THIS key's receipt, seen through itself
        if (armed && (await tx.commandExecution.count({ where: { projectId, idempotencyKey: key } })) > 0) {
          armed = false;
          holder = Number((await tx.$queryRawUnsafe<Array<{ pid: number }>>('SELECT pg_backend_pid() AS pid'))[0]!.pid);
          held.open();
          await release.p;
        }
        return result;
      }, { ...opts, timeout: 60_000, maxWait: 10_000 });
    };
    try {
      const a = settle(first());
      const reached = await Promise.race([held.p.then(() => 'held' as const), a.then(() => 'ended' as const)]);
      expect(reached, 'the first attempt is held inside its command transaction, before commit').toBe('held');
      const b = settle(second());
      await until(async () => (await waitersOn(holder)).length > 0, 'the contender blocks on the held first attempt');
      const waiting = await waitersOn(holder);
      expect(waiting, 'exactly one contender waits on the holder').toHaveLength(1);
      expect(waiting[0]!.query, 'it waits at the same-key reservation').toMatch(/INSERT INTO "public"\."CommandExecution"/);
      expect(await t.prisma.commandExecution.count({ where: { projectId, idempotencyKey: key } }), 'no receipt committed while it waits').toBe(0);
      release.open();
      const [ra, rb] = await Promise.all([a, b]);
      return { first: ra, second: rb };
    } finally {
      release.open();
      client.$transaction = original;
    }
  };

  /** A checklist issued by the pmc and submitted by the engineer, ready to decide. */
  const submittedChecklist = async (w: Fresh, title: string) => {
    await inspections.create(w.p, { title, zone: 'GF', items: ['Rebar', 'Cover'] }, as(w.p, w.users.pmc, 'pmc'), `k-${title}-c`);
    const insp = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: w.p, title }, include: { items: true } });
    const items = insp.items.map((it) => ({ id: it.id, name: it.name, state: 'pass' as const, photos: 0, note: '' }));
    await inspections.submit(w.p, insp.id, { items }, as(w.p, w.users.engineer, 'engineer'), `k-${title}-s`);
    return insp;
  };

  it('inspection reject: an unkeyed retry is refused and two concurrent decides leave ONE re-inspection notice, stamped with its child and served to every feed role', async () => {
    const w = await fresh();
    const reinspectionNotices = () => t.prisma.notification.findMany({ where: { projectId: w.p, text: { startsWith: 'Re-inspection ' } } });

    // sequential: the keyed decide commits; the same request without a key is refused after commit
    const one = await submittedChecklist(w, 'Reject one');
    const rejectOne = { approve: false, rejectedItemIds: [one.items[0]!.id], assigneeId: w.users.engineer };
    await inspections.decide(w.p, one.id, rejectOne, as(w.p, w.users.pmc, 'pmc'), 'k-rej-1');
    await expect(inspections.decide(w.p, one.id, rejectOne, as(w.p, w.users.pmc, 'pmc'), undefined)).rejects.toThrow();
    const childOne = await t.prisma.inspection.findFirstOrThrow({ where: { reinspectionOfId: one.id } });
    expect((await reinspectionNotices()).map((n) => n.inspectionId)).toEqual([childOne.id]);

    // concurrent: two pmcs reject at once, both held after their pre-transaction read
    const two = await submittedChecklist(w, 'Reject two');
    const rejectTwo = { approve: false, rejectedItemIds: [two.items[0]!.id], assigneeId: w.users.engineer };
    const b = barrierOnInspection(two.id);
    let raced: PromiseSettledResult<unknown>[];
    try {
      raced = await Promise.allSettled([
        inspections.decide(w.p, two.id, rejectTwo, as(w.p, w.users.pmc, 'pmc'), 'k-rej-race-a'),
        inspections.decide(w.p, two.id, rejectTwo, as(w.p, w.pmcB, 'pmc'), 'k-rej-race-b'),
      ]);
    } finally {
      b.restore();
    }
    expect(b.reads(), 'both decides read the undecided checklist').toBe(2);
    expect(raced.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((raced.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
    const children = await t.prisma.inspection.findMany({ where: { reinspectionOfId: two.id } });
    expect(children, 'one re-inspection child').toHaveLength(1);
    const notices = (await reinspectionNotices()).filter((n) => n.inspectionId !== childOne.id);
    expect(notices.map((n) => n.inspectionId), 'one notice, stamped with the child it announces').toEqual([children[0]!.id]);

    // the notice is the trace of exactly one logical rejection: one rejected event for the checklist and one
    // re-inspection event for the child the notice names
    const rejected = await oneEvent(w.p, 'inspection.rejected', two.id);
    const created = await oneEvent(w.p, 'inspection.reinspection_created', children[0]!.id);
    expect(created.causedByEventId).toBe(rejected.eventId);
    await expectRecipients(w, notices[0]!.id);
  });

  it('checklist issue: two concurrent same-key requests leave ONE checklist and ONE notice; two unkeyed requests are two checklists with two notices', async () => {
    const w = await fresh();
    const input = { title: 'Issued once', zone: 'GF', items: ['Rebar'] };
    // the second request reaches the same-key reservation while the first is held uncommitted; once the first
    // commits, the second's reservation fails on the key and it replays the winner's receipt (commands.ts)
    const raced = await sameKeyContention(w.p, 'k-issue-cc',
      () => inspections.create(w.p, input, as(w.p, w.users.pmc, 'pmc'), 'k-issue-cc'),
      () => inspections.create(w.p, input, as(w.p, w.users.pmc, 'pmc'), 'k-issue-cc'));
    expect(raced.first.ok, 'the held first attempt commits').toBe(true);
    expect(raced.second.ok ? 'replayed' : raced.second.e, 'the contender replays the committed receipt').toBe('replayed');
    const issued = await t.prisma.inspection.findMany({ where: { projectId: w.p, title: input.title } });
    expect(issued, 'one checklist').toHaveLength(1);
    const notices = await t.prisma.notification.findMany({ where: { projectId: w.p, text: { startsWith: 'New checklist issued: ' } } });
    expect(notices.map((n) => [n.text, n.inspectionId])).toEqual([[`New checklist issued: ${input.title} — GF`, issued[0]!.id]]);
    expect(await t.prisma.commandExecution.count({ where: { projectId: w.p, commandType: 'inspections.create', idempotencyKey: 'k-issue-cc' } })).toBe(1);
    await oneEvent(w.p, 'inspection.created', issued[0]!.id);
    await expectRecipients(w, notices[0]!.id);

    // without a key, each request is its own act: the id is minted per request, so a repeat is a NEW
    // checklist with its own notice and event — distinct, and kept distinct
    const repeat = { title: 'Issued twice', zone: 'GF', items: ['Rebar'] };
    await inspections.create(w.p, repeat, as(w.p, w.users.pmc, 'pmc'), undefined);
    await inspections.create(w.p, repeat, as(w.p, w.users.pmc, 'pmc'), undefined);
    const twice = await t.prisma.inspection.findMany({ where: { projectId: w.p, title: repeat.title }, orderBy: { id: 'asc' } });
    expect(twice).toHaveLength(2);
    const stamped = (await t.prisma.notification.findMany({ where: { projectId: w.p, text: `New checklist issued: ${repeat.title} — GF` } }))
      .map((n) => n.inspectionId).sort();
    expect(stamped, 'one notice per checklist, each stamped with its own').toEqual(twice.map((i) => i.id).sort());
    for (const i of twice) await oneEvent(w.p, 'inspection.created', i.id);
  });

  it('material mismatch flag: a keyed replay and two concurrent same-key requests leave ONE notice and ONE event; each unkeyed flag is a new act', async () => {
    const w = await fresh();
    const pmc = as(w.p, w.users.pmc, 'pmc');
    const decisionId = `${prefix}dec-${seq}`;
    await seedPublishedDecision(t.prisma, { id: decisionId, projectId: w.p, title: 'Flooring', room: 'Living', status: 'approved', photoSwatch: 'marble' });
    await dailyLog.start(w.p, pmc, `k-mm-start-${seq}`);
    await dailyLog.addMaterial(w.p, { name: 'Marble', qty: '20 boxes', zone: 'GF', swatch: 'marble', decisionId }, pmc, `k-mm-mat-${seq}`);
    const mat = await t.prisma.siteMaterial.findFirstOrThrow({ where: { projectId: w.p, decisionId } });
    const text = `Material mismatch: Marble ≠ approved ${decisionId}`;
    const mismatchNotices = () => t.prisma.notification.findMany({ where: { projectId: w.p, text } });
    const flagEvents = () => t.prisma.domainEvent.count({ where: { projectId: w.p, eventType: 'material.mismatch_flagged', entityId: mat.id } });

    // keyed: the retry replays
    await dailyLog.flagMismatch(w.p, { decisionId }, pmc, 'k-mm-1');
    await dailyLog.flagMismatch(w.p, { decisionId }, pmc, 'k-mm-1');
    expect(await mismatchNotices()).toHaveLength(1);
    expect(await flagEvents()).toBe(1);
    expect((await t.prisma.siteMaterial.findUniqueOrThrow({ where: { id: mat.id } })).matched).toBe(false);
    const ev = await oneEvent(w.p, 'material.mismatch_flagged', mat.id);
    expect(ev.payload).toMatchObject({ decisionId });
    await expectRecipients(w, (await mismatchNotices())[0]!.id);

    // concurrent under ONE key: the second request reaches the same-key reservation while the first is held
    // uncommitted; the ledger admits one execution and the contender replays it
    const raced = await sameKeyContention(w.p, 'k-mm-cc',
      () => dailyLog.flagMismatch(w.p, { decisionId }, pmc, 'k-mm-cc'),
      () => dailyLog.flagMismatch(w.p, { decisionId }, pmc, 'k-mm-cc'));
    expect(raced.first.ok, 'the held first attempt commits').toBe(true);
    expect(raced.second.ok ? 'replayed' : raced.second.e, 'the contender replays the committed receipt').toBe('replayed');
    expect(await t.prisma.commandExecution.count({ where: { projectId: w.p, commandType: 'daily-log.flagMismatch', idempotencyKey: 'k-mm-cc' } })).toBe(1);
    expect(await mismatchNotices(), 'the second key is ONE more flag').toHaveLength(2);
    expect(await flagEvents()).toBe(2);

    // unkeyed: the flag has no state guard, so a repeat is another flag of the same material — a new act
    // with its own notice and event (characterized as it is; no dedup is invented here)
    await dailyLog.flagMismatch(w.p, { decisionId }, pmc, undefined);
    await dailyLog.flagMismatch(w.p, { decisionId }, pmc, undefined);
    const all = await mismatchNotices();
    expect(all).toHaveLength(4);
    expect(new Set(all.map((n) => n.id)).size).toBe(4);
    expect(await flagEvents()).toBe(4);
    expect(await t.prisma.commandExecution.count({ where: { projectId: w.p, commandType: 'daily-log.flagMismatch' } }), 'an unkeyed flag writes no receipt').toBe(2);
  });

  it('sign-off request and approval: each notice is served to every feed role and tied to its one logical event', async () => {
    const w = await fresh();
    const pmc = as(w.p, w.users.pmc, 'pmc');
    const eng = as(w.p, w.users.engineer, 'engineer');
    await activities.create(w.p, { name: 'Skirting', zone: 'GF', plannedStart: 0, plannedEnd: 5, gateMaterial: 'na', gateTeam: 'na' } as CreateActivityInput, pmc, `k-so-c-${seq}`);
    const a = await t.prisma.activity.findFirstOrThrow({ where: { projectId: w.p, name: 'Skirting' } });
    await activities.start(w.p, a.id, eng, `k-so-s-${seq}`);
    await activities.complete(w.p, a.id, eng, `k-so-done-${seq}`);
    const closing = await t.prisma.inspection.findFirstOrThrow({ where: { projectId: w.p, activityId: a.id, closing: true } });
    const requested = await t.prisma.notification.findMany({ where: { projectId: w.p, text: { startsWith: 'Sign-off requested: ' } } });
    expect(requested.map((n) => [n.text, n.inspectionId])).toEqual([[`Sign-off requested: Skirting — awaiting the PMC's closing inspection`, closing.id]]);
    const completion = await oneEvent(w.p, 'activity.completion_requested', a.id);
    expect(completion.payload).toMatchObject({ closingInspectionId: closing.id });
    await oneEvent(w.p, 'inspection.closing_created', closing.id);
    await expectRecipients(w, requested[0]!.id);

    await inspections.decide(w.p, closing.id, { approve: true, rejectedItemIds: [] }, pmc, `k-so-ok-${seq}`);
    const signedOff = await t.prisma.notification.findMany({ where: { projectId: w.p, text: 'Signed off: Skirting is complete.' } });
    expect(signedOff).toHaveLength(1);
    const approved = await oneEvent(w.p, 'inspection.approved', closing.id);
    expect((await oneEvent(w.p, 'activity.signed_off', a.id)).causedByEventId).toBe(approved.eventId);
    await expectRecipients(w, signedOff[0]!.id);
  });
});
