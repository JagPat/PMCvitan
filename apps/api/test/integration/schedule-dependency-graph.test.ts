import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * Schedule unit B1 — the ACYCLIC ACTIVITY DEPENDENCY GRAPH, proven against live PostgreSQL.
 *
 * No service writes these edges yet, so every probe is a HOSTILE-SQL probe: during this unit
 * direct SQL is the only writer the table can have, and a guarantee that only holds when the
 * application cooperates is not a guarantee. Each probe therefore goes straight at the database.
 *
 * Probes
 *   P1  containment — an edge between two projects is not representable
 *   P2  self-dependency refused
 *   P3  duplicate edge refused
 *   P4  negative lag refused; zero and positive accepted
 *   P5  multiple predecessors accepted (the normal case — a successor waits for the latest)
 *   P6  a direct cycle refused, and a LONGER chain cycle refused
 *   P7  endpoint identity frozen — an edge cannot be re-pointed into a cycle after the fact
 *   P8  CONCURRENT edge inserts cannot compose into a cycle (two sessions, real lock barrier)
 */
describe('Schedule B1 — the acyclic activity dependency graph (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let seq = 0;
  const run = Math.floor(Math.random() * 1e6);

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
  });

  const wipe = async (): Promise<void> => {
    await t.prisma.$executeRawUnsafe(`DELETE FROM "ActivityDependency" WHERE "id" LIKE 'dep-b1-%'`);
    await t.prisma.activity.deleteMany({ where: { id: { startsWith: `act-b1-` } } });
  };
  afterEach(wipe);
  afterAll(async () => {
    await wipe();
    await f?.cleanup();
    await t?.close();
  });

  /** An activity, created directly. B1 takes no position on scheduling fields — only on edges. */
  const activity = async (projectId: string = f.projectA.id): Promise<string> => {
    const id = `act-b1-${run}-${seq++}`;
    await t.prisma.activity.create({
      data: { id, projectId, name: `Activity ${id}`, zone: 'Block A', plannedStart: 0, plannedEnd: 1 },
    });
    return id;
  };

  const edge = (
    predecessorId: string,
    successorId: string,
    over: { projectId?: string; lagWorkingDays?: number } = {},
  ): string => `INSERT INTO "ActivityDependency"
      ("id","projectId","predecessorId","successorId","lagWorkingDays","createdById","createdByName")
      VALUES ('dep-b1-${run}-${seq++}','${over.projectId ?? f.projectA.id}','${predecessorId}','${successorId}',${over.lagWorkingDays ?? 0},'${f.memberUser.id}','PMC')`;

  const refusal = async (sql: string): Promise<string> => {
    const err = await t.prisma.$executeRawUnsafe(sql).then(() => null, (e: unknown) => e);
    expect(err, `expected PostgreSQL to refuse: ${sql.slice(0, 90)}`).not.toBeNull();
    return String(err);
  };

  const edgeCount = async (): Promise<number> => {
    const rows = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT COUNT(*) AS n FROM "ActivityDependency" WHERE "id" LIKE 'dep-b1-%'`,
    );
    return Number(rows[0]?.n ?? 0);
  };

  // ── P1 ─────────────────────────────────────────────────────────────────────────────────────
  it('P1 containment: an edge cannot join activities of two different projects', async () => {
    const here = await activity(f.projectA.id);
    const foreign = await activity(f.projectB.id);

    // the composite FK carries the edge's own projectId, so the pair simply does not exist there
    expect(await refusal(edge(foreign, here))).toMatch(/foreign key|predecessorId_fkey/i);
    expect(await refusal(edge(here, foreign))).toMatch(/foreign key|successorId_fkey/i);
    expect(await edgeCount()).toBe(0);

    // PRECISION — the same shape inside ONE project is accepted, so the seal is not just strict
    const alsoHere = await activity(f.projectA.id);
    await t.prisma.$executeRawUnsafe(edge(here, alsoHere));
    expect(await edgeCount()).toBe(1);
  });

  // ── P2 / P3 / P4 ───────────────────────────────────────────────────────────────────────────
  it('P2/P3/P4 shape: self-dependency, duplicates and negative lag are all refused', async () => {
    const a = await activity();
    const b = await activity();

    expect(await refusal(edge(a, a))).toMatch(/cannot depend on itself|no_self_check/i);

    await t.prisma.$executeRawUnsafe(edge(a, b));
    // PostgreSQL reports the unique violation as 23505 naming the three-column key, so assert
    // BOTH — the code, and that the key that fired is the (project, successor, predecessor) one
    // rather than some other uniqueness the row happens to trip.
    const dup = await refusal(edge(a, b));
    expect(dup).toMatch(/23505/);
    expect(dup).toMatch(/already exists/i);
    for (const col of ['projectId', 'successorId', 'predecessorId']) expect(dup).toContain(col);

    const c = await activity();
    expect(await refusal(edge(c, b, { lagWorkingDays: -1 }))).toMatch(/lag_nonneg_check/i);

    // zero and positive lag are both legal — zero is the common case, positive is curing time
    await t.prisma.$executeRawUnsafe(edge(c, b, { lagWorkingDays: 7 }));
    const lags = await t.prisma.$queryRawUnsafe<Array<{ lagWorkingDays: number }>>(
      `SELECT "lagWorkingDays" FROM "ActivityDependency" WHERE "successorId"='${b}' ORDER BY "lagWorkingDays"`,
    );
    expect(lags.map((l) => l.lagWorkingDays)).toEqual([0, 7]);
  });

  // ── P5 ─────────────────────────────────────────────────────────────────────────────────────
  it('P5 multiple predecessors: a successor may wait on several activities at once', async () => {
    const slab = await activity();
    const conduit = await activity();
    const inspection = await activity();
    const screed = await activity();

    for (const p of [slab, conduit, inspection]) {
      await t.prisma.$executeRawUnsafe(edge(p, screed));
    }
    const rows = await t.prisma.$queryRawUnsafe<Array<{ predecessorId: string }>>(
      `SELECT "predecessorId" FROM "ActivityDependency" WHERE "successorId"='${screed}' ORDER BY "predecessorId"`,
    );
    expect(rows.map((r) => r.predecessorId).sort()).toEqual([slab, conduit, inspection].sort());
  });

  // ── P6 ─────────────────────────────────────────────────────────────────────────────────────
  it('P6 cycles: a direct loop and a longer chain loop are both refused', async () => {
    const a = await activity();
    const b = await activity();
    const c = await activity();

    await t.prisma.$executeRawUnsafe(edge(a, b));
    // B -> A would close a two-node loop
    expect(await refusal(edge(b, a))).toMatch(/dependency cycle/i);

    // …and the same over a longer path: A -> B -> C, so C -> A closes a three-node loop
    await t.prisma.$executeRawUnsafe(edge(b, c));
    const err = await refusal(edge(c, a));
    expect(err).toMatch(/dependency cycle/i);
    // the message names the path that leads back, so an operator can see WHICH sequence conflicts
    expect(err).toContain(a);

    // a DIAMOND is not a cycle and must still be accepted (A->B, A->C, B->D, C->D)
    const d = await activity();
    await t.prisma.$executeRawUnsafe(edge(a, c));
    await t.prisma.$executeRawUnsafe(edge(c, d));
    await t.prisma.$executeRawUnsafe(edge(b, d));
    expect(await edgeCount()).toBe(5);
  });

  // ── P7 ─────────────────────────────────────────────────────────────────────────────────────
  it('P7 frozen endpoints: an accepted edge cannot later be re-pointed into a cycle', async () => {
    const a = await activity();
    const b = await activity();
    await t.prisma.$executeRawUnsafe(edge(a, b));

    // the cycle check runs at INSERT; without this freeze, an UPDATE would walk straight past it
    expect(await refusal(
      `UPDATE "ActivityDependency" SET "predecessorId"='${b}', "successorId"='${a}' WHERE "successorId"='${b}'`,
    )).toMatch(/endpoints of dependency edge .* are frozen/);

    // PRECISION — the lag is NOT frozen: an ordinary re-plan is an ordinary update
    await t.prisma.$executeRawUnsafe(
      `UPDATE "ActivityDependency" SET "lagWorkingDays"=3 WHERE "successorId"='${b}'`,
    );
    const rows = await t.prisma.$queryRawUnsafe<Array<{ lagWorkingDays: number }>>(
      `SELECT "lagWorkingDays" FROM "ActivityDependency" WHERE "successorId"='${b}'`,
    );
    expect(rows[0]?.lagWorkingDays).toBe(3);
  });

  // ── P8 — the probe the guard exists for ────────────────────────────────────────────────────
  it('P8 concurrency: two sessions each adding one legal edge cannot compose a cycle', async () => {
    const a = await activity();
    const b = await activity();

    // Two INDEPENDENT connections: one transaction holds its edge uncommitted while the other
    // attempts the mirror edge. Individually each is legal; together they are a loop. This is the
    // interleaving a reachability check without serialization admits.
    const holder = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    const racer = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    await Promise.all([holder.$connect(), racer.$connect()]);

    let release!: () => void;
    let inserted!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    const didInsert = new Promise<void>((r) => { inserted = r; });

    try {
      const holding = holder.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(edge(a, b)); // takes the schedule-graph advisory lock
        inserted();
        await released;
      }, { timeout: 30_000, maxWait: 10_000 });
      await didInsert;

      // dispatch the racer (a Prisma raw promise is lazy — it must be started to block at all)
      const racing = racer.$executeRawUnsafe(edge(b, a)).then(() => null, (e: unknown) => e);

      // Condition-based barrier, matched to the ADVISORY lock specifically — not "some backend is
      // blocked", which would pass on any unrelated wait and prove nothing.
      let blocked = false;
      for (let i = 0; i < 400 && !blocked; i += 1) {
        const rows = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT COUNT(*) AS n FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND wait_event = 'advisory' AND state = 'active'`,
        );
        blocked = Number(rows[0]?.n ?? 0) >= 1;
        if (!blocked) await new Promise((r) => setTimeout(r, 25));
      }
      expect(blocked, 'the second writer must BLOCK on the schedule-graph lock, not race past it').toBe(true);

      release();
      await holding;
      const raceError = await racing;

      // The loser re-runs reachability with the winner's edge visible, and is refused.
      expect(raceError, 'the second edge must be refused once the first is visible').not.toBeNull();
      expect(String(raceError)).toMatch(/dependency cycle/i);
      expect(await edgeCount()).toBe(1);
    } finally {
      await Promise.all([holder.$disconnect(), racer.$disconnect()]);
    }
  });

  // ── P9 (Codex round 1, P1) ───────────────────────────────────────────────────────────────────
  // Freezing the endpoints alone left the ATTRIBUTION rewritable. Who imposed a sequencing
  // constraint, and when, is the whole reason those columns exist — a disputed schedule is only
  // answerable if that record cannot be edited after the fact.
  it('P9 the creation provenance is frozen as hard as the endpoints are', async () => {
    const a = await activity();
    const b = await activity();
    await t.prisma.$executeRawUnsafe(edge(a, b));
    const id = (await t.prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "ActivityDependency" WHERE "predecessorId"='${a}' AND "successorId"='${b}'`,
    ))[0].id;

    for (const [column, value] of [['createdById', "'forged-user'"], ['createdByName', "'Someone Else'"], ['createdAt', "now()"]] as const) {
      await expect(
        t.prisma.$executeRawUnsafe(`UPDATE "ActivityDependency" SET "${column}" = ${value} WHERE "id"='${id}'`),
      ).rejects.toThrow(/creation provenance .* is frozen/i);
    }

    // …and the freeze is not blanket: the lag is a real property of the constraint and stays editable.
    await t.prisma.$executeRawUnsafe(`UPDATE "ActivityDependency" SET "lagWorkingDays"=5 WHERE "id"='${id}'`);
    const [row] = await t.prisma.$queryRawUnsafe<{ lagWorkingDays: number }[]>(
      `SELECT "lagWorkingDays" FROM "ActivityDependency" WHERE "id"='${id}'`,
    );
    expect(row.lagWorkingDays).toBe(5);
  });

  // ── P10 (Codex round 1, P2) ──────────────────────────────────────────────────────────────────
  // The first walk carried a path, which forces UNION ALL, which enumerates every distinct ROUTE
  // rather than every node. Diamonds multiply routes: n of them in series gives 2^n. Twenty is a
  // schedule a person could draw, and a million paths; the guard has to be linear in EDGES.
  //
  // This probe is a real timing assertion because that is the only thing the defect changes — the
  // verdict was always correct, it just could not be reached. Against the UNION ALL walk this
  // times out; the bound is deliberately loose so it fails on the defect, not on a slow machine.
  it('P10 a branching DAG is judged in linear time, not once per distinct route', async () => {
    const head = await activity();
    let tail = head;
    for (let i = 0; i < 20; i += 1) {
      const left = await activity();
      const right = await activity();
      const join = await activity();
      await t.prisma.$executeRawUnsafe(edge(tail, left));
      await t.prisma.$executeRawUnsafe(edge(tail, right));
      await t.prisma.$executeRawUnsafe(edge(left, join));
      await t.prisma.$executeRawUnsafe(edge(right, join));
      tail = join;
    }
    // 2^20 routes from head to tail; an unrelated activity keeps the answer NO, so the walk has to
    // exhaust reachability rather than stopping at a lucky early hit.
    const unrelated = await activity();
    const started = Date.now();
    await t.prisma.$executeRawUnsafe(edge(unrelated, head));
    expect(Date.now() - started).toBeLessThan(5_000);

    // …and the REJECTION path has to be linear too, which is a separate walk and was a separate
    // bug. Detection dedupes on activity identity; the diagnostic that names a route for the user
    // originally carried a path, which forces UNION ALL and enumerates every ROUTE — 2^20 of them
    // in this graph. Refusing an edge must not cost more than accepting one.
    const rejectStarted = Date.now();
    await expect(t.prisma.$executeRawUnsafe(edge(tail, head))).rejects.toThrow(/dependency cycle/i);
    expect(Date.now() - rejectStarted).toBeLessThan(5_000);
  });

  // ── P11 ────────────────────────────────────────────────────────────────────────────────────
  it('P11 attribution has to be answerable, not merely present', async () => {
    const [a, b] = [await activity(), await activity()];
    // NOT NULL accepts all of these, and the freeze in P9 would then make them permanent — an edge
    // that cannot say who imposed it, forever. Note the vertical tab in particular: the obvious
    // hand-written trim set E' \t\n\r\v\f' does NOT strip it, because PostgreSQL reads \v there
    // as the letter v.
    for (const [name, blank] of [['empty', ''], ['space', ' '], ['tab', '\t'],
                                 ['newline', '\n'], ['vertical tab', '\v']] as const) {
      const err = await refusal(
        `INSERT INTO "ActivityDependency"("id","projectId","predecessorId","successorId","lagWorkingDays","createdById","createdByName")
         VALUES ('dep-b1-${run}-${seq++}','${f.projectA.id}','${a}','${b}',0,'${f.memberUser.id}',E'${blank}')`,
      );
      expect(err, `${name} must not pass as attribution`).toMatch(/attribution_check/u);
    }
    // a real name is untouched — including one that starts with the letter the bad trim set ate
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "ActivityDependency"("id","projectId","predecessorId","successorId","lagWorkingDays","createdById","createdByName")
       VALUES ('dep-b1-${run}-${seq++}','${f.projectA.id}','${a}','${b}',0,'${f.memberUser.id}','Vikram')`,
    );
    expect(await edgeCount()).toBe(1);
  });

  // ── P12 ────────────────────────────────────────────────────────────────────────────────────
  it('P12 a shadowing temporary table cannot blind the cycle check', async () => {
    const [a, b] = [await activity(), await activity()];
    await t.prisma.$executeRawUnsafe(edge(a, b));

    // The attack the pinned search path closes: `pg_temp` precedes `public` by default, so a writer
    // holding only the ordinary TEMP privilege can create a table of the same name. If the trigger
    // resolved the relation through the CALLING session's path it would walk this empty copy, find
    // no route, and let the opposing edge commit into the real table — a cycle no guard ever saw.
    await expect(
      t.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `CREATE TEMP TABLE "ActivityDependency" (LIKE public."ActivityDependency") ON COMMIT DROP`,
        );
        // the INSERT names the real table explicitly; only the TRIGGER's own lookup is under test
        await tx.$executeRawUnsafe(
          `INSERT INTO public."ActivityDependency"("id","projectId","predecessorId","successorId","lagWorkingDays","createdById","createdByName")
           VALUES ('dep-b1-${run}-${seq++}','${f.projectA.id}','${b}','${a}',0,'${f.memberUser.id}','PMC')`,
        );
      }),
    ).rejects.toThrow(/dependency cycle/i);

    expect(await edgeCount()).toBe(1);
  });

  // ── P13 ────────────────────────────────────────────────────────────────────────────────────
  it('P13 one project per transaction, so two writers cannot invert the lock order', async () => {
    const [a1, a2] = [await activity(), await activity()];
    const [b1, b2] = [await activity(f.projectB.id), await activity(f.projectB.id)];

    // Two projects in one transaction is what makes a deadlock possible: this is a ROW trigger, so
    // the per-project locks are taken in whatever order the rows arrive, and a second transaction
    // doing the same two projects the other way round leaves each holding what the other waits for.
    // A refusal that names the fix is better than PostgreSQL killing one of two legal imports.
    await expect(
      t.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(edge(a1, a2));
        await tx.$executeRawUnsafe(edge(b1, b2, { projectId: f.projectB.id }));
      }),
    ).rejects.toThrow(/one project per transaction/i);
    expect(await edgeCount()).toBe(0);

    // …and the ordinary case is untouched: many edges for ONE project in one transaction commit.
    const a3 = await activity();
    await t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(edge(a1, a2));
      await tx.$executeRawUnsafe(edge(a2, a3));
    });
    expect(await edgeCount()).toBe(2);
  });
});
