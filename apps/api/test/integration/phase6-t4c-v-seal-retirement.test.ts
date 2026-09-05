import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { splitSqlForReplay } from './phase6-t4c-migration-replay';
import { TRUNCATE_SEALS } from '../../prisma/sanctioned-reset';
import { CONSULTATION_CAPABILITY } from '../../src/platform/capabilities.service';

/**
 * Phase 6 unit 4c-v — the SEAL RETIREMENT (docs/superpowers/plans/2026-08-29-decision-workflow-4c.md
 * §D, review rounds 25–26), the last gate of 4c.
 *
 * 4c-iii installed a PRESERVATION seal over the per-project `consultation` capability row (row
 * DELETE, row UPDATE of the sealed key and attribution, statement TRUNCATE), a `Project` creation
 * trigger that manufactured the row for every project, and the transaction-local delete flag the
 * seal read to permit a cascade. The seal existed for ONE window: while any serving instance still
 * READ the row, its absence split the fleet. 4c-iv removed every read; the rollout of 4c-iv was
 * attested complete (`phase-6-4c-iv-rollout-complete`, #482 comment 5548460858). Nothing reads the
 * row now, so the latch retires: 4c-v drops the seal, the flag helper, the creation trigger and the
 * rows themselves, in one migration.
 *
 * THE PROBE IS THE MIRROR OF 4c-iii's, as the plan states it: the alternate-writer DELETE, the key
 * UPDATE and the TRUNCATE, each REFUSED between 4c-iii and 4c-v and each PERMITTED after. The
 * "before" half is proven on a scratch database migrated with the SHIPPED 4c-iii file, because the
 * shared database is already past the retirement; the "after" half is proven on both.
 */

const ENABLEMENT_PATH = join(
  __dirname, '../../prisma/migrations/20271120000000_phase6_t4c_iii_enablement/migration.sql');
const RETIREMENT_PATH = join(
  __dirname, '../../prisma/migrations/20271130000000_phase6_t4c_v_seal_retirement/migration.sql');

/** Everything 4c-iii installed and 4c-v retires — NAMED, so a renamed survivor fails here too. */
const RETIRED_TRIGGERS = [
  'ProjectCapability_t4c_preserved',
  'ProjectCapability_t4c_no_truncate',
  'Project_t4c_deleting',
  'Project_t4c_consultation_enabled',
] as const;
const RETIRED_FUNCTIONS = [
  'phase6_t4c_capability_preserved',
  'phase6_t4c_capability_no_truncate',
  'phase6_t4c_project_deleting',
  'phase6_t4c_project_consultation_row',
] as const;

/** The one raw TRUNCATE in this file, pinned in `sanctioned-reset-coverage.test.ts`. It is a PROBE
 *  in both directions — refused by the seal before 4c-v, permitted after — and must not go through
 *  the helper, which would disable the very seal whose absence is being measured. */
const TRUNCATE_CAPABILITIES = 'TRUNCATE "ProjectCapability"';

const baseUrl = (process.env.DATABASE_URL ?? '').split('?')[0].replace(/\/[^/]*$/, '');
const adminUrl = `${baseUrl}/postgres`;

type Raw = { $queryRawUnsafe: PrismaClient['$queryRawUnsafe']; $executeRawUnsafe: PrismaClient['$executeRawUnsafe'] };

const countTriggers = async (db: Raw, names: readonly string[]): Promise<number> => {
  const rows = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT count(*)::bigint AS n FROM pg_trigger WHERE NOT tgisinternal AND tgname = ANY($1::text[])`, names);
  return Number(rows[0]?.n ?? -1);
};
const countFunctions = async (db: Raw, names: readonly string[]): Promise<number> => {
  const rows = await db.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT count(*)::bigint AS n FROM pg_proc WHERE proname = ANY($1::text[])`, names);
  return Number(rows[0]?.n ?? -1);
};
const consultationRows = async (db: Raw, projectId?: string): Promise<number> => {
  const rows = projectId === undefined
    ? await db.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM "ProjectCapability" WHERE "capability" = 'consultation'`)
    : await db.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM "ProjectCapability" WHERE "capability" = 'consultation' AND "projectId" = $1`,
      projectId);
  return Number(rows[0]?.n ?? -1);
};

describe('Phase 6 unit 4c-v — the seal retirement (live PG)', () => {
  let t: TestApp;
  const run = randomUUID().slice(0, 8);
  const id = (label: string) => `t4cv-${label}-${run}`;
  const orgId = id('org');

  const projectData = (pid: string) => ({
    id: pid, orgId, name: pid, short: 'T4CV', descriptor: '', stage: 'Planning',
    siteCode: pid.slice(-8), projStart: '01 Jan 2026', projEnd: '31 Dec 2026',
    elapsedPct: 0, todayDay: 0, milestonePct: 0,
  });
  const makeProject = async (label: string): Promise<string> => {
    const pid = id(label);
    await t.prisma.project.create({ data: projectData(pid) });
    return pid;
  };
  const capRow = (projectId: string, capability = CONSULTATION_CAPABILITY) =>
    t.prisma.projectCapability.findUnique({ where: { projectId_capability: { projectId, capability } } });
  /** The generic writer, unchanged by this unit: `capability` stays free text, so `consultation`
   *  still inserts — as inert data nothing reads. Every "permitted" probe below plants its row
   *  this way first, because after 4c-v no project carries one by default. */
  const plant = (projectId: string) =>
    t.prisma.projectCapability.create({ data: { projectId, capability: CONSULTATION_CAPABILITY, enabledById: 'op' } });

  beforeAll(async () => {
    t = await createTestApp();
    await t.prisma.org.create({ data: { id: orgId, name: `T4CV ${run}`, slug: orgId } });
  });

  afterAll(async () => {
    // no seal, no bypass: the capability rows go with the project through the cascade FK 4c-iii
    // installed (and 4c-v keeps — the FK is modelled in schema.prisma and is not the latch)
    await t?.prisma.project.deleteMany({ where: { orgId } });
    await t?.prisma.org.deleteMany({ where: { id: orgId } });
    await t?.close();
  });

  // ═══ THE RETIREMENT, on the shared database ═════════════════════════════════════════════════

  it('the seal, its delete-flag helper and the creation trigger are GONE by name — and the reservation stays gone', async () => {
    expect(await countTriggers(t.prisma, RETIRED_TRIGGERS), 'no 4c-iii trigger survives').toBe(0);
    expect(await countFunctions(t.prisma, RETIRED_FUNCTIONS), 'no 4c-iii trigger function survives').toBe(0);
    // 4c-iii dropped the 4c-i/4c-ii RESERVATION; retiring the seal does not resurrect it
    expect(await countTriggers(t.prisma, ['ProjectCapability_t4c_reserved']), 'the reservation is still gone').toBe(0);
  });

  it('a project created after the retirement carries NO consultation row — the latch no longer manufactures one', async () => {
    // RED at the base: 4c-iii's `AFTER INSERT` trigger produced the row for every project.
    const pid = await makeProject('fresh');
    expect(await capRow(pid), 'nothing creates the row any more').toBeNull();
  });

  it('ARM 1 mirror — a direct DELETE of a consultation row is PERMITTED', async () => {
    // RED at the base: "may not be DELETED directly".
    const pid = await makeProject('del');
    await plant(pid);
    await expect(
      t.prisma.projectCapability.delete({
        where: { projectId_capability: { projectId: pid, capability: CONSULTATION_CAPABILITY } },
      }),
    ).resolves.toBeTruthy();
    expect(await capRow(pid), 'the row is gone').toBeNull();
  });

  it('ARM 2 mirror — re-keying, re-parenting and rewriting the attribution are PERMITTED: the row is ordinary free-text data again', async () => {
    // RED at the base on the first statement: "may not be RE-KEYED". Each of 4c-iii's three UPDATE
    // arms is exercised in turn on one row, tracked through its changing key.
    const a = await makeProject('upd-a');
    const b = await makeProject('upd-b');
    await plant(a);
    await expect(t.prisma.$executeRawUnsafe(
      `UPDATE "ProjectCapability" SET "enabledById" = 'someone-else', "enabledAt" = now() - interval '1 day'
        WHERE "projectId" = $1 AND "capability" = 'consultation'`, a,
    ), 'attribution rewrite').resolves.toBe(1);
    await expect(t.prisma.$executeRawUnsafe(
      `UPDATE "ProjectCapability" SET "projectId" = $2 WHERE "projectId" = $1 AND "capability" = 'consultation'`, a, b,
    ), 're-parent').resolves.toBe(1);
    await expect(t.prisma.$executeRawUnsafe(
      `UPDATE "ProjectCapability" SET "capability" = 'materials' WHERE "projectId" = $1 AND "capability" = 'consultation'`, b,
    ), 're-key').resolves.toBe(1);
    expect(await capRow(a)).toBeNull();
    expect(await capRow(b)).toBeNull();
    expect((await capRow(b, 'materials'))?.enabledById).toBe('someone-else');
  });

  it('the generic writer is UNCHANGED — `consultation` still upserts as inert free text, and the Board pin on the column stands', async () => {
    // No vocabulary whitelist was ever added and none is added by the retirement: an operator who
    // types `consultation` into `capability:enable` gets a row nothing reads. That is the
    // "rollout latch, not a permanent pilot" outcome §D describes, not an error.
    const pid = await makeProject('writer');
    await expect(
      t.prisma.projectCapability.upsert({
        where: { projectId_capability: { projectId: pid, capability: CONSULTATION_CAPABILITY } },
        create: { projectId: pid, capability: CONSULTATION_CAPABILITY, enabledById: 'op' },
        update: {},
      }),
    ).resolves.toBeTruthy();
    for (const capability of ['labour', 'anything-an-operator-types']) {
      await expect(
        t.prisma.projectCapability.create({ data: { projectId: pid, capability, enabledById: 'op' } }),
      ).resolves.toBeTruthy();
    }
  });

  it('the sanctioned reset needs no bypass for ProjectCapability any more — TRUNCATE_SEALS drops the entry, and the seal it named does not exist', async () => {
    // RED at the base: the registry carried `ProjectCapability_t4c_no_truncate`. A registry entry
    // naming a dropped trigger would be harmless at runtime (the toggle is guarded on existence)
    // and wrong as a record; the coverage test's PROBE_FILES pin moves with it.
    expect(TRUNCATE_SEALS.some((s) => s.table === 'ProjectCapability'), 'no ProjectCapability seal is registered').toBe(false);
    expect(await countTriggers(t.prisma, ['ProjectCapability_t4c_no_truncate'])).toBe(0);
  });

  it('the P3005 baseline path EXECUTES 20271130 rather than resolving it as applied — and AFTER 20271120', async () => {
    // The same defect class that put 20271120 in ALWAYS_EXECUTE, from the other side. On the
    // baseline path the loop resolves every migration as applied unless its name is in that set,
    // and 20271120 is in it — so it EXECUTES on that path and installs the seal, the flag helper,
    // the creation trigger and the rows. If 20271130 were resolved as applied at the same time,
    // the ledger would record the retirement while the seal it retires had just been installed,
    // and nothing downstream would notice: the generic enforcement verifier keeps no expected-
    // object list. Left pending, the deploy runs it after 20271120 in ledger order.
    const sh = readFileSync(join(__dirname, '../../scripts/migrate.sh'), 'utf8');
    const m = sh.match(/ALWAYS_EXECUTE="([^"]+)"/);
    expect(m, 'migrate.sh must declare ALWAYS_EXECUTE').not.toBeNull();
    const entries = m![1].split('\n').map((s) => s.trim());
    expect(entries).toContain('20271130000000_phase6_t4c_v_seal_retirement');
    expect(entries.indexOf('20271130000000_phase6_t4c_v_seal_retirement'))
      .toBeGreaterThan(entries.indexOf('20271120000000_phase6_t4c_iii_enablement'));
  });

  it('leaving it pending is SAFE — the shipped file applied a second time errors on nothing and changes nothing', async () => {
    // ALWAYS_EXECUTE's own precondition, asserted rather than trusted: replay the REAL file against
    // the already-retired database. Every statement is `IF EXISTS` or a DELETE with nothing to
    // delete, and the closing check finds the state it requires.
    const sql = readFileSync(RETIREMENT_PATH, 'utf8');
    const pid = await makeProject('rerun');
    await t.prisma.projectCapability.create({ data: { projectId: pid, capability: 'materials', enabledById: 'op' } });
    await t.prisma.$transaction(async (tx) => {
      for (const stmt of splitSqlForReplay(sql)) await tx.$executeRawUnsafe(stmt);
    });
    expect(await capRow(pid, 'materials'), 'an unrelated capability row is untouched by the replay').not.toBeNull();
    expect(await countTriggers(t.prisma, RETIRED_TRIGGERS)).toBe(0);
  });

  // ═══ THE MIRROR — refused between 4c-iii and 4c-v, permitted after — on a scratch database ═══

  it('the mirror: DELETE, key-UPDATE and TRUNCATE are each REFUSED after the shipped 4c-iii file and each PERMITTED after the shipped 4c-v file, which also removes every row', async () => {
    // Both files are read from disk and replayed verbatim (transaction control supplied here), so
    // this proves the SHIPPED retirement against the SHIPPED seal, not a paraphrase of either.
    const scratch = `pmcvitan_t4cv_mirror_test_${run}`;
    const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } });
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}"`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratch}"`);
    const url = `${baseUrl}/${scratch}?schema=public`;
    const db = new PrismaClient({ datasources: { db: { url } } });
    try {
      // the two tables the migrations touch, in their delivered shape — the same reduction the
      // 4c-iii race probe uses
      await db.$executeRawUnsafe(`CREATE TABLE "Project" ("id" TEXT PRIMARY KEY, "orgId" TEXT NOT NULL)`);
      await db.$executeRawUnsafe(
        `CREATE TABLE "ProjectCapability" (
           "projectId" TEXT NOT NULL, "capability" TEXT NOT NULL,
           "enabledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "enabledById" TEXT NOT NULL,
           CONSTRAINT "ProjectCapability_pkey" PRIMARY KEY ("projectId","capability"))`);
      await db.$executeRawUnsafe(
        `ALTER TABLE "ProjectCapability" ADD CONSTRAINT "ProjectCapability_projectId_fkey"
           FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE`);
      await db.$executeRawUnsafe(`INSERT INTO "Project" VALUES ('pre','o1'), ('other','o1')`);

      const replay = async (path: string) => {
        const sql = readFileSync(path, 'utf8');
        await db.$transaction(async (tx) => {
          for (const stmt of splitSqlForReplay(sql)) await tx.$executeRawUnsafe(stmt);
        }, { timeout: 30_000, maxWait: 30_000 });
      };

      // ── BEFORE: the shipped 4c-iii, and the three arms it seals ──────────────────────────────
      await replay(ENABLEMENT_PATH);
      expect(await consultationRows(db, 'pre'), 'the backfill covered the pre-existing project').toBe(1);
      await db.$executeRawUnsafe(`INSERT INTO "Project" VALUES ('during','o1')`);
      expect(await consultationRows(db, 'during'), 'the creation trigger covered the new one').toBe(1);
      expect(await countTriggers(db, RETIRED_TRIGGERS), 'all four 4c-iii triggers are armed').toBe(4);
      expect(await countFunctions(db, RETIRED_FUNCTIONS)).toBe(4);
      await expect(db.$executeRawUnsafe(
        `DELETE FROM "ProjectCapability" WHERE "projectId" = 'pre' AND "capability" = 'consultation'`,
      )).rejects.toThrow(/may not be DELETED directly/u);
      await expect(db.$executeRawUnsafe(
        `UPDATE "ProjectCapability" SET "capability" = 'materials' WHERE "projectId" = 'pre' AND "capability" = 'consultation'`,
      )).rejects.toThrow(/may not be RE-KEYED/u);
      await expect(db.$executeRawUnsafe(TRUNCATE_CAPABILITIES)).rejects.toThrow(/never truncated/u);
      expect(await consultationRows(db), 'every row survived every refused attempt').toBe(3);

      // ── AFTER: the shipped 4c-v ───────────────────────────────────────────────────────────────
      await replay(RETIREMENT_PATH);
      expect(await countTriggers(db, RETIRED_TRIGGERS), 'every 4c-iii trigger is dropped').toBe(0);
      expect(await countFunctions(db, RETIRED_FUNCTIONS), 'and every function behind them').toBe(0);
      expect(await consultationRows(db), 'and every consultation row is removed').toBe(0);
      // the cascade FK 4c-iii installed is NOT reverted — it is modelled in schema.prisma and is
      // not part of the latch
      const fk = await db.$queryRawUnsafe<Array<{ confdeltype: string }>>(
        `SELECT confdeltype::text FROM pg_constraint WHERE conname = 'ProjectCapability_projectId_fkey'`);
      expect(fk[0]?.confdeltype, 'ON DELETE CASCADE stays').toBe('c');

      await db.$executeRawUnsafe(`INSERT INTO "Project" VALUES ('after','o1')`);
      expect(await consultationRows(db, 'after'), 'a project created after the retirement gets no row').toBe(0);

      // the three arms, now permitted — each on a row planted through the unchanged generic writer
      const plantScratch = (pid: string) => db.$executeRawUnsafe(
        `INSERT INTO "ProjectCapability" ("projectId","capability","enabledById") VALUES ($1,'consultation','op')`, pid);
      await plantScratch('pre');
      await expect(db.$executeRawUnsafe(
        `DELETE FROM "ProjectCapability" WHERE "projectId" = 'pre' AND "capability" = 'consultation'`,
      ), 'ARM 1 permitted').resolves.toBe(1);
      await plantScratch('pre');
      await expect(db.$executeRawUnsafe(
        `UPDATE "ProjectCapability" SET "capability" = 'materials' WHERE "projectId" = 'pre' AND "capability" = 'consultation'`,
      ), 'ARM 2 permitted').resolves.toBe(1);
      await plantScratch('other');
      await expect(db.$executeRawUnsafe(TRUNCATE_CAPABILITIES), 'ARM 3 permitted').resolves.toBeDefined();
      expect(await consultationRows(db)).toBe(0);

      // ── and the retirement is re-runnable, which ALWAYS_EXECUTE requires ─────────────────────
      await plantScratch('other');
      await replay(RETIREMENT_PATH);
      expect(await consultationRows(db), 'a second run removes what the generic writer re-planted, and errors on nothing').toBe(0);
    } finally {
      await db.$disconnect();
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}"`);
      await admin.$disconnect();
    }
  }, 120_000);
});
