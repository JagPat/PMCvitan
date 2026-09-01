import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { CONSULTATION_CAPABILITY } from '../../src/platform/capabilities.service';

/** The migration under test, read from disk so the race below drives the SHIPPED file rather than
 *  a paraphrase of it — the difference the round-1 P2 finding turned on. */
const MIGRATION_PATH = join(
  __dirname, '../../prisma/migrations/20271120000000_phase6_t4c_iii_enablement/migration.sql');

/** The connection this suite's DATABASE_URL points at, split so the race can create and drop its
 *  own scratch database beside it. */
const baseUrl = (process.env.DATABASE_URL ?? '').split('?')[0].replace(/\/[^/]*$/, '');
const adminUrl = `${baseUrl}/postgres`;

/** Split a migration into executable statements. Postgres dollar-quoted bodies (`$$ … $$`) contain
 *  semicolons that are NOT statement terminators, so a naive split on ';' would tear every trigger
 *  function in half — the migration is mostly such bodies. */
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let tag: string | null = null;   // open $$…$$ / $tag$…$tag$ body
  let quoted = false;              // inside '…'
  let lineComment = false;         // inside -- …
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (lineComment) { buf += ch; if (ch === '\n') lineComment = false; continue; }
    if (quoted) { buf += ch; if (ch === "'") quoted = false; continue; }
    if (tag !== null) {
      if (sql.startsWith(tag, i)) { buf += tag; i += tag.length - 1; tag = null; continue; }
      buf += ch; continue;
    }
    // …outside every quoting construct: only here is a ';' a terminator. This file's own header
    // comments contain semicolons, which is how the first version of this splitter tore a comment
    // in half and handed PostgreSQL the word "the" as a statement.
    if (ch === '-' && sql[i + 1] === '-') { lineComment = true; buf += ch; continue; }
    if (ch === "'") { quoted = true; buf += ch; continue; }
    const open = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
    if (open) { tag = open[0]; buf += open[0]; i += open[0].length - 1; continue; }
    if (ch === ';') { if (buf.trim()) out.push(buf); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) out.push(buf);
  // a fragment that is only comments and whitespace is not a statement
  return out.filter((s) => s.replace(/--[^\n]*/g, '').trim().length > 0);
}

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
  let raceDb: PrismaClient;
  const run = randomUUID().slice(0, 8);
  const id = (label: string) => `t4ciii-${label}-${run}`;
  const orgId = id('org');
  const made: string[] = [];

  const projectData = (pid: string) => ({
    id: pid, orgId, name: pid, short: 'T4C3', descriptor: '', stage: 'Planning',
    siteCode: pid.slice(-8), projStart: '01 Jan 2026', projEnd: '31 Dec 2026',
    elapsedPct: 0, todayDay: 0, milestonePct: 0,
  });

  const makeProject = async (label: string): Promise<string> => {
    const pid = id(label);
    await t.prisma.project.create({ data: projectData(pid) });
    made.push(pid);
    return pid;
  };

  const capRow = (projectId: string) =>
    t.prisma.projectCapability.findUnique({
      where: { projectId_capability: { projectId, capability: CONSULTATION_CAPABILITY } },
    });

  beforeAll(async () => {
    t = await createTestApp();
    raceDb = new PrismaClient();
    await t.prisma.org.create({ data: { id: orgId, name: `T4CIII ${run}`, slug: orgId } });
    // Created HERE, before the first assertion, so the database-wide invariant below is not
    // vacuously true on an empty database — at the base head these projects hold no row and the
    // probe fails on them.
    await makeProject('pre-a');
    await makeProject('pre-b');
  });

  afterAll(async () => {
    await raceDb?.$disconnect();
    // the project delete CASCADES to its capability rows — which is the seal's permitted arm,
    // and the reason this teardown needs no bypass
    await t?.prisma.project.deleteMany({ where: { orgId } });
    await t?.prisma.org.deleteMany({ where: { id: orgId } });
    await t?.close();
  });

  // ═══ THE EVERY-PROJECT GUARANTEE ═════════════════════════════════════════════════════════════

  it('every project this suite created carries the row — none left behind', async () => {
    // SCOPED TO THIS SUITE'S ORG, deliberately — and the first draft of this probe was not, which
    // is why the scoping is explained rather than just applied. Asserting the invariant over the
    // WHOLE database looks stronger and is in fact unsound in the shared battery: `sanctionedReset`
    // disables every seal in `TRUNCATE_SEALS` wholesale (it must, because cascades reach tables the
    // caller never names), so any concurrently running suite may legitimately clear
    // `ProjectCapability` for projects it does not own. A database-wide count therefore measures
    // other suites' teardown timing, not this unit's guarantee — it failed in the full battery for
    // exactly that reason while the trigger was installed, enabled and working.
    //
    // What this probe holds is the guarantee itself, over projects whose whole lifetime this suite
    // controls, and it is not vacuous: `pre-a` and `pre-b` are created in `beforeAll`, and at the
    // base head they hold no row and this fails.
    //
    // The EVERY-PROJECT and BACKFILL claims are proven where the database is exclusively ours:
    // `scripts/upgrade-proof.sh` migrates a legacy fixture holding `p1`/`p2` — projects that
    // existed BEFORE the transition, which no suite can create — and asserts a database-wide count
    // of zero plus the trigger, seal and cascade arms on the migrated result.
    const missing = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM "Project" p
        WHERE p."orgId" = $1
          AND NOT EXISTS (SELECT 1 FROM "ProjectCapability" c
                           WHERE c."projectId" = p."id" AND c."capability" = 'consultation')`,
      orgId,
    );
    expect(Number(missing[0]?.n ?? -1), 'no project of this org may lack the consultation row').toBe(0);
    expect(made.length, 'and the check is not vacuous — projects exist to fail it').toBeGreaterThan(0);
  });

  it('a project created AFTER the transition carries the row, with no application involvement', async () => {
    // The row is produced by a DATABASE trigger, so it appears for a create path that knows
    // nothing about it — which is the whole reason §D refused to put this in `projects.create`.
    // This insert is a raw Prisma create with no capability field anywhere in it.
    const pid = await makeProject('new');
    const row = await capRow(pid);
    expect(row, 'the AFTER INSERT trigger must have produced the row').not.toBeNull();
    expect(row!.enabledById, 'the DB enablement records itself, never a borrowed human identity')
      .toBe('system:phase6-4c-iii');
  });

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
          for (const stmt of splitSql(sql)) await tx.$executeRawUnsafe(stmt);
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

  it('the reservation no longer refuses the capability — the gate it latched is now open', async () => {
    // 4c-i/4c-ii's reservation rejected every INSERT and re-key naming `consultation`. Its whole
    // purpose was the dark window, and that window closed with the drain. The row now simply
    // exists for every project, and the generic writer can idempotently re-enable it.
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

  // ═══ THE PRESERVATION SEAL — all three arms of the completeness rule ══════════════════════════

  it('ARM 1 — a direct DELETE of a live project’s consultation row is REFUSED', async () => {
    const pid = await makeProject('del');
    await expect(
      t.prisma.projectCapability.delete({
        where: { projectId_capability: { projectId: pid, capability: CONSULTATION_CAPABILITY } },
      }),
    ).rejects.toThrow(/may not be DELETED directly/u);
    expect(await capRow(pid), 'the row survives the attempt').not.toBeNull();
  });

  it('ARM 2 — RE-KEYING the row off `consultation` is REFUSED', async () => {
    // `capability` is a mutable key with no freeze trigger, so a DELETE-only seal would leave the
    // same gate-closed state reachable by renaming the row.
    const pid = await makeProject('rekey');
    await expect(
      t.prisma.$executeRawUnsafe(
        `UPDATE "ProjectCapability" SET "capability" = 'materials' WHERE "projectId" = $1 AND "capability" = 'consultation'`,
        pid,
      ),
    ).rejects.toThrow(/may not be RE-KEYED/u);
    expect(await capRow(pid)).not.toBeNull();
  });

  it('ARM 2b — RE-PARENTING the row to another project is REFUSED', async () => {
    // Round-1 finding (P1) widened this seal from `UPDATE OF "capability"` to every UPDATE, which
    // made two further removals-by-another-name reachable to test. Moving the row to another
    // project removes it from THIS one, and the gate reads are per-project.
    const a = await makeProject('reparent-a');
    const b = await makeProject('reparent-b');
    await expect(
      t.prisma.$executeRawUnsafe(
        `UPDATE "ProjectCapability" SET "projectId" = $2 WHERE "projectId" = $1 AND "capability" = 'consultation'`,
        a, b,
      ),
    ).rejects.toThrow(/may not be RE-PARENTED/u);
    expect(await capRow(a), 'the row stays with the project it belongs to').not.toBeNull();
  });

  it('ARM 2c — REWRITING the attribution is REFUSED: the row is evidence, not just a flag', async () => {
    // The round-1 P1 itself. The trigger fired only for `UPDATE OF "capability"`, so an alternate
    // writer could rewrite `enabledById`/`enabledAt` unopposed — dressing a DATABASE enablement up
    // as an operator's act, or the reverse. The row's presence was sealed; what it was evidence OF
    // was not. RED at head 9067d0cc, where both statements below succeeded.
    const pid = await makeProject('attrib');
    await expect(
      t.prisma.$executeRawUnsafe(
        `UPDATE "ProjectCapability" SET "enabledById" = 'some-user' WHERE "projectId" = $1 AND "capability" = 'consultation'`,
        pid,
      ),
    ).rejects.toThrow(/carries the ATTRIBUTION/u);
    await expect(
      t.prisma.$executeRawUnsafe(
        `UPDATE "ProjectCapability" SET "enabledAt" = now() - interval '10 days' WHERE "projectId" = $1 AND "capability" = 'consultation'`,
        pid,
      ),
    ).rejects.toThrow(/carries the ATTRIBUTION/u);
    expect((await capRow(pid))!.enabledById, 'the recorded actor is unchanged').toBe('system:phase6-4c-iii');
  });

  it('…and a NO-OP upsert still succeeds — the seal refuses CHANGES, not the mere fact of an UPDATE', async () => {
    // Widening the trigger to every UPDATE could have broken the ordinary idempotent enable, whose
    // update branch changes nothing. The arms test IS DISTINCT FROM per column for exactly this.
    const pid = await makeProject('noop');
    const before = await capRow(pid);
    await expect(
      t.prisma.projectCapability.upsert({
        where: { projectId_capability: { projectId: pid, capability: CONSULTATION_CAPABILITY } },
        create: { projectId: pid, capability: CONSULTATION_CAPABILITY, enabledById: 'op' },
        update: {},
      }),
    ).resolves.toBeTruthy();
    const after = await capRow(pid);
    expect(after!.enabledById).toBe(before!.enabledById);
    expect(after!.enabledAt.getTime()).toBe(before!.enabledAt.getTime());
  });

  it('ARM 3 — TRUNCATE is REFUSED, because a row trigger never fires for it', async () => {
    // Stated by enumeration over the mechanism rather than because a reviewer tried it: a seal
    // that must keep a row PRESENT is complete only when it covers row DELETE, row UPDATE of the
    // sealed key, and statement TRUNCATE.
    await expect(t.prisma.$executeRawUnsafe(`TRUNCATE "ProjectCapability"`))
      .rejects.toThrow(/never truncated/u);
  });

  it('the seal is PRECISE — every other capability is untouched by all three arms', async () => {
    // The Board pin stands: no CHECK on `capability`, no vocabulary whitelist. A seal that
    // refused every capability would be an outage wearing a seal's clothes.
    const pid = await makeProject('precise');
    await t.prisma.projectCapability.create({ data: { projectId: pid, capability: 'materials', enabledById: 'op' } });
    await expect(
      t.prisma.$executeRawUnsafe(
        `UPDATE "ProjectCapability" SET "capability" = 'labour' WHERE "projectId" = $1 AND "capability" = 'materials'`,
        pid,
      ),
    ).resolves.toBe(1);
    await expect(
      t.prisma.projectCapability.delete({
        where: { projectId_capability: { projectId: pid, capability: 'labour' } },
      }),
    ).resolves.toBeTruthy();
  });

  it('the seal is SCOPED TO A LIVE PROJECT — deleting the project cascades the row away', async () => {
    // The deliberate deviation from §D's "every way", argued in the packet. The invariant the
    // seal protects is the split brain between gate-reading and gate-blind instances FOR A
    // PROJECT; a project that no longer exists has no such state. Under CASCADE the child delete
    // runs in a later command than the parent's, so the trigger sees the parent already gone —
    // an exact discriminator, not a heuristic, and the arm-1 probe above is its other side.
    const pid = await makeProject('cascade');
    expect(await capRow(pid)).not.toBeNull();
    await expect(t.prisma.project.delete({ where: { id: pid } })).resolves.toBeTruthy();
    expect(await capRow(pid), 'the row went with the project it belonged to').toBeNull();
    expect(await t.prisma.project.findUnique({ where: { id: pid } })).toBeNull();
  });

  // ── round-2 Codex correction (the #503 head 2ff6596) ────────────────────────────────────────

  it('F1: the P3005 baseline path EXECUTES 20271120 rather than resolving it as applied (a db-push database has the cascade FK but none of the raw transition)', async () => {
    // Codex round 2, F1 — the same defect class R8-F3 caught on the 4b unit, and the reason
    // migrate.sh keeps ALWAYS_EXECUTE at all. On the P3005/pre-baseline path the loop resolves
    // EVERY migration as applied unless its name is in that set. `schema.prisma` models exactly
    // one object from this migration — the ProjectCapability.project cascade FK — so a
    // `prisma db push` baseline yields a database with the FK and NONE of the three trigger
    // functions, the three triggers, or the every-project backfill. Resolving it would skip them
    // permanently: no project would carry the `consultation` row this unit exists to guarantee,
    // and any attribution that did appear would stay rewritable because the preservation seal was
    // never installed. Nothing downstream notices — the generic enforcement verifier deliberately
    // keeps no expected-object list.
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

  it('F1: leaving it pending is SAFE because every statement is re-runnable — the shipped file applied twice is a no-op, not an error', async () => {
    // ALWAYS_EXECUTE's own precondition. A member is left pending on the baseline path, so it may
    // run against a database where it has somehow already run. This asserts the property the
    // migration's comments claim rather than trusting them: apply the REAL file a second time
    // against the already-migrated database and require it to succeed and change nothing.
    // Scoped to THIS suite's own projects deliberately. A global count is not a sound assertion
    // here: `sanctionedReset` legitimately TRUNCATEs `ProjectCapability` for other suites, so a
    // shared database can hold projects whose rows a sibling reset cleared — and the backfill
    // restoring those is the migration working, not a defect. What must hold for re-runnability
    // is that a second application ERRORS on nothing and REWRITES nothing.
    const pid = await makeProject('rerun');
    const before = await capRow(pid);
    expect(before).not.toBeNull();

    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    await t.prisma.$transaction(async (tx) => {
      for (const stmt of splitSql(sql)) await tx.$executeRawUnsafe(stmt);
    });

    const after = await capRow(pid);
    expect(after?.enabledAt?.toISOString()).toBe(before?.enabledAt?.toISOString());
    expect(after?.enabledById).toBe(before?.enabledById);
  });

  it('F2: the seal discriminates a cascade from a direct delete WITHOUT reading the orgs-owned Project table', async () => {
    // Round-2 F1: the DELETE arm asked `EXISTS (SELECT 1 FROM "Project" ...)`, a synchronous read
    // of another module's table from a platform-owned trigger. The replacement is two local facts
    // — pg_trigger_depth() > 1, and a transaction-local flag published by the orgs-owned
    // `Project_t4c_deleting` trigger. This pins the SHIPPED seal body: no foreign read remains.
    const fnBody = await t.prisma.$queryRawUnsafe<Array<{ src: string }>>(
      `SELECT prosrc AS src FROM pg_proc WHERE proname = 'phase6_t4c_capability_preserved'`,
    );
    expect(fnBody).toHaveLength(1);
    // Strip SQL line comments first: the body DOCUMENTS the removed read in prose, and asserting
    // over the commentary would pass or fail on how the rationale is worded rather than on what
    // the function executes.
    const executable = fnBody[0].src
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n');
    expect(executable, 'the seal executes no read of the orgs-owned Project table').not.toMatch(
      /FROM\s+"?Project"?/i,
    );
    expect(executable).toContain('pg_trigger_depth()');
    expect(executable).toContain('phase6.t4c_project_delete');
    // and the orgs-owned primitive that authorizes the cascade is installed on Project
    const trg = await t.prisma.$queryRawUnsafe<Array<{ tgname: string }>>(
      `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname = 'Project_t4c_deleting'`,
    );
    expect(trg).toHaveLength(1);
  });

  it('F2: a MULTI-ROW project delete cascades every consultation row away — the shape a scalar id-flag would have broken', async () => {
    // The design note this probe defends: PostgreSQL queues FK cascades as AFTER-statement
    // actions, so a flag carrying the deleting project's ID would hold only the LAST row's id by
    // the time the cascades fire, and every earlier project's cascade would be wrongly refused.
    // That is precisely the shape the shared fixture teardown uses, so it is tested rather than
    // reasoned about.
    const a = await makeProject('multi-a');
    const b = await makeProject('multi-b');
    const c = await makeProject('multi-c');
    for (const pid of [a, b, c]) expect(await capRow(pid)).not.toBeNull();

    await t.prisma.project.deleteMany({ where: { id: { in: [a, b, c] } } });

    for (const pid of [a, b, c]) {
      expect(await capRow(pid), 'every cascaded row went, not just the last').toBeNull();
      expect(await t.prisma.project.findUnique({ where: { id: pid } })).toBeNull();
    }
  });

  it('F2: a direct delete is STILL refused inside a transaction that already deleted another project', async () => {
    // The flag is transaction-local and stays set once any project delete has run, so the flag
    // alone would leave a hole for the rest of that transaction. Both conditions are required:
    // this delete is at depth 1, so it is refused regardless of the flag.
    const victim = await makeProject('flag-victim');
    const target = await makeProject('flag-target');
    await expect(
      t.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`DELETE FROM "Project" WHERE "id" = '${victim}'`);
        await tx.$executeRawUnsafe(
          `DELETE FROM "ProjectCapability" WHERE "projectId" = '${target}' AND "capability" = 'consultation'`,
        );
      }),
    ).rejects.toThrow(/may not be DELETED directly/i);
    expect(await capRow(target), 'the target row survived').not.toBeNull();
    // the seals are still installed and still named the same
    const trigs = await t.prisma.$queryRawUnsafe<Array<{ tgname: string }>>(
      `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname IN
         ('ProjectCapability_t4c_preserved','ProjectCapability_t4c_no_truncate','Project_t4c_consultation_enabled')
       ORDER BY tgname`,
    );
    expect(trigs.map((r) => r.tgname)).toEqual([
      'ProjectCapability_t4c_preserved',
      'Project_t4c_consultation_enabled',
      'ProjectCapability_t4c_no_truncate',
    ].sort());
  });
});
