import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { applyMigrationThroughHead, createTwoProjectFixture, seedProjectClient, type TwoProjectFixture, wipeDecisions } from './fixtures';
import { DecisionsService } from '../../src/decisions/decisions.service';
import { MembersService } from '../../src/orgs/members.service';
import type { AuthUser } from '../../src/common/auth';

/**
 * Phase 6 unit 4b-i — the ROUND-2 CORRECTION (Codex, four findings on head `067209bc`).
 *
 * Three of the four are follow-ons to round 1, and each landed where a round-1 fix stopped at its
 * surface: a guard that checked a DESTINATION instead of a TRANSITION, a predicate wired to one of
 * the two doors it governs, a cross-table read taken without the lock that makes it a decision, and
 * a service refusal stricter than the seal it exists to explain.
 *
 * Every probe below was RED at `067209bc` — with the round-2 migration `20270817000000` reverted as
 * well as the service half, so each failure is the behaviour and not a missing symbol.
 */
describe('Phase 6 unit 4b-i round 2 — the four Codex findings (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let svc: DecisionsService;
  let members: MembersService;
  let seq = 0;
  // A DEDICATED client for R2-3: the held transaction, the conflicting statement and the
  // pg_stat_activity poll each need their own backend connection AT THE SAME TIME, and the app's
  // shared pool can starve the conflicting session so that it never reaches the server to block.
  let raceDb: PrismaClient;

  const pmc = (): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId: f.projectA.id }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    svc = t.app.get(DecisionsService);
    members = t.app.get(MembersService);
    raceDb = new PrismaClient();
    await raceDb.$connect();
  });
  afterAll(async () => {
    await raceDb?.$disconnect();
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await wipeDecisions(t.prisma, { projectId: { in: [f.projectA.id, f.projectB.id] } });
    await t.prisma.decisionApprovalRevision.deleteMany({ where: { projectId: f.projectA.id } });
    await t.prisma.notification.deleteMany({ where: { projectId: f.projectA.id } });
    // R2-4 seeds a SECOND client; the next probe must start from the fixture's single one
    await t.prisma.membership.deleteMany({ where: { projectId: f.projectA.id, userId: f.strangerUser.id } });
    await t.prisma.membership.updateMany({
      where: { projectId: f.projectA.id, userId: f.clientUser.id },
      data: { role: 'client', status: 'active' },
    });
  });

  /** A published ordinary (client-held) decision with its two options. */
  const seedOrdinary = async (): Promise<string> => {
    const id = `DL-t4bc2-ord-${seq++}`;
    await t.prisma.decision.create({
      data: {
        id, projectId: f.projectA.id, title: `Ordinary ${id}`, room: 'Kitchen', status: 'pending',
        ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id, publishedAt: null,
      },
    });
    await t.prisma.decisionOption.createMany({ data: [
      { decisionId: id, label: 'A', optionKey: 'a', material: 'Teak', delta: 0, swatch: 'sw1', recommended: true, order: 0 },
      { decisionId: id, label: 'B', optionKey: 'b', material: 'Oak', delta: 100, swatch: 'sw2', recommended: false, order: 1 },
    ] });
    await t.prisma.decision.update({ where: { id }, data: { publishedAt: new Date() } });
    return id;
  };

  /** An UNPUBLISHED ordinary draft — the only door a conversion to `recorded` may pass through. */
  const seedDraft = async (authorId: string): Promise<string> => {
    const id = `DL-t4bc2-draft-${seq++}`;
    await t.prisma.decision.create({
      data: {
        id, projectId: f.projectA.id, title: `Draft ${id}`, room: 'Kitchen', status: 'pending',
        ageDays: 0, photoSwatch: 'sw1', authorId, publishedAt: null,
      },
    });
    return id;
  };

  // ── R2-1 ───────────────────────────────────────────────────────────────────────────────────
  it('R2-1: the approval holder tuple is written BY the approval — a row that is ALREADY approved cannot be given one', async () => {
    const id = await seedOrdinary();
    // The shape every row approved BEFORE `20270815000000` is in: status `approved`, tuple NULL.
    // Round 1's write-once rules protect a tuple ONCE WRITTEN; the question this finding asks is
    // who may write the FIRST one, and `NEW.status = 'approved'` answered "anyone updating an
    // approved row" rather than "the approval".
    await t.prisma.$executeRaw`UPDATE "Decision" SET "status"='approved' WHERE "id" = ${id}`;
    const legacy = await t.prisma.decision.findUniqueOrThrow({ where: { id } });
    expect(legacy.status).toBe('approved');
    expect(legacy.approvedDeciderKind).toBeNull();

    // at 067209bc this UPDATE was ACCEPTED, and round 1's freeze then made the forgery permanent
    await expect(
      t.prisma.$executeRaw`UPDATE "Decision"
         SET "approvedDeciderKind"='pmc', "approvedDeciderLabel"='Forged Holder'
       WHERE "id" = ${id}`,
    ).rejects.toThrow(/never onto a row that is already approved/);
    const after = await t.prisma.decision.findUniqueOrThrow({ where: { id } });
    expect(after.approvedDeciderKind).toBeNull();
    expect(after.approvedDeciderLabel).toBeNull();

    // PRECISION — the transition itself still writes the tuple, so the seal is exact and not
    // merely strict: the real approval act is the one write that may.
    const fresh = await seedOrdinary();
    await svc.approve(f.projectA.id, fresh, { optionIndex: 0 }, pmc());
    const approved = await t.prisma.decision.findUniqueOrThrow({ where: { id: fresh } });
    expect(approved.status).toBe('approved');
    expect(approved.approvedDeciderKind).toBe('client');
  });

  // ── R2-2 ───────────────────────────────────────────────────────────────────────────────────
  it('R2-2: the CONVERSION door asks what the INSERT door asks — a record cannot be born attributed to someone who may not file one', async () => {
    // `f.clientUser` holds an active CLIENT membership on projectA, so
    // `orgs_user_decision_authority` (narrowed to `pmc` by round 1's F7) says no. Authoring an
    // ordinary DRAFT is unrestricted — the guard is on becoming a permanent RECORD.
    const id = await seedDraft(f.clientUser.id);
    // at 067209bc the author predicate ran only on INSERT-of-`recorded`; this door never asked
    await expect(
      t.prisma.$executeRaw`UPDATE "Decision" SET "status"='recorded', "deciderKind"='none' WHERE "id" = ${id}`,
    ).rejects.toThrow(/decision authority/);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).status).toBe('pending');

    // PRECISION — the same conversion by an authorized author still passes, so this refuses the
    // attribution and not the lifecycle the plan supports.
    const ok = await seedDraft(f.memberUser.id);
    await t.prisma.$executeRaw`UPDATE "Decision" SET "status"='recorded', "deciderKind"='none' WHERE "id" = ${ok}`;
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id: ok } })).status).toBe('recorded');
  });

  // ── R2-3 ───────────────────────────────────────────────────────────────────────────────────
  //
  // A REAL two-session overlap, both orderings. Session A opens an interactive transaction, takes
  // its lock, and HOLDS it; session B then attempts the conflicting operation and BLOCKS, which the
  // test CONFIRMS through `pg_stat_activity` (condition-based, not a fixed sleep) before releasing
  // A. At `067209bc` the seal's parent read was a bare `SELECT`, so B never blocked at all and both
  // sides committed — leaving a record carrying the unclosable claim the seal exists to forbid.

  const gate = () => {
    let open!: () => void;
    const promise = new Promise<void>((r) => (open = r));
    return { promise, open };
  };
  // Prisma raw-query promises are LAZY — nothing is dispatched until a continuation is attached.
  // `reflect` attaches one (so session B actually runs and blocks) AND captures the settled outcome.
  //
  // It also exposes `state.done`, and that is not decoration: a `pg_stat_activity` row proves SOME
  // backend was waiting, while `done === false` at the barrier proves THIS statement had not
  // finished. Asserting both is what separates a real overlap from a fast sequential run that
  // happened to observe an unrelated waiter.
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

  it('R2-3 (conversion holds): a change request raised against a converting decision BLOCKS on the parent, then is REJECTED', async () => {
    const id = await seedDraft(f.memberUser.id);
    const g = gate();
    let converted!: () => void;
    const convertedP = new Promise<void>((r) => (converted = r));
    // Session A: convert to `recorded` — counting ZERO change requests — and hold the row lock.
    const a = raceDb.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE "Decision" SET "status"='recorded', "deciderKind"='none' WHERE "id" = $1`, id);
      converted();
      await g.promise;
    }, { timeout: 20_000, maxWait: 10_000 });
    await convertedP;

    // Session B: raise a change request. Its seal reads the parent FOR UPDATE, so it must WAIT.
    const b = reflect(raceDb.$executeRawUnsafe(
      `INSERT INTO "ChangeRequest" ("id","decisionId","reason","costImpact","timeImpactDays","status")
       VALUES ($1,$2,'Hostile',0,0,'open')`,
      `cr-${seq++}`, id,
    ));
    await waitUntilBlocked('%INSERT INTO "ChangeRequest"%');
    expect(b.state.done, 'the change request must still be WAITING while the conversion is held').toBe(false);
    g.open();
    expect((await reflect(a)).status).toBe('fulfilled');
    const rb = await b;
    expect(rb.status, 'the change request must lose to the committed conversion').toBe('rejected');
    expect(String((rb as { reason: unknown }).reason)).toMatch(/recorded issue cannot carry a change request/);
    expect(await t.prisma.changeRequest.count({ where: { decisionId: id } })).toBe(0);
  });

  it('R2-3 (change request holds): a conversion racing a change request BLOCKS, then is REJECTED for the claim it would strand', async () => {
    const id = await seedDraft(f.memberUser.id);
    const g = gate();
    let raised!: () => void;
    const raisedP = new Promise<void>((r) => (raised = r));
    // Session A: raise the change request — the seal's FOR UPDATE takes the parent row lock — and hold.
    const a = raceDb.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO "ChangeRequest" ("id","decisionId","reason","costImpact","timeImpactDays","status")
         VALUES ($1,$2,'Real claim',0,0,'open')`,
        `cr-${seq++}`, id,
      );
      raised();
      await g.promise;
    }, { timeout: 20_000, maxWait: 10_000 });
    await raisedP;

    // Session B: convert. At `067209bc` A held only the FK's KEY SHARE lock, which a plain UPDATE
    // does not conflict with, so B sailed through and counted zero change requests.
    const b = reflect(raceDb.$executeRawUnsafe(
      `UPDATE "Decision" SET "status"='recorded', "deciderKind"='none' WHERE "id" = $1`, id,
    ));
    await waitUntilBlocked('%UPDATE "Decision" SET "status"=\'recorded\'%');
    expect(b.state.done, 'the conversion must still be WAITING while the change request is held').toBe(false);
    g.open();
    expect((await reflect(a)).status).toBe('fulfilled');
    const rb = await b;
    expect(rb.status, 'the conversion must lose to the committed change request').toBe('rejected');
    expect(String((rb as { reason: unknown }).reason)).toMatch(/change request cannot become a record/);
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).status).toBe('pending');
    await t.prisma.changeRequest.deleteMany({ where: { decisionId: id } });
  });

  it('the round-2 migration is RE-RUNNABLE — every statement in it is a CREATE OR REPLACE', async () => {
    // The operator path is `prisma migrate deploy`, but a partially-applied deploy is retried, and
    // a correction that only works once is a correction that cannot be retried. Demonstrated, not
    // asserted — and asserted afterwards, so a re-run that succeeded while reverting something
    // would still be caught.
    applyMigrationThroughHead((process.env.DATABASE_URL ?? '').split('?')[0]!, '20270817000000_phase6_t4b_correction2');
    const fns = await t.prisma.$queryRawUnsafe<Array<{ proname: string; src: string }>>(
      `SELECT proname, prosrc AS src FROM pg_proc
        WHERE proname IN ('decision_t4b_recorded_seal', 'change_request_t4b_seal')`,
    );
    expect(fns).toHaveLength(2);
    expect(fns.find((r) => r.proname === 'decision_t4b_recorded_seal')!.src).toContain('never onto a row that is already approved');
    expect(fns.find((r) => r.proname === 'change_request_t4b_seal')!.src).toContain('FOR UPDATE');
  });

  // ── R2-4 ───────────────────────────────────────────────────────────────────────────────────
  it('R2-4: the departing ROLE is asked about only when this write takes its LAST standing — a second active client is not held hostage', async () => {
    await seedProjectClient(t.prisma, f.projectA.id, f.strangerUser.id);
    const id = await seedOrdinary(); // published, OPEN, client-held

    // at 067209bc the service passed `existing.role` unconditionally, so BOTH clients were refused
    // — a 409 the seal itself would never have raised, because standing survives.
    await expect(members.remove(f.projectA.id, pmc(), f.strangerUser.id)).resolves.toEqual({ ok: true });
    await expect(
      members.updateRole(f.projectA.id, pmc(), f.clientUser.id, { role: 'engineer' } as never),
    ).rejects.toThrow(/no client to decide it/);

    // …and the guard still refuses the write that DOES strand the decision — the one remaining
    // client, by removal and by re-roling alike, with the seal's own message never reaching the
    // caller as a 500.
    await expect(members.remove(f.projectA.id, pmc(), f.clientUser.id)).rejects.toThrow(/holds a published open decision/);
    expect(
      (await t.prisma.membership.findFirstOrThrow({ where: { projectId: f.projectA.id, userId: f.clientUser.id } })).status,
    ).toBe('active');
    expect((await t.prisma.decision.findUniqueOrThrow({ where: { id } })).status).toBe('pending');
  });
});
