import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * Schedule unit B1 — the ACYCLIC ACTIVITY DEPENDENCY GRAPH, proven against live PostgreSQL.
 *
 * No service writes these edges yet, so every probe is a HOSTILE-SQL probe: during this unit
 * direct SQL is the only writer the table can have, and a guarantee that only holds when the
 * application cooperates is not a guarantee.
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
    // Edges are neither deletable (P12) nor truncatable (P16) — that is the point of the table. A
    // test reset uses the same sanctioned destructive contract the seed does: disable the seal BY
    // NAME for exactly this wipe, inside ONE transaction, so a wipe that throws rolls the DISABLE
    // back with it and no failure path can leave the seal off for the suites that follow.
    await t.prisma.$transaction([
      t.prisma.$executeRawUnsafe(
        `ALTER TABLE "ActivityDependency" DISABLE TRIGGER "ActivityDependency_no_truncate"`),
      t.prisma.$executeRawUnsafe(`TRUNCATE TABLE "ActivityDependency"`),
      t.prisma.$executeRawUnsafe(
        `ALTER TABLE "ActivityDependency" ENABLE TRIGGER "ActivityDependency_no_truncate"`),
    ]);
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
    const id = `act-b1-${run}-${seq += 1}`;
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
      VALUES ('dep-b1-${run}-${seq += 1}','${over.projectId ?? f.projectA.id}','${predecessorId}','${successorId}',${over.lagWorkingDays ?? 0},'${f.memberUser.id}','PMC')`;

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

  const onlyId = async (): Promise<string> => (await t.prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT "id" FROM "ActivityDependency" WHERE "id" LIKE 'dep-b1-%' LIMIT 1`))[0]!.id;

  const migrationPath = join(__dirname, '..', '..', 'prisma', 'migrations',
                             '20270930000000_schedule_dependency_graph', 'migration.sql');

  /**
   * `DATABASE_URL` with its query string removed, because psql and Prisma do not accept the same
   * URL. Prisma's carries `?schema=public`; psql rejects it outright — `invalid URI query
   * parameter: "schema"` — and takes the whole invocation down with it. Worth a named helper
   * because the failure is invisible in local development and unmissable in CI.
   */
  const psqlUrl = (): string => {
    const url = new URL(process.env.DATABASE_URL!);
    url.search = '';
    return url.toString();
  };

  /** Apply the migration through psql, returning stderr on failure and null on success. */
  const applyMigration = (): string | null => {
    try {
      execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-d', psqlUrl(), '-f', migrationPath],
                   { encoding: 'utf8', stdio: 'pipe' });
      return null;
    } catch (e: unknown) {
      return String((e as { stderr?: string }).stderr ?? e);
    }
  };

  /** Every constraint / index OID on the table — identity, so a "no-op" can be proven to be one. */
  const objectIdentity = async (): Promise<string> => {
    const rows = await t.prisma.$queryRawUnsafe<Array<{ ids: string }>>(`
      SELECT COALESCE((SELECT string_agg(oid::text, ',' ORDER BY conname) FROM pg_constraint
                        WHERE conrelid = '"ActivityDependency"'::regclass), '')
          || '|' || COALESCE((SELECT string_agg(ci.oid::text, ',' ORDER BY ci.relname)
                                FROM pg_class ci JOIN pg_index ix ON ix.indexrelid = ci.oid
                               WHERE ix.indrelid = '"ActivityDependency"'::regclass), '') AS ids`);
    return rows[0]!.ids;
  };

  // ── P1 ─────────────────────────────────────────────────────────────────────────────────────
  it('P1 containment: an edge cannot join activities of two different projects', async () => {
    const here = await activity(f.projectA.id);
    const there = await activity(f.projectB.id);
    // Each endpoint key carries the edge's own projectId, so this is unrepresentable rather than
    // merely unwritten — no service, import or hand-written UPDATE can produce it.
    expect(await refusal(edge(there, here))).toMatch(/predecessorId_fkey/u);
    expect(await refusal(edge(here, there))).toMatch(/successorId_fkey/u);
    expect(await edgeCount()).toBe(0);
  });

  // ── P2 ─────────────────────────────────────────────────────────────────────────────────────
  it('P2 shape: self-dependency, duplicate live edges and negative lag are all refused', async () => {
    const [a, b] = [await activity(), await activity()];
    expect(await refusal(edge(a, a))).toMatch(/cannot depend on itself|no_self_check/u);
    expect(await refusal(edge(a, b, { lagWorkingDays: -1 }))).toMatch(/lag_nonneg_check/u);

    await t.prisma.$executeRawUnsafe(edge(a, b, { lagWorkingDays: 7 }));
    expect(await refusal(edge(a, b))).toMatch(/already exists|unique/u);
    // …and zero lag is ordinary: the guard is about NEGATIVE lag, not about lag.
    const c = await activity();
    await t.prisma.$executeRawUnsafe(edge(a, c, { lagWorkingDays: 0 }));
    expect(await edgeCount()).toBe(2);
  });

  // ── P3 ─────────────────────────────────────────────────────────────────────────────────────
  it('P3 many predecessors are the normal case; a direct and a chained cycle are both refused', async () => {
    const [a, b, c] = [await activity(), await activity(), await activity()];
    await t.prisma.$executeRawUnsafe(edge(a, c));
    await t.prisma.$executeRawUnsafe(edge(b, c));   // c waits for the LATEST of a and b

    expect(await refusal(edge(c, a))).toMatch(/dependency cycle/u);
    // and a longer one — the walk is reachability, not a neighbour check
    const d = await activity();
    await t.prisma.$executeRawUnsafe(edge(c, d));
    const err = await refusal(edge(d, a));
    expect(err).toMatch(/dependency cycle/u);
    // the diagnostic names ONE concrete route, forwards, for the person who has to fix it
    expect(err).toMatch(new RegExp(`${a} -> ${c} -> ${d}`, 'u'));
    expect(await edgeCount()).toBe(3);
  });

  // ── P4 ─────────────────────────────────────────────────────────────────────────────────────
  it('P4 the row is frozen: endpoints, lag and creation attribution are all unrewritable', async () => {
    const [a, b] = [await activity(), await activity()];
    await t.prisma.$executeRawUnsafe(edge(a, b, { lagWorkingDays: 7 }));
    const id = await onlyId();

    // Re-pointing is how a cycle evades a check that only ran at INSERT.
    expect(await refusal(
      `UPDATE "ActivityDependency" SET "predecessorId"='${b}', "successorId"='${a}' WHERE "id"='${id}'`,
    )).toMatch(/is frozen/u);
    // The lag is part of the sequencing claim: editing it in place would leave the frozen
    // attribution saying that whoever imposed a seven-day cure imposed today's zero-day one.
    expect(await refusal(
      `UPDATE "ActivityDependency" SET "lagWorkingDays"=0 WHERE "id"='${id}'`)).toMatch(/is frozen/u);
    expect(await refusal(
      `UPDATE "ActivityDependency" SET "createdByName"='Someone Else' WHERE "id"='${id}'`,
    )).toMatch(/is frozen/u);
    expect(await refusal(
      `UPDATE "ActivityDependency" SET "createdAt"=now() WHERE "id"='${id}'`)).toMatch(/is frozen/u);
  });

  // ── P5 ─────────────────────────────────────────────────────────────────────────────────────
  it('P5 concurrency: two sessions each adding one legal edge cannot compose a cycle', async () => {
    const [a, b] = [await activity(), await activity()];
    // Neither session is wrong on its own evidence — they touch different rows and conflict on
    // nothing. The advisory lock is what makes the second one see the first one's edge.
    const results = await Promise.allSettled([
      t.prisma.$executeRawUnsafe(edge(a, b)),
      t.prisma.$executeRawUnsafe(edge(b, a)),
    ]);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(/dependency cycle/u);
    expect(await edgeCount()).toBe(1);
  });

  // ── P6 ─────────────────────────────────────────────────────────────────────────────────────
  it('P6 attribution has to be answerable, and has to name a member of THIS project', async () => {
    const [a, b] = [await activity(), await activity()];
    // NOT NULL accepts all of these and P4 would then make them permanent — an edge that cannot
    // say who imposed it, forever. The vertical tab in particular: the obvious hand-written trim
    // set E' \t\n\r\v\f' does NOT strip it, because PostgreSQL reads \v there as the letter v.
    // The characters are REAL here, never SQL escape sequences: `E'\\v'` is the letter v to
    // PostgreSQL, so a probe written that way would test nothing and pass.
    for (const [label, blank] of [['empty', ''], ['space', ' '], ['tab', '\t'],
                                  ['newline', '\n'], ['vertical tab', '\v']] as const) {
      const err = await refusal(
        `INSERT INTO "ActivityDependency"("id","projectId","predecessorId","successorId","createdById","createdByName")
         VALUES ('dep-b1-${run}-${seq += 1}','${f.projectA.id}','${a}','${b}','${f.memberUser.id}','${blank}')`);
      expect(err, `${label} must not pass as attribution`).toMatch(/attribution_check/u);
    }
    // an id that names nobody at all
    expect(await refusal(
      `INSERT INTO "ActivityDependency"("id","projectId","predecessorId","successorId","createdById","createdByName")
       VALUES ('dep-b1-${run}-${seq += 1}','${f.projectA.id}','${a}','${b}','forged-user','PMC')`,
    )).toMatch(/createdBy_fkey/u);
    // …and a REAL user is still not enough. `otherUser` is an active pmc — on the OTHER project.
    expect(await refusal(
      `INSERT INTO "ActivityDependency"("id","projectId","predecessorId","successorId","createdById","createdByName")
       VALUES ('dep-b1-${run}-${seq += 1}','${f.projectA.id}','${a}','${b}','${f.otherUser.id}','Outsider')`,
    )).toMatch(/createdBy_fkey/u);
    // a real name is untouched, including one starting with the letter the bad trim set ate
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "ActivityDependency"("id","projectId","predecessorId","successorId","createdById","createdByName")
       VALUES ('dep-b1-${run}-${seq += 1}','${f.projectA.id}','${a}','${b}','${f.memberUser.id}','Vikram')`);
    expect(await edgeCount()).toBe(1);
  });

  // ── P7 ─────────────────────────────────────────────────────────────────────────────────────
  it('P7 a shadowing temporary table cannot blind the cycle check', async () => {
    const [a, b] = [await activity(), await activity()];
    await t.prisma.$executeRawUnsafe(edge(a, b));
    // `pg_temp` precedes `public` by default, so a writer holding only the ordinary TEMP privilege
    // can create a table of the same name. If the trigger resolved the relation through the
    // CALLING session's path it would walk this empty copy and let the opposing edge commit.
    await expect(t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `CREATE TEMP TABLE "ActivityDependency" (LIKE public."ActivityDependency") ON COMMIT DROP`);
      await tx.$executeRawUnsafe(
        `INSERT INTO public."ActivityDependency"("id","projectId","predecessorId","successorId","createdById","createdByName")
         VALUES ('dep-b1-${run}-${seq += 1}','${f.projectA.id}','${b}','${a}','${f.memberUser.id}','PMC')`);
    })).rejects.toThrow(/dependency cycle/iu);
    expect(await edgeCount()).toBe(1);
  });

  // ── P8 ─────────────────────────────────────────────────────────────────────────────────────
  it('P8 one project per transaction, and the caller cannot switch that scope off', async () => {
    const [a1, a2, a3] = [await activity(), await activity(), await activity()];
    const [b1, b2] = [await activity(f.projectB.id), await activity(f.projectB.id)];

    // Two projects in one transaction is what makes a deadlock possible: this is a ROW trigger, so
    // the per-project locks are taken in whatever order the rows arrive, and a second transaction
    // doing the same two projects the other way round leaves each holding what the other waits for.
    await expect(t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(edge(a1, a2));
      await tx.$executeRawUnsafe(edge(b1, b2, { projectId: f.projectB.id }));
    })).rejects.toThrow(/one project per transaction/iu);
    expect(await edgeCount()).toBe(0);

    // The scope is derived from the transaction's own advisory locks rather than from session
    // state, so clearing session state does not restore the deadlock shape.
    await expect(t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(edge(a1, a2));
      await tx.$executeRawUnsafe(`SELECT set_config('vitan.schedule_graph_project', '', true)`);
      await tx.$executeRawUnsafe(`RESET ALL`);
      await tx.$executeRawUnsafe(edge(b1, b2, { projectId: f.projectB.id }));
    })).rejects.toThrow(/one project per transaction/iu);
    expect(await edgeCount()).toBe(0);

    // …and the lock genuinely cannot be handed back mid-transaction, which is what makes the
    // derived state authoritative rather than merely inconvenient to forge.
    await t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(edge(a1, a2));
      const [{ released }] = await tx.$queryRawUnsafe<Array<{ released: boolean }>>(
        `SELECT pg_advisory_unlock(hashtext('vitan:schedule-graph'), hashtext('${f.projectA.id}')) AS released`);
      expect(released, 'a transaction-scoped advisory lock must not be releasable').toBe(false);
    });
    // many edges for ONE project in one transaction are untouched
    await t.prisma.$transaction(async (tx) => { await tx.$executeRawUnsafe(edge(a2, a3)); });
    expect(await edgeCount()).toBe(2);
  });

  // ── P9 ─────────────────────────────────────────────────────────────────────────────────────
  it('P9 a fixed snapshot cannot be used to write edges at all', async () => {
    const [a, b] = [await activity(), await activity()];
    await t.prisma.$executeRawUnsafe(edge(a, b));
    // The lock makes the second writer WAIT; what makes waiting useful is that the reachability
    // query afterwards sees the first writer's edge. Under a fixed snapshot it does not, so the
    // guard states its requirement rather than hoping SSI notices.
    for (const level of ['REPEATABLE READ', 'SERIALIZABLE'] as const) {
      await expect(t.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET TRANSACTION ISOLATION LEVEL ${level}`);
        await tx.$executeRawUnsafe(edge(b, a));
      })).rejects.toThrow(/READ COMMITTED/iu);
    }
    // and the ordinary isolation the application uses is untouched: the same write is refused, but
    // as the CYCLE it is, which is the point of getting this far.
    expect(await refusal(edge(b, a))).toMatch(/dependency cycle/iu);
    expect(await edgeCount()).toBe(1);
  });

  // ── P10 ────────────────────────────────────────────────────────────────────────────────────
  it('P10 a branching DAG is judged in linear time, not once per distinct route', async () => {
    // The shape matters, and getting it wrong hides the bug. Layers of two with complete edges
    // between them keep every route SHORT — 31 nodes, inside any plausible depth cap — while the
    // number of distinct ROUTES doubles per layer: about 120 edges and over two billion routes.
    // A path-carrying walk forces UNION ALL and enumerates routes; this one dedupes on node.
    const head = await activity();
    let prev = [head];
    for (let layer = 0; layer < 30; layer += 1) {
      const next = [await activity(), await activity()];
      for (const p of prev) for (const n of next) await t.prisma.$executeRawUnsafe(edge(p, n));
      prev = next;
    }
    // ACCEPTING has to be linear: an unrelated activity keeps the answer NO, so the walk has to
    // exhaust reachability rather than stop at a lucky early hit.
    const unrelated = await activity();
    const acceptStarted = Date.now();
    await t.prisma.$executeRawUnsafe(edge(unrelated, head));
    expect(Date.now() - acceptStarted).toBeLessThan(5_000);
    // …and so has REFUSING one, which is a SEPARATE walk and was a separate bug.
    const rejectStarted = Date.now();
    await expect(t.prisma.$executeRawUnsafe(edge(prev[0]!, head))).rejects.toThrow(/dependency cycle/iu);
    expect(Date.now() - rejectStarted).toBeLessThan(5_000);
  }, 180_000);

  // ── P11 (F4) ───────────────────────────────────────────────────────────────────────────────
  it('P11 (F4) refusing an edge costs about what accepting one costs, not many times more', async () => {
    // The route explosion P10 covers is not the only way this walk can be too slow. The earlier
    // version's ITERATION count was linear while its DATA STRUCTURES were not: `NOT (successorId =
    // ANY(v_seen))` is a linear array scan for every candidate edge, so the membership test alone
    // cost O(E*N) comparisons, and `v_seen := v_seen || v_node` rebuilt the whole array per node.
    // That runs while holding the project graph lock, so every other schedule write for the
    // project queues behind a diagnostic.
    //
    // The assertion is a RATIO, not a wall-clock bound, and that is deliberate. Accepting an edge
    // runs the DETECTION walk alone; refusing one runs detection AND the diagnostic. Both scale
    // with the same machine, so their ratio isolates the diagnostic and needs no assumption about
    // how fast the runner is — a plain millisecond bound would encode one and fail for the wrong
    // reason on a slow CI box. Measured on PostgreSQL 16 over this exact graph, in one warm
    // session: accept 27ms either way; refuse 1,206ms with the two arrays against 104ms with the
    // jsonb map, so the ratio is ~45x against ~4x. The bound sits well above the second and well
    // below the first, because the point is to fail on the defect and not on a slow machine.
    const W = 10;
    const L = 300;
    const node = (l: number, w: number): string => `act-b1-${run}-g-${l}-${w}`;
    const head = `act-b1-${run}-g-head`;
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "Activity"("id","projectId","name","zone","plannedStart","plannedEnd")
       VALUES ('${head}','${f.projectA.id}','head','Block A',0,1)`);
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "Activity"("id","projectId","name","zone","plannedStart","plannedEnd")
       SELECT 'act-b1-${run}-g-' || l || '-' || w, '${f.projectA.id}', 'n', 'Block A', 0, 1
         FROM generate_series(0, ${L - 1}) l, generate_series(0, ${W - 1}) w`);
    // Layers of ${W}, fully connected between consecutive layers: ~${(L - 1) * W * W} edges over
    // ${L * W + 1} activities. The guard is what this probe is timing, so the fixture is planted
    // with it disabled — the graph is acyclic and would be accepted anyway, this only avoids tens
    // of thousands of sequential guarded inserts.
    await t.prisma.$transaction([
      t.prisma.$executeRawUnsafe(
        `ALTER TABLE "ActivityDependency" DISABLE TRIGGER "ActivityDependency_acyclic"`),
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "ActivityDependency"("id","projectId","predecessorId","successorId","createdById","createdByName")
         SELECT 'dep-b1-${run}-gh-' || w, '${f.projectA.id}', '${head}', 'act-b1-${run}-g-0-' || w,
                '${f.memberUser.id}', 'PMC' FROM generate_series(0, ${W - 1}) w`),
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "ActivityDependency"("id","projectId","predecessorId","successorId","createdById","createdByName")
         SELECT 'dep-b1-${run}-g-' || l || '-' || a || '-' || b, '${f.projectA.id}',
                'act-b1-${run}-g-' || l || '-' || a, 'act-b1-${run}-g-' || (l + 1) || '-' || b,
                '${f.memberUser.id}', 'PMC'
           FROM generate_series(0, ${L - 2}) l, generate_series(0, ${W - 1}) a, generate_series(0, ${W - 1}) b`),
      t.prisma.$executeRawUnsafe(
        `ALTER TABLE "ActivityDependency" ENABLE TRIGGER "ActivityDependency_acyclic"`),
    ]);
    // Autovacuum has not seen this table yet, and the ratio is only meaningful when both walks are
    // planned against real statistics — which is what any live database has.
    await t.prisma.$executeRawUnsafe(`ANALYZE "ActivityDependency"`);

    // ACCEPTING: an unrelated activity keeps the answer NO, so detection must exhaust reachability
    // rather than stop at a lucky early hit. This is the machine-speed calibration.
    // Three of them, median taken: detection over this graph is tens of milliseconds, which is
    // close enough to one client round trip that a single sample is mostly noise.
    const accepts: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const unrelated = await activity();
      const started = Date.now();
      await t.prisma.$executeRawUnsafe(edge(unrelated, head));
      accepts.push(Date.now() - started);
    }
    const accept = Math.max(accepts.sort((x, y) => x - y)[1]!, 5);

    // REFUSING: the same detection walk, plus the diagnostic that names one route.
    const rejectStarted = Date.now();
    const err = await refusal(edge(node(L - 1, 0), head));
    const reject = Date.now() - rejectStarted;
    expect(err).toMatch(/dependency cycle/u);
    expect(reject / accept, `refusing took ${reject}ms against ${accept}ms to accept`)
      .toBeLessThan(15);

    // The fixture is cleaned by the shared `afterEach`, which truncates the edges BEFORE deleting
    // the activities — the endpoint keys are NO ACTION, so the other order is refused.
  }, 300_000);

  // ── P12 ────────────────────────────────────────────────────────────────────────────────────
  it('P12 an edge is revoked, never deleted, and a revocation needs an answerable author', async () => {
    const [a, b] = [await activity(), await activity()];
    await t.prisma.$executeRawUnsafe(edge(a, b));
    const id = await onlyId();

    // The freeze holds the creation provenance against UPDATE. Against DELETE it held nothing:
    // remove Alice's edge, re-insert the identical pair as Bob, and the original author is gone.
    expect(await refusal(`DELETE FROM "ActivityDependency" WHERE "id"='${id}'`)).toMatch(/not deletable/u);
    expect(await refusal(
      `UPDATE "ActivityDependency" SET "revokedAt"=now() WHERE "id"='${id}'`)).toMatch(/revocation_check/u);
    // …and a NAME, demanded EXPLICITLY. `NULL !~ '...'` is UNKNOWN and a CHECK PASSES on UNKNOWN,
    // so a revoked arm testing only the regex accepts a stamp and an id with no recorded revoker.
    expect(await refusal(
      `UPDATE "ActivityDependency" SET "revokedAt"=now(), "revokedById"='${f.memberUser.id}', "revokedByName"=NULL WHERE "id"='${id}'`,
    )).toMatch(/revocation_check/u);
    expect(await refusal(
      `UPDATE "ActivityDependency" SET "revokedAt"=now(), "revokedById"='${f.memberUser.id}', "revokedByName"='  ' WHERE "id"='${id}'`,
    )).toMatch(/revocation_check/u);
    // a fully attributed withdrawal LANDS — these seals refuse rewriting, not writing
    await t.prisma.$executeRawUnsafe(
      `UPDATE "ActivityDependency" SET "revokedAt"=now(), "revokedById"='${f.memberUser.id}', "revokedByName"='PMC' WHERE "id"='${id}'`);
    const [row] = await t.prisma.$queryRawUnsafe<Array<{ both: string }>>(
      `SELECT "createdByName" || '/' || "revokedByName" AS both FROM "ActivityDependency" WHERE "id"='${id}'`);
    expect(row!.both).toBe('PMC/PMC');
  });

  // ── P13 (F2) ───────────────────────────────────────────────────────────────────────────────
  it('P13 (F2) an edge cannot be BORN revoked, so a withdrawal always records one that stood', async () => {
    const [a, b] = [await activity(), await activity()];
    const bornRevoked = (id: string): string => `INSERT INTO "ActivityDependency"
        ("id","projectId","predecessorId","successorId","createdById","createdByName","revokedAt","revokedById","revokedByName")
        VALUES ('${id}','${f.projectA.id}','${a}','${b}','${f.memberUser.id}','PMC',now(),'${f.memberUser.id}','PMC')`;

    // The revocation CHECK's revoked arm is satisfied by this row, because a CHECK sees one row and
    // cannot tell an INSERT from an UPDATE. Every other guard then works in the fabrication's
    // favour, which is why this needs a trigger of its own.
    expect(await refusal(bornRevoked(`dep-b1-${run}-born`))).toMatch(/cannot be created already revoked/u);
    expect(await edgeCount()).toBe(0);

    // The three consequences, each stated as its own claim rather than left implied:
    //
    // (1) it would be permanent — the freeze refuses to touch an already-revoked row;
    // (2) it would never be judged for cycles — the walk reads LIVE edges only;
    // (3) the partial unique index covers live rows only, so an ordered pair could accumulate an
    //     unlimited number of fabricated withdrawals.
    // Proven by planting the row with ONLY this trigger disabled and watching the rest wave it
    // through — which is exactly what happened before the trigger existed.
    await t.prisma.$transaction([
      t.prisma.$executeRawUnsafe(
        `ALTER TABLE "ActivityDependency" DISABLE TRIGGER "ActivityDependency_born_live"`),
      t.prisma.$executeRawUnsafe(bornRevoked(`dep-b1-${run}-f1`)),
      t.prisma.$executeRawUnsafe(bornRevoked(`dep-b1-${run}-f2`)),   // (3) a second, same pair
      t.prisma.$executeRawUnsafe(
        `ALTER TABLE "ActivityDependency" ENABLE TRIGGER "ActivityDependency_born_live"`),
    ]);
    expect(await edgeCount(), 'two fabricated withdrawals for one pair were accepted').toBe(2);
    expect(await refusal(                                            // (1)
      `UPDATE "ActivityDependency" SET "revokedAt"=NULL, "revokedById"=NULL, "revokedByName"=NULL WHERE "id"='dep-b1-${run}-f1'`,
    )).toMatch(/already revoked/u);
    await t.prisma.$executeRawUnsafe(edge(b, a));                    // (2) the reverse edge stands
    expect(await edgeCount()).toBe(3);
  });

  // ── P14 ────────────────────────────────────────────────────────────────────────────────────
  it('P14 a revocation is evidence: it cannot be re-attributed or undone, and it frees the pair', async () => {
    const [a, b] = [await activity(), await activity()];
    await t.prisma.$executeRawUnsafe(edge(a, b));
    const id = await onlyId();
    await t.prisma.$executeRawUnsafe(
      `UPDATE "ActivityDependency" SET "revokedAt"=now(), "revokedById"='${f.memberUser.id}', "revokedByName"='PMC' WHERE "id"='${id}'`);

    expect(await refusal(
      `UPDATE "ActivityDependency" SET "revokedByName"='Someone Else' WHERE "id"='${id}'`)).toMatch(/already revoked/u);
    // un-revoking would also return a live edge to the graph without ever passing the acyclicity
    // trigger, which fires on INSERT
    expect(await refusal(
      `UPDATE "ActivityDependency" SET "revokedAt"=NULL, "revokedById"=NULL, "revokedByName"=NULL WHERE "id"='${id}'`,
    )).toMatch(/already revoked/u);

    // A withdrawn edge binds nothing, so the REPLACEMENT in the other direction is an ordinary
    // re-plan. A walk over history rather than over live edges would refuse it — through an edge
    // withdrawn precisely to make room for it.
    // (i) the same pair may be re-imposed, which is what the PARTIAL unique index is for
    await t.prisma.$executeRawUnsafe(edge(a, b));
    const again = (await t.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT "id" FROM "ActivityDependency" WHERE "revokedAt" IS NULL LIMIT 1`))[0]!.id;
    // (ii) and once THAT is withdrawn too, the replacement in the OTHER direction is accepted — a
    //      walk over history rather than over live edges would refuse it as a cycle through an
    //      edge withdrawn precisely to make room for it.
    await t.prisma.$executeRawUnsafe(
      `UPDATE "ActivityDependency" SET "revokedAt"=now(), "revokedById"='${f.memberUser.id}', "revokedByName"='PMC' WHERE "id"='${again}'`);
    await t.prisma.$executeRawUnsafe(edge(b, a));
    expect(await edgeCount()).toBe(3);
  });

  // ── P15 (F3) ───────────────────────────────────────────────────────────────────────────────
  it('P15 (F3) re-applying is a no-op, and every object is recognized by DEFINITION not by name', async () => {
    const sql = readFileSync(migrationPath, 'utf8');
    const statements = sql.split('\n').map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('--'));
    expect(statements[0], 'the migration must open a transaction').toBe('BEGIN;');
    expect(statements[statements.length - 1], 'the migration must close it').toBe('COMMIT;');
    expect(sql, 'and pin the schema, since psql takes the caller path')
      .toMatch(/SET LOCAL search_path = public;/u);

    const [a, b] = [await activity(), await activity()];
    await t.prisma.$executeRawUnsafe(edge(a, b));
    const before = await objectIdentity();

    // (1) a second application over a complete install changes NOTHING — not the rows, and not
    // even the object identities. "It did not error" is a much weaker claim than this.
    expect(applyMigration(), 'a re-apply must succeed').toBeNull();
    expect(await edgeCount(), 'and must not disturb the rows').toBe(1);
    expect(await objectIdentity(), 'and must not recreate a single object').toBe(before);

    // (2) an object of the RIGHT NAME and the WRONG DEFINITION must be repaired, not skipped. Each
    // of these satisfies a name test, which is why a name test is not enough:
    //   - a hollow CHECK (TRUE) that judges nothing;
    //   - a NOT VALID constraint, which judges nothing already in the table;
    //   - a foreign key to the global `User`, losing the project half of the identity;
    //   - a plain, NON-UNIQUE index named `..._key`, leaving the ordered pair unconstrained.
    await t.prisma.$executeRawUnsafe(
      `ALTER TABLE "ActivityDependency" DROP CONSTRAINT "ActivityDependency_no_self_check"`);
    await t.prisma.$executeRawUnsafe(
      `ALTER TABLE "ActivityDependency" ADD CONSTRAINT "ActivityDependency_no_self_check" CHECK (TRUE)`);
    await t.prisma.$executeRawUnsafe(
      `ALTER TABLE "ActivityDependency" DROP CONSTRAINT "ActivityDependency_lag_nonneg_check"`);
    await t.prisma.$executeRawUnsafe(
      `ALTER TABLE "ActivityDependency" ADD CONSTRAINT "ActivityDependency_lag_nonneg_check" CHECK ("lagWorkingDays" >= 0) NOT VALID`);
    await t.prisma.$executeRawUnsafe(
      `ALTER TABLE "ActivityDependency" DROP CONSTRAINT "ActivityDependency_createdBy_fkey"`);
    await t.prisma.$executeRawUnsafe(
      `ALTER TABLE "ActivityDependency" ADD CONSTRAINT "ActivityDependency_createdBy_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id")`);
    await t.prisma.$executeRawUnsafe(
      `DROP INDEX "ActivityDependency_projectId_successorId_predecessorId_key"`);
    await t.prisma.$executeRawUnsafe(
      `CREATE INDEX "ActivityDependency_projectId_successorId_predecessorId_key" ON "ActivityDependency"("projectId","successorId","predecessorId")`);

    expect(applyMigration(), 'the migration must install over a same-named wrong definition').toBeNull();
    const [defs] = await t.prisma.$queryRawUnsafe<Array<{ d: string }>>(`
      SELECT (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='ActivityDependency_no_self_check')
          || '|' || (SELECT convalidated::text FROM pg_constraint WHERE conname='ActivityDependency_lag_nonneg_check')
          || '|' || (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='ActivityDependency_createdBy_fkey')
          || '|' || (SELECT ix.indisunique::text FROM pg_class ci JOIN pg_index ix ON ix.indexrelid=ci.oid
                      WHERE ci.relname='ActivityDependency_projectId_successorId_predecessorId_key') AS d`);
    expect(defs!.d).toMatch(/"predecessorId" <> "successorId"/u);
    expect(defs!.d).toMatch(/\|true\|/u);
    expect(defs!.d).toMatch(/REFERENCES "Membership"\("projectId", "userId"\)/u);
    expect(defs!.d).toMatch(/\|true$/u);
    // and the repaired rules really bind, which the catalog alone does not prove
    const c = await activity();
    expect(await refusal(edge(c, c))).toMatch(/cannot depend on itself|no_self_check/u);
    expect(await refusal(edge(a, b))).toMatch(/already exists|unique/u);
  }, 60_000);

  // ── P16 ────────────────────────────────────────────────────────────────────────────────────
  it('P16 the sequencing record cannot be erased by TRUNCATE, and an empty one may be', async () => {
    // A ROW trigger does not fire for TRUNCATE, so without a statement-level seal one statement
    // erases every edge and every attribution the DELETE seal exists to protect.
    const [a, b] = [await activity(), await activity()];
    await t.prisma.$executeRawUnsafe(edge(a, b));
    expect(await refusal(`TRUNCATE TABLE "ActivityDependency"`)).toMatch(/never truncated/u);
    expect(await edgeCount()).toBe(1);

    // …and a TRUNCATE that erases NOTHING is permitted, deliberately. What must not be destroyed
    // is the record of who imposed each constraint and who withdrew it; with no edges there is no
    // such record, and refusing anyway would refuse every fixture reset that CASCADEs through
    // "Activity" on a database where no edge has ever been written — which is how a seal becomes a
    // formality that every caller disables as a matter of routine.
    await wipe();
    await t.prisma.$executeRawUnsafe(`TRUNCATE TABLE "ActivityDependency"`);
    expect(await edgeCount()).toBe(0);
  });

  // ── P17 (F3 / the data half of the reframing) ──────────────────────────────────────────────
  it('P17 rows the guards would refuse are named before any object is installed', async () => {
    // What this file refuses is DATA it cannot honestly interpret — never objects. Acyclicity is
    // the one rule no constraint can validate retroactively, so the migration walks it itself.
    const [a, b, c] = [await activity(), await activity(), await activity()];
    await t.prisma.$executeRawUnsafe(edge(a, b));
    await t.prisma.$executeRawUnsafe(edge(b, c));
    // A pre-existing loop, planted the only way one can exist: behind the guard's back.
    await t.prisma.$transaction([
      t.prisma.$executeRawUnsafe(
        `ALTER TABLE "ActivityDependency" DISABLE TRIGGER "ActivityDependency_acyclic"`),
      t.prisma.$executeRawUnsafe(edge(c, a)),
      t.prisma.$executeRawUnsafe(
        `ALTER TABLE "ActivityDependency" ENABLE TRIGGER "ActivityDependency_acyclic"`),
    ]);

    const err = applyMigration();
    expect(err, 'a pre-existing cycle must abort the migration').not.toBeNull();
    expect(err).toMatch(/already holds a dependency CYCLE/u);
    expect(err, 'and must name the loop, not just report that one exists')
      .toMatch(new RegExp(`${a} -> ${b} -> ${c} -> ${a}`, 'u'));

    // Repaired the way the diagnostic instructs — revoke an edge on the loop — the same file
    // applies. The abort is about the data, and it clears when the data does.
    const loop = (await t.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT "id" FROM "ActivityDependency" WHERE "predecessorId"='${c}' AND "successorId"='${a}'`))[0]!.id;
    await t.prisma.$executeRawUnsafe(
      `UPDATE "ActivityDependency" SET "revokedAt"=now(), "revokedById"='${f.memberUser.id}', "revokedByName"='PMC' WHERE "id"='${loop}'`);
    expect(applyMigration(), 'and applies once the loop is withdrawn').toBeNull();
    expect(await edgeCount(), 'without touching the rows').toBe(3);
  }, 60_000);
});
