import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';

/**
 * Schedule unit B1 — the ACYCLIC ACTIVITY DEPENDENCY GRAPH, proven against live PostgreSQL.
 *
 * No service writes these edges yet, so every probe is a HOSTILE-SQL probe: during this unit
 * direct SQL is the only writer the table can have, and a guarantee that only holds when the
 * application cooperates is not a guarantee.
 *
 * THE NUMBERING HAS GAPS, DELIBERATELY. A stable probe number keeps the earlier review records
 * readable, and a gap says "deleted" where a shifted number would say nothing. Two are gone:
 *
 *   P17 - rows the guards would refuse are named before any object is installed.
 *   P18 - a withdrawal the seals could not have judged is refused.
 *
 * Both only mean something when the migration ADOPTS a populated table, and it does not: nothing
 * can write "ActivityDependency" between the CREATE TABLE that makes it and the seals a few
 * statements later, so a table holding any row is not this file's partial apply and section 1c
 * refuses it outright (P22). P15, P20 and P21 are back, and they now assert REFUSAL where they
 * once asserted repair - the migration completes its OWN install and adopts nothing else.
 *
 * P23 is the retry-safety probe the whole shape exists for: a partial apply is left behind, the
 * refusal this file used to carry is shown to dead-end on it, and the file as it stands completes
 * the install. The install-and-repair half runs against real pre-baseline databases in
 * `apps/api/scripts/schedule-b1-baseline-proof.sh`, which CI runs in the required `api` job.
 *
 * P24, P25, P26 and P27 are the three findings of #410's second round, each reproduced RED before
 * its fix:
 *
 *   P24 - a COMPLETE install THAT HOLDS ROWS replays as a no-op. This is what P23 and P15 left
 *         out: they replay over an EMPTY table, and the state a real re-deploy meets is a table
 *         in service. One accepted edge used to make the file permanently non-rerunnable.
 *   P25 - a same-named no-op in a schema ahead of `public` on the CALLER's path cannot capture a
 *         seal. `SET LOCAL search_path` is only a warning outside a transaction block, so for the
 *         autocommit caller an unqualified `EXECUTE FUNCTION` bound the decoy and exited 0.
 *   P26 - an unfinished install is UNWRITABLE. A lock cannot span autocommit statements, so the
 *         exclusion is an unsatisfiable CHECK installed atomically with the table and dropped
 *         only once every seal is proven armed.
 *   P27 - and that barrier is load-bearing rather than decorative: a seal that cannot be armed
 *         leaves the table shut.
 *
 * The row rule therefore changed shape, and P22 carries the half that survived: rows plus an
 * INCOMPLETE or foreign install is still refused, because arming a trigger validates nothing
 * already in the table. Rows alone are not evidence of anything.
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

  /**
   * Apply the migration through psql, returning stderr on failure and null on success.
   *
   * `--single-transaction` is what the ORDINARY caller supplies. The file carries no
   * `BEGIN;`/`COMMIT;` of its own — an explicit transaction inside it masks section 1's named
   * diagnostics under `prisma migrate deploy`, which is why it was removed — so the CALLER
   * supplies it. Prisma does automatically; psql does only when asked. It is passed here so the
   * "changed nothing at all" assertions in P15 and P22 measure the refusal rather than luck.
   *
   * It is NOT what makes the file re-runnable. That comes from the object guards, and P23 proves
   * it by leaving a partial apply behind and letting the file finish over it.
   */
  const applyMigration = (
    opts: { autocommit?: boolean; searchPath?: string; file?: string } = {},
  ): string | null => {
    // AUTOCOMMIT is the caller the repository requires this file to tolerate, and the reason it is
    // an option here rather than an aside: `psql` without `--single-transaction` commits every
    // statement on its own, so a failure part-way leaves whatever ran behind. P23 uses it.
    const tx = opts.autocommit ? [] : ['--single-transaction'];
    // `searchPath` is the CALLER's path, set the way a real role's path is set — through the
    // connection, not through anything this file can see. It is how P25 reproduces a same-named
    // decoy sitting in front of `public`.
    const env = opts.searchPath
      ? { ...process.env, PGOPTIONS: `-c search_path=${opts.searchPath}` }
      : process.env;
    try {
      execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', ...tx, '-q',
                            '-d', psqlUrl(), '-f', opts.file ?? migrationPath],
                   { encoding: 'utf8', stdio: 'pipe', env });
      return null;
    } catch (e: unknown) {
      return String((e as { stderr?: string }).stderr ?? e);
    }
  };

  /**
   * Wait for a live database CONDITION, never for a duration.
   *
   * A sleep encodes an assumption about machine speed, and when that assumption is wrong the test
   * does not merely flake — it can pass the wrong way round, reporting a serialization that never
   * happened. Every barrier below waits on `pg_locks`, which is the mechanism itself.
   */
  const waitFor = async (what: string, sql: string): Promise<void> => {
    for (let i = 0; i < 400; i += 1) {
      const rows = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(sql);
      if (Number(rows[0]?.n ?? 0) > 0) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`barrier never satisfied after 10s: ${what}`);
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

    // The hazard: two sessions each add an edge that is individually fine and jointly a loop.
    //
    //   T1: add a -> b   (asks: does b already reach a?  no)
    //   T2: add b -> a   (asks: does a already reach b?  no)
    //
    // Neither is wrong on its own evidence. They touch different rows, conflict on nothing, and
    // under READ COMMITTED neither can see the other's uncommitted row. Only the advisory lock —
    // plus the fresh snapshot READ COMMITTED gives T2 after it waits — turns that into a refusal.
    //
    // FIRING BOTH INSERTS AS CONCURRENT PROMISES DOES NOT TEST THAT, and an earlier version of this
    // probe did exactly that. The client pool is free to run one to completion before starting the
    // other, and serial execution produces the same visible outcome — one edge accepted, one refused
    // as an ordinary cycle — so the assertion passed without any interleaving at all, and would
    // still pass with the serialization removed. A probe that cannot fail on the defect it names is
    // not evidence.
    //
    // So the overlap is CONSTRUCTED: a second, independently-connected session holds its
    // transaction open, and the first session's write is required to be genuinely BLOCKED on the
    // project graph lock — asserted from `pg_locks`, not assumed after a sleep — before the holder
    // is allowed to commit.
    const holder = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let blocked: Promise<string> | null = null;

    try {
      const holderTx = holder.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(edge(a, b));   // takes the project graph lock, and keeps it
        await held;                               // …until this test says otherwise
      }, { timeout: 60_000, maxWait: 20_000 });

      await waitFor('the holding session has taken the project graph lock',
        `SELECT COUNT(*) AS n FROM pg_locks
          WHERE locktype = 'advisory' AND granted
            AND classid = hashtext('vitan:schedule-graph')
            AND objid = hashtext('${f.projectA.id}')::bigint::int`);

      // the opposing edge, from THIS session — it must not get past the lock
      blocked = t.prisma.$executeRawUnsafe(edge(b, a))
        .then(() => 'COMMITTED', (e: unknown) => String(e));

      await waitFor('the opposing writer is WAITING on that same lock',
        `SELECT COUNT(*) AS n FROM pg_locks
          WHERE locktype = 'advisory' AND NOT granted
            AND classid = hashtext('vitan:schedule-graph')
            AND objid = hashtext('${f.projectA.id}')::bigint::int`);

      // Only now — the two writes provably overlap, and the second is asleep on the lock the first
      // holds. Letting the holder commit is what gives the second its fresh snapshot.
      release();
      await holderTx;

      expect(await blocked, 'the second writer must be refused, not committed')
        .toMatch(/dependency cycle/u);
    } finally {
      release();
      await blocked?.catch(() => undefined);
      await holder.$disconnect();
    }

    // the terminal invariant, which is the thing that actually matters
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

  // ── P19 ────────────────────────────────────────────────────────────────────────────────────
  it('P19 a withdrawal attributed to a BLANK id is refused, exactly as a blank author is', async () => {
    // The foreign key proves the revoker id names a membership. It does not prove the id is
    // legible, and a writer able to create a whitespace-id user and membership can revoke through
    // it — permanently, because section 7 freezes the withdrawal. The creation arm already refuses
    // this on `createdById`; the revoked arm has to refuse it on `revokedById` for the same reason.
    const blank = '   ';
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "User"("id","projectId","name","email","role") VALUES ('${blank}','${f.projectA.id}','Blank','blank-b1@example.com','pmc')`);
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "Membership"("id","projectId","userId","role","status") VALUES ('mem-b1-blank','${f.projectA.id}','${blank}','pmc','active')`);
    try {
      const [a, b] = [await activity(), await activity()];
      await t.prisma.$executeRawUnsafe(edge(a, b));
      const id = await onlyId();
      // The membership really exists, so the FK is satisfied and only the CHECK can refuse this.
      expect(await refusal(
        `UPDATE "ActivityDependency" SET "revokedAt"=now(),"revokedById"='${blank}',"revokedByName"='PMC' WHERE "id"='${id}'`,
      )).toMatch(/revocation_check/u);
      // and the edge is still LIVE — a refused withdrawal withdraws nothing
      const live = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT COUNT(*) AS n FROM "ActivityDependency" WHERE "id"='${id}' AND "revokedAt" IS NULL`);
      expect(Number(live[0]!.n)).toBe(1);
    } finally {
      await t.prisma.$executeRawUnsafe(`DELETE FROM "Membership" WHERE "id"='mem-b1-blank'`);
      await t.prisma.$executeRawUnsafe(`DELETE FROM "User" WHERE "id"='${blank}'`);
    }
  });

  /** Every installed object, by KIND and COUNT — "the install is complete" as one readable string. */
  const installed = async (): Promise<string> => (await t.prisma.$queryRawUnsafe<Array<{ s: string }>>(`
    SELECT (SELECT COUNT(*) FROM pg_constraint
             WHERE conrelid = '"ActivityDependency"'::regclass AND contype = 'c' AND convalidated)
        || '/' || (SELECT COUNT(*) FROM pg_constraint
                    WHERE conrelid = '"ActivityDependency"'::regclass AND contype = 'f')
        || '/' || (SELECT COUNT(*) FROM pg_index WHERE indrelid = '"ActivityDependency"'::regclass)
        || '/' || (SELECT COUNT(*) FROM pg_trigger
                    WHERE tgrelid = '"ActivityDependency"'::regclass
                      AND NOT tgisinternal AND tgenabled = 'O')
        || '/' || (SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname LIKE 'activity\\_dependency%') AS s`))[0]!.s;

  /** checks/foreign keys/indexes/armed triggers/functions, when every object this file installs is present. */
  const COMPLETE = '4/5/4/5/5';

  // ── P15 ────────────────────────────────────────────────────────────────────────────────────
  it('P15 a complete re-apply is a no-op, and a same-named WRONG definition is REFUSED, not adopted', async () => {
    // Half of retry-safety is that a repeated apply over a finished install does nothing at all.
    // "It did not error" is a much weaker claim than this: the object IDENTITIES are compared, so a
    // drop-and-recreate would fail here even though the end state would look right.
    expect(await installed(), 'the suite database carries the finished install').toBe(COMPLETE);
    const before = await objectIdentity();
    expect(applyMigration(), 'a re-apply over a complete install must succeed').toBeNull();
    expect(await objectIdentity(), 'and must not recreate a single object').toBe(before);

    // THIS ALSO PINS THE CANONICAL LIST AGAINST DRIFT, which is worth naming because it is the one
    // hazard of writing a definition down twice. Section 1 compares the installed objects against
    // canonical `pg_get_*def` texts spelled out in the file; if someone later edits a CHECK inline
    // in section 2 and forgets its entry in section 1e, a FRESH install still succeeds — and this
    // assertion is what fails, because the next apply over that install would then abort. The two
    // copies cannot diverge without turning this red.

    // The other half is that PRESENT is decided by DEFINITION, never by name. Each forgery below
    // satisfies a name test — which is exactly why a name test is not enough — and each is REFUSED
    // rather than repaired: this file completes its own install and adopts nothing else. The
    // function case is the one that closed PR #409: `CREATE OR REPLACE FUNCTION` preserves the
    // function's identity, so a hollowed body of the right name survives everything short of
    // reading `prosrc`.
    const forgeries: Array<{ what: string; forge: string[]; expect: RegExp; restore: string[] }> = [
      { what: 'a hollow CHECK (TRUE) that judges nothing',
        forge: [`ALTER TABLE "ActivityDependency" DROP CONSTRAINT "ActivityDependency_no_self_check"`,
                `ALTER TABLE "ActivityDependency" ADD CONSTRAINT "ActivityDependency_no_self_check" CHECK (TRUE)`],
        expect: /constraint "ActivityDependency_no_self_check" is present as CHECK \(true\)/u,
        restore: [`ALTER TABLE "ActivityDependency" DROP CONSTRAINT "ActivityDependency_no_self_check"`,
                  `ALTER TABLE "ActivityDependency" ADD CONSTRAINT "ActivityDependency_no_self_check" CHECK ("predecessorId" <> "successorId")`] },
      { what: 'a NOT VALID constraint, which judges nothing already in the table',
        forge: [`ALTER TABLE "ActivityDependency" DROP CONSTRAINT "ActivityDependency_lag_nonneg_check"`,
                `ALTER TABLE "ActivityDependency" ADD CONSTRAINT "ActivityDependency_lag_nonneg_check" CHECK ("lagWorkingDays" >= 0) NOT VALID`],
        expect: /"ActivityDependency_lag_nonneg_check" is present as .*\[NOT VALID\]/u,
        restore: [`ALTER TABLE "ActivityDependency" DROP CONSTRAINT "ActivityDependency_lag_nonneg_check"`,
                  `ALTER TABLE "ActivityDependency" ADD CONSTRAINT "ActivityDependency_lag_nonneg_check" CHECK ("lagWorkingDays" >= 0)`] },
      { what: 'a foreign key to the global "User", losing the project half of the identity',
        forge: [`ALTER TABLE "ActivityDependency" DROP CONSTRAINT "ActivityDependency_createdBy_fkey"`,
                `ALTER TABLE "ActivityDependency" ADD CONSTRAINT "ActivityDependency_createdBy_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id")`],
        expect: /"ActivityDependency_createdBy_fkey" is present as FOREIGN KEY \("createdById"\) REFERENCES public\."User"/u,
        restore: [`ALTER TABLE "ActivityDependency" DROP CONSTRAINT "ActivityDependency_createdBy_fkey"`,
                  `ALTER TABLE "ActivityDependency" ADD CONSTRAINT "ActivityDependency_createdBy_fkey" FOREIGN KEY ("projectId", "createdById") REFERENCES "Membership"("projectId", "userId")`] },
      { what: 'a plain NON-UNIQUE index wearing the partial-unique name',
        forge: [`DROP INDEX "ActivityDependency_projectId_successorId_predecessorId_key"`,
                `CREATE INDEX "ActivityDependency_projectId_successorId_predecessorId_key" ON "ActivityDependency"("projectId","successorId","predecessorId")`],
        expect: /index "ActivityDependency_projectId_successorId_predecessorId_key" exists .* with a definition this migration did not install/su,
        restore: [`DROP INDEX "ActivityDependency_projectId_successorId_predecessorId_key"`] },
      { what: 'a same-named function whose body has been hollowed out',
        forge: [`CREATE OR REPLACE FUNCTION activity_dependency_acyclic() RETURNS TRIGGER LANGUAGE plpgsql
                 SET search_path = pg_catalog, public AS $hollow$ BEGIN RETURN NEW; END $hollow$`],
        expect: /function public\.activity_dependency_acyclic\(\) already exists with a definition this migration did not install/u,
        restore: [`DROP TRIGGER "ActivityDependency_acyclic" ON "ActivityDependency"`,
                  `DROP FUNCTION activity_dependency_acyclic()`] },
      { what: 'a seal that is present but DISABLED, so it reads as installed and fires for nobody',
        forge: [`ALTER TABLE "ActivityDependency" DISABLE TRIGGER "ActivityDependency_frozen"`],
        expect: /trigger "ActivityDependency_frozen" .*tgenabled=D/su,
        restore: [`ALTER TABLE "ActivityDependency" ENABLE TRIGGER "ActivityDependency_frozen"`] },
    ];

    for (const g of forgeries) {
      for (const s of g.forge) await t.prisma.$executeRawUnsafe(s);
      try {
        const err = applyMigration();
        expect(err, `must refuse: ${g.what}`).not.toBeNull();
        expect(err, `must name the object and both definitions: ${g.what}`).toMatch(g.expect);
        expect(err, 'and must point at the operator procedure').toMatch(/docs\/RUNBOOK\.md section B1/u);
      } finally {
        for (const s of g.restore) await t.prisma.$executeRawUnsafe(s);
      }
      // Refusal is not the end of the road: with the forgery removed, the SAME file finishes the
      // install. That is the difference between a guard and a dead end.
      expect(applyMigration(), `and applies once removed: ${g.what}`).toBeNull();
      expect(await installed(), `restoring the full install: ${g.what}`).toBe(COMPLETE);
    }

    // The restored rules really BIND, which the catalog alone does not prove.
    const [a, b] = [await activity(), await activity()];
    expect(await refusal(edge(a, a))).toMatch(/cannot depend on itself/u);
    await t.prisma.$executeRawUnsafe(edge(a, b));
    expect(await refusal(edge(b, a))).toMatch(/dependency cycle/u);
    expect(await refusal(edge(a, b))).toMatch(/already exists|unique/u);
  }, 120_000);

  // ── P20 ────────────────────────────────────────────────────────────────────────────────────
  it('P20 the table is judged on its COLUMN CONTRACT, not on its column names', async () => {
    // Section 2's `CREATE TABLE IF NOT EXISTS` skips its definition when the table is already
    // there, so on the resume path the shape is whatever produced it. A name test cannot tell a
    // conforming column from a differently-shaped one, and a NULLABLE `predecessorId` is the case
    // that matters: MATCH SIMPLE skips the composite FK entirely for a row with a NULL key column,
    // the self-dependency CHECK evaluates to UNKNOWN and passes, and the walk matches no node.
    await t.prisma.$executeRawUnsafe(
      `ALTER TABLE "ActivityDependency" ALTER COLUMN "predecessorId" DROP NOT NULL`);
    try {
      const err = applyMigration();
      expect(err, 'a nullable endpoint must abort the migration').not.toBeNull();
      expect(err).toMatch(/does not match the column contract/u);
      expect(err, 'and must name the column and both shapes').toMatch(/predecessorId/u);
      expect(err).toMatch(/nullable=YES.*nullable=NO/su);
    } finally {
      await t.prisma.$executeRawUnsafe(
        `ALTER TABLE "ActivityDependency" ALTER COLUMN "predecessorId" SET NOT NULL`);
    }
    expect(applyMigration(), 'and applies once the contract is restored').toBeNull();
  }, 60_000);

  // ── P21 ────────────────────────────────────────────────────────────────────────────────────
  it('P21 an index name owned by ANOTHER table is refused, never reclaimed', async () => {
    // An index name is unique per SCHEMA, not per table. Two silent failures follow from that: a
    // table-scoped definition lookup reports "absent", and `CREATE INDEX IF NOT EXISTS` skips on
    // the name — so the migration would report success over a table that never got the index.
    const name = 'ActivityDependency_projectId_predecessorId_idx';
    await t.prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS public."${name}"`);
    await t.prisma.$executeRawUnsafe(`CREATE TABLE "b1_decoy_owner"("k" TEXT)`);
    await t.prisma.$executeRawUnsafe(`CREATE INDEX "${name}" ON "b1_decoy_owner"("k")`);
    try {
      const err = applyMigration();
      expect(err, 'a name owned by another table must abort the migration').not.toBeNull();
      expect(err).toMatch(/will not drop or reclaim an object it does not own/u);
      expect(err, 'and must name the table that really owns it').toMatch(/b1_decoy_owner/u);

      // The whole point: the other table's index is STILL THERE. An unscoped drop would have taken
      // it, and the migration would have reported success.
      const rows = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT COUNT(*) AS n FROM pg_index ix JOIN pg_class ci ON ci.oid = ix.indexrelid
          WHERE ci.relname = '${name}' AND ix.indrelid = '"b1_decoy_owner"'::regclass`);
      expect(Number(rows[0]!.n), 'the decoy owner kept its index').toBe(1);
    } finally {
      await t.prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "b1_decoy_owner"`);
    }
    expect(applyMigration(), 'and applies once the name is free').toBeNull();
    expect(await installed(), 'restoring the index it does own').toBe(COMPLETE);
  }, 60_000);

  // ── P22 ────────────────────────────────────────────────────────────────────────────────────
  it('P22 the file supplies no transaction of its own, and refuses a table that holds rows', async () => {
    const sql = readFileSync(migrationPath, 'utf8');

    // THE TRANSACTION CONTRACT, pinned rather than described. The file must NOT open one of its
    // own — measured: with `BEGIN;`/`COMMIT;` in the file, `migrate deploy` reports `current
    // transaction is aborted, commands ignored…` and every named diagnostic in section 1 is
    // discarded; without them it reports the message verbatim. That measurement is what makes the
    // aborts in P15/P20/P21 readable at all, so the next person to reach for the obvious `BEGIN;`
    // fails a test instead of costing an operator their diagnostic.
    const statements = sql.split('\n').map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('--'));
    expect(statements, 'the file must not open its own transaction').not.toContain('BEGIN;');
    expect(statements, 'nor close one').not.toContain('COMMIT;');
    expect(statements[0], 'the first statement must pin the schema, since psql takes the caller path')
      .toBe('SET LOCAL search_path = public;');

    // Retry-safety is by OBJECT GUARDS, not by the caller's transaction: the table is created only
    // if absent, and section 1 has already established that a table which IS present is this
    // file's own unfinished install.
    expect(sql, 'the table must be created conditionally')
      .toMatch(/^CREATE TABLE IF NOT EXISTS public\."ActivityDependency" \($/mu);

    // EVERY object is created SCHEMA-QUALIFIED. `SET LOCAL search_path` is only a WARNING outside
    // a transaction block, so for the autocommit caller it does nothing at all — and an
    // unqualified CREATE under a role whose path names `pg_temp` first would build the whole graph
    // somewhere else and commit, while section 1's qualified lookups kept reporting a fresh
    // install forever. Qualification is what makes the outcome independent of the caller's path.
    for (const unqualified of sql.split('\n')
           .filter((l) => /^\s*(CREATE (UNIQUE )?INDEX|CREATE TABLE|LOCK TABLE|\s*ON) /u.test(l))
           .filter((l) => /"ActivityDependency"/u.test(l))
           .filter((l) => !/public\."ActivityDependency"/u.test(l))) {
      expect.unreachable(`every created object must be schema-qualified: ${unqualified.trim()}`);
    }

    // AND SO IS EVERY FOREIGN-KEY TARGET, which is the same hazard pointing the other way. A key
    // resolves its target through the CALLER's path at CREATE time, so an unqualified
    // `REFERENCES "Project"` under a path naming another schema first binds containment to a decoy
    // — and containment bound to a decoy proves nothing at all.
    for (const unqualified of sql.split('\n')
           .filter((l) => !/^\s*--/u.test(l))            // the prose ABOUT the hazard is not the hazard
           .filter((l) => /REFERENCES /u.test(l))
           .filter((l) => !/REFERENCES public\./u.test(l))) {
      expect.unreachable(`every foreign-key target must be schema-qualified: ${unqualified.trim()}`);
    }

    // And no LOCK may be a top-level statement: a bare `LOCK TABLE` is an ERROR outside a
    // transaction block, so it would dead-end the autocommit caller one statement past the CREATE.
    // (matched at column 0: every top-level statement in this file is unindented, and the two
    // locks that ARE legitimate live indented inside `DO` blocks.)
    expect(sql, 'every lock must be inside a DO block').not.toMatch(/^LOCK TABLE/mu);

    // ROWS PLUS AN UNFINISHED INSTALL is where the resume stops — and note which half does the
    // work. Rows alone are the ordinary state of a deployed database and are replayed over freely
    // (P24). What cannot be finished is a POPULATED table that is missing a seal or was built by
    // something else: arming a trigger validates nothing already in the table, so completing it
    // would certify those rows by silence.
    const [a, b] = [await activity(), await activity()];
    await t.prisma.$executeRawUnsafe(edge(a, b));
    await t.prisma.$executeRawUnsafe(
      `DROP TRIGGER "ActivityDependency_born_live" ON "ActivityDependency"`);
    const before = await objectIdentity();

    let err: string | null;
    try {
      err = applyMigration();
      expect(err, 'a populated table with a missing seal must abort the migration').not.toBeNull();
      expect(err, 'and must name what is missing')
        .toMatch(/installation is INCOMPLETE: armed trigger "ActivityDependency_born_live"/u);
      expect(err, 'and must say how many rows it found').toMatch(/already exists and holds 1 row\(s\)/u);
      expect(err, 'and must point at the operator procedure').toMatch(/docs\/RUNBOOK\.md section B1/u);
      // The abort is inside the caller's transaction, so it is not merely a refusal — it changes
      // nothing at all.
      expect(await objectIdentity(), 'the refused run must not touch a single object').toBe(before);
      expect(await edgeCount(), 'nor a single row').toBe(1);
    } finally {
      await t.prisma.$executeRawUnsafe(
        `CREATE TRIGGER "ActivityDependency_born_live" BEFORE INSERT ON public."ActivityDependency"
           FOR EACH ROW EXECUTE FUNCTION public.activity_dependency_born_live()`);
    }
    expect(await refusal(edge(b, a))).toMatch(/dependency cycle/u);
  }, 60_000);

  // ── P23 ────────────────────────────────────────────────────────────────────────────────────
  it('P23 the migration COMPLETES its own partial apply, where the old refusal dead-ended', async () => {
    // THE FINDING, reproduced. A caller that wraps this file in no transaction — which `AGENTS.md`
    // requires it to tolerate — and fails anywhere after `CREATE TABLE` leaves the table behind
    // with some of its objects installed and some not. Simulated exactly: the table and the ten
    // constraints `CREATE TABLE` installs atomically survive; the indexes, functions and triggers
    // that come after it do not.
    for (const s of [
      `DROP INDEX "ActivityDependency_projectId_successorId_predecessorId_key"`,
      `DROP INDEX "ActivityDependency_projectId_predecessorId_idx"`,
      `DROP INDEX "ActivityDependency_projectId_successorId_idx"`,
      `DROP TRIGGER "ActivityDependency_born_live" ON "ActivityDependency"`,
      `DROP TRIGGER "ActivityDependency_no_delete" ON "ActivityDependency"`,
      `DROP TRIGGER "ActivityDependency_no_truncate" ON "ActivityDependency"`,
      `DROP TRIGGER "ActivityDependency_frozen" ON "ActivityDependency"`,
      `DROP TRIGGER "ActivityDependency_acyclic" ON "ActivityDependency"`,
      `DROP FUNCTION activity_dependency_born_live(), activity_dependency_no_delete(),
                     activity_dependency_no_truncate(), activity_dependency_frozen(),
                     activity_dependency_acyclic()`,
    ]) await t.prisma.$executeRawUnsafe(s);
    // 4 CHECKs and 5 keys survive with the table; every index but the primary key, every trigger
    // and every function is gone.
    expect(await installed(), 'the partial-apply state').toBe('4/5/1/0/0');

    // RED: the shape this file used to carry — an unconditional refusal of any existing table —
    // dead-ends here. It is asserted rather than described, because a retry that can never succeed
    // is the whole defect: the only way forward was the destructive runbook DROP.
    const oldRefusal = `DO $$ BEGIN
      IF to_regclass('public."ActivityDependency"') IS NOT NULL THEN
        RAISE EXCEPTION 'schedule B1: table "ActivityDependency" already exists. This migration CREATES that table and does not adopt one.';
      END IF; END $$`;
    expect(await refusal(oldRefusal), 'the unconditional refusal cannot complete a partial apply')
      .toMatch(/already exists\. This migration CREATES that table and does not adopt one/u);

    // GREEN: the file as it stands finishes the job, over the same database, in one run.
    expect(applyMigration(), 'the migration must complete its own partial apply').toBeNull();
    expect(await installed(), 'every object installed').toBe(COMPLETE);

    // And a catalog full of objects is not a table full of rules. Each seal is exercised.
    const [a, b] = [await activity(), await activity()];
    expect(await refusal(edge(a, a))).toMatch(/cannot depend on itself/u);
    await t.prisma.$executeRawUnsafe(edge(a, b));
    expect(await refusal(edge(b, a))).toMatch(/dependency cycle/u);        // acyclic
    expect(await refusal(edge(a, b))).toMatch(/already exists|unique/u);   // partial unique index
    const id = await onlyId();
    expect(await refusal(`DELETE FROM "ActivityDependency" WHERE "id"='${id}'`))
      .toMatch(/not deletable/u);                                          // no_delete
    expect(await refusal(`TRUNCATE TABLE "ActivityDependency"`)).toMatch(/never truncated/u);
    expect(await refusal(`UPDATE "ActivityDependency" SET "lagWorkingDays"=9 WHERE "id"='${id}'`))
      .toMatch(/is frozen/u);                                              // frozen
    // A FRESH pair for the born-live probe: triggers fire in name order, so `..._acyclic` runs
    // before `..._born_live` and a reversed pair would be refused as a cycle before born-live is
    // ever consulted — which would leave that seal untested while the assertion still passed.
    const [c, d] = [await activity(), await activity()];
    expect(await refusal(
      `INSERT INTO "ActivityDependency"("id","projectId","predecessorId","successorId","createdById","createdByName","revokedAt","revokedById","revokedByName")
       VALUES ('dep-b1-born-${run}','${f.projectA.id}','${c}','${d}','${f.memberUser.id}','PMC',now(),'${f.memberUser.id}','PMC')`))
      .toMatch(/cannot be created already revoked/u);                      // born_live

    // AND THE SAME THING FOR THE CALLER THE FINDING IS ACTUALLY ABOUT: psql with no
    // `--single-transaction`, which commits every statement on its own. That caller is the one
    // that can leave a partial apply behind at all, and it also cannot execute a bare
    // `LOCK TABLE` — `LOCK TABLE can only be used in transaction blocks` — so a top-level lock
    // statement would dead-end this file one statement past `CREATE TABLE`, on every retry
    // forever. Every lock this file takes is inside a `DO` block for that reason.
    await wipe();
    for (const s of [
      `DROP TRIGGER "ActivityDependency_acyclic" ON "ActivityDependency"`,
      `DROP FUNCTION activity_dependency_acyclic()`,
      `DROP INDEX "ActivityDependency_projectId_successorId_idx"`,
    ]) await t.prisma.$executeRawUnsafe(s);
    expect(applyMigration({ autocommit: true }),
           'an autocommit caller must be able to finish the install').toBeNull();
    expect(await installed(), 'and must finish it completely').toBe(COMPLETE);
    const [e, g] = [await activity(), await activity()];
    await t.prisma.$executeRawUnsafe(edge(e, g));
    expect(await refusal(edge(g, e)), 'with the seals really armed').toMatch(/dependency cycle/u);

    // Finally: a SECOND complete run over the finished install is still a no-op, under either
    // caller — so the resume path does not trade retry-safety for idempotence.
    await wipe();
    const objects = await objectIdentity();
    expect(applyMigration(), 'and re-running once complete changes nothing').toBeNull();
    expect(applyMigration({ autocommit: true }), 'under autocommit too').toBeNull();
    expect(await objectIdentity()).toBe(objects);
  }, 120_000);

  // ── P24 ────────────────────────────────────────────────────────────────────────────────────
  it('P24 a POPULATED complete install replays as a no-op — the state a real re-deploy meets', async () => {
    // THE FINDING (review round 1 of #410, migration.sql:171), reproduced. P15 proved a complete
    // install replays; it did so over an EMPTY table. The state a direct repair, a re-deploy, or
    // `migrate resolve --rolled-back` followed by `migrate deploy` actually meets is a complete
    // install THAT HAS BEEN IN SERVICE — and the earlier head's unconditional row check aborted on
    // the first row it saw, before comparing a single object. One accepted edge made the migration
    // permanently non-rerunnable, with the destructive runbook DROP as the only way forward.
    //
    // MEASURED against that head, on this container: replay over one legal edge exited 3 with
    // `schedule B1: "ActivityDependency" already exists and holds 1 row(s)`.
    const [a, b] = [await activity(), await activity()];
    await t.prisma.$executeRawUnsafe(edge(a, b));
    expect(await installed(), 'a complete install').toBe(COMPLETE);
    expect(await edgeCount(), 'holding a real edge').toBe(1);
    const before = await objectIdentity();

    // The refusal the earlier head carried, executed against this exact state, so the defect is
    // asserted rather than described.
    expect(await refusal(`DO $$ BEGIN
      IF (SELECT COUNT(*) FROM "ActivityDependency") > 0 THEN
        RAISE EXCEPTION 'schedule B1: "ActivityDependency" already exists and holds % row(s).',
          (SELECT COUNT(*) FROM "ActivityDependency");
      END IF; END $$`), 'the unconditional row check cannot replay a populated install')
      .toMatch(/already exists and holds 1 row\(s\)/u);

    // GREEN, under BOTH callers: complete plus populated is a no-op. Not merely "it exited 0" —
    // no object is recreated and no row is touched.
    expect(applyMigration(), 'a replay over a populated COMPLETE install must succeed').toBeNull();
    expect(applyMigration({ autocommit: true }), 'under autocommit too').toBeNull();
    expect(await objectIdentity(), 'and must not recreate a single object').toBe(before);
    expect(await edgeCount(), 'nor touch a single row').toBe(1);

    // The install barrier is not reintroduced over a table already in service — a replay that left
    // it behind would make a live table unwritable, which is the opposite of retry-safe.
    const barrier = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT COUNT(*) AS n FROM pg_constraint
        WHERE conname = 'ActivityDependency_install_incomplete_check'
          AND conrelid = '"ActivityDependency"'::regclass`);
    expect(Number(barrier[0]!.n), 'no install barrier survives a replay').toBe(0);

    // And the table is still a working dependency graph afterwards.
    expect(await refusal(edge(b, a))).toMatch(/dependency cycle/u);
    const c = await activity();
    await t.prisma.$executeRawUnsafe(edge(b, c));
    expect(await edgeCount(), 'a legal edge still commits after the replay').toBe(2);
  }, 120_000);

  // ── P25 ────────────────────────────────────────────────────────────────────────────────────
  it('P25 a same-named decoy on the CALLER path cannot capture a seal', async () => {
    // THE FINDING (migration.sql:894), reproduced. `SET LOCAL search_path` at the top of the file
    // is only a WARNING outside a transaction block, so for the autocommit caller the file
    // explicitly supports it does nothing — and an unqualified `EXECUTE FUNCTION` in a
    // `CREATE TRIGGER` resolves through the CALLER's path. A role whose path names another schema
    // before `public`, holding a same-named no-op, gets the decoy: the file verifies and creates
    // the canonical function in `public`, binds the trigger to something else, and exits 0 with
    // the seal inert.
    //
    // MEASURED against the earlier head, on this container, with `search_path=b1decoy,public`:
    // exit 0, and `ActivityDependency_born_live -> b1decoy.activity_dependency_born_live()`.
    const bound = async (): Promise<string> => (await t.prisma.$queryRawUnsafe<Array<{ s: string }>>(`
      SELECT string_agg(g.tgname || '=' || (
               SELECT n.nspname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE p.oid = g.tgfoid), ',' ORDER BY g.tgname) AS s
        FROM pg_trigger g
       WHERE g.tgrelid = '"ActivityDependency"'::regclass AND NOT g.tgisinternal`))[0]!.s;

    await t.prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "b1_decoy_schema"`);
    try {
      // The decoys: same names, same signature, and each one a no-op that enforces nothing.
      for (const fn of ['born_live', 'no_delete', 'no_truncate', 'frozen', 'acyclic']) {
        await t.prisma.$executeRawUnsafe(
          `CREATE OR REPLACE FUNCTION "b1_decoy_schema".activity_dependency_${fn}()
             RETURNS TRIGGER LANGUAGE plpgsql AS $decoy$ BEGIN RETURN NEW; END $decoy$`);
      }
      // Remove the armed seals so the file has to create them again, under the hostile path.
      for (const tg of ['born_live', 'no_delete', 'no_truncate', 'frozen', 'acyclic']) {
        await t.prisma.$executeRawUnsafe(
          `DROP TRIGGER "ActivityDependency_${tg}" ON "ActivityDependency"`);
      }

      expect(applyMigration({ autocommit: true, searchPath: 'b1_decoy_schema,public' }),
             'the file must apply under a hostile caller path').toBeNull();
      expect(await bound(), 'every seal must be bound to the function in public').toBe(
        ['ActivityDependency_acyclic=public', 'ActivityDependency_born_live=public',
         'ActivityDependency_frozen=public', 'ActivityDependency_no_delete=public',
         'ActivityDependency_no_truncate=public'].join(','));

      // A catalog entry is not a rule. The seal the finding names is EXERCISED: under the decoy
      // binding this insert commits, because the decoy returns NEW and judges nothing.
      const [c, d] = [await activity(), await activity()];
      expect(await refusal(
        `INSERT INTO "ActivityDependency"("id","projectId","predecessorId","successorId","createdById","createdByName","revokedAt","revokedById","revokedByName")
         VALUES ('dep-b1-decoy-${run}','${f.projectA.id}','${c}','${d}','${f.memberUser.id}','PMC',now(),'${f.memberUser.id}','PMC')`),
        'the born-live seal must actually fire').toMatch(/cannot be created already revoked/u);
    } finally {
      await t.prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "b1_decoy_schema" CASCADE`);
    }
    expect(await installed(), 'and the install is complete').toBe(COMPLETE);
  }, 120_000);

  // ── P26 ────────────────────────────────────────────────────────────────────────────────────
  it('P26 an unfinished install is UNWRITABLE, so no row can slip in before the seals', async () => {
    // THE FINDING (migration.sql:428), reproduced as the exact interleaving it names:
    //
    //     T1  runs this file, gets past CREATE TABLE, commits (autocommit — no wrapping transaction)
    //     T2  INSERTs an already-revoked edge while `ActivityDependency_born_live` does not exist
    //     T1  creates the triggers and reports success
    //
    // Creating a trigger validates nothing already in the table, so the fabricated withdrawal —
    // a record of a constraint that never stood — survives, and every other seal then protects it.
    //
    // MEASURED against the earlier head, on this container, driving exactly that sequence: T1
    // exit 0, five seals armed, the fabricated row present, and `DELETE` refused by the no-delete
    // seal — permanent, immutable, invented evidence.
    //
    // A LOCK CANNOT FIX THIS and no rewriting of the file can: a lock is released at COMMIT, and
    // on the autocommit path COMMIT happens after every statement. The exclusion is therefore
    // written into the TABLE — an unsatisfiable CHECK installed atomically with it and dropped
    // only by section 9, after every seal is proven armed and bound to `public`.
    const head = join(__dirname, '..', '..', '..', '..',
                      'node_modules', '.cache', 'b1-head.sql');
    const sql = readFileSync(migrationPath, 'utf8');
    const cut = sql.indexOf('-- ── 4. An edge is BORN LIVE');
    expect(cut, 'the file must still have a section 4 to cut at').toBeGreaterThan(0);
    mkdirSync(dirname(head), { recursive: true });
    writeFileSync(head, sql.slice(0, cut), 'utf8');

    // Start over, so the table is created by THIS run and carries the barrier its creation
    // installs. `DROP TABLE` fires no table trigger — that gap is documented in section 5.
    await t.prisma.$executeRawUnsafe(`DROP TABLE "ActivityDependency"`);
    try {
      expect(applyMigration({ autocommit: true, file: head }),
             'T1 must get through CREATE TABLE and the indexes').toBeNull();
      const mid = await t.prisma.$queryRawUnsafe<Array<{ s: string }>>(`
        SELECT (SELECT COUNT(*) FROM pg_trigger WHERE tgrelid = '"ActivityDependency"'::regclass
                  AND NOT tgisinternal)
            || '/' || (SELECT COUNT(*) FROM pg_constraint
                        WHERE conrelid = '"ActivityDependency"'::regclass
                          AND conname = 'ActivityDependency_install_incomplete_check') AS s`);
      expect(mid[0]!.s, 'and stop with no seal armed and the barrier standing').toBe('0/1');

      // T2, arriving in the window the finding names. Both writes are refused: the fabricated
      // withdrawal AND an ordinary legal edge, because an unfinished install is not open for
      // business at all — there is no rule yet that could judge either one.
      const [a, b] = [await activity(), await activity()];
      expect(await refusal(
        `INSERT INTO "ActivityDependency"("id","projectId","predecessorId","successorId","createdById","createdByName","revokedAt","revokedById","revokedByName")
         VALUES ('dep-b1-fab-${run}','${f.projectA.id}','${a}','${b}','${f.memberUser.id}','PMC',now(),'${f.memberUser.id}','PMC')`),
        'the fabricated withdrawal must be refused while the seals are absent')
        .toMatch(/ActivityDependency_install_incomplete_check/u);
      expect(await refusal(edge(a, b)), 'and so must a legal edge')
        .toMatch(/ActivityDependency_install_incomplete_check/u);
      expect(await edgeCount(), 'nothing reached the half-built table').toBe(0);

      // T1 resumes and finishes. The barrier is lifted only here, and only on proof.
      expect(applyMigration({ autocommit: true }), 'T1 must be able to finish').toBeNull();
      expect(await installed(), 'with every seal armed').toBe(COMPLETE);
      const after = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT COUNT(*) AS n FROM pg_constraint
          WHERE conname = 'ActivityDependency_install_incomplete_check'
            AND conrelid = '"ActivityDependency"'::regclass`);
      expect(Number(after[0]!.n), 'and the barrier lifted').toBe(0);
      expect(await edgeCount(), 'and no fabricated evidence anywhere').toBe(0);

      // Now the table works, and the seal that would have been bypassed really binds.
      await t.prisma.$executeRawUnsafe(edge(a, b));
      expect(await refusal(edge(b, a))).toMatch(/dependency cycle/u);
      const [c, d] = [await activity(), await activity()];
      expect(await refusal(
        `INSERT INTO "ActivityDependency"("id","projectId","predecessorId","successorId","createdById","createdByName","revokedAt","revokedById","revokedByName")
         VALUES ('dep-b1-fab2-${run}','${f.projectA.id}','${c}','${d}','${f.memberUser.id}','PMC',now(),'${f.memberUser.id}','PMC')`))
        .toMatch(/cannot be created already revoked/u);
    } finally {
      rmSync(head, { force: true });
    }
  }, 120_000);

  // ── P27 ────────────────────────────────────────────────────────────────────────────────────
  it('P27 the barrier is not a formality: a missing seal keeps the table shut', async () => {
    // Section 9 lifts the barrier only after proving all ten constraints, three indexes, five
    // functions and five ARMED triggers — the last asked against `tgfoid`, so a trigger bound to
    // a same-named decoy fails it however it renders. If anything is missing the barrier STAYS,
    // and a half-sealed table is unwritable rather than quietly open.
    const section9 = readFileSync(migrationPath, 'utf8');
    expect(section9, 'section 9 must exist and be the last thing the file does')
      .toMatch(/── 9\. Finish the install: prove every seal, then LIFT THE INSTALL BARRIER/u);
    expect(section9, 'and must check the bound function itself, not a rendered name')
      .toMatch(/g\.tgfoid = to_regprocedure\('public\.' \|\| t\.fn \|\| '\(\)'\)/u);

    // Executed rather than read: strip one seal, put the barrier back by hand exactly as section 2
    // installs it, and run the file. Section 8 refuses first (the seal is missing, so it is
    // recreated) — so the case section 9 is for is the one where a seal cannot be created at all.
    // That is simulated by holding the barrier while the file is asked to finish an install whose
    // function has been renamed out from under it.
    await t.prisma.$executeRawUnsafe(
      `ALTER TABLE "ActivityDependency" ADD CONSTRAINT "ActivityDependency_install_incomplete_check" CHECK ("id" !~ '^')`);
    await t.prisma.$executeRawUnsafe(
      `ALTER TABLE "ActivityDependency" DISABLE TRIGGER "ActivityDependency_acyclic"`);
    try {
      const err = applyMigration();
      expect(err, 'a disabled seal must abort').not.toBeNull();
      expect(err, 'naming the seal').toMatch(/ActivityDependency_acyclic/u);
      // The barrier is still there, so the table is still shut. That is the whole point: a
      // refusal that left it writable would leave a half-sealed graph open for business.
      const [a, b] = [await activity(), await activity()];
      expect(await refusal(edge(a, b)), 'and the table stays unwritable')
        .toMatch(/ActivityDependency_install_incomplete_check/u);
    } finally {
      await t.prisma.$executeRawUnsafe(
        `ALTER TABLE "ActivityDependency" ENABLE TRIGGER "ActivityDependency_acyclic"`);
      await t.prisma.$executeRawUnsafe(
        `ALTER TABLE "ActivityDependency" DROP CONSTRAINT IF EXISTS "ActivityDependency_install_incomplete_check"`);
    }
    expect(applyMigration(), 'and the file applies once the seal is armed again').toBeNull();
    expect(await installed()).toBe(COMPLETE);
  }, 120_000);

  /** Every foreign key, as `name->target relation`, read from `confrelid` rather than from text. */
  const bindings = async (): Promise<string> => (await t.prisma.$queryRawUnsafe<Array<{ s: string }>>(`
    SELECT string_agg(k.conname || '->' || n.nspname || '."' || c.relname || '"', ',' ORDER BY k.conname) AS s
      FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.confrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE k.conrelid = 'public."ActivityDependency"'::regclass AND k.contype = 'f'`))[0]!.s;

  // ── P28 ────────────────────────────────────────────────────────────────────────────────────
  it('P28 a same-named decoy TABLE on the caller path cannot capture containment', async () => {
    // THE FINDING (round 1 of #411, migration.sql:496). The seals were qualified; the FOREIGN-KEY
    // TARGETS were not. A key resolves its target through the CALLER's path at CREATE time, and
    // `SET LOCAL search_path` is only a warning outside a transaction block — so under the
    // autocommit caller a role whose path names another schema first binds all five containment
    // keys to same-named decoys there. Containment then proves NOTHING: an edge may name any
    // project, any activity, any user, and PostgreSQL accepts it.
    //
    // MEASURED against `f87e5a7`, on this container, with `search_path=b1decoy,public`: exit 0 and
    // all five keys bound to `b1decoy."Project"` / `"Activity"` / `"Membership"` — and a REPLAY
    // accepted them, because `pg_get_constraintdef` renders the target relative to the reader's
    // path too, so the decoy printed exactly like the canonical text.
    await t.prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "b1_decoy_schema"`);
    try {
      for (const ddl of [
        `CREATE TABLE "b1_decoy_schema"."Project"("id" TEXT PRIMARY KEY)`,
        `CREATE TABLE "b1_decoy_schema"."Activity"("projectId" TEXT, "id" TEXT, PRIMARY KEY ("projectId","id"))`,
        `CREATE TABLE "b1_decoy_schema"."Membership"("projectId" TEXT, "userId" TEXT, PRIMARY KEY ("projectId","userId"))`,
      ]) await t.prisma.$executeRawUnsafe(ddl);

      // Start over so the keys are created by THIS run, under the hostile path.
      await t.prisma.$executeRawUnsafe(`DROP TABLE "ActivityDependency"`);
      expect(applyMigration({ autocommit: true, searchPath: 'b1_decoy_schema,public' }),
             'the file must apply under a hostile caller path').toBeNull();
      expect(await bindings(), 'every containment key must bind to the relation in public').toBe(
        ['ActivityDependency_createdBy_fkey->public."Membership"',
         'ActivityDependency_projectId_fkey->public."Project"',
         'ActivityDependency_projectId_predecessorId_fkey->public."Activity"',
         'ActivityDependency_projectId_successorId_fkey->public."Activity"',
         'ActivityDependency_revokedBy_fkey->public."Membership"'].join(','));

      // And the comparison is no longer rendered through the caller's path either: a key REALLY
      // bound to the decoy is refused, and the abort NAMES the schema it disagrees about.
      await t.prisma.$executeRawUnsafe(
        `ALTER TABLE "ActivityDependency" DROP CONSTRAINT "ActivityDependency_projectId_fkey"`);
      await t.prisma.$executeRawUnsafe(
        `ALTER TABLE "ActivityDependency" ADD CONSTRAINT "ActivityDependency_projectId_fkey"
           FOREIGN KEY ("projectId") REFERENCES "b1_decoy_schema"."Project"("id")
           ON DELETE RESTRICT ON UPDATE CASCADE`);
      const err = applyMigration({ autocommit: true, searchPath: 'b1_decoy_schema,public' });
      expect(err, 'a key bound to a decoy must abort the migration').not.toBeNull();
      expect(err, 'and must name the decoy schema it found')
        .toMatch(/ActivityDependency_projectId_fkey" is present as FOREIGN KEY .*b1_decoy_schema/su);
      await t.prisma.$executeRawUnsafe(
        `ALTER TABLE "ActivityDependency" DROP CONSTRAINT "ActivityDependency_projectId_fkey"`);
      await t.prisma.$executeRawUnsafe(
        `ALTER TABLE "ActivityDependency" ADD CONSTRAINT "ActivityDependency_projectId_fkey"
           FOREIGN KEY ("projectId") REFERENCES public."Project"("id")
           ON DELETE RESTRICT ON UPDATE CASCADE`);
    } finally {
      await t.prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "b1_decoy_schema" CASCADE`);
    }
    expect(applyMigration(), 'and applies once the real target is restored').toBeNull();
    expect(await installed()).toBe(COMPLETE);

    // Containment really binds again, which the catalog alone does not prove.
    const a = await activity();
    const foreign = await activity(f.projectB.id);
    expect(await refusal(edge(a, foreign))).toMatch(/violates foreign key|foreign key constraint/u);
  }, 120_000);

  // ── P29 ────────────────────────────────────────────────────────────────────────────────────
  it('P29 VOLATILITY is part of a seal function\'s identity, not an assumption about it', async () => {
    // THE FINDING (migration.sql:961). The identity check compared body, language, return type and
    // `search_path` — not `provolatile`. PostgreSQL hands a STABLE or IMMUTABLE function the
    // CALLING STATEMENT's snapshot, so a same-bodied `..._acyclic` declared STABLE reads the graph
    // as it stood BEFORE it began waiting on the project advisory lock: T2 starts the opposite
    // edge, blocks on T1's lock, and when it finally runs the recursive walk it cannot see the
    // edge T1 just committed. The cycle commits. `ALTER FUNCTION ... STABLE` changes nothing else,
    // so the forgery is byte-identical in `prosrc`.
    //
    // MEASURED against `f87e5a7`: `ALTER FUNCTION ... STABLE` then replay — exit 0, and the
    // function was still STABLE afterwards. The migration had certified it.
    const volatility = async (): Promise<string> => (await t.prisma.$queryRawUnsafe<Array<{ s: string }>>(`
      SELECT string_agg(p.proname || '=' || p.provolatile::text, ',' ORDER BY p.proname) AS s
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname LIKE 'activity\\_dependency%'`))[0]!.s;

    expect(await volatility(), 'the installed seals are VOLATILE').toBe(
      ['activity_dependency_acyclic=v', 'activity_dependency_born_live=v',
       'activity_dependency_frozen=v', 'activity_dependency_no_delete=v',
       'activity_dependency_no_truncate=v'].join(','));

    for (const fn of ['acyclic', 'born_live']) {
      await t.prisma.$executeRawUnsafe(`ALTER FUNCTION activity_dependency_${fn}() STABLE`);
      try {
        const err = applyMigration();
        expect(err, `a STABLE ${fn} must abort the migration`).not.toBeNull();
        expect(err, 'naming the function').toMatch(
          new RegExp(`function public\\.activity_dependency_${fn}\\(\\) already exists with a definition this migration did not install`, 'u'));
        expect(err, 'and must point at the operator procedure').toMatch(/docs\/RUNBOOK\.md section B1/u);
      } finally {
        await t.prisma.$executeRawUnsafe(`ALTER FUNCTION activity_dependency_${fn}() VOLATILE`);
      }
      expect(applyMigration(), `and applies once ${fn} is VOLATILE again`).toBeNull();
    }
    expect(await installed()).toBe(COMPLETE);
  }, 120_000);

  // ── P30 ────────────────────────────────────────────────────────────────────────────────────
  it('P30 an UNLOGGED table is refused, however canonical its shape', async () => {
    // THE FINDING (migration.sql:151). The resume path never asked `relpersistence`, and an
    // UNLOGGED table carries the same columns, constraints, indexes, functions and triggers as a
    // permanent one — so every shape comparison passes. What differs is the only property this
    // table exists for: PostgreSQL TRUNCATES an unlogged relation after a crash or unclean
    // shutdown. The migration would arm five seals over an append-only record of who imposed and
    // who withdrew each constraint, and that record would silently empty itself.
    //
    // MEASURED against `f87e5a7`: the file's own CREATE TABLE, applied as UNLOGGED, then the
    // migration — exit 0, five seals armed, `relpersistence` still `u`.
    const sql = readFileSync(migrationPath, 'utf8');
    const start = sql.indexOf('CREATE TABLE IF NOT EXISTS public."ActivityDependency" (');
    const end = sql.indexOf('\n);', start);
    expect(start, 'the CREATE TABLE block must still be findable').toBeGreaterThan(0);
    const unlogged = sql.slice(start, end + 3)
      .replace('CREATE TABLE IF NOT EXISTS', 'CREATE UNLOGGED TABLE');

    await t.prisma.$executeRawUnsafe(`DROP TABLE "ActivityDependency"`);
    await t.prisma.$executeRawUnsafe(unlogged);
    const persistence = async (): Promise<string> => (await t.prisma.$queryRawUnsafe<Array<{ s: string }>>(
      `SELECT relkind::text || '/' || relpersistence::text AS s
         FROM pg_class WHERE oid = '"ActivityDependency"'::regclass`))[0]!.s;
    expect(await persistence(), 'the fixture is an unlogged ordinary table').toBe('r/u');

    const err = applyMigration();
    expect(err, 'an unlogged register must abort the migration').not.toBeNull();
    expect(err, 'naming what it found and what it required')
      .toMatch(/is not an ordinary permanent table \(pg_class relkind\/relpersistence = r\/u, expected r\/p\)/u);
    expect(err, 'and saying why it matters').toMatch(/truncates an UNLOGGED relation/u);
    expect(err, 'and must point at the operator procedure').toMatch(/docs\/RUNBOOK\.md section B1/u);

    // NOTHING was installed over it — the refusal is not merely a message.
    const armed = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT COUNT(*) AS n FROM pg_trigger
        WHERE tgrelid = '"ActivityDependency"'::regclass AND NOT tgisinternal`);
    expect(Number(armed[0]!.n), 'no seal may be armed over an unlogged register').toBe(0);

    // And the repair the abort names lets the SAME file deploy — a guard, not a dead end.
    await t.prisma.$executeRawUnsafe(`ALTER TABLE "ActivityDependency" SET LOGGED`);
    expect(await persistence(), 'converted to permanent').toBe('r/p');
    expect(applyMigration(), 'and the same file then completes the install').toBeNull();
    expect(await installed()).toBe(COMPLETE);
    const [a, b] = [await activity(), await activity()];
    await t.prisma.$executeRawUnsafe(edge(a, b));
    expect(await refusal(edge(b, a)), 'with the seals really armed').toMatch(/dependency cycle/u);
  }, 120_000);
});
