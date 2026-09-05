import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { splitSql, splitSqlForReplay } from './phase6-t4c-migration-replay';
import { CONSULTATION_CAPABILITY } from '../../src/platform/capabilities.service';

/**
 * Phase 6 unit 4c-iii — the ENABLEMENT TRANSITION, as it stands after unit 4c-v.
 *
 * 4c-iii replaced the 4c-i/4c-ii reservation with a PRESERVATION seal, installed the `Project`
 * creation trigger and backfilled the `consultation` row for every project, in one transaction
 * and in that order. Unit 4c-v (migration 20271130000000) RETIRED the seal, the creation trigger
 * and the rows once the 4c-iv rollout was attested complete, so the shared database this suite
 * runs against no longer carries any of them.
 *
 * What remains here is what is still TRUE of 4c-iii on that database and of its shipped file:
 * the ordering race (driven on a scratch database from the file read from disk), the reservation
 * being dropped rather than bypassed, the ALWAYS_EXECUTE pins, and the file's own transaction
 * boundary. The seal's three behavioural arms, the every-project guarantee, the creation trigger,
 * the cascade discriminator and the re-run no-op are now the BEFORE half of 4c-v's mirror probe
 * in `phase6-t4c-v-seal-retirement.test.ts`, proven on a scratch database migrated with THIS
 * unit's shipped file — they cannot be asserted on a database that is already past 4c-v.
 */

/** The migration under test, read from disk so the race below drives the SHIPPED file rather than
 *  a paraphrase of it — the difference the round-1 P2 finding turned on. */
const MIGRATION_PATH = join(
  __dirname, '../../prisma/migrations/20271120000000_phase6_t4c_iii_enablement/migration.sql');

/** The connection this suite's DATABASE_URL points at, split so the race can create and drop its
 *  own scratch database beside it. */
const baseUrl = (process.env.DATABASE_URL ?? '').split('?')[0].replace(/\/[^/]*$/, '');
const adminUrl = `${baseUrl}/postgres`;

/** The §D round-21 DEFECT, produced FROM the shipped file rather than hand-written: hoist the
 *  backfill to the very front, ahead of every statement that takes a lock on `Project`.
 *
 *  Hoisting it merely above the `CREATE TRIGGER` is NOT enough, and finding that out is what this
 *  comment exists for: step 1a adds the `ProjectCapability → Project` foreign key, and adding an
 *  FK locks the REFERENCED table too, so the migration already waits for any in-flight create
 *  before it reaches the trigger. The ordering hazard is only reachable by a backfill that runs
 *  before the transaction holds any `Project` lock at all. */
export function mutateToBackfillFirst(sql: string): string {
  const stmts = splitSql(sql);
  const backfill = stmts.findIndex((s) => s.includes(`SELECT p."id", 'consultation'`));
  const trigger = stmts.findIndex((s) => s.includes('CREATE TRIGGER "Project_t4c_consultation_enabled"'));
  if (backfill < 0 || trigger < 0 || backfill < trigger) {
    throw new Error('the shipped migration no longer has trigger-before-backfill; this mutation is stale');
  }
  const [b] = stmts.splice(backfill, 1);
  stmts.unshift(b);
  return stmts.join(';\n') + ';';
}

describe('Phase 6 unit 4c-iii — the enablement transition (live PG)', () => {
  let t: TestApp;
  const run = randomUUID().slice(0, 8);
  const id = (label: string) => `t4ciii-${label}-${run}`;
  const orgId = id('org');

  const projectData = (pid: string) => ({
    id: pid, orgId, name: pid, short: 'T4C3', descriptor: '', stage: 'Planning',
    siteCode: pid.slice(-8), projStart: '01 Jan 2026', projEnd: '31 Dec 2026',
    elapsedPct: 0, todayDay: 0, milestonePct: 0,
  });

  const makeProject = async (label: string): Promise<string> => {
    const pid = id(label);
    await t.prisma.project.create({ data: projectData(pid) });
    return pid;
  };

  beforeAll(async () => {
    t = await createTestApp();
    await t.prisma.org.create({ data: { id: orgId, name: `T4CIII ${run}`, slug: orgId } });
  });

  afterAll(async () => {
    // the project delete CASCADES to its capability rows through the FK this unit installed
    await t?.prisma.project.deleteMany({ where: { orgId } });
    await t?.prisma.org.deleteMany({ where: { id: orgId } });
    await t?.close();
  });

  // ═══ THE TRANSITION ORDER, on the shipped file ═══════════════════════════════════════════════

  it('a create racing the TRANSITION ITSELF still ends with its row — and the wrong order loses it', async () => {
    // REWRITTEN after a review finding on head 9067d0cc (P2). The first version raced two ordinary
    // creates AFTER the migration had already committed, which tests nothing about the ordering:
    // a migration that backfilled BEFORE installing the trigger would have passed it unchanged,
    // while a create committing in that installation gap would permanently lack the row.
    //
    // This runs the ACTUAL migration file, read from disk, against a scratch database, with a
    // writer held at the transition lock by an explicit barrier — and then runs a MUTATED copy
    // with the two steps swapped, to show the probe can actually fail. Without that second half
    // "it passed" would again mean nothing.
    //
    // Still valid after 4c-v: the scratch database is migrated with THIS unit's file only, so the
    // property proven is 4c-iii's own ordering — which is what an operator upgrading through
    // 20271120 on the way to 20271130 still depends on.
    const scratch = `pmcvitan_t4ciii_race_test_${run}`;
    const admin = new PrismaClient({ datasources: { db: { url: adminUrl } } });
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}"`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratch}"`);
    const url = `${baseUrl}/${scratch}?schema=public`;

    /** The two tables the migration touches, in their delivered shape (the columns and constraints
     *  it depends on). A scratch database with 2 tables instead of 134 is the only reduction. */
    const seed = async (db: PrismaClient) => {
      await db.$executeRawUnsafe(`CREATE TABLE "Project" ("id" TEXT PRIMARY KEY, "orgId" TEXT NOT NULL)`);
      await db.$executeRawUnsafe(
        `CREATE TABLE "ProjectCapability" (
           "projectId" TEXT NOT NULL, "capability" TEXT NOT NULL,
           "enabledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "enabledById" TEXT NOT NULL,
           CONSTRAINT "ProjectCapability_pkey" PRIMARY KEY ("projectId","capability"))`);
      await db.$executeRawUnsafe(
        `ALTER TABLE "ProjectCapability" ADD CONSTRAINT "ProjectCapability_projectId_fkey"
           FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE`);
      await db.$executeRawUnsafe(`INSERT INTO "Project" VALUES ('already-there','o1')`);
    };

    /** Hold an UNCOMMITTED project insert, then report when the migration session is blocked on it.
     *  The insert takes ROW EXCLUSIVE on "Project", which `CREATE TRIGGER`'s ACCESS EXCLUSIVE
     *  cannot take — so the migration WAITS here, which is the barrier. */
    const raceOnce = async (sql: string): Promise<{ missing: string[]; failure: string | null }> => {
      const holder = new PrismaClient({ datasources: { db: { url } } });
      const runner = new PrismaClient({ datasources: { db: { url } } });
      const probe = new PrismaClient({ datasources: { db: { url } } });
      try {
        let release!: () => void;
        const held = new Promise<void>((r) => { release = r; });
        let ready!: () => void;
        const holding = new Promise<void>((r) => { ready = r; });

        const holderTx = holder.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`INSERT INTO "Project" VALUES ('racer','o1')`);
          ready();
          await held;
        }, { timeout: 30_000, maxWait: 30_000 });
        await holding;

        let done = false;
        let failure: unknown;
        const migration = runner.$transaction(async (tx) => {
          for (const stmt of splitSqlForReplay(sql)) await tx.$executeRawUnsafe(stmt);
        }, { timeout: 30_000, maxWait: 30_000 }).then(() => { done = true; }, (e) => { done = true; failure = e; });

        // the barrier: observed, never slept on
        const blocked = await (async () => {
          const deadline = Date.now() + 10_000;
          while (Date.now() < deadline) {
            const rows = await probe.$queryRawUnsafe<Array<{ n: bigint }>>(
              `SELECT count(*)::bigint AS n FROM pg_stat_activity
                WHERE datname = $1 AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`, scratch);
            if (Number(rows[0]?.n ?? 0) > 0) return true;
            await new Promise((r) => setTimeout(r, 50));
          }
          return false;
        })();
        expect(blocked, `the migration must WAIT at the transition lock while a create is in flight (migration error: ${failure ? String(failure).slice(0, 400) : 'none'})`).toBe(true);
        expect(done, 'and it cannot have finished while that create is uncommitted').toBe(false);

        release();
        await holderTx;
        await migration;

        const got = await probe.$queryRawUnsafe<Array<{ projectId: string }>>(
          `SELECT p."id" AS "projectId" FROM "Project" p
            WHERE NOT EXISTS (SELECT 1 FROM "ProjectCapability" c
                               WHERE c."projectId" = p."id" AND c."capability" = 'consultation')
            ORDER BY p."id"`);
        return { missing: got.map((r) => r.projectId), failure: failure ? String(failure) : null };
      } finally {
        await holder.$disconnect(); await runner.$disconnect(); await probe.$disconnect();
      }
    };

    const shipped = readFileSync(MIGRATION_PATH, 'utf8');
    let scratchDb = new PrismaClient({ datasources: { db: { url } } });
    await seed(scratchDb);
    await scratchDb.$disconnect();

    // (1) THE SHIPPED ORDER — trigger, then backfill. The racing create is covered whichever side
    //     won: it committed before the backfill's snapshot, or the trigger was already installed.
    const ok = await raceOnce(shipped);
    expect(ok.failure, 'the shipped migration commits').toBeNull();
    expect(ok.missing, 'no project may be left without the row').toEqual([]);

    // (2) THE WRONG ORDER, to prove this probe has teeth — without it, "it passed" means nothing.
    //     A backfill that runs before the transaction holds any `Project` lock cannot see the
    //     in-flight create, so the project it strands is exactly the one §D round 21 describes.
    //     The migration's own closing check then REFUSES TO COMMIT, which is the whole reason that
    //     check exists: the every-project guarantee is verified, not asserted.
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}"`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratch}"`);
    scratchDb = new PrismaClient({ datasources: { db: { url } } });
    await seed(scratchDb);
    await scratchDb.$disconnect();
    const broken = await raceOnce(mutateToBackfillFirst(shipped));
    expect(broken.failure ?? '', 'the broken order must be caught by the migration itself')
      .toMatch(/still lack the `consultation` capability row/u);

    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}"`);
    await admin.$disconnect();
  }, 120_000);

  // ═══ THE RESERVATION IS GONE ═════════════════════════════════════════════════════════════════

  it('the reservation no longer refuses the capability — the gate it latched is open, and stays open after 4c-v', async () => {
    // 4c-i/4c-ii's reservation rejected every INSERT and re-key naming `consultation`. Its whole
    // purpose was the dark window, and that window closed with the drain. The generic writer can
    // still upsert the value — after 4c-v as inert free text nothing reads, which is the Board pin
    // (no CHECK, no vocabulary whitelist) holding through the retirement.
    const pid = await makeProject('reserv');
    await expect(
      t.prisma.projectCapability.upsert({
        where: { projectId_capability: { projectId: pid, capability: CONSULTATION_CAPABILITY } },
        create: { projectId: pid, capability: CONSULTATION_CAPABILITY, enabledById: 'op' },
        update: {},
      }),
    ).resolves.toBeTruthy();

    const trg = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM pg_trigger WHERE tgname = 'ProjectCapability_t4c_reserved'`,
    );
    expect(Number(trg[0]?.n ?? -1), 'the reservation trigger is dropped, not merely bypassed').toBe(0);
  });

  // ── round-2 Codex correction (the #503 head 2ff6596) ────────────────────────────────────────

  it('F1: the P3005 baseline path EXECUTES 20271120 rather than resolving it as applied (a db-push database has the cascade FK but none of the raw transition)', async () => {
    // Codex round 2, F1 — the same defect class R8-F3 caught on the 4b unit, and the reason
    // migrate.sh keeps ALWAYS_EXECUTE at all. On the P3005/pre-baseline path the loop resolves
    // EVERY migration as applied unless its name is in that set. `schema.prisma` models exactly
    // one object from this migration — the ProjectCapability.project cascade FK — so a
    // `prisma db push` baseline yields a database with the FK and NONE of the three trigger
    // functions, the three triggers, or the every-project backfill. Resolving it would skip them
    // permanently — and, after 4c-v, would leave 20271130 retiring objects that were never
    // installed while the ledger records both as applied. Nothing downstream notices — the
    // generic enforcement verifier deliberately keeps no expected-object list.
    const sh = readFileSync(join(__dirname, '../../scripts/migrate.sh'), 'utf8');
    // the migration is in the ALWAYS_EXECUTE set…
    const m = sh.match(/ALWAYS_EXECUTE="([^"]+)"/);
    expect(m, 'migrate.sh must declare ALWAYS_EXECUTE').not.toBeNull();
    const entries = m![1].split('\n').map((s) => s.trim());
    expect(entries).toContain('20271120000000_phase6_t4c_iii_enablement');
    // …and so are the three 4c PREREQUISITES whose seals this unit's enablement assumes. Adding
    // 20271120 alone would have been worse than adding none of them (round-2 F2): the capability
    // would be opened for EVERY project against evidence tables a db-push baseline left without
    // their append-only, CHECK, eligibility and provenance triggers.
    expect(entries).toContain('20271101000000_phase6_t4c_i_consultation');
    expect(entries).toContain('20271115000000_phase6_t4c_ii_approval_provenance');
    expect(entries).toContain('20271116000000_phase6_t4c_ii_rollout_fence');
    // …and the baseline loop consults that set to leave its members pending for the deploy
    expect(sh).toContain('printf \'%s\\n\' "$ALWAYS_EXECUTE" | grep -qx "$name"');
  });

  it('F3: the SHIPPED migration carries its own transaction boundary — the handover is indivisible by construction, not by the runner', async () => {
    // Round-3 F1. An earlier head relied on `prisma migrate deploy` supplying the transaction,
    // which is measurably true of this Prisma version but is the opposite of what Prisma
    // DOCUMENTS. An undocumented guarantee is one a version bump removes silently, with no test
    // failing — and what it guards is not cosmetic: between dropping the reservation and
    // installing the preservation seal, a generic capability writer could insert a `consultation`
    // row with a forged human `enabledById`, which the backfill's ON CONFLICT DO NOTHING would
    // then preserve and the new seal would freeze. So the file states the boundary itself.
    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    // Statements carry their own leading commentary, so compare on the EXECUTABLE text: the file
    // documents this boundary at length and the assertion must not pass or fail on that prose.
    const executable = (stmt: string) =>
      stmt.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n').trim();
    const stmts = splitSql(sql).filter((stmt) => executable(stmt).length > 0);
    expect(executable(stmts[0]), 'the file opens its own transaction').toMatch(/^BEGIN\s*;?$/i);
    expect(executable(stmts[stmts.length - 1]), 'and closes it').toMatch(/^COMMIT\s*;?$/i);

    // the reservation drop and the seal installation are INSIDE that boundary, which is the pair
    // whose separate observability is the hazard
    const inside = stmts.slice(1, -1).join('\n');
    expect(inside).toContain('DROP TRIGGER IF EXISTS "ProjectCapability_t4c_reserved"');
    expect(inside).toContain('CREATE TRIGGER "ProjectCapability_t4c_preserved"');
  });
});
