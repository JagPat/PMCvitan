import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture, wipeDecisions } from './fixtures';
import { DecisionsService } from '../../src/decisions/decisions.service';
import { addMemberSchema } from '../../src/contracts';
import type { AuthUser } from '../../src/common/auth';

/**
 * Phase 6 unit 4b-i round 14 — the three Codex findings on `a09f0b2`.
 *
 *   R14-1 (P2) `addMemberSchema` admits a whitespace-only name, so `holderLabel` renders blank and
 *              `decisions_t4b_blank` rejects the approval — as a raw Prisma error, and the decision
 *              is then unapprovable by anyone. Two doors: the contract that let the name in, and
 *              the service that must say so before it writes.
 *   R14-2 (P1) `migrate.sh` runs inside the API container's start command, so a rolled-back deploy
 *              leaves a pre-4b release — which writes no `approvedDecider*` column — in front of
 *              the seal. Answered in prose rather than code; see the block below and §P6-4b.1.
 *   R14-3 (P1) a DIRECT `Activity`/`SiteMaterial` insert races the conversion seal. The FK's
 *              `FOR KEY SHARE` does not conflict with the conversion's non-key UPDATE, so both
 *              commit and the dependent waits forever on an issue nobody can approve. Round 10
 *              serialized the SERVICE writers, which opt into `FOR SHARE`; nothing served a raw one.
 *
 * Every probe below was RED at `a09f0b2`.
 */
describe('Phase 6 unit 4b-i round 14 — the three Codex findings (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let svc: DecisionsService;
  let seq = 0;
  const run = Math.random().toString(36).slice(2, 8);
  // A DEDICATED client for the R14-3 race — the held transaction, the conflicting statement and the
  // `pg_stat_activity` poll each need their own backend connection AT THE SAME TIME.
  let raceDb: PrismaClient;

  const pmc = (): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId: f.projectA.id }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    svc = t.app.get(DecisionsService);
    raceDb = new PrismaClient();
    await raceDb.$connect();
  });
  afterAll(async () => {
    await raceDb?.$disconnect();
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await t.prisma.activity.deleteMany({ where: { projectId: f.projectA.id } });
    await t.prisma.siteMaterial.deleteMany({ where: { projectId: f.projectA.id } });
    await t.prisma.dailyLog.deleteMany({ where: { projectId: f.projectA.id } });
    await wipeDecisions(t.prisma, { projectId: { in: [f.projectA.id, f.projectB.id] } });
    // This suite mints its own holder identities; a leftover `User` blocks the project delete.
    const mine = await t.prisma.user.findMany({ where: { email: { endsWith: '@t4bc14.test' } }, select: { id: true } });
    const mineIds = mine.map((u) => u.id);
    if (mineIds.length) {
      await t.prisma.membership.deleteMany({ where: { userId: { in: mineIds } } });
      await t.prisma.user.deleteMany({ where: { id: { in: mineIds } } });
    }
  });

  const statusOf = async (id: string): Promise<string> =>
    (await t.prisma.decision.findUniqueOrThrow({ where: { id }, select: { status: true } })).status as string;

  /** An UNPUBLISHED ordinary draft — the only door a conversion to `recorded` may pass through. */
  const seedDraft = async (): Promise<string> => {
    const id = `DL-t4bc14-draft-${run}-${seq++}`;
    await t.prisma.decision.create({
      data: {
        id, projectId: f.projectA.id, title: `Draft ${id}`, room: 'Kitchen', status: 'pending',
        ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id, publishedAt: null,
      },
    });
    return id;
  };

  /** A PUBLISHED, client-held decision awaiting approval, with two options. */
  const seedPublished = async (): Promise<string> => {
    const id = `DL-t4bc14-pub-${run}-${seq++}`;
    await t.prisma.decision.create({
      data: {
        id, projectId: f.projectA.id, title: `Pub ${id}`, room: 'Kitchen', status: 'pending',
        deciderKind: 'client', ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id,
      },
    });
    await t.prisma.decisionOption.createMany({ data: [
      { decisionId: id, label: 'A', optionKey: 'a', material: 'Teak', delta: 0, swatch: 'sw1', recommended: true, order: 0 },
      { decisionId: id, label: 'B', optionKey: 'b', material: 'Oak', delta: 100, swatch: 'sw2', recommended: false, order: 1 },
    ] });
    await t.prisma.decision.update({ where: { id }, data: { publishedAt: new Date() } });
    return id;
  };

  // ── R14-1 ──────────────────────────────────────────────────────────────────────────────────

  it('R14-1: the member contract refuses a whitespace-only name', async () => {
    // `z.string().min(1)` counts characters, and a tab is a character. The name then flows all the
    // way to `decisions_t4b_holder_label`, which renders it verbatim, and the seal — correctly —
    // refuses to freeze a blank attribution. Closing the door at the contract is the cheap half.
    for (const blank of ['\t', '   ', '\n', ' \t\r\n ']) {
      const parsed = addMemberSchema.safeParse({ name: blank, role: 'contractor', email: 'x@y.test' });
      expect(parsed.success, `a name of ${JSON.stringify(blank)} is not a name`).toBe(false);
    }
    // …and an ordinary name with incidental padding is ACCEPTED, trimmed — being stricter than the
    // seal is the failure round 5 already recorded here.
    const ok = addMemberSchema.safeParse({ name: '  Priya Nair  ', role: 'contractor', email: 'p@y.test' });
    expect(ok.success).toBe(true);
    expect(ok.success && ok.data.name).toBe('Priya Nair');
  });

  it('R14-1: approving a decision held by a blank-named member is an actionable CONFLICT, not a raw database error', async () => {
    // The contract fix cannot reach a name that is ALREADY blank — a legacy row, a seed, an
    // identity minted by another module. The decision is genuinely unapprovable until the name is
    // fixed, so the service must say THAT, in words the caller can act on.
    const holderUser = await t.prisma.user.create({
      data: { projectId: f.projectA.id, role: 'contractor', name: '\t', email: `blank-${run}-${seq++}@t4bc14.test` },
    });
    const holder = await t.prisma.membership.create({
      data: { projectId: f.projectA.id, userId: holderUser.id, role: 'contractor', status: 'active' },
    });
    const id = `DL-t4bc14-blank-${run}-${seq++}`;
    await t.prisma.decision.create({
      data: {
        id, projectId: f.projectA.id, title: 'Blank-held', room: 'Kitchen', status: 'pending',
        deciderKind: 'member', deciderMembershipId: holder.id, ageDays: 0, photoSwatch: 'sw1',
        authorId: f.memberUser.id,
      },
    });
    await t.prisma.decisionOption.createMany({ data: [
      { decisionId: id, label: 'A', optionKey: 'a', material: 'Teak', delta: 0, swatch: 'sw1', recommended: true, order: 0 },
      { decisionId: id, label: 'B', optionKey: 'b', material: 'Oak', delta: 100, swatch: 'sw2', recommended: false, order: 1 },
    ] });
    await t.prisma.decision.update({ where: { id }, data: { publishedAt: new Date() } });

    const err = await svc.approve(f.projectA.id, id, { optionIndex: 0 }, pmc()).then(() => null, (e: unknown) => e);
    expect(err, 'the approval must be refused').not.toBeNull();
    expect(err, 'and refused by the SERVICE, not by a trigger surfacing as a 500').toBeInstanceOf(ConflictException);
    expect(String((err as Error).message)).toMatch(/name/i);
    expect(await statusOf(id)).toBe('pending');
  });

  // ── R14-2 ──────────────────────────────────────────────────────────────────────────────────
  //
  // R14-2 is answered in prose, not code, and the reasoning is in
  // `20270829000000_phase6_t4b_correction14/migration.sql` and RUNBOOK §P6-4b.1. In short: the
  // exposure is real (a rolled-back deploy leaves a pre-4b release in front of this seal, and it
  // writes no `approvedDecider*` column) but it is not specific to 4b — nine migrations in this
  // ledger make an existing column NOT NULL and sixty-eight install raising triggers, and the old
  // writer dies on every one. The fix that was actually tried — deriving the absent tuple — is
  // REVERTED here, because it does not add a compatibility path so much as retire the rule: ten
  // assertions across rounds 6, 8 and 10 flipped from refusal to acceptance under it, which the
  // upgrade proof named in full. The seal's own coverage of the shape is therefore unchanged and
  // already pinned where it always was: `phase6-t4b-correction6.test.ts` and the round-6/8/10
  // blocks of `scripts/upgrade-proof.sh`. Nothing is added here that would only restate them.

  // ── R14-3 ──────────────────────────────────────────────────────────────────────────────────

  const gate = () => {
    let open!: () => void;
    const promise = new Promise<void>((r) => (open = r));
    return { promise, open };
  };
  // Prisma raw-query promises are LAZY — nothing is dispatched until a continuation is attached.
  type Reflected<T> = Promise<{ status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown }>
    & { state: { done: boolean } };
  const reflect = <T>(p: Promise<T>): Reflected<T> => {
    const state = { done: false };
    const wrapped = p.then(
      (value) => { state.done = true; return { status: 'fulfilled' as const, value }; },
      (reason) => { state.done = true; return { status: 'rejected' as const, reason }; },
    );
    return Object.assign(wrapped, { state });
  };
  const waitUntilBlocked = async (queryLike: string): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      const rows = await t.prisma.$queryRawUnsafe<Array<{ c: number }>>(
        `SELECT COUNT(*)::int AS c FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND state = 'active' AND query ILIKE $1`,
        queryLike,
      );
      if (Number(rows[0]!.c) >= 1) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`barrier timeout: expected a backend blocked on the Decision row lock while running ${queryLike}`);
  };

  it('R14-3: a RAW activity insert naming a recorded issue is refused outright', async () => {
    // No race yet — the plainest statement of the rule. Round 10 sealed the conversion against
    // existing dependents; the link direction was enforced only by `linkableInProject`, which a
    // writer that does not call it simply does not run.
    const id = await seedDraft();
    await t.prisma.$executeRawUnsafe(`UPDATE "Decision" SET "status"='recorded', "deciderKind"='none' WHERE "id" = $1`, id);
    const err = await t.prisma.$executeRawUnsafe(
      `INSERT INTO "Activity" ("id","projectId","name","zone","plannedStart","plannedEnd","status","decisionId")
       VALUES ($1,$2,'Raw act','Kitchen',0,5,'not_started',$3)`,
      `ACT-raw-${run}-${seq++}`, f.projectA.id, id,
    ).then(() => null, (e: unknown) => e);
    expect(err, 'the gate would wait forever on an issue nobody can approve').not.toBeNull();
    expect(String(err)).toMatch(/recorded issue/);
  });

  it('R14-3: a RAW delivery match naming a recorded issue is refused outright', async () => {
    const id = await seedDraft();
    await t.prisma.$executeRawUnsafe(`UPDATE "Decision" SET "status"='recorded', "deciderKind"='none' WHERE "id" = $1`, id);
    const logId = `DLG-t4bc14-${run}-${seq++}`;
    await t.prisma.dailyLog.create({ data: { id: logId, projectId: f.projectA.id, date: '01 Jan 2026' } });
    const err = await t.prisma.$executeRawUnsafe(
      `INSERT INTO "SiteMaterial" ("id","projectId","dailyLogId","name","qty","zone","swatch","matched","decisionId")
       VALUES ($1,$2,$3,'Teak','1','Kitchen','sw1',true,$4)`,
      `SM-raw-${run}-${seq++}`, f.projectA.id, logId, id,
    ).then(() => null, (e: unknown) => e);
    expect(err, 'the link rule refuses a record, whichever door the writer uses').not.toBeNull();
    expect(String(err)).toMatch(/recorded issue/);
  });

  it('R14-3 precision: a raw insert naming an ORDINARY draft still links', async () => {
    // The guard must cost nothing to every legitimate writer — it is the same question
    // `linkableInProject` already asks, asked of the writers that never called it.
    const id = await seedDraft();
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "Activity" ("id","projectId","name","zone","plannedStart","plannedEnd","status","decisionId")
       VALUES ($1,$2,'Fine act','Kitchen',0,5,'not_started',$3)`,
      `ACT-fine-${run}-${seq++}`, f.projectA.id, id,
    );
    expect(await t.prisma.activity.count({ where: { decisionId: id } })).toBe(1);
  });

  it('R14-3 (conversion holds): a RAW insert racing a committing conversion BLOCKS, then is REFUSED', async () => {
    // THE finding. At `a09f0b2` the insert did not block at all: the FK takes `FOR KEY SHARE`,
    // which is compatible with the conversion's non-key UPDATE, so both sessions committed and the
    // activity was left waiting on an issue nobody can approve.
    const id = await seedDraft();
    const g = gate();
    let converted!: () => void;
    const convertedP = new Promise<void>((r) => (converted = r));
    const a = raceDb.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE "Decision" SET "status"='recorded', "deciderKind"='none' WHERE "id" = $1`, id);
      converted();
      await g.promise;
    }, { timeout: 20_000, maxWait: 10_000 });
    await convertedP;

    const actId = `ACT-race-${run}-${seq++}`;
    const b = reflect(raceDb.$executeRawUnsafe(
      `INSERT INTO "Activity" ("id","projectId","name","zone","plannedStart","plannedEnd","status","decisionId")
       VALUES ($1,$2,'Racing act','Kitchen',0,5,'not_started',$3)`,
      actId, f.projectA.id, id,
    ));
    await waitUntilBlocked('%INSERT INTO "Activity"%');
    expect(b.state.done, 'the raw insert must WAIT on the decision row, not slip past the FK lock').toBe(false);
    g.open();
    expect((await reflect(a)).status).toBe('fulfilled');
    const rb = await b;
    expect(rb.status, 'and then lose to the committed conversion').toBe('rejected');
    expect(String((rb as { reason: unknown }).reason)).toMatch(/recorded issue/);
    expect(await t.prisma.activity.count({ where: { id: actId } })).toBe(0);
    expect(await statusOf(id)).toBe('recorded');
  });

  it('R14-3 (raw link holds): a conversion racing an uncommitted RAW insert BLOCKS, then is REFUSED', async () => {
    // The other ordering. The raw writer now holds the same lock the service writer opted into, so
    // the conversion waits for it and then counts the dependent it committed.
    const id = await seedDraft();
    const g = gate();
    let linked!: () => void;
    const linkedP = new Promise<void>((r) => (linked = r));
    const a = raceDb.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO "Activity" ("id","projectId","name","zone","plannedStart","plannedEnd","status","decisionId")
         VALUES ($1,$2,'Held act','Kitchen',0,5,'not_started',$3)`,
        `ACT-held-${run}-${seq++}`, f.projectA.id, id,
      );
      linked();
      await g.promise;
    }, { timeout: 20_000, maxWait: 10_000 });
    await linkedP;

    const b = reflect(raceDb.$executeRawUnsafe(
      `UPDATE "Decision" SET "status"='recorded', "deciderKind"='none' WHERE "id" = $1`, id,
    ));
    await waitUntilBlocked('%UPDATE "Decision" SET "status"=\'recorded\'%');
    expect(b.state.done, 'the conversion must still be WAITING while the raw link is held').toBe(false);
    g.open();
    expect((await reflect(a)).status).toBe('fulfilled');
    const rb = await b;
    expect(rb.status, 'the conversion must lose to the committed link').toBe('rejected');
    expect(String((rb as { reason: unknown }).reason)).toMatch(/an activity already depends on/);
    expect(await statusOf(id)).toBe('pending');
  });
});
