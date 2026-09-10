import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createTestApp, type TestApp } from './test-app';

/**
 * Phase 6 unit 4d-i — the seed's TRUNCATE lists are CLOSED under "is referenced by".
 *
 * WHY THIS EXISTS. PostgreSQL refuses to truncate a table that a foreign key references unless
 * every referencing table is named in the SAME statement. `ON DELETE CASCADE` does not exempt it:
 * TRUNCATE is a statement, not a row delete, and the rule looks at the reference. So a migration
 * that adds one FK onto a table the seed truncates silently breaks the seed — and only the seed.
 *
 * HOW IT WAS FOUND, which is the point. The integration suites reach `sanctionedReset` with
 * `{ cascade: true }`, which papers the omission over completely; a full green integration run
 * says nothing about it. `prisma/seed.ts` passes no `cascade`, and `pnpm test:e2e:api` runs the
 * seed — so the first signal was a red `api-e2e` check on CI, naming ONE missing table at a time,
 * because PostgreSQL reports the first violation and stops. 4d-i added FIVE such references
 * (`Notification.eventId` and `DomainEventPairingClaim` onto `DomainEvent`;
 * `ChangeRequest.revisionId` and the two chain facts onto `DecisionApprovalRevision`) — five CI
 * rounds if the only oracle is CI.
 *
 * WHY IT READS `pg_constraint` AND NOT THE PRISMA SCHEMA. The first draft of this suite computed
 * the closure from the DMMF and PASSED against the broken seed, which is worse than no tripwire:
 * `Notification.eventId` is a plain `String?` in `schema.prisma` with the foreign key declared in
 * the migration SQL alone, so the DMMF cannot see it and the check was vacuous for exactly the
 * cases that had just broken CI. It was driven against the pre-fix seed, seen to pass, and
 * rewritten to ask the DATABASE — which is where the constraint actually lives.
 *
 * It reads the LIST TEXT out of `prisma/seed.ts` rather than importing the seed, because importing
 * it would run it.
 */

const SEED = join(__dirname, '..', '..', 'prisma', 'seed.ts');

/** psql wants a libpq URI: Prisma's `?schema=public` is not one of its parameters. */
function adminUrl(raw: string): string {
  const url = new URL(raw);
  url.search = '';
  return url.toString();
}

/** the same server, a different database, with Prisma's query string kept for Prisma's own use. */
function dbUrl(raw: string, db: string): string {
  const url = new URL(raw);
  url.pathname = `/${db}`;
  return url.toString();
}

/** CREATE/DROP DATABASE cannot run inside the database being created — go through `postgres`. */
function psqlAdmin(raw: string, sql: string): void {
  execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', adminUrl(dbUrl(raw, 'postgres')), '-c', sql],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * One row in each register the DELETE-phase arm exists to catch, on whatever project, membership,
 * decision and user the seed just created. The INSERT seals belong to 4d-ii's writers; this plant
 * is about the RESET, so they are disabled by name for exactly these two statements and re-enabled
 * unconditionally — PostgreSQL DDL is transactional, so a failure rolls the disable back with it.
 */
const PLANT = `
BEGIN;
ALTER TABLE "MembershipTransition" DISABLE TRIGGER "MembershipTransition_t4d_seal";
ALTER TABLE "MembershipTransition" DISABLE TRIGGER "MembershipTransition_t4d_provenance_bound";
ALTER TABLE "DecisionForward" DISABLE TRIGGER "DecisionForward_t4d_reserved";
ALTER TABLE "DecisionForward" DISABLE TRIGGER "DecisionForward_t4d_seal";
ALTER TABLE "DecisionForward" DISABLE TRIGGER "DecisionForward_t4d_paired";
ALTER TABLE "DecisionForward" DISABLE TRIGGER "DecisionForward_t4d_provenance_bound";
INSERT INTO "CommandExecution"
  ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
  SELECT 'RLC-CMD', 'project', p."orgId", m."projectId", m."userId", 'members.updateRole',
         'RLC-KEY', 'RLC-HASH', 'reserved'
    FROM "Membership" m JOIN "Project" p ON p."id" = m."projectId" ORDER BY m."id" LIMIT 1;
UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(),
       "resultRef" = (SELECT "id" FROM "Membership" ORDER BY "id" LIMIT 1)
 WHERE "id" = 'RLC-CMD';
INSERT INTO "MembershipTransition"
  ("id","projectId","membershipId","userId","role","fromStanding","toStanding","activeCount",
   "actorId","actorRole","actorName","sourceCommandId")
  SELECT 'RLC-MT', m."projectId", m."id", m."userId", m."role", 'not_held', 'held', 1,
         m."userId", m."role", u."name", 'RLC-CMD'
    FROM "Membership" m JOIN "User" u ON u."id" = m."userId" ORDER BY m."id" LIMIT 1;
INSERT INTO "DecisionForward"
  ("id","projectId","decisionId","fromDesignationKind","toDesignationKind",
   "forwardedById","forwardedByRole","forwardedByName","reason","sourceCommandId")
  SELECT 'RLC-FWD', d."projectId", d."id", 'client', 'pmc', m."userId", m."role", u."name",
         'reset closure plant', 'RLC-CMD'
    FROM "Decision" d
    JOIN "Membership" m ON m."projectId" = d."projectId"
    JOIN "User" u ON u."id" = m."userId"
   ORDER BY d."id", m."id" LIMIT 1;
-- the FKs on both tables are deferrable, and PostgreSQL refuses ALTER TABLE while a table
-- carries pending trigger events, so the queue is flushed before the seals go back on.
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE "DecisionForward" ENABLE TRIGGER "DecisionForward_t4d_provenance_bound";
ALTER TABLE "DecisionForward" ENABLE TRIGGER "DecisionForward_t4d_paired";
ALTER TABLE "DecisionForward" ENABLE TRIGGER "DecisionForward_t4d_seal";
ALTER TABLE "DecisionForward" ENABLE TRIGGER "DecisionForward_t4d_reserved";
ALTER TABLE "MembershipTransition" ENABLE TRIGGER "MembershipTransition_t4d_provenance_bound";
ALTER TABLE "MembershipTransition" ENABLE TRIGGER "MembershipTransition_t4d_seal";
COMMIT;
`;

/** The named `const <NAME> = [...] as const;` array literal, as plain strings. */
function resetList(name: string): string[] {
  const text = readFileSync(SEED, 'utf8');
  const start = text.indexOf(`const ${name} = [`);
  expect(start, `prisma/seed.ts must declare ${name}`).toBeGreaterThan(-1);
  const end = text.indexOf('] as const;', start);
  expect(end, `${name} must end with its \`] as const;\``).toBeGreaterThan(start);
  return [...text.slice(start, end).matchAll(/'([A-Za-z][A-Za-z0-9]*)'/g)].map((m) => m[1]!);
}

describe('the seed\'s TRUNCATE lists are closed under foreign-key references (live PG)', () => {
  let t: TestApp;
  /** referenced table → the tables carrying a foreign key onto it, as PostgreSQL holds it. */
  let refs: Map<string, Set<string>>;

  beforeAll(async () => {
    t = await createTestApp();
    const rows = await t.prisma.$queryRaw<Array<{ parent: string; child: string }>>`
      SELECT c.confrelid::regclass::text AS parent, c.conrelid::regclass::text AS child
        FROM pg_constraint c
       WHERE c.contype = 'f'`;
    refs = new Map();
    for (const { parent, child } of rows) {
      const p = parent.replace(/"/g, '');
      const ch = child.replace(/"/g, '');
      if (!refs.has(p)) refs.set(p, new Set());
      refs.get(p)!.add(ch);
    }
  });

  afterAll(async () => { await t?.close(); });

  it('the database actually declares references — an empty map would make every list vacuously closed', () => {
    expect(refs.size).toBeGreaterThan(20);
    expect(refs.get('DomainEvent'), 'DomainEvent is referenced by the outbox at minimum').toBeDefined();
    expect(refs.get('DomainEvent')!.has('OutboxDelivery')).toBe(true);
    // and the SQL-only foreign key the DMMF cannot see, which is the reason this suite is here
    expect(
      refs.get('DomainEvent')!.has('Notification'),
      'Notification.eventId is declared in the migration SQL, not as a Prisma relation — if this '
      + 'is false the query is wrong and every assertion below is vacuous',
    ).toBe(true);
  });

  for (const listName of ['RESET_EVENTS', 'RESET_TABLES'] as const) {
    it(`${listName} names every table that references one of its members`, () => {
      const list = resetList(listName);
      expect(list.length, `${listName} must parse to a non-empty list`).toBeGreaterThan(5);
      const inList = new Set(list);

      const missing: string[] = [];
      for (const parent of list) {
        for (const child of refs.get(parent) ?? []) {
          if (child !== parent && !inList.has(child)) missing.push(`${child} (references ${parent})`);
        }
      }

      expect(
        [...new Set(missing)].sort(),
        `these tables carry a foreign key onto a table ${listName} truncates, and PostgreSQL `
        + 'refuses to truncate a referenced table unless every referencing table is named in the '
        + 'SAME statement — ON DELETE CASCADE does not exempt them. Add each to '
        + `${listName} in prisma/seed.ts, and give it a TRUNCATE_SEALS entry in `
        + 'prisma/sanctioned-reset.ts if it carries a no-TRUNCATE seal. The other integration '
        + 'suites pass `{ cascade: true }` and will NOT catch this; the seed does not, so without '
        + 'this arm the only signal is a red api-e2e check on CI, one missing table per round.',
      ).toEqual([]);
    });
  }

  /**
   * Phase 6 unit 4d-i, round 1 — the DELETE phase, which the two arms above cannot see, proven
   * by RUNNING THE SEED rather than by reasoning about it.
   *
   * WHAT THE ARMS ABOVE MISS. They ask whether each TRUNCATE list is internally closed. The seed
   * then clears a second set of tables with `deleteMany`, and `Membership`, `Decision` and `User`
   * — three of the most referenced tables in the schema — are in THAT set. A table referencing
   * one of them is invisible to those arms and breaks the seed two ways: a NO ACTION key refuses
   * the delete outright, or a CASCADE key delivers a row DELETE into a seal that was never asked
   * about this wipe. Codex round 1, finding 7 is the second shape — `MembershipTransition`
   * cascades from `Membership` into `_t4d_append_only`, which admits a delete only under the
   * project-deletion flag — and `DecisionForward` is the first, from three parents at once.
   *
   * WHY THIS IS DYNAMIC AND NOT A STATIC CLOSURE. A static version of this arm was written first
   * and produced eleven FALSE positives on a seed that works: a child reached only through an
   * earlier parent's cascade is already gone (`WorkerSkill` via `Worker`), and a DELETE trigger
   * is not the same as a DELETE refusal (`ProjectOrg_t4d_writer` and its siblings ADMIT a
   * cascade, which arrives nested). Encoding those exceptions is encoding a second copy of the
   * seed's reasoning, and the first draft of THIS FILE already shipped one tripwire that passed
   * vacuously by modelling instead of asking. So this arm asks the only oracle that cannot be
   * wrong: it runs the seed, plants one row in each newly sealed register the way a real run
   * would leave one, and runs the seed AGAIN.
   *
   * The SECOND run is the whole point. The first seed of an empty database deletes nothing, so
   * no seal fires and no key is tested — which is exactly why the previous defect of this family
   * reached CI. The plant between the runs is what makes the second one meet the rows.
   */
  it('the seed runs AGAIN over a database holding the rows this unit seals', () => {
    const base = process.env.DATABASE_URL;
    expect(base, 'this arm needs a server to create its scratch database on').toBeTruthy();
    const api = join(__dirname, '..', '..');

    // ON ITS OWN DATABASE, never the suite's. The seed is a DESTRUCTIVE reset followed by a
    // fixture: running it against the shared integration database wipes what every other suite
    // built and leaves its own rows behind, which is a pollution the first version of this arm
    // caused and four unrelated probes reported.
    const scratch = 't4d_reset_closure';
    const scratchUrl = dbUrl(base!, scratch);
    psqlAdmin(base!, `DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
    psqlAdmin(base!, `CREATE DATABASE "${scratch}"`);
    try {
      execFileSync('npx', ['prisma', 'migrate', 'deploy'],
        { cwd: api, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, DATABASE_URL: scratchUrl } });

      const seed = (): { ok: boolean; out: string } => {
        try {
          return { ok: true, out: execFileSync('npx', ['tsx', 'prisma/seed.ts'],
            { cwd: api, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
              env: { ...process.env, DATABASE_URL: scratchUrl } }) };
        } catch (e) {
          const err = e as { stdout?: string; stderr?: string };
          return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
        }
      };

      const first = seed();
      expect(first.ok, `the seed must run over a freshly migrated database at all:\n${first.out}`).toBe(true);

      // The plant: one row in each register whose omission this arm exists to catch, written the
      // way the seed will meet it — a committed row referencing the seeded project's own
      // membership, decision and user. The fact seals are 4d-ii's writers' business, not this
      // arm's, so the plant disables them BY NAME, exactly as `fixtures.ts` plants a legacy event.
      execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', adminUrl(scratchUrl), '-c', PLANT], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });

      const second = seed();
      expect(
        second.ok,
        'the seed aborted on a database holding a MembershipTransition and a DecisionForward. '
        + 'Every table this unit seals must be cleared BEFORE the `deleteMany` that reaches it — '
        + 'add it to RESET_TABLES in prisma/seed.ts, with a TRUNCATE_SEALS entry in '
        + `prisma/sanctioned-reset.ts if it carries a no-TRUNCATE seal:\n${second.out}`,
      ).toBe(true);
    } finally {
      psqlAdmin(base!, `DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
    }
  }, 600_000);
});
