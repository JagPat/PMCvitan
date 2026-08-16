import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture, wipeDecisions } from './fixtures';

/**
 * Phase 6 unit 4b-i round 10 — the two Codex findings on `a283568`.
 *
 * ── R10-1 ends a five-round lineage rather than extending it ────────────────────────────────
 * The restoration exemption was re-cut in rounds 6, 7, 8 and 9, and every attempt was either
 * over-broad (breaking a real path) or forgeable, because each tried to tell a genuine legacy
 * restoration from a forgery using evidence a direct SQL writer can manufacture. Round 9's
 * ordering predicate lost BOTH ways Codex named: close the `ChangeRequest` first and the missing
 * open request makes the COALESCE bound read `infinity`; or simply rewrite the caller-supplied
 * `DecisionEvent."at"`. Probes A and B execute exactly those two.
 *
 * The exemption is therefore GONE, replaced by a set enumerated once at upgrade time.
 * `20270827000000` stamps `DecisionLegacyApproval` for every approval standing when it ran, then
 * refuses every subsequent write to that table. Nothing about the decision's own rows is consulted
 * any more, because none of it is trustworthy.
 *
 * WHERE THE PRECISION HALF OF R10-1 IS PROVEN, AND WHY NOT HERE. A genuine legacy row is one that
 * was already approved BEFORE this migration ran. That state is unreachable from an integration
 * test: the DB under test is migrated from empty, so the stamp set is empty, and minting a member
 * of it afterwards is the one thing the seal exists to prevent (probe C). Faking it would mean
 * disabling the seal — i.e. proving the exemption works by removing the property that makes it
 * safe. So the precision half is proven where genuinely pre-migration rows actually exist:
 * `scripts/upgrade-proof.sh`, which plants legacy shapes and THEN migrates. It asserts the stamp
 * lands on the legacy approvals, that a real legacy `approved → change → approved` withdrawal
 * still commits on that evidence, and that the same move on a post-migration row is refused.
 * This file proves what is provable here; it does not stage a fake legacy row and call it one.
 *
 * ── R10-2 is the reverse of a rule that was only enforced forwards ──────────────────────────
 * `decisions.linkableInProject` refuses to LINK a `recorded` decision, because a record is
 * approvable by nobody and the dependent's gate would wait forever. Walking the same two legal
 * steps in the other order — link an ordinary draft, then convert it — reached the identical dead
 * gate. The conversion now asks the OWNING modules through predicates named for their owners, and
 * reads no peer table itself.
 *
 * Every probe below was RED at `a283568`.
 */
describe('Phase 6 unit 4b-i round 10 — the two Codex findings (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let seq = 0;
  const run = Math.random().toString(36).slice(2, 8);
  // A DEDICATED client for the R10-2 race: the held transaction, the conflicting statement and the
  // pg_stat_activity poll each need their own backend connection AT THE SAME TIME, and the app's
  // shared pool can starve the conflicting session so it never reaches the server to block.
  let raceDb: PrismaClient;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
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
  });

  /**
   * The row a forger needs: PUBLISHED, sitting in `change`, carrying the approval columns a
   * restoration would carry — and NO holder tuple. It never passes through `approved`, so it is
   * built exactly the way a direct SQL writer builds one, with no help from any exemption.
   */
  const forgeryTarget = async (): Promise<string> => {
    const id = `DL-t4bc10-${run}-${seq++}`;
    await t.prisma.decision.create({
      data: {
        id, projectId: f.projectA.id, title: `Target ${id}`, room: 'Kitchen', status: 'pending',
        ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id, publishedAt: null,
      },
    });
    await t.prisma.decisionOption.createMany({ data: [
      { decisionId: id, label: 'A', optionKey: 'a', material: 'Teak', delta: 0, swatch: 'sw1', recommended: true, order: 0 },
      { decisionId: id, label: 'B', optionKey: 'b', material: 'Oak', delta: 100, swatch: 'sw2', recommended: false, order: 1 },
    ] });
    await t.prisma.decision.update({ where: { id }, data: { publishedAt: new Date() } });
    // straight into `change` with the approval columns planted — never through `approved`, so the
    // row is unattributed for the only reason that matters: no approval ever happened.
    await t.prisma.$executeRawUnsafe(
      `UPDATE "Decision" SET "status"='change', "approvedById"=$2, "approvedOption"='A',
              "approver"='Client', "material"='Teak', "date"='01 Jan 2026'
        WHERE "id" = $1`,
      id, f.clientUser.id,
    );
    return id;
  };

  /** An UNPUBLISHED ordinary draft — the only door a conversion to `recorded` may pass through. */
  const seedDraft = async (): Promise<string> => {
    const id = `DL-t4bc10-draft-${run}-${seq++}`;
    await t.prisma.decision.create({
      data: {
        id, projectId: f.projectA.id, title: `Draft ${id}`, room: 'Kitchen', status: 'pending',
        ageDays: 0, photoSwatch: 'sw1', authorId: f.memberUser.id, publishedAt: null,
      },
    });
    return id;
  };

  const statusOf = async (id: string): Promise<string> =>
    (await t.prisma.decision.findUniqueOrThrow({ where: { id }, select: { status: true } })).status as string;

  // ── R10-1 ──────────────────────────────────────────────────────────────────────────────────

  it('R10-1a: the forgery round 9 admitted — close the request, then plant the event — is REFUSED', async () => {
    const id = await forgeryTarget();
    // FORGERY PATH 1. Round 9 demanded an approval event PREDATING the earliest OPEN change
    // request. With no open request the COALESCE bound read `infinity`, so ANY event qualified —
    // including one written now, long after the row reached `change`.
    await t.prisma.changeRequest.create({
      data: {
        decisionId: id, status: 'closed', requestedById: f.clientUser.id,
        reason: 'closed first, so no open request bounds the ordering', costImpact: 0, timeImpactDays: 0,
      },
    });
    await t.prisma.decisionEvent.create({
      data: { decisionId: id, type: 'approved', actor: 'Nobody', actorId: f.clientUser.id },
    });

    await expect(
      t.prisma.$executeRawUnsafe(`UPDATE "Decision" SET "status"='approved' WHERE "id" = $1`, id),
    ).rejects.toThrow(/records WHO approved it/);
    expect(await statusOf(id)).toBe('change');
  });

  it('R10-1b: the OTHER forgery — backdating the caller-supplied event — is REFUSED', async () => {
    const id = await forgeryTarget();
    await t.prisma.changeRequest.create({
      data: {
        decisionId: id, status: 'open', requestedById: f.clientUser.id,
        reason: 'open, but the event will claim to predate it', costImpact: 0, timeImpactDays: 0,
      },
    });
    // FORGERY PATH 2. `DecisionEvent."at"` is caller-supplied, so the forger simply backdates it
    // past the open request and round 9's ordering predicate is satisfied.
    await t.prisma.decisionEvent.create({
      data: {
        decisionId: id, type: 'approved', actor: 'Nobody', actorId: f.clientUser.id,
        at: new Date('2020-01-01T00:00:00.000Z'),
      },
    });

    await expect(
      t.prisma.$executeRawUnsafe(`UPDATE "Decision" SET "status"='approved' WHERE "id" = $1`, id),
    ).rejects.toThrow(/records WHO approved it/);
    expect(await statusOf(id)).toBe('change');

    // …and the honest path off this row is still open: an approval that ATTRIBUTES itself commits.
    // The rule refuses unattributed approvals, not restorations.
    await t.prisma.$executeRawUnsafe(
      `UPDATE "Decision" SET "status"='approved', "approvedDeciderKind"='client',
              "approvedDeciderMembershipId"=NULL, "approvedDeciderLabel"='Client'
        WHERE "id" = $1`,
      id,
    );
    expect(await statusOf(id)).toBe('approved');
  });

  it('R10-1c: the exemption set is closed — its evidence can be neither minted nor removed', async () => {
    const id = await forgeryTarget();
    // THE POINT OF THE WHOLE REDESIGN: four predicates lost because their evidence was writable.
    // This one is not — the migration wrote its rows and closed the door behind itself, so the set
    // of unattributed approvals is finite, frozen and enumerable.
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "DecisionLegacyApproval" ("decisionId") VALUES ($1)`, id,
    )).rejects.toThrow(/one-time migration evidence/);

    // On a database migrated from empty there is nothing to stamp, so the set is EMPTY — which is
    // why no probe here can exercise the exemption, and why upgrade-proof owns that half.
    const rows = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT COUNT(*)::bigint AS n FROM "DecisionLegacyApproval"`,
    );
    expect(Number(rows[0]!.n), 'a freshly migrated database has no legacy approvals to exempt').toBe(0);
    // The DELETE arm — evidence is immutable except as a consequence of its subject ceasing to
    // exist — is registered structurally by the next probe and exercised BEHAVIOURALLY in
    // upgrade-proof, for the same reason as the exemption: a row-level trigger cannot fire over an
    // empty set, and this database has no stamped rows to attempt it against.
  });

  it('R10-1d: the seal is registered for every verb, so the enumeration is pinned rather than re-argued', async () => {
    const verbs = await t.prisma.$queryRawUnsafe<Array<{ trigger_name: string; events: string }>>(
      `SELECT trigger_name, string_agg(DISTINCT event_manipulation, ',' ORDER BY event_manipulation) AS events
         FROM information_schema.triggers
        WHERE trigger_name = 'DecisionLegacyApproval_sealed'
        GROUP BY trigger_name`,
    );
    expect(Object.fromEntries(verbs.map((r) => [r.trigger_name, r.events]))).toEqual({
      DecisionLegacyApproval_sealed: 'DELETE,INSERT,UPDATE',
    });
  });

  // ── R10-2 ──────────────────────────────────────────────────────────────────────────────────

  const linkActivity = async (decisionId: string): Promise<string> => {
    const id = `ACT-t4bc10-${run}-${seq++}`;
    await t.prisma.activity.create({
      data: {
        id, projectId: f.projectA.id, name: `Act ${id}`, zone: 'Kitchen',
        plannedStart: 0, plannedEnd: 5, status: 'not_started', decisionId,
      },
    });
    return id;
  };

  it('R10-2a: a draft an ACTIVITY already depends on cannot be converted to a record', async () => {
    const id = await seedDraft();
    // Legal step 1: `linkableInProject` permits this — an ordinary draft is exactly what a gate
    // is supposed to wait for.
    await linkActivity(id);

    // Legal step 2, at `a283568`: ACCEPTED. The activity's decision gate then waited on an issue
    // approvable by nobody, forever.
    await expect(
      t.prisma.$executeRawUnsafe(
        `UPDATE "Decision" SET "status"='recorded', "deciderKind"='none' WHERE "id" = $1`, id),
    ).rejects.toThrow(/an activity already depends on/);
    expect(await statusOf(id)).toBe('pending');
  });

  it('R10-2b: a draft a DELIVERY is already matched to cannot be converted to a record', async () => {
    const id = await seedDraft();
    const log = await t.prisma.dailyLog.create({
      data: { id: `DLG-t4bc10-${run}-${seq++}`, projectId: f.projectA.id, date: '01 Aug 2026', submitted: false },
    });
    await t.prisma.siteMaterial.create({
      data: {
        id: `SM-t4bc10-${run}-${seq++}`, projectId: f.projectA.id, dailyLogId: log.id,
        name: 'Teak ply', qty: '20 sheets', zone: 'Kitchen', decisionId: id, swatch: 'sw1',
        matched: true, order: 1,
      },
    });

    // `daily-log.service` calls the SAME `linkableInProject`, so the same reverse must hold: the
    // conversion must not create a state the link rule would have refused.
    await expect(
      t.prisma.$executeRawUnsafe(
        `UPDATE "Decision" SET "status"='recorded', "deciderKind"='none' WHERE "id" = $1`, id),
    ).rejects.toThrow(/a delivery is already matched to/);
    expect(await statusOf(id)).toBe('pending');
  });

  it('R10-2c: PRECISION — an unlinked draft still converts, and unlinking re-opens the door', async () => {
    // The rule refuses stranded gates, not the conversion lifecycle the plan supports.
    const free = await seedDraft();
    await t.prisma.$executeRawUnsafe(
      `UPDATE "Decision" SET "status"='recorded', "deciderKind"='none' WHERE "id" = $1`, free);
    expect(await statusOf(free)).toBe('recorded');

    // …and it is a statement about the CURRENT dependents, not a permanent mark on the draft.
    const linked = await seedDraft();
    const act = await linkActivity(linked);
    await expect(
      t.prisma.$executeRawUnsafe(
        `UPDATE "Decision" SET "status"='recorded', "deciderKind"='none' WHERE "id" = $1`, linked),
    ).rejects.toThrow(/an activity already depends on/);
    await t.prisma.activity.update({ where: { id: act }, data: { decisionId: null } });
    await t.prisma.$executeRawUnsafe(
      `UPDATE "Decision" SET "status"='recorded', "deciderKind"='none' WHERE "id" = $1`, linked);
    expect(await statusOf(linked)).toBe('recorded');
  });

  // A REAL two-session overlap. Session A opens an interactive transaction, takes its lock and
  // HOLDS it; session B then attempts the conflicting operation and BLOCKS, which the test
  // CONFIRMS through `pg_stat_activity` (condition-based, not a fixed sleep) before releasing A.
  //
  // The serialization is not new machinery: `linkableInProject`'s in-tx form takes `FOR SHARE` on
  // the decision row and the conversion UPDATEs that same row, so the two conflict on the lock the
  // link path already takes. Both orderings therefore have exactly one winner, and — this is the
  // point — the loser fails for the RIGHT reason in each direction.

  const gate = () => {
    let open!: () => void;
    const promise = new Promise<void>((r) => (open = r));
    return { promise, open };
  };
  // Prisma raw-query promises are LAZY — nothing is dispatched until a continuation is attached.
  // `reflect` attaches one (so session B actually runs and blocks) AND captures the settled
  // outcome. `state.done` is not decoration: a `pg_stat_activity` row proves SOME backend was
  // waiting, while `done === false` at the barrier proves THIS statement had not finished.
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

  it('R10-2d (link holds): a conversion racing a new link BLOCKS on the decision row, then is REFUSED', async () => {
    const id = await seedDraft();
    const g = gate();
    let linked!: () => void;
    const linkedP = new Promise<void>((r) => (linked = r));
    // Session A: the link path's authority — `FOR SHARE` on the decision, then the write — held open.
    const a = raceDb.$transaction(async (tx) => {
      await tx.$queryRawUnsafe(`SELECT "status"::text FROM "Decision" WHERE "id" = $1 AND "projectId" = $2 FOR SHARE`, id, f.projectA.id);
      await tx.$executeRawUnsafe(
        `INSERT INTO "Activity" ("id","projectId","name","zone","plannedStart","plannedEnd","status","decisionId")
         VALUES ($1,$2,'Race act','Kitchen',0,5,'not_started',$3)`,
        `ACT-race-${run}-${seq++}`, f.projectA.id, id,
      );
      linked();
      await g.promise;
    }, { timeout: 20_000, maxWait: 10_000 });
    await linkedP;

    const b = reflect(raceDb.$executeRawUnsafe(
      `UPDATE "Decision" SET "status"='recorded', "deciderKind"='none' WHERE "id" = $1`, id,
    ));
    await waitUntilBlocked('%UPDATE "Decision" SET "status"=\'recorded\'%');
    expect(b.state.done, 'the conversion must still be WAITING while the link is held').toBe(false);
    g.open();
    expect((await reflect(a)).status).toBe('fulfilled');
    const rb = await b;
    expect(rb.status, 'the conversion must lose to the committed link').toBe('rejected');
    expect(String((rb as { reason: unknown }).reason)).toMatch(/an activity already depends on/);
    expect(await statusOf(id)).toBe('pending');
  });

  it('R10-2d (conversion holds): a link racing a committing conversion BLOCKS, then sees `recorded`', async () => {
    const id = await seedDraft();
    const g = gate();
    let converted!: () => void;
    const convertedP = new Promise<void>((r) => (converted = r));
    // Session A: convert — counting ZERO dependents — and hold the row lock.
    const a = raceDb.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE "Decision" SET "status"='recorded', "deciderKind"='none' WHERE "id" = $1`, id);
      converted();
      await g.promise;
    }, { timeout: 20_000, maxWait: 10_000 });
    await convertedP;

    // Session B: the link path's in-tx authority. Its `FOR SHARE` conflicts with A's row update,
    // so it CANNOT read a stale `pending` and link behind the conversion.
    const b = reflect(raceDb.$queryRawUnsafe<Array<{ status: string }>>(
      `SELECT "status"::text AS status FROM "Decision" WHERE "id" = $1 AND "projectId" = $2 FOR SHARE`,
      id, f.projectA.id,
    ));
    await waitUntilBlocked('%FOR SHARE%');
    expect(b.state.done, 'the link check must still be WAITING while the conversion is held').toBe(false);
    g.open();
    expect((await reflect(a)).status).toBe('fulfilled');
    const rb = await b;
    expect(rb.status).toBe('fulfilled');
    // …and what it reads is the committed conversion, which `linkableInProject` maps to
    // `recorded` — the refusal the link path already had.
    expect((rb as { value: Array<{ status: string }> }).value[0]!.status).toBe('recorded');
    expect(await statusOf(id)).toBe('recorded');
  });
});
