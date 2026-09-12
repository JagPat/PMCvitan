import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { effectCoverageVersion } from '../../src/platform/external-effects';

/**
 * THIS release's coverage generation. From round 8's finding 3 the migration seeds TWO — this one
 * and the outgoing `6313b00c…` a still-serving process emits — so a fixture that picks a catalog
 * row by `effectKey` alone now matches both and plants two events at one stream position. Every
 * plant here stands in for a CURRENT writer, so it names the version a current writer computes.
 */
const COVERAGE = effectCoverageVersion();


/**
 * Phase 6 unit 4d-i — THE SEAL-STRIPPED MIGRATION HARNESS (§C).
 *
 * BOARD DECISION, not re-litigable (2026-08-29, on PR #480, carried from the 4c plan §C): a probe
 * whose subject is a NEW seal is proven by applying this unit's migration TWICE to scratch
 * databases — once with the specific seal statement OMITTED, where the hostile write is ACCEPTED,
 * and once WHOLE, where the same write is REJECTED. The omission is performed BY THE TEST, one
 * named object at a time.
 *
 * WHY THAT SHAPE AND NOT `expect(...).rejects`. An ordinary probe proves only that SOMETHING
 * refused the write. This one proves WHICH thing did: strip exactly one named object and the same
 * statement commits. That is the difference between "the database said no" and "this seal says
 * no", and it is what makes a green suite evidence about the seal a reviewer is reading rather
 * than about the pile of seals around it. The `deciderKind = 'architect'` arm below is the
 * standing example — the first hostile statement written for it was refused by the DELIVERED 4b
 * attribution seal, and the door under test never fired.
 *
 * HOW THE OMISSION IS PERFORMED. By name, on the migration TEXT, before it is applied:
 *
 *   · a top-level `CREATE [CONSTRAINT] TRIGGER "N" … ;` is DELETED outright;
 *   · one inside a `DO $$ … $$` block is replaced with plpgsql's `NULL;` no-op, because deleting
 *     it would leave an empty `THEN` and the file would not parse — a stripped run that fails to
 *     apply proves nothing at all.
 *
 * Each strip asserts it matched exactly once, and each stripped database asserts the trigger is
 * ABSENT before the hostile write runs. Both guards exist because a strip that silently matched
 * nothing would turn every arm into a tautology: the seal would be present in both runs, the
 * "stripped" write would be refused, and the arm would fail — loudly, which is the point.
 *
 * COVERAGE IS DECLARED, NOT ASSUMED. The last arm reads the FULL `_t4d_` inventory out of the
 * whole-migration database and requires every seal to be either stripped by an arm here or named
 * in `COVERED_BY_CLASS` with the arm that exercises its mechanism. A seal that appears in neither
 * fails the suite, so a later unit cannot add a seal and leave it unproven.
 */

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'prisma', 'migrations');

/**
 * THE UNIT IS TWO MIGRATION FILES, applied in this order.
 *
 * #582's lifecycle asked six times for a split, and the seam it was finally split at is the one
 * this harness has to straddle: the four adopted platform registers, their baseline audits and
 * their writers separate cleanly from the decisions fact tables and their pairing seals, with no
 * dependency in that direction — the registers do not read a fact table; the fact seals read the
 * registers. So `MIGRATION` applies first and STANDS ALONE, and `FACTS` applies on top of it.
 *
 * Every claim this suite makes is about the UNIT and not about either file, so the strip is
 * performed across the PAIR: a seal named for omission must be created exactly once across BOTH
 * files, and a name that matched nothing in either is the same tautology the single-file guard
 * existed to refuse. An arm that applies one file by name does so because the audit it measures
 * lives in that file, and the abort it asserts is that file's abort.
 */
const UNIT_DIRS = [
  '20271220000000_phase6_t4d_i_dark_migration',
  '20271221000000_phase6_t4d_i_decision_facts',
] as const;
/** the registers half — the catalog, the four adopted registers, MembershipTransition, the
 *  kernel envelope/allocation/notification seals, and the generic pairing mechanism */
const MIGRATION = join(MIGRATIONS_DIR, UNIT_DIRS[0], 'migration.sql');
/** the decisions half — the three dark fact tables, their seven obligations, and the widened
 *  4b/4c seals that read them */
const FACTS = join(MIGRATIONS_DIR, UNIT_DIRS[1], 'migration.sql');
/** the whole unit, in apply order */
const UNIT_FILES = [MIGRATION, FACTS] as const;

/**
 * The OUTGOING generation this unit seeds beside its own — `origin/main`'s coverage version. Read
 * out of the migration rather than retyped, so a probe can never assert against a constant the
 * file stopped using.
 */
const OUTGOING = (() => {
  const m = readFileSync(MIGRATION, 'utf8')
    .match(/SELECT '([0-9a-f]{64})',\n\s+c\."effectKey"/);
  if (!m) throw new Error('the outgoing coverage generation could not be read from the migration');
  return m[1]!;
})();

const BASE_DB = 't4d_seal_stripped_base';
const RUN_DB = 't4d_seal_stripped_run';

/** The connection this suite's scratch databases live on: the configured server, a chosen
 *  database, and NO query string — Prisma's `?schema=public` is not a libpq URI parameter and
 *  psql refuses it. */
function adminUrl(db: string): string {
  const raw = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/pmcvitan_test';
  const url = new URL(raw);
  url.search = '';
  url.pathname = `/${db}`;
  return url.toString();
}

/** psql, returning {ok, output}. Never throws on SQL error — the outcome IS the measurement. */
function psql(db: string, args: string[]): { ok: boolean; output: string } {
  try {
    const out = execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', adminUrl(db), ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, output: out };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

let tmp: string;

/**
 * Omit one named seal from the migration, BY NAME, in one of two modes.
 *
 * `omit` — the CREATE is a literal statement in the file, so it is removed: outright at top
 * level, or replaced with plpgsql's `NULL;` no-op inside a `DO $$ … $$` block, where deleting it
 * would leave an empty `THEN` and the file would not parse.
 *
 * `drop` — the CREATE is SYNTHESIZED by a `FOREACH … EXECUTE format('CREATE TRIGGER %I …')` loop,
 * where the name never appears as literal text and no textual excision is possible without
 * rewriting plpgsql (which would change far more than the one object). Those are omitted by
 * appending `DROP TRIGGER "N" ON "T";` to the file: the resulting database carries exactly the
 * object set that omitting the CREATE would produce, which is the property every arm rests on.
 * The strip still binds to a REAL installer — it asserts the loop that names the suffix is in the
 * file — and `buildRun` then asserts the trigger is genuinely ABSENT before any hostile write.
 */
function stripSeal(sources: readonly string[], name: string): string[] {
  const re = new RegExp(`(^[ \\t]*)CREATE (?:CONSTRAINT )?TRIGGER "${name}"[\\s\\S]*?;`, 'gm');
  // counted across the PAIR, not per file: the unit is two files now, and "exactly once in the
  // file I happened to look at" would pass for a seal created in both.
  const hits = sources.reduce((n, sql) => n + (sql.match(re)?.length ?? 0), 0);
  if (hits > 0) {
    expect(hits, `"${name}" must be created exactly once across the unit for the strip to mean anything`).toBe(1);
    return sources.map((sql) => sql.replace(re, (_m, indent: string) => (indent.length > 0 ? `${indent}NULL;` : '')));
  }
  const table = name.replace(/_t4d_.*$/, '');
  const suffix = name.slice(table.length);
  // the DROP is appended to the file that carries the LOOP, because that is the file whose apply
  // creates the trigger — appending it to the other one would run before the CREATE and fail.
  const carrier = sources.findIndex((sql) => sql.includes(`t || '${suffix}'`));
  expect(
    carrier,
    `"${name}" appears in the unit neither as a literal CREATE nor as a loop over '${suffix}' — `
    + 'the strip would omit nothing and the arm would be a tautology',
  ).toBeGreaterThanOrEqual(0);
  return sources.map((sql, i) => (
    i === carrier
      ? `${sql}\n-- seal-stripped harness: this ONE named object omitted\nDROP TRIGGER "${name}" ON "${table}";\n`
      : sql
  ));
}

/** Build a scratch database at the point BEFORE this unit's migration. */
function buildBase(): void {
  psql('postgres', ['-c', `DROP DATABASE IF EXISTS "${BASE_DB}" WITH (FORCE)`]);
  const created = psql('postgres', ['-c', `CREATE DATABASE "${BASE_DB}"`]);
  expect(created.ok, created.output).toBe(true);
  const unit = new Set<string>(UNIT_DIRS);
  for (const dir of readdirSync(MIGRATIONS_DIR).filter((d) => !unit.has(d) && !d.endsWith('.toml')).sort()) {
    const file = join(MIGRATIONS_DIR, dir, 'migration.sql');
    // Everything is applied the way Prisma applies it (one transaction, stop on error), because
    // some migrations take a LOCK TABLE and LOCK outside a transaction is an error. A migration
    // carrying `ALTER TYPE … ADD VALUE` is applied WITHOUT the outer `--single-transaction`: not
    // because PostgreSQL forbids the ADD in a transaction (it has permitted it since 12 — the
    // restriction is on CONSUMING the value before commit, and #582's round 3, finding 1
    // measured this unit's own file applying inside one BEGIN/COMMIT on 16), but because these
    // older files were written for the psql-per-statement shape and this builder only needs to
    // reach the pre-unit state, not to re-decide their boundaries.
    const body = readFileSync(file, 'utf8');
    const tx = /ALTER TYPE .* ADD VALUE/i.test(body) ? [] : ['--single-transaction'];
    const r = psql(BASE_DB, [...tx, '-f', file]);
    expect(r.ok, `base migration ${dir} failed:\n${r.output}`).toBe(true);
  }
}

/** A scratch database carrying this unit's migration — whole, or with ONE named seal omitted. */
function buildRun(strip: readonly string[]): void {
  psql('postgres', ['-c', `DROP DATABASE IF EXISTS "${RUN_DB}" WITH (FORCE)`]);
  const created = psql('postgres', ['-c', `CREATE DATABASE "${RUN_DB}" TEMPLATE "${BASE_DB}"`]);
  expect(created.ok, created.output).toBe(true);

  let sources: string[] = UNIT_FILES.map((f) => readFileSync(f, 'utf8'));
  for (const name of strip) sources = stripSeal(sources, name);
  const what = strip.length === 0 ? 'whole' : `${strip.join('+')}-stripped`;
  sources.forEach((sql, i) => {
    const file = join(tmp, `unit-${i}.sql`);
    writeFileSync(file, sql);
    const applied = psql(RUN_DB, ['-f', file]);
    expect(
      applied.ok,
      `the ${what} migration must APPLY (${UNIT_DIRS[i]}):\n${applied.output}`,
    ).toBe(true);
  });

  for (const name of strip) {
    const present = psql(RUN_DB, ['-t', '-A', '-c',
      `SELECT count(*) FROM pg_trigger WHERE tgname = '${name}' AND NOT tgisinternal`]);
    expect(present.output.trim(), `"${name}" must be ABSENT from the stripped database`).toBe('0');
  }

  const fx = psql(RUN_DB, ['-c', FIXTURE]);
  expect(fx.ok, `the world every arm writes against must plant cleanly:\n${fx.output}`).toBe(true);
}

/**
 * The WHOLE unit, applied in order to the current run database. Both files are re-runnable by
 * construction (`CREATE TABLE IF NOT EXISTS`, `DROP TRIGGER IF EXISTS` before each CREATE,
 * `CREATE OR REPLACE FUNCTION`, guarded constraints and indexes) — which is what migrate.sh's
 * ALWAYS_EXECUTE list rests on — so the arms that repair a planted database and re-apply use
 * this, and get the whole unit rather than the half that aborted.
 */
function applyWhole(): { ok: boolean; output: string } {
  for (const file of UNIT_FILES) {
    const r = psql(RUN_DB, ['-f', file]);
    if (!r.ok) return r;
  }
  return { ok: true, output: '' };
}

/**
 * The world the hostile statements are written against: one org, one project, a pmc and a client
 * membership (the 4b publication seal requires an active holder of the decider role), and one
 * PUBLISHED choice decision born unpublished with its option floor and published in the same
 * transaction — the shape 4b's entry seals admit.
 */
const FIXTURE = `
INSERT INTO "Org" ("id","name","slug") VALUES ('ss-org','SS Org','ss-org');
INSERT INTO "Project" ("id","orgId","name","short","descriptor","stage","siteCode","projStart","projEnd","elapsedPct","todayDay","milestonePct")
  VALUES ('ss-proj','ss-org','SS Site','SS','','Finishing','SS-01','01 Jan 2026','31 Dec 2026',0,0,0);
INSERT INTO "User" ("id","projectId","role","name","phone") VALUES
  ('ss-user','ss-proj','pmc','SS User','+910000000001'),
  ('ss-client','ss-proj','client','SS Client','+910000000002');
INSERT INTO "Membership" ("id","projectId","userId","role","status") VALUES
  ('ss-mem','ss-proj','ss-user','pmc','active'),
  ('ss-mem-c','ss-proj','ss-client','client','active');
BEGIN;
INSERT INTO "Decision" ("id","projectId","title","room","status","photoSwatch","publishedAt")
  VALUES ('ss-dec','ss-proj','SS Decision','Hall','pending','sw',NULL);
INSERT INTO "DecisionOption" ("id","decisionId","label","optionKey","material","delta","swatch","order")
  VALUES ('ss-opt-a','ss-dec','Option A','a','Granite',0,'sw1',0),
         ('ss-opt-b','ss-dec','Option B','b','Quartz',100,'sw2',1);
UPDATE "Decision" SET "publishedAt" = now() WHERE "id" = 'ss-dec';
COMMIT;
-- #582's review round 22, finding 3 — AN ALREADY-APPROVED DECISION, committed HERE.
-- The attack that round names is a NO-OP update against a decision that is ALREADY approved: it
-- supplies the xmin round 19 asked for and leaves the status round 19's strengthening asked for,
-- while transitioning nothing. Reproducing it needs a decision whose approval happened in an
-- EARLIER transaction, which ss-dec (pending) cannot be. The transition below is a real one, so
-- this block also stands as the legitimate path the new seal must keep admitting.
-- (No backticks in this block: it lives inside a TypeScript template literal.)
BEGIN;
INSERT INTO "Decision" ("id","projectId","title","room","status","photoSwatch","publishedAt")
  VALUES ('ss-dec2','ss-proj','SS Approved Decision','Hall','pending','sw',NULL);
INSERT INTO "DecisionOption" ("id","decisionId","label","optionKey","material","delta","swatch","order")
  VALUES ('ss-opt2-a','ss-dec2','Option A','a','Granite',0,'sw1',0),
         ('ss-opt2-b','ss-dec2','Option B','b','Quartz',100,'sw2',1);
UPDATE "Decision" SET "publishedAt" = now() WHERE "id" = 'ss-dec2';
UPDATE "Decision" SET "status" = 'approved' WHERE "id" = 'ss-dec2';
COMMIT;
-- one real event at a position taken from the allocator, and one SUCCEEDED command receipt: the
-- referents the fact and claim arms need, so their hostile writes are refused by the SEAL under
-- test and not by a foreign key that never had a row to point at.
-- The event is planted the way emitEvent plants one, and for the same reason the seals now
-- demand it: allocate by incrementing the counter, then insert at nextPosition - 1, IN ONE
-- TRANSACTION (§A.2). A counter row is created at 0 or not at all — _t4d_init refuses a stream
-- introduced further along — so the row is born here only if the project has none.
-- (No backticks in this block: it lives inside a TypeScript template literal.)
BEGIN;
INSERT INTO "ProjectEventStream" ("projectId","nextPosition") VALUES ('ss-proj', 0)
  ON CONFLICT ("projectId") DO NOTHING;
UPDATE "ProjectEventStream" SET "nextPosition" = "nextPosition" + 1 WHERE "projectId" = 'ss-proj';
INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","actorKind","systemActor","entityType","entityId","dispatchIntent")
  SELECT 'ss-ev1','decision.published',1,'ss-org','ss-proj',s."nextPosition" - 1,'system','system:seed','Decision','ss-dec',
         jsonb_build_object('effectKey','decision.published','coverageVersion',c."coverageVersion",'invalidate',c."invalidate",
                            'push', jsonb_build_object('body','ss','roles', jsonb_build_array('client')))
    FROM "ProjectEventStream" s, "ExternalEffectCatalog" c
   WHERE s."projectId" = 'ss-proj' AND c."effectKey" = 'decision.published'
     AND c."coverageVersion" = '${COVERAGE}';
COMMIT;
-- ONE LIVE LEASE for the drain-attestation arms: a serving process at catalog version 2 whose
-- lease runs an hour out. The table is DARK, so nothing else in this fixture reads or writes it.
INSERT INTO "ReleaseLease" ("instanceId","catalogVersion","release","startedAt","leaseUntil")
  VALUES ('ss-instance', 2, 'ss-release', now(), now() + interval '1 hour');
-- the receipt is RESERVED on insert and COMPLETES by update, because the delivered ledger
-- protocol refuses a receipt born terminal ("a command that never ran").
INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
  VALUES ('ss-cmd','project','ss-org','ss-proj','ss-user','decisions.forward','ss-key','ss-hash','reserved');
UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = 'ss-dec' WHERE "id" = 'ss-cmd';
-- A SECOND succeeded forward receipt, this one naming a forward id that does not exist yet, for
-- the transaction-predicate probe below. It is committed HERE, in the fixture, which is the whole
-- point: everything a later statement does with it is a different transaction, exactly as a
-- mature database's months-old receipts are.
INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
  VALUES ('ss-cmd-hist','project','ss-org','ss-proj','ss-user','decisions.forward','ss-key-hist','ss-hash-hist','reserved');
UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = 'ss-fwd-hist' WHERE "id" = 'ss-cmd-hist';
`;

/**
 * `seal` is the object under test. `alsoStrip` names OTHER 4d-i objects that stand IN FRONT of it
 * for this statement — a door whose subject a second seal also refuses. They are omitted together
 * so the stripped run reaches the write at all, and the whole-migration run still has to answer
 * with the SEAL'S OWN message, which is what binds the arm to the object it claims to measure.
 *
 * `polarity` is `refuses` for a seal (whole ⇒ REFUSED, stripped ⇒ accepted) and `admits` for a
 * compatibility SHIM — a trigger that exists so a PREVIOUS-RELEASE writer keeps working, where
 * the same two runs prove the opposite pair (whole ⇒ ACCEPTED, stripped ⇒ refused). Both are
 * two-run proofs about one named object; only the direction of the claim differs.
 */
type Arm = {
  seal: string;
  what: string;
  hostile: string;
  refusal: RegExp;
  alsoStrip?: string[];
  polarity?: 'refuses' | 'admits';
};

const ARMS: Arm[] = [
  {
    seal: 'Decision_t4d_architect_reserved',
    what: 'the architect DESIGNATION is unreachable until 4d-iii retires the door',
    hostile: `INSERT INTO "Decision" ("id","projectId","title","room","status","photoSwatch","deciderKind")
              VALUES ('ss-arch-dec','ss-proj','Reserved','Hall','pending','sw','architect')`,
    refusal: /Decision\.deciderKind = architect is not writable yet/,
  },
  {
    seal: 'Decision_t4d_awaiting_reserved',
    what: 'the chain STATE is unreachable until 4d-iii retires the door',
    hostile: `UPDATE "Decision" SET "status" = 'awaiting_countersign' WHERE "id" = 'ss-dec'`,
    refusal: /Decision\.status = awaiting_countersign is not writable yet/,
    // `Decision_t4d_entry_seal` refuses the same flip for a DIFFERENT reason (no active architect
    // to countersign), and `Decision_t4d_awaiting_paired` for a THIRD (no provisional revision is
    // born by a bare status flip — #582 round 12, finding 6). All three are 4d-i's; the door is
    // the one whose message the whole run returns, because a BEFORE trigger fires in NAME order
    // and `_awaiting_reserved` precedes `_entry_`, while the other two are deferred to COMMIT and
    // never reached once the door has raised.
    alsoStrip: ['Decision_t4d_entry_seal', 'Decision_t4d_awaiting_paired'],
  },
  {
    seal: 'Membership_t4d_architect_reserved',
    what: 'an architect MEMBERSHIP is unreachable until 4d-iii retires the door',
    // a DISTINCT user: `Membership_projectId_userId_key` would otherwise refuse the row before
    // the door ever fires, and the stripped run would measure the unique index.
    hostile: `INSERT INTO "User" ("id","projectId","role","name","phone")
                VALUES ('ss-arch-m','ss-proj','pmc','Arch M','+910000000009');
              INSERT INTO "Membership" ("id","projectId","userId","role","status")
              VALUES ('ss-arch','ss-proj','ss-arch-m','architect','active')`,
    refusal: /Membership\.role = architect is not writable yet/,
    // `Membership_t4d_architect_provenance` refuses the same row for a different reason (no
    // MembershipTransition recording the act). Both are 4d-i's; the door answers first by name.
    alsoStrip: ['Membership_t4d_architect_provenance'],
  },
  {
    seal: 'User_t4d_architect_reserved',
    what: 'an architect USER row is unreachable until 4d-iii retires the door',
    hostile: `INSERT INTO "User" ("id","projectId","role","name","phone")
              VALUES ('ss-arch-u','ss-proj','architect','Arch','+910000000003')`,
    refusal: /User\.role = architect is not writable yet/,
  },
  {
    seal: 'DecisionEvent_t4d_append_only',
    what: 'the attributable audit register refuses DELETE',
    hostile: `INSERT INTO "DecisionEvent" ("id","decisionId","type","actor") VALUES ('ss-ev','ss-dec','published','X');
              DELETE FROM "DecisionEvent" WHERE "id" = 'ss-ev'`,
    refusal: /"DecisionEvent" is the attributable audit register and is append-only/,
  },
  {
    seal: 'DecisionEvent_t4d_kind_reserved',
    what: 'the audit register\'s 4d-only KINDS are reserved, like the states they record',
    // #582 round 15, finding 2. `countersigned` records an act whose command lands in 4d-ii, so
    // in the dark window nothing can legitimately write this row — and, before this door, nothing
    // refused it either: on an `approved` decision the weak correspondence's table pairs the kind
    // with the approval's own `decision.approved` event and is answered, the row commits,
    // `DecisionEvent_t4d_append_only` freezes it, and 4d-iii's stronger INSERT trigger judges only
    // NEW rows — permanent evidence of a countersign nobody performed.
    //
    // THE (`countersigned`, `pending`) PAIR IS NOW THE CORRESPONDENCE'S OWN REFUSAL (#582's review
    // round 24, finding 1). This comment used to say that pair "returns NULL and judges nothing at
    // all", which was true and was the hole that finding closes. The arm therefore omits the
    // correspondence alongside the door: both are this unit's, and with the door stripped the
    // write must reach the table at all for the arm to measure the DOOR rather than the seal that
    // now stands behind it.
    alsoStrip: ['DecisionEvent_t4d_correspondence'],
    hostile: `INSERT INTO "DecisionEvent" ("id","decisionId","type","actor","actorId","actorName","actorRole","payload")
              VALUES ('ss-de-cs','ss-dec','countersigned','SS User','ss-user','SS User','pmc','{}'::jsonb)`,
    refusal: /DecisionEvent\.type = a 4d-only kind is not writable yet/,
  },
  {
    seal: 'ExternalEffectCatalog_t4d_no_truncate',
    what: 'a projected register is never truncated — the STATEMENT is sealed, not just the row',
    hostile: `TRUNCATE "ExternalEffectCatalog"`,
    refusal: /is a projected register .* and is never truncated/,
  },
  {
    seal: 'ExternalEffectCatalog_t4d_sealed',
    what: 'a catalog entry leaves service by being RETIRED, never by being deleted',
    hostile: `DELETE FROM "ExternalEffectCatalog" WHERE "effectKey" = 'decision.approved'`,
    refusal: /may not be DELETED/,
  },
  {
    seal: 'RolloutRetirement_t4d_gate',
    what: 'the retirement marker is written by the retiring migration, never by a statement',
    hostile: `INSERT INTO "RolloutRetirement" ("unit","retiredBy") VALUES ('phase6-4d','me')`,
    refusal: /written only by the retiring migration/,
  },
  {
    seal: 'RolloutRetirement_t4d_no_truncate',
    what: 'the rollout fact cannot be truncated away',
    hostile: `TRUNCATE "RolloutRetirement"`,
    refusal: /never truncated|no_truncate|truncate/i,
  },
  {
    seal: 'DomainEvent_t4d_envelope',
    what: 'half an actor envelope is refused — the pair is written together or not at all',
    // allocate and insert in ONE transaction, exactly as `emitEvent` does — so the ONLY thing
    // wrong with this write is the half-filled envelope, which is what the arm claims to measure.
    hostile: `BEGIN;
              UPDATE "ProjectEventStream" SET "nextPosition" = "nextPosition" + 1 WHERE "projectId" = 'ss-proj';
              INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","actorId","actorKind","entityType","entityId","actorRole","dispatchIntent")
              SELECT 'ss-half','decision.drafted',1,'ss-org','ss-proj',s."nextPosition" - 1,'ss-user','human','Decision','ss-dec','pmc',
                     jsonb_build_object('effectKey','decision.drafted','coverageVersion',c."coverageVersion",'invalidate',c."invalidate")
                FROM "ProjectEventStream" s, "ExternalEffectCatalog" c
               WHERE s."projectId" = 'ss-proj' AND c."effectKey" = 'decision.drafted'
                 AND c."coverageVersion" = '${COVERAGE}';
              COMMIT`,
    refusal: /carries half an actor envelope/,
  },
  // ── the INTENT half of the envelope (#582 round 2, finding 1) ────────────────────────────
  // Three arms, because the intent arm makes three different claims and a single hostile write
  // would prove whichever one happens to fire first. Each carries a CORRECT allocation and a
  // correct actor envelope, so the only thing wrong with it is the one the arm names.
  {
    seal: 'DomainEvent_t4d_envelope',
    what: 'an intent naming a catalog entry this database does not hold is refused',
    hostile: `BEGIN;
              UPDATE "ProjectEventStream" SET "nextPosition" = "nextPosition" + 1 WHERE "projectId" = 'ss-proj';
              INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","actorKind","systemActor","entityType","entityId","dispatchIntent")
              SELECT 'ss-unknown','decision.drafted',1,'ss-org','ss-proj',s."nextPosition" - 1,'system','system:seed','Decision','ss-dec',
                     jsonb_build_object('effectKey','decision.drafted','coverageVersion','not-a-version','invalidate',false)
                FROM "ProjectEventStream" s WHERE s."projectId" = 'ss-proj';
              COMMIT`,
    refusal: /which this database does not hold/,
  },
  {
    seal: 'DomainEvent_t4d_envelope',
    what: 'an intent that suppresses the catalog\'s invalidation is refused',
    // the shape that leaves every open surface showing the state before the act: the catalog
    // says this family invalidates, the persisted intent says it does not, and the relay
    // rebuilds from the intent.
    hostile: `BEGIN;
              UPDATE "ProjectEventStream" SET "nextPosition" = "nextPosition" + 1 WHERE "projectId" = 'ss-proj';
              INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","actorKind","systemActor","entityType","entityId","dispatchIntent")
              SELECT 'ss-noinval','decision.published',1,'ss-org','ss-proj',s."nextPosition" - 1,'system','system:seed','Decision','ss-dec',
                     jsonb_build_object('effectKey','decision.published','coverageVersion',c."coverageVersion",'invalidate',false,
                                        'push', jsonb_build_object('body','ss','roles', jsonb_build_array('client')))
                FROM "ProjectEventStream" s, "ExternalEffectCatalog" c
               WHERE s."projectId" = 'ss-proj' AND c."effectKey" = 'decision.published'
     AND c."coverageVersion" = '${COVERAGE}';
              COMMIT`,
    refusal: /claims invalidate=/,
  },
  {
    seal: 'DomainEvent_t4d_envelope',
    what: 'a push audience wider than the catalog ceiling is refused',
    // `decision.approved` broadcasts to pmc/contractor/engineer; `client` is outside that
    // ceiling, so this is an audience invented at the write rather than narrowed from one.
    hostile: `BEGIN;
              UPDATE "ProjectEventStream" SET "nextPosition" = "nextPosition" + 1 WHERE "projectId" = 'ss-proj';
              INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","actorKind","systemActor","entityType","entityId","dispatchIntent")
              SELECT 'ss-widened','decision.approved',1,'ss-org','ss-proj',s."nextPosition" - 1,'system','system:seed','Decision','ss-dec',
                     jsonb_build_object('effectKey','decision.approved','coverageVersion',c."coverageVersion",'invalidate',c."invalidate",
                                        'push', jsonb_build_object('body','ss','roles', jsonb_build_array('pmc','contractor','engineer','client')))
                FROM "ProjectEventStream" s, "ExternalEffectCatalog" c
               WHERE s."projectId" = 'ss-proj' AND c."effectKey" = 'decision.approved'
                 AND c."coverageVersion" = '${COVERAGE}';
              COMMIT`,
    refusal: /outside the ceiling/,
  },
  {
    seal: 'ProjectEventStream_t4d_allocation',
    what: 'the allocator moves by EXACTLY ONE — a jump leaves positions nobody can fill',
    // §A.2's rule, and the one the first implementation weakened to "any increase" (Codex round 1,
    // finding 7). Starting at N, a jump to N+2 with no events passed the old pair, and the next
    // legitimate emit then wrote N+2 — leaving N and N+1 empty forever, which stalls
    // `dispatchOrdered` at the hole and makes every rebuild report a replay gap.
    hostile: `UPDATE "ProjectEventStream" SET "nextPosition" = "nextPosition" + 2 WHERE "projectId" = 'ss-proj'`,
    refusal: /moves by exactly one/,
    // with the `+1` rule omitted, the DEFERRED converse still refuses an increment whose position
    // no event took, so both are stripped together and the immediate rule answers first by name.
    alsoStrip: ['ProjectEventStream_t4d_allocation_bound'],
  },
  {
    // #582 round 9, finding 4 — `->>` returns NULL only for an absent key or a JSON null, so a
    // blank target reads as PRESENT and satisfies a targeted family. The consumer's `if
    // (!targetUserId)` branch then marks the delivery non-actionable and the announcement the
    // catalog REQUIRES is cancelled with nothing raised. Same blank-string class as the push body.
    seal: 'DomainEvent_t4d_envelope',
    what: 'a targeted push naming a BLANK user is refused — an empty target is a cancelled announcement',
    hostile: `BEGIN;
              UPDATE "ProjectEventStream" SET "nextPosition" = "nextPosition" + 1 WHERE "projectId" = 'ss-proj';
              INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","actorKind","systemActor","entityType","entityId","dispatchIntent")
                SELECT 'ss-ev-blank','decision.consultation_requested',1,'ss-org','ss-proj',s."nextPosition" - 1,'system','system:seed','Decision','ss-dec',
                       jsonb_build_object('effectKey','decision.consultation_requested','coverageVersion',c."coverageVersion",'invalidate',c."invalidate",
                                          'push', jsonb_build_object('body','ss','roles', jsonb_build_array('pmc'), 'targetUserId', ''))
                  FROM "ProjectEventStream" s, "ExternalEffectCatalog" c
                 WHERE s."projectId" = 'ss-proj' AND c."effectKey" = 'decision.consultation_requested'
                   AND c."coverageVersion" = '${COVERAGE}';
              COMMIT;`,
    refusal: /names a target that is not a nonblank string/,
  },
  {
    seal: 'ProjectEventStream_t4d_no_delete',
    what: 'the allocator row cannot be dropped — deleting and recreating it bypasses the +1 rule',
    hostile: `DELETE FROM "ProjectEventStream" WHERE "projectId" = 'ss-proj'`,
    refusal: /may not be DELETED/,
  },
  {
    seal: 'ProjectEventStream_t4d_init',
    what: 'an allocator row is born at 0, on a project that has no events',
    // #561's review round 1, finding 7, which this unit had left unimplemented: a transaction
    // could delete a project's stream row, reinsert it at N + 2 and insert one event at N + 1 —
    // no UPDATE trigger firing at all — leaving position N absent forever.
    // The DELETE that sets this arm up is itself sealed, and `alsoStrip` would only remove that
    // seal from the STRIPPED run — the whole run would then be answered by `_t4d_no_delete` and
    // the arm would measure the wrong object. So the setup declares a NAMED BYPASS inside the
    // hostile SQL, identically in both runs, leaving `_t4d_init` as the only difference between
    // them.
    hostile: `ALTER TABLE "ProjectEventStream" DISABLE TRIGGER "ProjectEventStream_t4d_no_delete";
              DELETE FROM "ProjectEventStream" WHERE "projectId" = 'ss-proj';
              ALTER TABLE "ProjectEventStream" ENABLE TRIGGER "ProjectEventStream_t4d_no_delete";
              INSERT INTO "ProjectEventStream" ("projectId","nextPosition") VALUES ('ss-proj', 5)`,
    refusal: /created at position 0|already holds events/,
  },
  {
    seal: 'DomainEventPairingClaim_t4d_writer',
    what: 'the claim register is projected from a fact trigger, never typed by hand',
    hostile: `INSERT INTO "DomainEventPairingClaim" ("projectId","eventId","claimedBy","claimedById")
              VALUES ('ss-proj','ss-ev1','DecisionForward','x')`,
    refusal: /trigger depth|projected/,
  },
  {
    seal: 'ProjectOrg_t4d_writer',
    what: 'the tenancy register is projected, never written by a statement someone typed',
    hostile: `UPDATE "ProjectOrg" SET "orgId" = 'ss-org' WHERE "projectId" = 'ss-proj'`,
    refusal: /trigger depth|projected/,
  },
  {
    seal: 'ProjectRoleStanding_t4d_writer',
    what: 'the counted register is projected from the membership trigger',
    hostile: `INSERT INTO "ProjectRoleStanding" ("projectId","role","activeCount") VALUES ('ss-proj','architect',7)`,
    refusal: /trigger depth|projected/,
  },
  {
    seal: 'ProjectUserStanding_t4d_writer',
    what: 'the per-user standing register is projected, not typed',
    hostile: `UPDATE "ProjectUserStanding" SET "role" = 'pmc' WHERE "projectId" = 'ss-proj' AND "userId" = 'ss-user'`,
    refusal: /trigger depth|projected/,
  },
  {
    seal: 'UserIdentity_t4d_writer',
    what: 'the identity register is projected from the User trigger',
    hostile: `UPDATE "UserIdentity" SET "displayName" = 'Typed' WHERE "userId" = 'ss-user'`,
    refusal: /trigger depth|projected/,
  },
  {
    seal: 'OrgUserAuthority_t4d_writer',
    what: 'the org-authority register is projected from the OrgMembership trigger',
    hostile: `INSERT INTO "OrgUserAuthority" ("orgId","userId","role") VALUES ('ss-org','ss-user','owner')`,
    refusal: /trigger depth|projected/,
  },
  {
    seal: 'DecisionForward_t4d_reserved',
    what: 'the forward FACT table exists but nothing may write it — the door and the fact\'s own '
      + 'seven-obligation seal set are omitted together, and the door answers first by name',
    hostile: `INSERT INTO "DecisionForward"
                ("id","projectId","decisionId","fromDesignationKind","toDesignationKind",
                 "forwardedById","forwardedByRole","forwardedByName","reason","sourceCommandId")
              VALUES ('ss-fwd','ss-proj','ss-dec','client','pmc','ss-user','pmc','SS User','because','ss-cmd')`,
    refusal: /DecisionForward is not writable yet/,
    // §A.3's obligations are separate objects on the same table and each refuses this row on its
    // own terms (append-only, the pairing in both directions, the command receipt, the subject's
    // eligibility). They are omitted together so the stripped run reaches the write; the WHOLE
    // run still has to answer with the reserved door's own message.
    alsoStrip: [
      'DecisionForward_t4d_seal',
      'DecisionForward_t4d_paired',
      'DecisionForward_t4d_provenance_bound',
      'DecisionForward_t4d_append_only',
    ],
  },
  {
    seal: 'ChangeRequest_t4d_project',
    what: 'the PREVIOUS-RELEASE writer, which names no project, keeps working — the shim fills it',
    // `decisions.requestChange` as it ships today writes no `projectId`; 4d-i makes the column NOT
    // NULL. This trigger is the whole reason the delivered writer survives the drain, so the proof
    // runs the other way: with the shim the legacy-shaped insert COMMITS, without it the NOT NULL
    // refuses it. (P42's "a `ChangeRequest` inserted WITHOUT `projectId` is filled from its
    // decision"; §D's drain-window rule that a still-serving instance can run its five writers.)
    polarity: 'admits',
    hostile: `INSERT INTO "ChangeRequest" ("id","decisionId","reason","costImpact","timeImpactDays","status")
              VALUES ('ss-cr','ss-dec','x',0,0,'open')`,
    refusal: /never reached/,
  },
  {
    // #582's review round 22, finding 3 — A STATE IS NOT AN ACT.
    //
    // Round 19's finding 2 asked the finalized birth to ride its transition; round 19's first
    // answer, `xmin` alone, was satisfied by a NO-OP UPDATE, and the strengthening that followed
    // added the END STATUS. This is that same hole one step along: a no-op against a decision that
    // is ALREADY approved writes the row (the `xmin`) and leaves it approved (the status), and
    // transitions nothing. `ss-dec2` was approved in the FIXTURE's transaction, so the update
    // below changes no value and performs no move — and the forged finalized revision becomes the
    // head that 4c counts as a consultation cycle.
    seal: 'DecisionApprovalRevision_t4d_birth_paired',
    what: 'a FINALIZED revision may not be born beside a decision this transaction never MOVED',
    // RECEIPT-BACKED, which is the bundle Codex describes and also what the harness's own
    // tautology guard forced: `DecisionApprovalRevision_t4c_provenance` is a DELIVERED 4c-ii
    // trigger, so `alsoStrip` — which omits objects THIS unit creates — cannot take it out of the
    // way. Satisfying it instead is the better arm: the forger mints a real `decisions.approve`
    // receipt by the ledger protocol, naming the decision as its result, so 4c's provenance seal
    // is answered truthfully and the ONLY thing left between the forged revision and the register
    // is the transition demand this arm names.
    hostile: `INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
              VALUES ('ss-cmd-noop','project','ss-org','ss-proj','ss-user','decisions.approve','ss-key-noop','ss-hash-noop','reserved');
              UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = 'ss-dec2' WHERE "id" = 'ss-cmd-noop';
              UPDATE "Decision" SET "status" = 'approved' WHERE "id" = 'ss-dec2';
              INSERT INTO "DecisionApprovalRevision" ("id","projectId","decisionId","version","optionKey","approvedAt","approvedById","sourceCommandId")
              VALUES ('ss-rev-noop','ss-proj','ss-dec2',1,'a',now(),'ss-user','ss-cmd-noop')`,
    refusal: /transition of decision/,
  },
  {
    // #582's review round 22, finding 2 — THE CLOSURE RECEIPT WAS FROZEN AND NEVER JUDGED, which
    // is the sibling round 20's finding 1 left standing when it bound the BIRTH receipt.
    //
    // The request is born in the previous release's shape (no `sourceCommandId`), which the birth
    // binding's WHEN clause keeps out of it entirely — so nothing but the new closure binding is
    // in front of this write. `ss-cmd-hist` is a succeeded, same-project receipt the FIXTURE
    // committed and nothing cites: the FK is satisfied, the one-use unique index is satisfied, and
    // the resolver pair is TRUE of `ss-user`. Everything a forger controls is in order.
    seal: 'ChangeRequest_t4d_closure_bound',
    what: 'a closure may not cite a receipt an EARLIER transaction completed',
    hostile: `INSERT INTO "ChangeRequest" ("id","decisionId","projectId","reason","costImpact","timeImpactDays","status")
              VALUES ('ss-cr-cl','ss-dec','ss-proj','borrowed closure',0,0,'open');
              UPDATE "ChangeRequest" SET "resolvedByCommandId" = 'ss-cmd-hist', "resolvedById" = 'ss-user',
                     "resolvedByRole" = 'pmc', "resolvedByName" = 'SS User', "status" = 'withdrawn',
             "resolution" = 'withdrawn', "resolvedAt" = now()
               WHERE "id" = 'ss-cr-cl'`,
    // the phrase is the CLOSURE message's own — the birth binding's earlier-transaction refusal
    // shares the first half of that sentence, and an arm that either message could satisfy
    // witnesses neither (rounds 3 and 5, in the contract oracle).
    refusal: /past withdrawal or approval/,
  },
  {
    // #582's review round 20, finding 1 — THE BIRTH RECEIPT WAS FROZEN AND NEVER JUDGED.
    //
    // Round 8 made `sourceCommandId` immutable from the moment it lands; round 17 bound the
    // requester PAIR to its actor. Between them nothing asked what the receipt IS, so a direct
    // standard-request bundle could cite any unused historical same-project `CommandExecution` —
    // the FK is satisfied, the unique index is satisfied — and the freeze then made that false
    // provenance permanent, past anything 4d-iii's future-write seals can reach.
    //
    // `ss-cmd-hist` is exactly that: a succeeded, same-project receipt committed by the FIXTURE's
    // transaction and cited by nothing. Everything else about this request is legitimate.
    seal: 'ChangeRequest_t4d_source_bound',
    what: 'a change request may not cite a receipt an EARLIER transaction completed',
    hostile: `INSERT INTO "ChangeRequest" ("id","decisionId","projectId","reason","costImpact","timeImpactDays","status","sourceCommandId")
              VALUES ('ss-cr-hist','ss-dec','ss-proj','borrowed provenance',0,0,'open','ss-cmd-hist')`,
    refusal: /completed by an EARLIER transaction/,
  },
  {
    seal: 'ChangeRequest_t4d_evidence_frozen',
    what: 'a written command receipt cannot be CLEARED off a change request',
    // #582 round 3, finding 4 — the delivered `ChangeRequest_t4b2_seal` freezes `decisionId`
    // alone, and it is a MERGED migration, so every evidence column this unit adds arrived with
    // no freeze. The NULLing is the shape P33 names: the row keeps saying a request was raised
    // and stops saying which command raised it, and 4d-iii then seals that.
    hostile: `INSERT INTO "ChangeRequest" ("id","decisionId","reason","costImpact","timeImpactDays","status","sourceCommandId")
              VALUES ('ss-cr-ev','ss-dec','x',0,0,'withdrawn','ss-cmd');
              UPDATE "ChangeRequest" SET "sourceCommandId" = NULL WHERE "id" = 'ss-cr-ev'`,
    // #582 round 20, finding 1 put a DEFERRED binding in front of this write: the planted receipt
    // is a `decisions.forward` completed in the fixture's own transaction, which the new seal
    // refuses before this freeze is ever reached. It is omitted alongside, so the arm still
    // measures the FREEZE — the object it names — rather than the binding.
    alsoStrip: ['ChangeRequest_t4d_source_bound'],
    // #582 round 8, finding 5 split this freeze in two, and `sourceCommandId` is BIRTH
    // provenance, so it now answers with the birth message rather than the resolver one. The
    // regex moved with the rule: leaving it matching the old sentence would have made this arm
    // fail for a correction, which is the same "trace every consumer" step round 7 needed.
    refusal: /at its BIRTH and it may not be written, replaced or cleared/,
  },
  {
    // Codex round 1, finding 10, and the column set beyond it. The register's whole purpose is
    // that 4d-iii's preflight can ask "is any process of an older generation still serving?" and
    // trust the answer, so re-versioning a LIVE lease into the minimum is the exact write that
    // would talk the preflight into retiring the doors under a running old process.
    seal: 'ReleaseLease_t4d_frozen',
    what: 'a LIVE lease may not be re-versioned into the minimum',
    hostile: `UPDATE "ReleaseLease" SET "catalogVersion" = 1 WHERE "instanceId" = 'ss-instance'`,
    refusal: /identity .* is FROZEN/,
  },
  {
    // the same hole reached through the OTHER door. A lease whose expiry can be pulled back to
    // its own start reads to the preflight exactly like a stopped process — so the direction is
    // sealed, not merely the identity. (The `leaseUntil >= startedAt` CHECK is why the hostile
    // write lands ON the start and not before it: a write the CHECK refuses would be refused in
    // the STRIPPED run too, and the arm would measure the constraint instead of the seal.)
    seal: 'ReleaseLease_t4d_frozen',
    what: 'a live lease may not be SHORTENED into looking expired',
    hostile: `UPDATE "ReleaseLease" SET "leaseUntil" = "startedAt" WHERE "instanceId" = 'ss-instance'`,
    refusal: /may not move BACKWARD/,
  },
  {
    // #582 round 5, finding 1 — an EMPTY body is not a quiet announcement, it is none. The
    // delivered consumer reads a falsy body as a `noop`, so this shape passes every other clause
    // and silently declines to announce an event the catalog says always announces.
    seal: 'DomainEvent_t4d_envelope',
    what: 'a push body is a NONBLANK string — an empty one is read as a noop and never announces',
    hostile: `UPDATE "ProjectEventStream" SET "nextPosition" = "nextPosition" + 1 WHERE "projectId" = 'ss-proj';
              INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","actorKind","systemActor","entityType","entityId","dispatchIntent")
              SELECT 'ss-blank','decision.approved',1,'ss-org','ss-proj',s."nextPosition" - 1,'system','system:seed','Decision','ss-dec',
                     jsonb_build_object('effectKey','decision.approved','coverageVersion',c."coverageVersion",'invalidate',c."invalidate",
                                        'push', jsonb_build_object('body','   ','roles', c."pushRoles"))
                FROM "ProjectEventStream" s, "ExternalEffectCatalog" c
               WHERE s."projectId" = 'ss-proj' AND c."effectKey" = 'decision.approved'
                 AND c."coverageVersion" = '${COVERAGE}'`,
    refusal: /a push announces, so its body is a NONBLANK string/,
  },
  {
    // #582 round 5, finding 6 — the roles are the whole ceiling AND a target is named. The
    // delivered consumer prefers the target and returns, so one user receives a broadcast.
    seal: 'DomainEvent_t4d_envelope',
    what: 'a BROADCAST family may not also name a target — the consumer would deliver to it alone',
    hostile: `UPDATE "ProjectEventStream" SET "nextPosition" = "nextPosition" + 1 WHERE "projectId" = 'ss-proj';
              INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","actorKind","systemActor","entityType","entityId","dispatchIntent")
              SELECT 'ss-bcast-t','decision.approved',1,'ss-org','ss-proj',s."nextPosition" - 1,'system','system:seed','Decision','ss-dec',
                     jsonb_build_object('effectKey','decision.approved','coverageVersion',c."coverageVersion",'invalidate',c."invalidate",
                                        'push', jsonb_build_object('body','ok','roles', c."pushRoles",'targetUserId','ss-client'))
                FROM "ProjectEventStream" s, "ExternalEffectCatalog" c
               WHERE s."projectId" = 'ss-proj' AND c."effectKey" = 'decision.approved'
                 AND c."coverageVersion" = '${COVERAGE}'`,
    refusal: /is a BROADCAST family, but the push of event .* also names a target/,
  },
  {
    // #582 round 10, finding 4 — TWO FACTS, ONE WRITE. Every clause of the pairing is satisfied by
    // each row SEPARATELY, which is exactly what an existence test cannot see: the two rows
    // describe the write truthfully and differ only in the receipt they cite, and
    // `MembershipTransition_command_key` bounds facts per receipt. The add is an ENGINEER, so no
    // reservation door stands in front of it and the arm measures the pairing alone.
    seal: 'Membership_t4d_architect_provenance',
    what: 'two identical transition facts citing different receipts cannot record ONE membership write',
    hostile: `INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
                VALUES ('ss-cmd-t1','project','ss-org','ss-proj','ss-user','members.add','ss-key-t1','ss-hash-t1','reserved'),
                       ('ss-cmd-t2','project','ss-org','ss-proj','ss-user','members.add','ss-key-t2','ss-hash-t2','reserved');
              UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = 'ss-mem-e'
               WHERE "id" IN ('ss-cmd-t1','ss-cmd-t2');
              INSERT INTO "User" ("id","projectId","role","name","phone")
                VALUES ('ss-eng','ss-proj','engineer','SS Eng','+910000000021');
              INSERT INTO "MembershipTransition"
                ("id","projectId","membershipId","userId","fromRole","fromStatus","toRole","toStatus","actorId","actorRole","actorName","sourceCommandId")
              VALUES ('ss-mt-t1','ss-proj','ss-mem-e','ss-eng',NULL,NULL,'engineer','active','ss-user','pmc','SS User','ss-cmd-t1'),
                     ('ss-mt-t2','ss-proj','ss-mem-e','ss-eng',NULL,NULL,'engineer','active','ss-user','pmc','SS User','ss-cmd-t2');
              INSERT INTO "Membership" ("id","projectId","userId","role","status")
                VALUES ('ss-mem-e','ss-proj','ss-eng','engineer','active')`,
    refusal: /describe one and the same standing change of membership/,
  },
  {
    // #582 round 6, finding 2 — the ORDER. A member command that writes the membership before its
    // fact is refused: the fact's live authority read must see the PRE-state, and after 4d-iii a
    // membership-first bundle lets an actor's own promotion authorise itself.
    seal: 'Membership_t4d_fact_first',
    what: 'a member command writes its FACT before the membership write it describes',
    hostile: `INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
                VALUES ('ss-cmd-ord','project','ss-org','ss-proj','ss-user','members.updateRole','ss-key-ord','ss-hash-ord','reserved');
              UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = 'ss-mem-c' WHERE "id" = 'ss-cmd-ord';
              UPDATE "Membership" SET "status" = 'active' WHERE "id" = 'ss-mem-c'`,
    refusal: /has not been inserted yet — the fact comes FIRST/,
  },
  {
    // #582 round 12, finding 1 — A COMMAND'S WHOLE SHAPE. The fact is truthful about the write
    // it rides and cites a valid `members.add` receipt; only its SOURCE gives it away. Round 7
    // bound `updateRole`'s two ends and left the add's source and the removal's destination free,
    // so an add receipt could back a live engineer's promotion to architect.
    seal: 'MembershipTransition_t4d_provenance_bound',
    what: 'a `members.add` receipt may not back a transition that begins from a LIVE standing',
    hostile: `INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
                VALUES ('ss-cmd-shape2','project','ss-org','ss-proj','ss-user','members.add','ss-key-shape2','ss-hash-shape2','reserved');
              UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = 'ss-mem-c' WHERE "id" = 'ss-cmd-shape2';
              INSERT INTO "MembershipTransition"
                ("id","projectId","membershipId","userId","fromRole","fromStatus","toRole","toStatus","actorId","actorRole","actorName","sourceCommandId")
              VALUES ('ss-mt-shape2','ss-proj','ss-mem-c','ss-client','client','active','architect','active','ss-user','pmc','SS User','ss-cmd-shape2')`,
    refusal: /cites a `members.add` receipt — an add ends ACTIVE and begins from nothing at all or from `removed`/,
  },
  {
    // #582 round 12, finding 2 — A FROZEN PAIR IS TRUE OF ITS ACTOR. Round 11 gave this pair
    // nonblank and nothing else; every other pair in the unit goes through
    // `phase6_t4d_actor_bound`. The approver here is real and the receipt is real; only the ROLE
    // is invented, and the finalized notice would render it.
    seal: 'DecisionApprovalRevision_t4d_birth',
    what: 'an approval pair must be TRUE of its approver, not merely nonblank',
    hostile: `INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
                VALUES ('ss-cmd-fp','project','ss-org','ss-proj','ss-client','decisions.approve','ss-key-fp','ss-hash-fp','reserved');
              UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = 'ss-dec' WHERE "id" = 'ss-cmd-fp';
              INSERT INTO "DecisionApprovalRevision"
                ("id","projectId","decisionId","version","optionKey","approvedAt","approvedById","sourceCommandId","finalized","approvedByName","approvedByRole")
              VALUES ('ss-rev-fp','ss-proj','ss-dec',1,'a',now(),'ss-client','ss-cmd-fp',TRUE,'Somebody Else','architect')`,
    refusal: /a role that actor does not hold on project/,
    // #582 round 19, finding 2 — `_t4d_birth_paired` now also demands that a FINALIZED birth ride
    // the transition that produced it, and these plants are deliberately orphans. It stands in
    // front of the seal under test at COMMIT, so it is stripped with it; the whole-migration run
    // still has to answer with this seal's own message, which is what binds the arm to it.
    alsoStrip: ['DecisionApprovalRevision_t4d_birth_paired'],
  },
  {
    // #582 round 11, finding 2 — COHERENT IS NOT PRESENT. Both halves are non-null, so the
    // pair-coherence arm passes on them; the append-only seal then makes an envelope that names
    // nobody permanent, and 4d-iii's "every new human event carries the pair" is satisfied by it.
    seal: 'DomainEvent_t4d_envelope',
    what: 'an actor envelope of blanks attributes nothing and is refused',
    hostile: `UPDATE "ProjectEventStream" SET "nextPosition" = "nextPosition" + 1 WHERE "projectId" = 'ss-proj';
              INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","actorKind","actorId","entityType","entityId","actorRole","actorName","dispatchIntent")
              SELECT 'ss-blankactor','decision.published',1,'ss-org','ss-proj',s."nextPosition" - 1,'human','ss-user','Decision','ss-dec','   ','   ',
                     jsonb_build_object('effectKey','decision.published','coverageVersion',c."coverageVersion",'invalidate',c."invalidate",
                                        'push', jsonb_build_object('body','ok','roles', jsonb_build_array('client')))
                FROM "ProjectEventStream" s, "ExternalEffectCatalog" c
               WHERE s."projectId" = 'ss-proj' AND c."effectKey" = 'decision.published'
                 AND c."coverageVersion" = '${COVERAGE}'`,
    refusal: /carries a BLANK actor envelope/,
  },
  {
    // the SIBLING SITE the finding did not name. Sweeping "a frozen role/name pair is nonblank"
    // across the unit leaves exactly two members unguarded, and this is the other one.
    seal: 'DecisionApprovalRevision_t4d_birth',
    what: 'an approval pair of blanks attributes nothing and is refused',
    hostile: `INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
                VALUES ('ss-cmd-bp','project','ss-org','ss-proj','ss-client','decisions.approve','ss-key-bp','ss-hash-bp','reserved');
              UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = 'ss-dec' WHERE "id" = 'ss-cmd-bp';
              INSERT INTO "DecisionApprovalRevision"
                ("id","projectId","decisionId","version","optionKey","approvedAt","approvedById","sourceCommandId","finalized","approvedByName","approvedByRole")
              VALUES ('ss-rev-bp','ss-proj','ss-dec',1,'a',now(),'ss-client','ss-cmd-bp',TRUE,'  ','  ')`,
    refusal: /carries a BLANK approval pair/,
    // #582 round 19, finding 2 — `_t4d_birth_paired` now also demands that a FINALIZED birth ride
    // the transition that produced it, and these plants are deliberately orphans. It stands in
    // front of the seal under test at COMMIT, so it is stripped with it; the whole-migration run
    // still has to answer with this seal's own message, which is what binds the arm to it.
    alsoStrip: ['DecisionApprovalRevision_t4d_birth_paired'],
  },
  {
    // #582 round 10, finding 5 — TWO BIRTHS, ONE APPROVAL. Consecutive versions clear the
    // `(projectId, decisionId, version)` key, and each cites its own valid `decisions.approve`
    // receipt, so the 4c provenance seal passes on both. The project carries no architect here, so
    // both are born final — the same duplicate reaches the register through the no-chain approve
    // as through the provisional one, which is why the count is not scoped to the provisional arm.
    seal: 'DecisionApprovalRevision_t4d_birth_paired',
    what: 'one approval births ONE revision — sibling versions citing different receipts are refused',
    hostile: `INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
                VALUES ('ss-cmd-r1','project','ss-org','ss-proj','ss-client','decisions.approve','ss-key-r1','ss-hash-r1','reserved'),
                       ('ss-cmd-r2','project','ss-org','ss-proj','ss-client','decisions.approve','ss-key-r2','ss-hash-r2','reserved');
              UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = 'ss-dec'
               WHERE "id" IN ('ss-cmd-r1','ss-cmd-r2');
              INSERT INTO "DecisionApprovalRevision"
                ("id","projectId","decisionId","version","optionKey","approvedAt","approvedById","sourceCommandId")
              VALUES ('ss-rev-1','ss-proj','ss-dec',1,'a',now(),'ss-client','ss-cmd-r1'),
                     ('ss-rev-2','ss-proj','ss-dec',2,'a',now(),'ss-client','ss-cmd-r2')`,
    refusal: /rows BORN in this transaction/,
  },
  {
    // #582 round 6, finding 5 — a half or blank attribution pair is frozen the moment it lands,
    // so INSERT is the only moment it can be judged.
    seal: 'DecisionConsultation_t4d_attribution_present',
    what: 'a consultation attribution pair may not be written blank',
    // The write is LEGITIMATE in every respect the delivered 4c request seal judges — a
    // reserved-then-succeeded `consultations.request` receipt naming this row, the decision's
    // current open cycle, the active consultee and their canonical audience — because
    // `DecisionConsultation_t4c_request_seal` sorts BEFORE this trigger and would otherwise
    // answer for both runs, leaving the arm measuring a 4c object rather than mine. The one
    // defect left is the blank half of the attribution pair.
    hostile: `INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
                VALUES ('ss-cmd-con','project','ss-org','ss-proj','ss-user','consultations.request','ss-key-con','ss-hash-con','reserved');
              INSERT INTO "DecisionConsultation"
                ("id","projectId","decisionId","requestedById","consulteeMembershipId","consulteeUserId","question","openCycle","sourceCommandId","requestedByRole","requestedByName")
              VALUES ('ss-con-b','ss-proj','ss-dec','ss-user','ss-mem-c','ss-client','is this blank pair admitted?',0,'ss-cmd-con','   ','SS User');
              UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = 'ss-con-b' WHERE "id" = 'ss-cmd-con'`,
    refusal: /carries a blank attribution pair/,
  },
  {
    // ── #582's review round 17, the class-3 SWEEP ───────────────────────────────────────────
    // Round 16 gave three frozen role/name pairs their correspondence and the sweep of that
    // round ran along the tables its findings NAMED. These three arms are the pairs it did not
    // reach, and each is the same sentence: NONBLANK IS NOT CORRESPONDENCE, and a rule about
    // the SECOND write says nothing about the first.
    //
    // (1) THE KERNEL ENVELOPE. The pair had coherence, non-blankness, a human-actor arm and an
    // immutability arm, and nothing asked whether it was true of `actorId`. It is the worst site
    // of the three to leave unjudged, because §A.3 obligation 7 makes this envelope the thing
    // every FACT's pair is compared against — a forged envelope is not just a false byline, it
    // is the standard a judged pair is measured by.
    //
    // The write is legitimate in every other respect the envelope judges: allocated by
    // incrementing the stream in this transaction, at `nextPosition - 1`, with the dispatch
    // intent built from the live catalog row — exactly the fixture's own plant. The one defect
    // is `architect`, a role `ss-user` does not hold.
    seal: 'DomainEvent_t4d_envelope',
    what: 'an event envelope may not freeze a role its actor does not hold',
    hostile: `BEGIN;
              UPDATE "ProjectEventStream" SET "nextPosition" = "nextPosition" + 1 WHERE "projectId" = 'ss-proj';
              INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","actorKind","actorId","actorRole","actorName","entityType","entityId","dispatchIntent")
                SELECT 'ss-ev-forged','decision.published',1,'ss-org','ss-proj',s."nextPosition" - 1,'human','ss-user','architect','SS User','Decision','ss-dec',
                       jsonb_build_object('effectKey','decision.published','coverageVersion',c."coverageVersion",'invalidate',c."invalidate",
                                          'push', jsonb_build_object('body','ss','roles', jsonb_build_array('client')))
                  FROM "ProjectEventStream" s, "ExternalEffectCatalog" c
                 WHERE s."projectId" = 'ss-proj' AND c."effectKey" = 'decision.published'
                   AND c."coverageVersion" = '${COVERAGE}';
              COMMIT`,
    refusal: /a role that actor does not hold on project/,
  },
  {
    // (2) THE CHANGE REQUEST'S BIRTH PAIR — the sibling COLUMN SET of round 16's finding 4, in
    // the very trigger that fix was written into. The resolver pair three arms below it is
    // judged by `phase6_t4d_actor_bound`; the requester pair had a CHECK for its shape, a total
    // freeze against any later write, and nothing that asked whether it was true.
    //
    // Everything else about this request is legitimate — a real decision, a real requester — so
    // only the new seal can refuse it.
    seal: 'ChangeRequest_t4d_birth_pair',
    what: 'a change request may not be BORN attributing itself to a role its requester does not hold',
    hostile: `INSERT INTO "ChangeRequest" ("id","decisionId","projectId","reason","costImpact","timeImpactDays","status","requestedById","requestedByRole","requestedByName")
              VALUES ('ss-cr-forged','ss-dec','ss-proj','forged birth',0,0,'open','ss-user','architect','SS User')`,
    refusal: /a role that actor does not hold on project/,
  },
  {
    // #582 round 7, finding 3 — the shape, not just the set. `ss-mem-c` is an ACTIVE client
    // membership; the fact records it arriving into active from a removed state, and cites a
    // REMOVAL. Everything else agrees — the receipt succeeded in this transaction, its actor is
    // the fact's actor, its result is the membership — so only the command↔shape rule can refuse
    // it. Fact FIRST, as every membership probe in this file now is.
    seal: 'MembershipTransition_t4d_provenance_bound',
    what: 'a removal\'s receipt may not back a transition INTO active standing',
    hostile: `INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
                VALUES ('ss-cmd-shape','project','ss-org','ss-proj','ss-user','members.remove','ss-key-shape','ss-hash-shape','reserved');
              UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = 'ss-mem-c' WHERE "id" = 'ss-cmd-shape';
              INSERT INTO "MembershipTransition"
                ("id","projectId","membershipId","userId","fromRole","fromStatus","toRole","toStatus","actorId","actorRole","actorName","sourceCommandId")
              VALUES ('ss-mt-shape','ss-proj','ss-mem-c','ss-client','client','removed','client','active','ss-user','pmc','SS User','ss-cmd-shape');
              UPDATE "Membership" SET "status" = 'active' WHERE "id" = 'ss-mem-c'`,
    // `Membership_t4d_architect_provenance` stands in front of this for the STRIPPED run: its
    // every-role comparison sees a fact naming `(client, removed) → (client, active)` over a
    // write that left an already-active membership active, and refuses first. In the WHOLE run
    // the order is the other way — both are deferred and fire in QUEUE order, and the fact INSERT
    // precedes the membership UPDATE here — so the whole migration still answers with this
    // seal's own message, which is what binds the arm to the object it names.
    alsoStrip: ['Membership_t4d_architect_provenance'],
    refusal: /cites a `members.remove` receipt/,
  },
  {
    // #582 round 7, finding 5 — a KINDED notice is RENDERED from its kind, so a kind that
    // disagrees with its own event announces something that did not happen. The event is a real
    // `decision.published`; the notice claims it is an approval.
    //
    // EMITTED IN THE SAME TRANSACTION (#582's review round 24, finding 3). This arm used to cite
    // the fixture's committed `ss-ev1`, which the new same-transaction demand now refuses first —
    // so the arm would have measured that rule instead of this one. The bundle is minted here
    // instead: a real allocation, a real event, and the wrong kind on the notice, which leaves the
    // kind rule as the only thing standing between the write and commit.
    seal: 'Notification_t4d_binding_bound',
    what: 'a kinded notice may not name an event of a different type',
    hostile: `BEGIN;
              UPDATE "ProjectEventStream" SET "nextPosition" = "nextPosition" + 1 WHERE "projectId" = 'ss-proj';
              INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","actorKind","systemActor","entityType","entityId","dispatchIntent")
                SELECT 'ss-ev-kind','decision.published',1,'ss-org','ss-proj',s."nextPosition" - 1,'system','system:seed','Decision','ss-dec',
                       jsonb_build_object('effectKey','decision.published','coverageVersion',c."coverageVersion",'invalidate',c."invalidate",
                                          'push', jsonb_build_object('body','ss','roles', jsonb_build_array('client')))
                  FROM "ProjectEventStream" s, "ExternalEffectCatalog" c
                 WHERE s."projectId" = 'ss-proj' AND c."effectKey" = 'decision.published'
                   AND c."coverageVersion" = '${COVERAGE}';
              INSERT INTO "Notification" ("id","projectId","text","color","time","kind","eventId","decisionId")
                VALUES ('ss-note-k','ss-proj','Decision approved','green','just now','decision.approved','ss-ev-kind','ss-dec');
              COMMIT;`,
    refusal: /declares kind `decision.approved` but names event/,
  },
  {
    seal: 'ReleaseLease_t4d_frozen',
    what: 'a lease expires and stays as history — it is never deleted',
    hostile: `DELETE FROM "ReleaseLease" WHERE "instanceId" = 'ss-instance'`,
    refusal: /may not be DELETED/,
  },
  {
    seal: 'Notification_t4d_no_truncate',
    what: 'the notice register is never truncated',
    hostile: `TRUNCATE "Notification"`,
    refusal: /never truncated|truncate/i,
  },
  {
    // #582's review round 24, finding 2 — the register is immutable ROW BY ROW and TRUNCATE fires
    // no row trigger. The fixture plants no approval row, which is exactly the state the DELIVERED
    // `DecisionEvent_t4a_no_truncate` permits the wipe in — so with this seal omitted the truncate
    // succeeds, and the arm measures this seal rather than the delivered one beside it.
    seal: 'DecisionEvent_t4d_no_truncate',
    what: 'the audit register is never truncated, approval rows present or not',
    hostile: `TRUNCATE "DecisionEvent"`,
    refusal: /attributable audit register and is never truncated/,
  },
  {
    seal: 'DomainEventPairingClaim_t4d_no_truncate',
    what: 'the pairing-claim register is never truncated',
    hostile: `TRUNCATE "DomainEventPairingClaim"`,
    refusal: /append-only register|never truncated/i,
  },
  {
    // #582's review round 24, the sweep behind finding 2 — the STREAM every 4d correspondence,
    // claim and actor binding is written against, which carried four row triggers and no
    // statement-level arm while every register derived from it was already sealed.
    seal: 'DomainEvent_t4d_no_truncate',
    what: 'the delivery stream is never truncated',
    // The stream cannot be truncated alone — `Notification`, `OutboxDelivery` and
    // `DomainEventPairingClaim` all hold a foreign key into it, so PostgreSQL pulls them into the
    // CASCADE and fires THEIR seals first. Two of those three are this unit's, and they are
    // omitted alongside so the stripped run reaches the stream at all; `OutboxDelivery` carries no
    // seal. This is the same cascade reality `sanctioned-reset.ts` documents for its own registry:
    // a truncate seal is fired by tables the caller never names.
    alsoStrip: ['Notification_t4d_no_truncate', 'DomainEventPairingClaim_t4d_no_truncate'],
    hostile: `TRUNCATE "DomainEvent" CASCADE`,
    refusal: /delivery stream every 4d correspondence/,
  },
];

/**
 * Seals NOT individually stripped, each with the arm whose MECHANISM it shares. Every entry is a
 * seal that is the SAME plpgsql function as its representative, installed on a sibling table by
 * the same loop or the same paragraph of the migration — so stripping it would re-measure a
 * function this suite already measured. A seal with its OWN body does not belong here.
 */
/**
 * Seals stripped by a STANDALONE probe rather than by an arm, each with the probe that strips it.
 *
 * An arm's whole-migration run strips nothing, so a seal standing BEHIND a reservation door — or
 * behind a state the door makes unreachable — cannot be an arm: the door would answer for both
 * runs. Those seals get their own `it()`, which strips the door on both sides and the seal on one.
 * They are still measured two-sidedly; the coverage tripwire below simply cannot see the strip
 * list of a probe it does not parse, so the probe declares itself here.
 *
 * This is NOT `COVERED_BY_CLASS`: these seals have their own bodies and their own hostile writes.
 */
const STRIPPED_BY_PROBE: Record<string, string> = {
  // #582 round 26, finding 3 — stripped by the hand-written round-26 arm rather than by a table
  // entry, because the identity class needs a row PLANTED before the rewrite can be attempted and
  // the declarative arms carry a single hostile statement.
  ChangeRequest_t4d_identity:
    // the title carries no apostrophe on purpose: the declaration is matched against this file's
    // SOURCE TEXT, and an escaped quote in the literal never equals the resolved string.
    'round 26: SUBSTANCE, MOMENT and IDENTITY are evidence too',

  // #582 round 10, finding 2 — `awaiting_countersign` is reserved until 4d-iii, so the transition
  // this door judges does not exist on a database where the doors still stand.
  Decision_t4d_disagreement_paired: 'the awaiting_countersign to change transition owes its rejection request',

  // #582 round 17 — these two were declared COVERED_BY_CLASS with a reason that was never driven
  // ("a 4d-ii service path, unreachable while the doors stand"), and the reason was wrong. They
  // ARE unreachable, for a different reason entirely: the DELIVERED `<table>_t4c_append_only`
  // refuses every UPDATE to both tables and sorts BEFORE `_t4d_` in the name order PostgreSQL
  // fires row triggers in. So the declaration moves here, where it must name an `it()` that
  // exists and that DRIVES the claim — and the day another unit replaces or re-orders that
  // delivered seal, the probe goes red rather than this line going quietly stale.
  DecisionConsultation_t4d_attribution:
    'the 4d attribution freeze is unreachable, and the DELIVERED 4c append-only seal is why',
  DecisionConsultationResponse_t4d_attribution:
    'the 4d attribution freeze is unreachable, and the DELIVERED 4c append-only seal is why',
};

const COVERED_BY_CLASS: Record<string, string> = {
  // #582 round 22, finding 3 — `Decision_t4d_approval_transition` RECORDS the approval move; it
  // refuses nothing. Stripping it does not admit a hostile write, it makes the database refuse
  // MORE (the birth seal then sees an empty set), so the strip-vs-whole shape cannot express it.
  // Its mechanism is exercised in both directions by the arm that drives the no-op attack: whole,
  // the recorder stays silent on a no-op and the birth is refused; and the fixture's own real
  // `pending` -> `approved` transition is admitted, which is the recorder firing.
  Decision_t4d_approval_transition: 'DecisionApprovalRevision_t4d_birth_paired',
  // #582 round 26, finding 3 — `phase6_t4d_identity_frozen` is ONE function over four tables.
  // The arm below drives it on `ChangeRequest`, stripped and whole; these three are the same
  // function on the same operation, and each is additionally DRIVEN, per column, by the
  // frozen-column coverage oracle — which is what keeps "covered by class" from meaning
  // "assumed".
  Membership_t4d_identity: 'ChangeRequest_t4d_identity',
  Notification_t4d_identity: 'ChangeRequest_t4d_identity',
  OrgMembership_t4d_identity: 'ChangeRequest_t4d_identity',
  // platform_t4d_register_no_truncate — one function, many registers
  ChangeRequest_t4d_no_truncate: 'ExternalEffectCatalog_t4d_no_truncate',
  DecisionCountersign_t4d_no_truncate: 'ExternalEffectCatalog_t4d_no_truncate',
  DecisionForward_t4d_no_truncate: 'ExternalEffectCatalog_t4d_no_truncate',
  DecisionStrandedResolution_t4d_no_truncate: 'ExternalEffectCatalog_t4d_no_truncate',
  // #582's review round 24 — `DomainEventPairingClaim_t4d_no_truncate` LEFT this list and became
  // an ARM. The stream's own truncate arm cascades into this table and must omit its seal to reach
  // the stream at all, and a seal this suite strips cannot also claim class coverage. Rather than
  // drop the declaration and leave the seal proved by nothing, it gets the two-sided proof the
  // class declaration was standing in for.
  MembershipTransition_t4d_no_truncate: 'ExternalEffectCatalog_t4d_no_truncate',
  OrgUserAuthority_t4d_no_truncate: 'ExternalEffectCatalog_t4d_no_truncate',
  ProjectOrg_t4d_no_truncate: 'ExternalEffectCatalog_t4d_no_truncate',
  ProjectRoleStanding_t4d_no_truncate: 'ExternalEffectCatalog_t4d_no_truncate',
  ProjectUserStanding_t4d_no_truncate: 'ExternalEffectCatalog_t4d_no_truncate',
  ReleaseLease_t4d_no_truncate: 'ExternalEffectCatalog_t4d_no_truncate',
  UserIdentity_t4d_no_truncate: 'ExternalEffectCatalog_t4d_no_truncate',
  ProjectEventStream_t4d_no_truncate: 'ExternalEffectCatalog_t4d_no_truncate',
  // `TRUNCATE "Membership"` needs CASCADE to run at all, and the cascade meets a DELIVERED 4c
  // statement-level seal on `DecisionConsultation` — an object this harness has no business
  // stripping. Same function as the arm above; measured there.
  Membership_t4d_no_truncate: 'ExternalEffectCatalog_t4d_no_truncate',
  RolloutRetirement_t4d_frozen: 'RolloutRetirement_t4d_gate',
  // the frozen/writer pair on a projected register: a DIRECT statement never reaches the freeze,
  // because the writer-depth seal refuses it one trigger earlier. Measured through its writer.
  ProjectOrg_t4d_frozen: 'ProjectOrg_t4d_writer',
  // platform_t4d_register_writer — one depth rule, many registers
  // (the five register writers ARE stripped above; nothing else uses it)
  // the fact tables' seven obligations: one function each, three tables
  DecisionCountersign_t4d_append_only: 'DecisionForward_t4d_reserved',
  DecisionStrandedResolution_t4d_append_only: 'DecisionForward_t4d_reserved',
  DecisionCountersign_t4d_paired: 'DecisionForward_t4d_reserved',
  DecisionStrandedResolution_t4d_paired: 'DecisionForward_t4d_reserved',
  DecisionCountersign_t4d_provenance_bound: 'DecisionForward_t4d_reserved',
  DecisionStrandedResolution_t4d_provenance_bound: 'DecisionForward_t4d_reserved',
  DecisionCountersign_t4d_seal: 'DecisionForward_t4d_reserved',
  DecisionStrandedResolution_t4d_seal: 'DecisionForward_t4d_reserved',
  // the projections that FEED the registers stripped above
  Project_t4d_project_org: 'ProjectOrg_t4d_writer',
  Project_t4d_user_standing: 'ProjectUserStanding_t4d_writer',
  Project_t4d_deleting: 'ProjectOrg_t4d_writer',
  Membership_t4d_role_standing: 'ProjectRoleStanding_t4d_writer',
  OrgMembership_t4d_org_authority: 'OrgUserAuthority_t4d_writer',
  OrgMembership_t4d_user_standing: 'ProjectUserStanding_t4d_writer',
  User_t4d_identity: 'UserIdentity_t4d_writer',
  // the kernel pair, and the deferred halves of seals whose immediate half is stripped
  DomainEvent_t4d_pairing_claimed: 'DomainEventPairingClaim_t4d_writer',
  // A CLAIMANT, NOT A REFUSER, AND UNREACHABLE ON A 4d-i DATABASE. It writes the pairing claim the
  // `countersign_renotified` branch owes, so there is no hostile write to strip it against. More
  // to the point, its branch cannot be CONSTRUCTED here: `decision.awaiting_countersign` is a
  // 4d-ii event type with no row in the compiled catalog, and `DomainEvent_t4d_envelope` refuses
  // any event whose `(coverageVersion, effectKey)` does not resolve — so no such event exists to
  // be claimed until 4d-ii seeds the key. A probe was written for this and deleted rather than
  // weakened into one that drives a different key: it would have measured some other branch's
  // claim and reported this one. It belongs with the other seals whose subject is a 4d-ii path,
  // and 4d-ii owns proving it on the database where the branch is reachable.
  DecisionEvent_t4d_renotified_claim: 'DomainEventPairingClaim_t4d_writer',
  Notification_t4d_binding: 'Notification_t4d_no_truncate',
  // the response half of the consultation pair check: the SAME function on the sibling table,
  // installed by the same paragraph, so stripping it re-measures a body already measured.
  DecisionConsultationResponse_t4d_attribution_present: 'DecisionConsultation_t4d_attribution_present',
  // seals whose subject is a 4d-ii/4d-iii SERVICE path — unreachable while the doors stand, so
  // their hostile write cannot be constructed on a 4d-i database at all. They are proven by the
  // integration suite driving the delivered writers, and by 4d-ii's own probes.
  Decision_t4d_holder_standing: 'Decision_t4d_awaiting_reserved',
  Membership_t4d_holder_guard: 'Membership_t4d_architect_reserved',
  MembershipTransition_t4d_append_only: 'DecisionForward_t4d_reserved',
  MembershipTransition_t4d_seal: 'DecisionForward_t4d_reserved',
  DecisionApprovalRevision_t4d_one_flip: 'Decision_t4d_awaiting_reserved',
  DecisionApprovalRevision_t4d_flip_paired: 'Decision_t4d_awaiting_reserved',
  // #582's review round 24, finding 1 — `DecisionEvent_t4d_correspondence` LEFT this list. It is
  // now omitted by the `DecisionEvent_t4d_kind_reserved` arm's `alsoStrip`, because that finding
  // put a refusal where the correspondence used to return NULL, so the door's arm no longer
  // reaches its write without it. A seal this suite actually strips must not also be declared
  // covered by a class — the oracle says so, and it is right: the two claims would disagree about
  // which proof stands behind it. Its own rule is driven two-sidedly by the round-23 and round-24
  // probes below.
};

describe('phase 6 unit 4d-i — the seal-stripped migration harness (§C)', () => {
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 't4d-seal-stripped-'));
    buildBase();
  }, 300_000);

  afterAll(() => {
    psql('postgres', ['-c', `DROP DATABASE IF EXISTS "${RUN_DB}" WITH (FORCE)`]);
    psql('postgres', ['-c', `DROP DATABASE IF EXISTS "${BASE_DB}" WITH (FORCE)`]);
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  for (const arm of ARMS) {
    const admits = arm.polarity === 'admits';
    it(`${arm.seal} — ${arm.what}`, () => {
      const strip = [arm.seal, ...(arm.alsoStrip ?? [])];
      buildRun(strip);
      const stripped = psql(RUN_DB, ['-c', arm.hostile]);
      expect(
        stripped.ok,
        admits
          ? `with "${arm.seal}" OMITTED the previous-release write must FAIL — a shim that changes `
            + `nothing when removed is not the reason the delivered writer works:\n${stripped.output}`
          : `with ${strip.map((n) => `"${n}"`).join(' + ')} OMITTED the hostile write must be `
            + `ACCEPTED — if it is refused, the arm is measuring some OTHER object and proves `
            + `nothing about this seal:\n${stripped.output}`,
      ).toBe(!admits);

      buildRun([]);
      const whole = psql(RUN_DB, ['-c', arm.hostile]);
      expect(
        whole.ok,
        admits
          ? `with the WHOLE migration the previous-release write must COMMIT:\n${whole.output}`
          : `with the WHOLE migration the same write must be REFUSED`,
      ).toBe(admits);
      if (!admits) expect(whole.output).toMatch(arm.refusal);
    }, 120_000);
  }

  /**
   * #582's review round 4, finding 3 — THE RECEIPT IS THIS TRANSACTION'S, on the decision facts.
   *
   * This cannot be an ARM. `DecisionForward_t4d_reserved` stands in front of the table and answers
   * every whole-migration write with its own message, so an arm could only ever measure the door.
   * The probe therefore strips the DOOR (and the two seals that refuse this row on their own
   * unrelated terms) and leaves `DecisionForward_t4d_provenance_bound` standing, which is the only
   * arrangement in which that binding's own judgement is observable at all.
   *
   * Two-sided on purpose: a refusal alone would also be produced by a binding that refused
   * everything, so the same shape citing a receipt completed IN the transaction has to commit.
   */
  it('a decision fact may not cite a receipt an EARLIER transaction completed', () => {
    buildRun(['DecisionForward_t4d_reserved', 'DecisionForward_t4d_seal', 'DecisionForward_t4d_paired']);

    const cols = '("id","projectId","decisionId","fromDesignationKind","toDesignationKind",'
      + '"forwardedById","forwardedByRole","forwardedByName","reason","sourceCommandId")';

    // `ss-cmd-hist` succeeded in the FIXTURE's transaction: right command kind, right actor, and
    // its `resultRef` names this very row. Every other clause of the binding is satisfied.
    const historical = psql(RUN_DB, ['-c',
      `INSERT INTO "DecisionForward" ${cols}
       VALUES ('ss-fwd-hist','ss-proj','ss-dec','client','pmc','ss-user','pmc','SS User','because','ss-cmd-hist')`]);
    expect(
      historical.ok,
      'a forward citing a receipt completed by an EARLIER transaction must be REFUSED — every '
      + 'other clause of the binding passes truthfully, which is exactly why the transaction '
      + `predicate is the one that has to stop it:\n${historical.output}`,
    ).toBe(false);
    expect(historical.output).toMatch(/completed by an EARLIER transaction/);

    // the same row, with its receipt completed HERE. psql sends a multi-statement -c as one
    // implicit transaction, which is the shape a command's own writer has.
    const sameTx = psql(RUN_DB, ['-c',
      `INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
         VALUES ('ss-cmd-now','project','ss-org','ss-proj','ss-user','decisions.forward','ss-key-now','ss-hash-now','reserved');
       UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = 'ss-fwd-now' WHERE "id" = 'ss-cmd-now';
       INSERT INTO "DecisionForward" ${cols}
       VALUES ('ss-fwd-now','ss-proj','ss-dec','client','pmc','ss-user','pmc','SS User','because','ss-cmd-now')`]);
    expect(
      sameTx.ok,
      `the same forward whose receipt completed in THIS transaction must COMMIT — otherwise the `
      + `probe above measured a binding that refuses everything:\n${sameTx.output}`,
    ).toBe(true);
  }, 180_000);

  /**
   * THE FACT IS WRITTEN BEFORE THE MEMBERSHIP, and the whole unit must accept that.
   *
   * The plan does not merely permit this order, it REQUIRES it — "the fact is inserted BEFORE the
   * membership write it describes, for every transition" (line 2860) — and the file agrees in two
   * places of its own: the architect pairing trigger is deferred because "the transition row may
   * be written before or after the membership write", and
   * `MembershipTransition_projectId_membershipId_fkey` is DEFERRED because "an ADD may write the
   * transition before the `Membership` row exists".
   *
   * #582 round 4, finding 1 caught an INSERT-time register comparison refusing exactly this
   * transaction. Round 5 removed the comparison outright with the invented `activeCount` column it
   * read (the count is an event payload field, not a fact column), so what this arm guards now is
   * the ORDER itself: an architect ADD written fact-first has to commit through the deferred FK,
   * the membership-side pairing and the deferred binding together. No seal is stripped but the two
   * reservation doors, which is the state 4d-iii leaves behind.
   */
  it('the transition fact may be written BEFORE the membership write it records', () => {
    // The ARCHITECT case is the one that reproduces it, and it has to be: the counted register
    // carries `architect` alone, so for any other role the correspondence compares 0 against 0 and
    // agrees whichever order the command wrote in. Only the two reservation DOORS are stripped —
    // 4d-iii retires them and this is the act that follows — while `MembershipTransition_t4d_seal`,
    // `Membership_t4d_role_standing`, `Membership_t4d_architect_provenance` and the deferred
    // binding all stand. Adding the FIRST architect is therefore a real 4d-ii transaction: the
    // fact carries `activeCount = 1` and the register still reads 0 until the membership lands.
    buildRun(['Membership_t4d_architect_reserved', 'User_t4d_architect_reserved']);
    const factFirst = psql(RUN_DB, ['-c',
      `INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
         VALUES ('ss-cmd-add','project','ss-org','ss-proj','ss-user','members.add','ss-key-add','ss-hash-add','reserved');
       UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = 'ss-mem-a' WHERE "id" = 'ss-cmd-add';
       INSERT INTO "User" ("id","projectId","role","name","phone") VALUES ('ss-arch-p','ss-proj','architect','SS Arch P','+910000000011');
       INSERT INTO "MembershipTransition"
         ("id","projectId","membershipId","userId","fromRole","fromStatus","toRole","toStatus","actorId","actorRole","actorName","sourceCommandId")
       VALUES ('ss-mt-1','ss-proj','ss-mem-a','ss-arch-p',NULL,NULL,'architect','active','ss-user','pmc','SS User','ss-cmd-add');
       INSERT INTO "Membership" ("id","projectId","userId","role","status") VALUES ('ss-mem-a','ss-proj','ss-arch-p','architect','active')`]);
    expect(
      factFirst.ok,
      'a member command that writes its FACT before the membership must commit — the file defers '
      + 'both the pairing trigger and the membership foreign key for exactly this order, and a '
      + `correspondence judged at INSERT time contradicts them:\n${factFirst.output}`,
    ).toBe(true);

    // and the register really did move. Nothing in the FACT claims a count any more, so this is
    // the arm's evidence that the membership write was real rather than merely accepted.
    const head = psql(RUN_DB, ['-t', '-A', '-c',
      `SELECT "activeCount" FROM "ProjectRoleStanding" WHERE "projectId" = 'ss-proj' AND "role" = 'architect'`]);
    expect(head.output.trim(), 'the architect register must hold 1 after the add').toBe('1');
  }, 180_000);

  /**
   * #582's review round 4, finding 2 — THE WRITE MUST BE *THIS* STANDING CHANGE.
   *
   * The orphan clause asked only whether some `Membership` write happened in the transaction. For
   * a non-architect fact nothing else narrowed it: the counted register carries `architect` only,
   * so the correspondence compares 0 against 0 for every other role and agrees with anything. A
   * command touching an engineer membership for an unrelated reason could therefore commit a
   * permanent, immutable fact claiming that member entered or left any role at all.
   */
  it('a membership fact may not ride a write that made a DIFFERENT standing change', () => {
    buildRun([]);

    // an ordinary engineer, added truthfully, so the hostile transaction below has a real
    // membership to touch and a real receipt shape to borrow.
    const seed = psql(RUN_DB, ['-c',
      `INSERT INTO "User" ("id","projectId","role","name","phone") VALUES ('ss-eng2','ss-proj','engineer','SS Eng2','+910000000012');
       INSERT INTO "Membership" ("id","projectId","userId","role","status") VALUES ('ss-mem-e2','ss-proj','ss-eng2','engineer','active')`]);
    expect(seed.ok, seed.output).toBe(true);

    // the membership is written — its `xmin` is this transaction's — but the write leaves the
    // member an ACTIVE engineer, while the fact claims they LEFT engineer standing.
    const mismatched = psql(RUN_DB, ['-c',
      // #582 round 7, finding 3 — the receipt is a `members.remove`, because the FACT records a
      // removal. It was `members.updateRole` until this round, which the new command↔shape
      // binding now refuses on its own (a re-role does not end a standing) — and that would have
      // quietly moved this arm off the post-state rule it exists to measure and onto the new one.
      // Tracing the consumers of a rule before changing it is what caught this.
      `INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
         VALUES ('ss-cmd-x','project','ss-org','ss-proj','ss-user','members.remove','ss-key-x','ss-hash-x','reserved');
       UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = 'ss-mem-e2' WHERE "id" = 'ss-cmd-x';
       INSERT INTO "MembershipTransition"
         ("id","projectId","membershipId","userId","fromRole","fromStatus","toRole","toStatus","actorId","actorRole","actorName","sourceCommandId")
       VALUES ('ss-mt-x','ss-proj','ss-mem-e2','ss-eng2','engineer','active','engineer','removed','ss-user','pmc','SS User','ss-cmd-x');
       UPDATE "Membership" SET "status" = 'active' WHERE "id" = 'ss-mem-e2'`]);
    expect(
      mismatched.ok,
      'a fact claiming a standing change the transaction\'s membership write did not make must be '
      + `REFUSED — the receipt, the actor, the subject and the register all agree:\n${mismatched.output}`,
    ).toBe(false);
    // TWO clauses refuse this row and the message names the one that answers FIRST. Both are
    // deferred constraint triggers, so they fire in the order they were QUEUED: the membership
    // UPDATE precedes the fact INSERT here, so `Membership_t4d_architect_provenance`'s
    // every-role comparison speaks before `MembershipTransition_t4d_provenance_bound`'s
    // post-state one. Accepting either keeps this arm about the RULE rather than about statement
    // order, which a 4d-ii writer is free to change.
    expect(mismatched.output).toMatch(
      /name the change the write actually made|does not describe the write that happened/);

    // EVERY transaction here writes the FACT FIRST. That is not stylistic: `Membership_t4d_fact_first`
    // (round 6, finding 2) refuses a member command that writes the membership before its fact,
    // because the fact's live authority read has to see the PRE-state. These probes were written
    // membership-first and the new seal refused them — the fixtures were wrong, not the seal.
    //
    // #582 round 5, finding 5 — THE PRE-STATE, on a NON-ARCHITECT role. The membership is left
    // exactly as it was (an active engineer), so the POST-state comparison above agrees with a
    // fact claiming this member had just been ADDED — a NULL pre-state arriving at
    // `(engineer, active)`. Only the write's OLD row contradicts it, and only the membership side
    // can see that, which is why this arm exists on top of the one above. The counted register is
    // architect-only, so nothing else narrows a fact about any other role.
    const fabricatedArrival = psql(RUN_DB, ['-c',
      // and here the receipt is a `members.add`, for the same reason and the same round: the fact
      // claims the member ARRIVED, and an arrival is what `members.add` performs (plan line 3085
      // — re-activation goes through it too). Only the membership's OLD row contradicts this
      // fact, which is the whole point of the arm.
      `INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
         VALUES ('ss-cmd-f','project','ss-org','ss-proj','ss-user','members.add','ss-key-f','ss-hash-f','reserved');
       UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = 'ss-mem-e2' WHERE "id" = 'ss-cmd-f';
       INSERT INTO "MembershipTransition"
         ("id","projectId","membershipId","userId","fromRole","fromStatus","toRole","toStatus","actorId","actorRole","actorName","sourceCommandId")
       VALUES ('ss-mt-f','ss-proj','ss-mem-e2','ss-eng2',NULL,NULL,'engineer','active','ss-user','pmc','SS User','ss-cmd-f');
       UPDATE "Membership" SET "status" = 'active' WHERE "id" = 'ss-mem-e2'`]);
    expect(
      fabricatedArrival.ok,
      'a fact claiming the member ARRIVED, written against a membership that was already active '
      + 'and merely re-touched, must be REFUSED — the post-state agrees with it and only the '
      + `pre-state does not:\n${fabricatedArrival.output}`,
    ).toBe(false);
    expect(fabricatedArrival.output).toMatch(/does not describe the write that happened/);

    // the truthful version of the same act commits, so the clause is not refusing everything.
    const truthful = psql(RUN_DB, ['-c',
      `INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
         VALUES ('ss-cmd-r','project','ss-org','ss-proj','ss-user','members.remove','ss-key-r','ss-hash-r','reserved');
       UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = 'ss-mem-e2' WHERE "id" = 'ss-cmd-r';
       INSERT INTO "MembershipTransition"
         ("id","projectId","membershipId","userId","fromRole","fromStatus","toRole","toStatus","actorId","actorRole","actorName","sourceCommandId")
       VALUES ('ss-mt-r','ss-proj','ss-mem-e2','ss-eng2','engineer','active','engineer','removed','ss-user','pmc','SS User','ss-cmd-r');
       UPDATE "Membership" SET "status" = 'removed' WHERE "id" = 'ss-mem-e2'`]);
    expect(
      truthful.ok,
      `the same removal, with the membership actually left inactive, must COMMIT:\n${truthful.output}`,
    ).toBe(true);
  }, 180_000);

  /**
   * #582's review round 4, finding 4 — THE CATALOG CHECKS INSTALL ON A BASELINE DATABASE.
   *
   * `CREATE TABLE IF NOT EXISTS` skips its whole body, constraints included, when the table is
   * already there — and on the P3005 path it always is, because `prisma db push` built the schema
   * from `schema.prisma`, which carries this table's columns and primary key and none of its
   * CHECKs. The probe reproduces that database exactly: create the modeled shape first, then apply
   * the whole migration over it, then ask PostgreSQL what constraints the table actually carries.
   */
  it('the catalog CHECKs install even when the table already exists (db-push baseline)', () => {
    psql('postgres', ['-c', `DROP DATABASE IF EXISTS "${RUN_DB}" WITH (FORCE)`]);
    const created = psql('postgres', ['-c', `CREATE DATABASE "${RUN_DB}" TEMPLATE "${BASE_DB}"`]);
    expect(created.ok, created.output).toBe(true);

    // what `prisma db push` reproduces from the model: columns, defaults, primary key. No CHECKs —
    // Prisma cannot express them — and no triggers.
    const baseline = psql(RUN_DB, ['-c',
      `CREATE TABLE "ExternalEffectCatalog" (
         "coverageVersion" TEXT NOT NULL, "effectKey" TEXT NOT NULL, "eventType" TEXT NOT NULL,
         "invalidate" BOOLEAN NOT NULL, "pushRoles" JSONB, "pushFamily" TEXT,
         "frozenAudience" BOOLEAN NOT NULL, "requiresPush" BOOLEAN NOT NULL, "audience" TEXT,
         "pushBody" TEXT, "pairingRequired" BOOLEAN NOT NULL DEFAULT FALSE,
         "retiredAt" TIMESTAMP(3),
         CONSTRAINT "ExternalEffectCatalog_pkey" PRIMARY KEY ("coverageVersion", "effectKey"))`]);
    expect(baseline.ok, baseline.output).toBe(true);

    const applied = applyWhole();
    expect(applied.ok, `the unit must apply over a db-push baseline:\n${applied.output}`).toBe(true);

    const checks = psql(RUN_DB, ['-t', '-A', '-c',
      `SELECT conname FROM pg_constraint
        WHERE conrelid = '"ExternalEffectCatalog"'::regclass AND contype = 'c' ORDER BY 1`]);
    expect(checks.ok, checks.output).toBe(true);
    expect(
      checks.output.trim().split('\n').filter(Boolean),
      'the three catalog CHECKs must be present on a baseline database too — written inside the '
      + 'CREATE TABLE body they install on a fresh migrate and on no baseline at all, leaving the '
      + 'seals that read this catalog judging rows nothing constrains',
    ).toEqual([
      'ExternalEffectCatalog_audience_check',
      'ExternalEffectCatalog_frozen_body_check',
      'ExternalEffectCatalog_requires_push_check',
    ]);
  }, 180_000);

  /**
   * #582's review round 7, finding 1 — A RETIREMENT VERDICT MAY NOT BE EVIDENCE OF ITSELF.
   *
   * Round 5 answered a FORGED marker — a `RolloutRetirement` row for `phase6-4d` on a database
   * that never ran 4d-iii — by requiring one of this unit's own artifacts beside it. The artifact
   * it named is created by THIS file, so the predicate was false at the doors and TRUE from the
   * moment the seal function existed: every gate after that point skipped as though 4d-iii had
   * run, and the unit committed with `DecisionForward_t4d_reserved` uninstalled and
   * `DecisionEvent_t4d_correspondence` absent — a database calling itself dark with the
   * forwarding door standing open.
   *
   * The probe builds exactly that database: the modelled `RolloutRetirement` table (what
   * `prisma db push` reproduces — columns and key, no triggers) carrying the marker, and nothing
   * else of 4d-i. Then it applies the whole migration and asks what was installed.
   */
  it('a forged retirement marker does not disarm the doors it cannot have earned', () => {
    psql('postgres', ['-c', `DROP DATABASE IF EXISTS "${RUN_DB}" WITH (FORCE)`]);
    const created = psql('postgres', ['-c', `CREATE DATABASE "${RUN_DB}" TEMPLATE "${BASE_DB}"`]);
    expect(created.ok, created.output).toBe(true);

    const baseline = psql(RUN_DB, ['-c',
      // exactly what `prisma db push` reproduces from the model — columns, default and key, and
      // none of the CHECKs or triggers this file adds. The marker row is the forgery.
      `CREATE TABLE "RolloutRetirement" (
         "unit" TEXT NOT NULL, "retiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
         "retiredBy" TEXT NOT NULL,
         CONSTRAINT "RolloutRetirement_pkey" PRIMARY KEY ("unit"));
       INSERT INTO "RolloutRetirement" ("unit","retiredBy") VALUES ('phase6-4d','someone')`]);
    expect(baseline.ok, baseline.output).toBe(true);

    const applied = applyWhole();
    expect(applied.ok, `the unit must apply over a marker-bearing baseline:\n${applied.output}`).toBe(true);

    const installed = psql(RUN_DB, ['-t', '-A', '-c',
      `SELECT tgname FROM pg_trigger
        WHERE tgname IN ('DecisionForward_t4d_reserved', 'DecisionEvent_t4d_correspondence',
                         'Decision_t4d_awaiting_reserved', 'Membership_t4d_architect_reserved')
          AND NOT tgisinternal ORDER BY 1`]);
    expect(installed.ok, installed.output).toBe(true);
    expect(
      installed.output.trim().split('\n').filter(Boolean),
      'a database whose marker is not backed by 4d-i\'s own artifacts retired NOTHING, so every '
      + 'door and the correspondence seal are owed. The verdict has to be taken BEFORE this file '
      + 'creates the evidence it reads, or the file talks itself out of its own reservation '
      + 'halfway through.',
    ).toEqual([
      'DecisionEvent_t4d_correspondence',
      'DecisionForward_t4d_reserved',
      'Decision_t4d_awaiting_reserved',
      'Membership_t4d_architect_reserved',
    ]);
  }, 180_000);

  /**
   * #582's review round 16, finding 2 — A GENUINELY RETIRED DATABASE REPLAYS AS A NO-OP, and
   * this is the arm the SPLIT needed and did not have.
   *
   * Both halves are marker-aware: on a database that has run 4d-iii they must install no door,
   * replace no seal and abort no audit. `phase6_t4d_retired_at_start()` is what every one of those
   * gates asks, and it reads a setting established with `set_config(..., is_local => true)` — which
   * is TRANSACTION-local. Splitting the unit into two Prisma migrations made them two
   * transactions, so the first half's snapshot was discarded at its commit and the second half
   * read the setting as absent: false, the "not retired yet" answer, for all eight of its gates.
   *
   * Every proof of the split measured that both files APPLY. They do — on a fresh database, where
   * false is also the correct answer. That is a PROJECTION of "the split is correct": applying is
   * one dimension and the marker-aware replay is a second, and only this arm asks the second.
   *
   * The sequence is the real one: apply the unit, retire it the way 4d-iii does (write the marker
   * under its gate, drop the six doors), then replay both halves and require every door to STAY
   * dropped. Against the unfixed second half the four decisions-side doors come back — on a live
   * chain, where they refuse the very commands 4d-ii shipped.
   */
  it('a replay over a genuinely RETIRED database installs no door, in either half', () => {
    buildRun([]);

    // retire it exactly as 4d-iii does: the marker under its own gate, then the doors dropped
    const retire = psql(RUN_DB, ['-c', `
      BEGIN;
      SET LOCAL vitan.phase6_4d_retire = 'on';
      INSERT INTO "RolloutRetirement" ("unit","retiredBy") VALUES ('phase6-4d','4d-iii');
      COMMIT;
      DROP TRIGGER IF EXISTS "Decision_t4d_architect_reserved" ON "Decision";
      DROP TRIGGER IF EXISTS "Decision_t4d_awaiting_reserved" ON "Decision";
      DROP TRIGGER IF EXISTS "Membership_t4d_architect_reserved" ON "Membership";
      DROP TRIGGER IF EXISTS "User_t4d_architect_reserved" ON "User";
      DROP TRIGGER IF EXISTS "DecisionForward_t4d_reserved" ON "DecisionForward";
      DROP TRIGGER IF EXISTS "DecisionEvent_t4d_kind_reserved" ON "DecisionEvent";
    `]);
    expect(retire.ok, retire.output).toBe(true);

    // the predicate BOTH halves consult must now be true of this database
    const retired = psql(RUN_DB, ['-t', '-A', '-c', 'SELECT phase6_t4d_retired()']);
    expect(retired.output.trim(), 'the marker and the artifact together ARE retirement').toBe('t');

    const replay = applyWhole();
    expect(replay.ok, `the replay of a retired database must abort nothing:\n${replay.output}`).toBe(true);

    const back = psql(RUN_DB, ['-t', '-A', '-c',
      `SELECT coalesce(string_agg(tgname, ',' ORDER BY tgname), '') FROM pg_trigger
        WHERE tgname IN ('Decision_t4d_architect_reserved', 'Decision_t4d_awaiting_reserved',
                         'Membership_t4d_architect_reserved', 'User_t4d_architect_reserved',
                         'DecisionForward_t4d_reserved', 'DecisionEvent_t4d_kind_reserved')
          AND NOT tgisinternal`]);
    expect(back.ok, back.output).toBe(true);
    expect(
      back.output.trim(),
      'the replay re-created a reservation door on a database that has already retired it — on a '
      + 'live chain those doors refuse the commands 4d-ii shipped',
    ).toBe('');
  }, 300_000);

  /**
   * #582's review round 7, finding 2 — THE REGISTER MUST AGREE, NOT MERELY EXIST.
   *
   * `ProjectOrg` is the project→org mapping every tenancy join reads, and on the db-push/P3005
   * path the modelled table can exist before its writer-depth and freeze seals do. The backfill
   * keys its `WHERE NOT EXISTS` on the PROJECT, so a row already there is preserved whatever it
   * says; the audit asked only whether a row existed; and the freeze then made it permanent. A
   * project mapped to another org hands that org's owners and admins team-management authority
   * over it, through `platform_user_orchestration_authority`.
   */
  it('a pre-existing ProjectOrg row that names the wrong org ABORTS the apply', () => {
    psql('postgres', ['-c', `DROP DATABASE IF EXISTS "${RUN_DB}" WITH (FORCE)`]);
    const created = psql('postgres', ['-c', `CREATE DATABASE "${RUN_DB}" TEMPLATE "${BASE_DB}"`]);
    expect(created.ok, created.output).toBe(true);

    const baseline = psql(RUN_DB, ['-c',
      `INSERT INTO "Org" ("id","name","slug") VALUES ('po-org-a','PO Org A','po-org-a'), ('po-org-b','PO Org B','po-org-b');
       INSERT INTO "Project" ("id","orgId","name","short","descriptor","stage","siteCode","projStart","projEnd","elapsedPct","todayDay","milestonePct")
         VALUES ('po-proj','po-org-a','PO Site','PO','','Finishing','PO-01','01 Jan 2026','31 Dec 2026',0,0,0);
       CREATE TABLE "ProjectOrg" (
         "projectId" TEXT NOT NULL, "orgId" TEXT NOT NULL,
         CONSTRAINT "ProjectOrg_pkey" PRIMARY KEY ("projectId"));
       INSERT INTO "ProjectOrg" ("projectId","orgId") VALUES ('po-proj','po-org-b')`]);
    expect(baseline.ok, baseline.output).toBe(true);

    const applied = psql(RUN_DB, ['-f', MIGRATION]);
    expect(
      applied.ok,
      'the unit must REFUSE to adopt and freeze a tenancy mapping that contradicts the Project it '
      + `names — existence is not agreement:\n${applied.output}`,
    ).toBe(false);
    expect(applied.output).toMatch(/name an org their "Project" does not/);
    expect(applied.output, 'the abort must name the projects that disagree, or an operator cannot act on it')
      .toMatch(/po-proj→po-org-b \(Project says po-org-a\)/);

    // and the same database, with the mapping corrected by the operator, applies.
    const repaired = psql(RUN_DB, ['-c', `UPDATE "ProjectOrg" SET "orgId" = 'po-org-a' WHERE "projectId" = 'po-proj'`]);
    expect(repaired.ok, repaired.output).toBe(true);
    const again = applyWhole();
    expect(again.ok, `once the register agrees, the same apply must succeed:\n${again.output}`).toBe(true);
  }, 180_000);

  it('every installed _t4d_ seal is either stripped by an arm or declared covered by its class', () => {
    buildRun([]);
    const listed = psql(RUN_DB, ['-t', '-A', '-c',
      `SELECT tgname FROM pg_trigger WHERE tgname LIKE '%\\_t4d\\_%' AND NOT tgisinternal ORDER BY 1`]);
    expect(listed.ok, listed.output).toBe(true);
    const installed = listed.output.trim().split('\n').filter(Boolean);
    expect(installed.length, 'the unit installs a substantial inventory; an empty read is a broken query')
      .toBeGreaterThan(60);

    const stripped = new Set([...ARMS.flatMap((a) => [a.seal, ...(a.alsoStrip ?? [])]),
      ...Object.keys(STRIPPED_BY_PROBE)]);
    const undeclared = installed.filter((n) => !stripped.has(n) && !(n in COVERED_BY_CLASS));
    expect(
      undeclared,
      'these seals are installed by 4d-i and neither stripped by an arm here nor declared in '
      + 'COVERED_BY_CLASS with the arm that exercises their mechanism. A seal nobody can point at '
      + 'is a seal nobody proved.',
    ).toEqual([]);

    // a probe declaration must name a probe that EXISTS in this file, or the register rots the
    // same way an inventory of what was built rots: silently, and in the direction of claiming
    // more coverage than there is.
    const own = readFileSync(join(__dirname, 'phase6-t4d-i-seal-stripped.test.ts'), 'utf8');
    const missingProbe = Object.entries(STRIPPED_BY_PROBE)
      .filter(([, title]) => !own.includes(`it('${title}'`))
      .map(([name, title]) => `${name} -> ${title}`);
    expect(
      missingProbe,
      'a probe declaration must name an `it()` that exists in this file',
    ).toEqual([]);

    // and the declarations point at arms that actually exist
    const dangling = Object.entries(COVERED_BY_CLASS)
      .filter(([name, rep]) => !stripped.has(rep) || stripped.has(name))
      .map(([name, rep]) => `${name} -> ${rep}`);
    expect(
      dangling,
      'a class declaration must name a seal this suite actually strips, and must not restate a '
      + 'seal that is itself stripped',
    ).toEqual([]);
  }, 120_000);

  /**
   * #582's review round 3, finding 1 — THE UNIT IS ATOMIC, and this is the two-sided proof.
   *
   * The whole claim of a dark unit is that there is no observable window: the reservation doors,
   * the enum values, the registers, the seals and the audits either are all there or none of them
   * is, and §P6T4D's recovery tells an operator exactly that. Prisma documents that it does NOT
   * wrap migrations in a transaction, so nothing was enforcing it — a raise in the late audits
   * would have left doors and trigger replacements committed under a migration reported FAILED.
   *
   * Measuring only "it applies" would not be a proof of atomicity: it would pass with no BEGIN at
   * all. So the arm injects a raise at the very END of the file — after every object has been
   * created — and requires the database to carry NONE of them afterwards.
   *
   * SPLIT INTO TWO FILES, the claim is per file and the measurement is a DIFFERENCE rather than a
   * zero. Prisma applies and records each migration separately, so each half is its own atomic
   * unit and an operator resolving one has the other's state untouched. For the registers half
   * the difference is from an empty database and the old `= 0` still holds exactly; for the
   * decisions half the registers are legitimately there first, and asserting zero would be
   * asserting the wrong thing — what must be true is that the poisoned apply changed NOTHING.
   */
  const UNIT_INVENTORY = `SELECT (SELECT count(*) FROM pg_trigger WHERE tgname LIKE '%\\_t4d\\_%' AND NOT tgisinternal)
        || '/' || (SELECT count(*) FROM pg_class WHERE relname IN
             ('RolloutRetirement','ExternalEffectCatalog','ReleaseLease','MembershipTransition','DomainEventPairingClaim',
              'DecisionForward','DecisionCountersign','DecisionStrandedResolution'))
        || '/' || (SELECT count(*) FROM pg_proc WHERE proname LIKE 'phase6\\_t4d\\_%')`;

  it('each half of the unit is ONE transaction: a raise at the end leaves no object behind', () => {
    UNIT_FILES.forEach((unitFile, i) => {
      psql('postgres', ['-c', `DROP DATABASE IF EXISTS "${RUN_DB}" WITH (FORCE)`]);
      const created = psql('postgres', ['-c', `CREATE DATABASE "${RUN_DB}" TEMPLATE "${BASE_DB}"`]);
      expect(created.ok, created.output).toBe(true);

      // every EARLIER half applies normally — the half under test is the only poisoned one
      for (const earlier of UNIT_FILES.slice(0, i)) {
        const r = psql(RUN_DB, ['-f', earlier]);
        expect(r.ok, `${UNIT_DIRS[i]}'s atomicity probe needs its predecessor applied:\n${r.output}`).toBe(true);
      }
      const before = psql(RUN_DB, ['-t', '-A', '-c', UNIT_INVENTORY]);
      expect(before.ok, before.output).toBe(true);

      const sql = readFileSync(unitFile, 'utf8');
      expect(sql.includes('\nBEGIN;\n'), `${UNIT_DIRS[i]} must open its own transaction`).toBe(true);
      expect(sql.trimEnd().endsWith('COMMIT;'), `${UNIT_DIRS[i]} must close its own transaction`).toBe(true);

      // the raise goes BEFORE the COMMIT, so everything above it has already run
      const poisoned = sql.replace(
        /COMMIT;\s*$/,
        "DO $probe$ BEGIN RAISE EXCEPTION 'seal-stripped harness: atomicity probe'; END $probe$;\nCOMMIT;\n",
      );
      const file = join(tmp, `atomicity-${i}.sql`);
      writeFileSync(file, poisoned);
      const applied = psql(RUN_DB, ['-f', file]);
      expect(
        applied.ok,
        `the poisoned apply of ${UNIT_DIRS[i]} must FAIL — otherwise the probe measured nothing`,
      ).toBe(false);
      expect(applied.output).toMatch(/atomicity probe/);

      // and nothing it created survives: the inventory is exactly what it was before
      const after = psql(RUN_DB, ['-t', '-A', '-c', UNIT_INVENTORY]);
      expect(after.ok, after.output).toBe(true);
      expect(
        after.output.trim(),
        `the failed apply of ${UNIT_DIRS[i]} left objects behind — that half is NOT atomic, and `
        + '§P6T4D\'s recovery would be telling an operator something untrue',
      ).toBe(before.output.trim());
      // the registers half starts from an empty database, so its difference is also an absolute
      // zero — the claim the single-file arm used to make, kept rather than weakened
      if (i === 0) {
        expect(before.output.trim(), 'the registers half must be measured from an EMPTY base').toBe('0/0/0');
      }
    });
  }, 300_000);

  /**
   * #582's review round 3, finding 2 — an account whose identity cannot be projected ABORTS the
   * apply rather than being silently dropped from the register every 4d fact resolves through.
   */
  it('a blank-named legacy account aborts the apply with a named repair, rather than vanishing', () => {
    psql('postgres', ['-c', `DROP DATABASE IF EXISTS "${RUN_DB}" WITH (FORCE)`]);
    const created = psql('postgres', ['-c', `CREATE DATABASE "${RUN_DB}" TEMPLATE "${BASE_DB}"`]);
    expect(created.ok, created.output).toBe(true);

    const seeded = psql(RUN_DB, ['-c', `
      INSERT INTO "Org" ("id","name","slug") VALUES ('bn-org','BN Org','bn-org');
      INSERT INTO "Project" ("id","orgId","name","short","descriptor","stage","siteCode","projStart","projEnd","elapsedPct","todayDay","milestonePct")
        VALUES ('bn-proj','bn-org','BN Site','BN','','Finishing','BN-01','01 Jan 2026','31 Dec 2026',0,0,0);
      INSERT INTO "User" ("id","projectId","role","name","phone") VALUES ('bn-user','bn-proj','pmc','   ','+910000000009');
    `]);
    expect(seeded.ok, seeded.output).toBe(true);

    const applied = psql(RUN_DB, ['-f', MIGRATION]);
    expect(applied.ok, 'the apply must REFUSE while an account cannot be projected').toBe(false);
    expect(applied.output).toMatch(/cannot be projected into "UserIdentity"/);
    expect(applied.output, 'the abort must name the account so the operator can repair it')
      .toMatch(/bn-user/);

    // the same database applies cleanly once the account has a real name — the repair the
    // message names is the repair that works.
    const repaired = psql(RUN_DB, ['-c', `UPDATE "User" SET "name" = 'BN User' WHERE "id" = 'bn-user'`]);
    expect(repaired.ok, repaired.output).toBe(true);
    const again = applyWhole();
    expect(again.ok, `after the named repair the apply must succeed:\n${again.output}`).toBe(true);
  }, 180_000);
  /**
   * #582's review round 8, findings 1, 2 and 4 — THE ADOPTED REGISTERS MUST AGREE WITH THEIR
   * SOURCE, on the one path where they can predate their seals.
   *
   * A `prisma db push` / P3005 baseline creates these tables from `schema.prisma` before any raw
   * trigger exists, so rows can be sitting in them that nothing vouched for. Every backfill skips
   * an existing key, so whatever is there is ADOPTED and then frozen. This plants one bad row in
   * each of the three registers and repairs them one at a time: each repair must move the abort
   * on to the next, which is how the arm proves three separate audits rather than one.
   */
  it('a pre-baseline register row that contradicts its source aborts the apply, one audit at a time', () => {
    psql('postgres', ['-c', `DROP DATABASE IF EXISTS "${RUN_DB}" WITH (FORCE)`]);
    const created = psql('postgres', ['-c', `CREATE DATABASE "${RUN_DB}" TEMPLATE "${BASE_DB}"`]);
    expect(created.ok, created.output).toBe(true);

    // the world, plus the three registers as `schema.prisma` would create them — UNSEALED, which
    // is the whole premise: no `_t4d_` trigger exists on this database yet.
    const seeded = psql(RUN_DB, ['-c', `
      INSERT INTO "Org" ("id","name","slug") VALUES ('pb-org','PB Org','pb-org');
      INSERT INTO "Project" ("id","orgId","name","short","descriptor","stage","siteCode","projStart","projEnd","elapsedPct","todayDay","milestonePct")
        VALUES ('pb-proj','pb-org','PB Site','PB','','Finishing','PB-01','01 Jan 2026','31 Dec 2026',0,0,0);
      INSERT INTO "User" ("id","projectId","role","name","phone") VALUES
        ('pb-user','pb-proj','pmc','PB Real Name','+910000000021'),
        ('pb-out','pb-proj','engineer','PB Outsider','+910000000022');
      CREATE TABLE "UserIdentity" ("userId" TEXT NOT NULL, "displayName" TEXT NOT NULL,
        CONSTRAINT "UserIdentity_pkey" PRIMARY KEY ("userId"));
      CREATE TABLE "OrgUserAuthority" ("orgId" TEXT NOT NULL, "userId" TEXT NOT NULL, "role" TEXT NOT NULL,
        CONSTRAINT "OrgUserAuthority_pkey" PRIMARY KEY ("orgId","userId"));
      CREATE TABLE "ProjectUserStanding" ("projectId" TEXT NOT NULL, "userId" TEXT NOT NULL,
        "role" TEXT NOT NULL, "membershipId" TEXT,
        CONSTRAINT "ProjectUserStanding_pkey" PRIMARY KEY ("projectId","userId","role"));
      -- (1) an identity that contradicts its account: from 4d-ii this name is what every fact freezes
      INSERT INTO "UserIdentity" ("userId","displayName") VALUES ('pb-user','PB FORGED NAME');
      -- (2) admin authority with no owner/admin OrgMembership behind it
      INSERT INTO "OrgUserAuthority" ("orgId","userId","role") VALUES ('pb-org','pb-out','admin');
      -- (3) pmc standing for a user with neither an active membership in it nor an org owner/admin row
      INSERT INTO "ProjectUserStanding" ("projectId","userId","role","membershipId")
        VALUES ('pb-proj','pb-out','pmc',NULL);
      -- (4) round 9, finding 3 -- a standing row whose JUSTIFICATION is real (pb-user is an
      -- active pmc) but whose membershipId points at SOMEBODY ELSE's membership. Round 8 judged
      -- justification only and wrote into the migration that a stale pointer is "untidy, not a
      -- grant"; platform_membership_active_user resolves the holder by that column ALONE, so a
      -- forward FROM pb-out's membership would answer pb-user.
      -- (No backticks in this block: it lives inside a TypeScript template literal.)
      INSERT INTO "Membership" ("id","projectId","userId","role","status") VALUES
        ('pb-mem-a','pb-proj','pb-user','pmc','active'),
        ('pb-mem-b','pb-proj','pb-out','engineer','active');
    `]);
    expect(seeded.ok, seeded.output).toBe(true);

    const identity = psql(RUN_DB, ['-f', MIGRATION]);
    expect(identity.ok, 'the apply must REFUSE a "UserIdentity" row that contradicts its "User"').toBe(false);
    expect(identity.output).toMatch(/"UserIdentity" row\(s\) disagree with the "User" they project/);
    expect(identity.output, 'the abort must name the row so the operator can repair it')
      .toMatch(/PB FORGED NAME/);

    // repair (1) — the abort must now move to the authority register, not vanish
    expect(psql(RUN_DB, ['-c',
      `UPDATE "UserIdentity" SET "displayName" = 'PB Real Name' WHERE "userId" = 'pb-user'`]).ok).toBe(true);
    const authority = psql(RUN_DB, ['-f', MIGRATION]);
    expect(authority.ok, 'the apply must REFUSE unbacked "OrgUserAuthority"').toBe(false);
    expect(authority.output).toMatch(/"OrgUserAuthority" row\(s\) are backed by no owner\/admin "OrgMembership"/);
    expect(authority.output).toMatch(/pb-out@pb-org/);

    // repair (2) — on to the per-user standing register
    expect(psql(RUN_DB, ['-c',
      `DELETE FROM "OrgUserAuthority" WHERE "userId" = 'pb-out'`]).ok).toBe(true);
    const standing = psql(RUN_DB, ['-f', MIGRATION]);
    expect(standing.ok, 'the apply must REFUSE unbacked "ProjectUserStanding"').toBe(false);
    expect(standing.output).toMatch(/"ProjectUserStanding" row\(s\) are backed by neither an active "Membership"/);
    expect(standing.output).toMatch(/pb-out on pb-proj as 'pmc'/);

    // repair (3) — replace the unbacked row with a MISPOINTED one, which round 8 would have
    // adopted and round 9 refuses
    expect(psql(RUN_DB, ['-c', `
      DELETE FROM "ProjectUserStanding" WHERE "userId" = 'pb-out';
      INSERT INTO "ProjectUserStanding" ("projectId","userId","role","membershipId")
        VALUES ('pb-proj','pb-user','pmc','pb-mem-b');
    `]).ok).toBe(true);
    const pointer = psql(RUN_DB, ['-f', MIGRATION]);
    expect(
      pointer.ok,
      'a standing row pointing at ANOTHER user\'s membership must REFUSE the apply — the holder '
      + 'is resolved by that column alone, so the pointer is authority, not bookkeeping',
    ).toBe(false);
    expect(pointer.output).toMatch(/"ProjectUserStanding" row\(s\) are backed by neither an active "Membership" of that exact user, role AND id/);
    expect(pointer.output).toMatch(/membershipId 'pb-mem-b'/);

    // repair (4) — on to the LAST shape, which round 9 still adopted
    expect(psql(RUN_DB, ['-c',
      `UPDATE "ProjectUserStanding" SET "membershipId" = 'pb-mem-a' WHERE "userId" = 'pb-user'`]).ok).toBe(true);

    // (5) round 10, finding 3 — a MEMBERSHIP-LESS `pmc` claim for a user who is not
    // membership-less. `pb-out` becomes an org OWNER, which is the whole justification round 9's
    // arm asked for, while keeping the ACTIVE engineer membership planted above. Neither the
    // projection writer nor the backfill would ever produce this row — both recompute the `pmc`
    // arm only while the user has no active presence on the project — and adopting it hands
    // `platform_user_holds_role` a `pmc` answer for an engineer, which the fact seals then FREEZE
    // as authority evidence for the whole 4d-i → 4d-iii window.
    expect(psql(RUN_DB, ['-c', `
      INSERT INTO "OrgMembership" ("id","orgId","userId","role") VALUES ('pb-om','pb-org','pb-out','owner');
      INSERT INTO "ProjectUserStanding" ("projectId","userId","role","membershipId")
        VALUES ('pb-proj','pb-out','pmc',NULL);
    `]).ok).toBe(true);
    const memberful = psql(RUN_DB, ['-f', MIGRATION]);
    expect(
      memberful.ok,
      'a membership-less `pmc` claim for a user WITH an active membership must REFUSE the apply — '
      + '"membership-less" is the writer\'s own condition, and an owner who is also an active '
      + 'engineer is not membership-less',
    ).toBe(false);
    expect(memberful.output).toMatch(/"ProjectUserStanding" row\(s\) are backed by neither an active "Membership"/);
    expect(memberful.output).toMatch(/pb-out on pb-proj as 'pmc'/);

    // repair (5) — and only now does the whole unit apply
    expect(psql(RUN_DB, ['-c',
      `DELETE FROM "ProjectUserStanding" WHERE "userId" = 'pb-out' AND "role" = 'pmc'`]).ok).toBe(true);
    const clean = applyWhole();
    expect(clean.ok, `after all five named repairs the apply must succeed:\n${clean.output}`).toBe(true);
  }, 300_000);

  /**
   * #582's review round 11, finding 1 — THE 4d-ONLY SHAPE OF TABLES THAT ALREADY EXISTED.
   *
   * The sibling audit proves the tables this unit CREATES are empty. This one proves the same
   * about the columns it ADDS to tables that were already there — the case the round-9 audit
   * never asked, and the one a `db push` / P3005 baseline actually produces, because those
   * columns can exist and be populated before a single raw 4d trigger does.
   *
   * Two tables are planted, not one. The finding named `ChangeRequest`; the class covers every
   * table gaining a 4d-only column, and `DecisionApprovalRevision` is the member with the worst
   * consequence — a pre-baseline `finalized = false` row is an OPEN approval under no chain that
   * the one-flip seal then makes permanently unfinalizable.
   */
  it('a pre-baseline row already in a 4d-only shape aborts the apply', () => {
    psql('postgres', ['-c', `DROP DATABASE IF EXISTS "${RUN_DB}" WITH (FORCE)`]);
    expect(psql('postgres', ['-c', `CREATE DATABASE "${RUN_DB}" TEMPLATE "${BASE_DB}"`]).ok).toBe(true);

    const seeded = psql(RUN_DB, ['-c', `
      INSERT INTO "Org" ("id","name","slug") VALUES ('ls-org','LS Org','ls-org');
      INSERT INTO "Project" ("id","orgId","name","short","descriptor","stage","siteCode","projStart","projEnd","elapsedPct","todayDay","milestonePct")
        VALUES ('ls-proj','ls-org','LS Site','LS','','Finishing','LS-01','01 Jan 2026','31 Dec 2026',0,0,0);
      INSERT INTO "User" ("id","projectId","role","name","phone") VALUES
        ('ls-user','ls-proj','pmc','LS User','+910000000041'),
        ('ls-client','ls-proj','client','LS Client','+910000000042');
      -- the delivered 4b publication seal requires an ACTIVE holder of the decider role, so the
      -- world this plants is the world that seal admits.
      INSERT INTO "Membership" ("id","projectId","userId","role","status") VALUES
        ('ls-mem','ls-proj','ls-user','pmc','active'),
        ('ls-mem-c','ls-proj','ls-client','client','active');
      -- born UNPUBLISHED, given its option floor, published second — the order the delivered 4b
      -- seals admit (options are frozen once the question is published, and a published choice
      -- needs two of them).
      INSERT INTO "Decision" ("id","projectId","title","room","status","photoSwatch","publishedAt")
        VALUES ('ls-dec','ls-proj','LS Decision','Hall','pending','sw',NULL);
      INSERT INTO "DecisionOption" ("id","decisionId","label","optionKey","material","delta","swatch","order")
        VALUES ('ls-opt-a','ls-dec','A','a','Granite',0,'sw1',0),
               ('ls-opt-b','ls-dec','B','b','Quartz',100,'sw2',1);
      UPDATE "Decision" SET "publishedAt" = now() WHERE "id" = 'ls-dec';
      -- THE COLUMNS ARE CREATED HERE, the way prisma db push creates them: from schema.prisma,
      -- before any raw 4d trigger exists. That is the whole premise of this arm and of its
      -- sibling above — on this database they do NOT exist yet, because the base template is the
      -- pre-4d-i world, so a plant that assumed them would be measuring nothing.
      -- (No backticks in this block: it lives inside a TypeScript template literal.)
      ALTER TABLE "DecisionApprovalRevision" ADD COLUMN "finalized" BOOLEAN NOT NULL DEFAULT TRUE;
      ALTER TABLE "ChangeRequest" ADD COLUMN "projectId" TEXT;
      ALTER TABLE "ChangeRequest" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'standard';
      ALTER TABLE "ChangeRequest" ADD COLUMN "revisionId" TEXT;
      -- and the rows that sit in them, vouched for by nothing THIS unit installs. The 4c
      -- provenance seal is already on this database (4c-ii is a merged migration), so the
      -- revision carries a real approval receipt and is legal in every respect 4c judges — which
      -- is the point: its ONLY illegal aspect is the 4d column, and no 4d seal exists yet to see
      -- it.
      INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
        VALUES ('ls-cmd','project','ls-org','ls-proj','ls-user','decisions.approve','ls-key','ls-hash','reserved');
      UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = 'ls-dec' WHERE "id" = 'ls-cmd';
      INSERT INTO "DecisionApprovalRevision" ("id","projectId","decisionId","version","optionKey","approvedAt","approvedById","sourceCommandId","finalized")
        VALUES ('ls-rev','ls-proj','ls-dec',1,'a',now(),'ls-user','ls-cmd',FALSE);
      INSERT INTO "ChangeRequest" ("id","projectId","decisionId","reason","costImpact","timeImpactDays","status","origin","revisionId")
        VALUES ('ls-cr','ls-proj','ls-dec','planted',0,0,'open','countersign_rejection','ls-rev');
    `]);
    expect(seeded.ok, seeded.output).toBe(true);

    // The columns this audit reads are added by the DECISIONS half, and the audit sits with
    // them. The registers half applies first and cleanly — which is itself part of the claim:
    // the seam holds, and a planted 4d-only row is not a register's problem.
    const dark = psql(RUN_DB, ['-f', MIGRATION]);
    expect(dark.ok, `the registers half is not implicated and must apply:\n${dark.output}`).toBe(true);
    const applied = psql(RUN_DB, ['-f', FACTS]);
    expect(applied.ok, 'the apply must REFUSE rows already carrying 4d-only values').toBe(false);
    expect(applied.output).toMatch(/already carry this unit's 4d-only columns before it seals them/);
    // BOTH tables are named, which is what makes this the class and not the reported site
    expect(applied.output).toMatch(/ChangeRequest \(1 row\(s\): ls-cr\)/);
    expect(applied.output).toMatch(/DecisionApprovalRevision \(1 row\(s\): ls-rev\)/);

    // and the named repair is the repair that works
    // THE REPAIR IS THE SANCTIONED BYPASS, named. The aborted apply installed none of this
    // unit's seals, but the DELIVERED append-only seal on the approval register is already there
    // and refuses every direct UPDATE — correctly. So the repair declares itself by name for
    // exactly that statement, the same contract `plantLegacyApprovalRevision` and
    // `sanctionedReset` use, and the same one §P6T4D tells an operator to use.
    const repaired = psql(RUN_DB, ['-c', `
      DELETE FROM "ChangeRequest" WHERE "id" = 'ls-cr';
      ALTER TABLE "DecisionApprovalRevision" DISABLE TRIGGER "DecisionApprovalRevision_append_only";
      UPDATE "DecisionApprovalRevision" SET "finalized" = TRUE WHERE "id" = 'ls-rev';
      ALTER TABLE "DecisionApprovalRevision" ENABLE TRIGGER "DecisionApprovalRevision_append_only";
    `]);
    expect(repaired.ok, `the named repair must be applicable:\n${repaired.output}`).toBe(true);
    const clean = applyWhole();
    expect(clean.ok, `after the named repairs the apply must succeed:\n${clean.output}`).toBe(true);
  }, 300_000);

  /**
   * #582's review round 12, finding 4 — ONE CROSSING PER PROJECT, not one per membership.
   *
   * Round 10 counted the facts matching each WRITE, which two different memberships satisfy
   * independently. The contract is one flip per project per transaction, and the reason is the
   * crossing: `activeCount` is read after the writes, so two simultaneous activations both carry
   * the final count and NEITHER records the zero-to-one move the countersign re-notification
   * reads. Both bundles here are individually truthful, which is exactly why a per-membership
   * count cannot see the problem.
   */
  it('two architect activations in one project, one transaction, are refused', () => {
    buildRun(['Membership_t4d_architect_reserved', 'User_t4d_architect_reserved']);

    const twin = psql(RUN_DB, ['-c', `
      INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
        VALUES ('ss-cmd-x1','project','ss-org','ss-proj','ss-user','members.add','ss-key-x1','ss-hash-x1','reserved'),
               ('ss-cmd-x2','project','ss-org','ss-proj','ss-user','members.add','ss-key-x2','ss-hash-x2','reserved');
      UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = 'ss-mem-x1' WHERE "id" = 'ss-cmd-x1';
      UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = 'ss-mem-x2' WHERE "id" = 'ss-cmd-x2';
      INSERT INTO "User" ("id","projectId","role","name","phone") VALUES
        ('ss-arch-1','ss-proj','architect','SS Arch 1','+910000000101'),
        ('ss-arch-2','ss-proj','architect','SS Arch 2','+910000000102');
      INSERT INTO "MembershipTransition"
        ("id","projectId","membershipId","userId","fromRole","fromStatus","toRole","toStatus","actorId","actorRole","actorName","sourceCommandId")
      VALUES ('ss-mt-x1','ss-proj','ss-mem-x1','ss-arch-1',NULL,NULL,'architect','active','ss-user','pmc','SS User','ss-cmd-x1'),
             ('ss-mt-x2','ss-proj','ss-mem-x2','ss-arch-2',NULL,NULL,'architect','active','ss-user','pmc','SS User','ss-cmd-x2');
      INSERT INTO "Membership" ("id","projectId","userId","role","status") VALUES
        ('ss-mem-x1','ss-proj','ss-arch-1','architect','active'),
        ('ss-mem-x2','ss-proj','ss-arch-2','architect','active');
    `]);
    expect(twin.ok, 'two architect crossings in one transaction must be REFUSED').toBe(false);
    expect(twin.output).toMatch(/architect standing crossings in ONE transaction/);

    // ONE activation, the same shape, must commit — or the count above would be a seal that
    // refuses every architect the chain ever gets.
    buildRun(['Membership_t4d_architect_reserved', 'User_t4d_architect_reserved']);
    const single = psql(RUN_DB, ['-c', `
      INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
        VALUES ('ss-cmd-x1','project','ss-org','ss-proj','ss-user','members.add','ss-key-x1','ss-hash-x1','reserved');
      UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = 'ss-mem-x1' WHERE "id" = 'ss-cmd-x1';
      INSERT INTO "User" ("id","projectId","role","name","phone") VALUES ('ss-arch-1','ss-proj','architect','SS Arch 1','+910000000101');
      INSERT INTO "MembershipTransition"
        ("id","projectId","membershipId","userId","fromRole","fromStatus","toRole","toStatus","actorId","actorRole","actorName","sourceCommandId")
      VALUES ('ss-mt-x1','ss-proj','ss-mem-x1','ss-arch-1',NULL,NULL,'architect','active','ss-user','pmc','SS User','ss-cmd-x1');
      INSERT INTO "Membership" ("id","projectId","userId","role","status") VALUES ('ss-mem-x1','ss-proj','ss-arch-1','architect','active');
    `]);
    expect(single.ok, `one architect activation must COMMIT:\n${single.output}`).toBe(true);
  }, 180_000);

  /**
   * #582's review round 12, finding 5 — THE CASCADE EXCEPTION IS THIS PROJECT'S, NOT ANY PROJECT'S.
   *
   * The exception was two facts — nested trigger depth AND a transaction-local flag — and the
   * flag was a boolean saying "a project is being deleted here". The seals read that as "THIS
   * row's project is being deleted", which is a different sentence. Delete an event-free project
   * A, then hard-delete a membership in a SURVIVING project B: B's fact rides its own FK cascade
   * at depth 2 with A's flag on, and B's permanent evidence is erased while B remains.
   *
   * Not an arm: the exception is INSIDE the append-only seal, so stripping that seal removes the
   * refusal this probe is about. The doors are not involved; only the flag's shape is.
   */
  it('one project\'s deletion cascade may not erase another project\'s facts', () => {
    buildRun([]);

    // a second project, and a membership fact of its own — written fact-first, like any member
    // command, so nothing here is a shape this unit refuses on other grounds.
    const planted = psql(RUN_DB, ['-c', `
      INSERT INTO "Project" ("id","orgId","name","short","descriptor","stage","siteCode","projStart","projEnd","elapsedPct","todayDay","milestonePct")
        VALUES ('ss-proj-b','ss-org','B Site','B','','Finishing','B-01','01 Jan 2026','31 Dec 2026',0,0,0);
      -- the actor needs authority on the project the FACT is about, and B is not the project the
      -- base fixture made them a pmc of. Owner of the org covers every project in it, which is
      -- the window arm the membership seal admits.
      INSERT INTO "OrgMembership" ("id","orgId","userId","role") VALUES ('ss-om-b','ss-org','ss-user','owner');
      -- HOMED ON THE BASE PROJECT, not on B. User.projectId is a home pointer with a NO ACTION
      -- foreign key, so a user homed on B would block B's own deletion for a reason that has
      -- nothing to do with the seal under test — and the last assertion here is precisely that
      -- B's own cascade still carries its facts away.
      -- (No backticks in this block: it lives inside a TypeScript template literal.)
      INSERT INTO "User" ("id","projectId","role","name","phone") VALUES ('ss-b-user','ss-proj','engineer','B User','+910000000081');
      INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
        VALUES ('ss-cmd-b','project','ss-org','ss-proj-b','ss-user','members.add','ss-key-b','ss-hash-b','reserved');
      UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = 'ss-mem-b' WHERE "id" = 'ss-cmd-b';
      INSERT INTO "MembershipTransition"
        ("id","projectId","membershipId","userId","fromRole","fromStatus","toRole","toStatus","actorId","actorRole","actorName","sourceCommandId")
      VALUES ('ss-mt-b','ss-proj-b','ss-mem-b','ss-b-user',NULL,NULL,'engineer','active','ss-user','pmc','SS User','ss-cmd-b');
      INSERT INTO "Membership" ("id","projectId","userId","role","status") VALUES ('ss-mem-b','ss-proj-b','ss-b-user','engineer','active');
      -- project A: nothing in it, so deleting it is a clean cascade that sets the flag
      INSERT INTO "Project" ("id","orgId","name","short","descriptor","stage","siteCode","projStart","projEnd","elapsedPct","todayDay","milestonePct")
        VALUES ('ss-proj-a','ss-org','A Site','A','','Finishing','A-01','01 Jan 2026','31 Dec 2026',0,0,0);
    `]);
    expect(planted.ok, `the two-project world must plant cleanly:\n${planted.output}`).toBe(true);

    // A goes, and B's membership is hard-deleted in the SAME transaction. B survives, so B's fact
    // must survive with it.
    const riding = psql(RUN_DB, ['-c', `
      DELETE FROM "Project" WHERE "id" = 'ss-proj-a';
      DELETE FROM "Membership" WHERE "id" = 'ss-mem-b';
    `]);
    expect(
      riding.ok,
      'a surviving project\'s fact may not be erased by another project\'s cascade — the flag '
      + 'names WHICH projects are going, and B is not one of them',
    ).toBe(false);
    expect(riding.output).toMatch(/may not be DELETED/);

    // and B's own deletion still takes its fact with it, which is the arm the exception exists for
    const ownCascade = psql(RUN_DB, ['-c', `DELETE FROM "Project" WHERE "id" = 'ss-proj-b'`]);
    expect(
      ownCascade.ok,
      `a project's own deletion must still carry its facts away:\n${ownCascade.output}`,
    ).toBe(true);
  }, 180_000);

  /**
   * THE PAIR CHECKS, which are CONSTRAINTS and so cannot be stripped by name — the harness omits
   * `CREATE TRIGGER` statements, and a CHECK either exists or does not. The constraint NAME in the
   * refusal is what identifies which object spoke, which is the same thing a strip proves.
   *
   * #582's review round 9, finding 6 for the notice pair; and the round-8 change-request pairs,
   * which were added with the freeze proven and the CHECKS themselves never exercised — the same
   * "proved the site, not the rule" gap this round is about, in my own harness.
   */
  it('every attribution and binding PAIR is both halves or neither', () => {
    buildRun([]);

    // (1) the notice binding — round 9, finding 6
    const halfNotice = psql(RUN_DB, ['-c',
      `INSERT INTO "Notification" ("id","projectId","text","color","time","eventId")
       VALUES ('ss-note-half','ss-proj','half bound','ink','now','ss-ev1')`]);
    expect(halfNotice.ok, 'a notice with an eventId and no kind must be REFUSED').toBe(false);
    expect(halfNotice.output).toMatch(/Notification_event_binding_pair_check/);

    // the legacy shape — BOTH null — is exactly what the previous release writes, and stays legal
    const legacyNotice = psql(RUN_DB, ['-c',
      `INSERT INTO "Notification" ("id","projectId","text","color","time")
       VALUES ('ss-note-legacy','ss-proj','legacy','ink','now')`]);
    expect(legacyNotice.ok, `the previous release's kindless, eventless notice must COMMIT:\n${legacyNotice.output}`).toBe(true);

    // (2) the change request's requester pair — round 8, never exercised until now
    const halfRequester = psql(RUN_DB, ['-c',
      `INSERT INTO "ChangeRequest" ("id","decisionId","reason","costImpact","timeImpactDays","status","requestedByRole")
       VALUES ('ss-cr-half','ss-dec','x',0,0,'open','architect')`]);
    expect(halfRequester.ok, 'a role without a name must be REFUSED').toBe(false);
    expect(halfRequester.output).toMatch(/ChangeRequest_requested_pair_check/);

    // and a BLANK half is refused too — a present half is non-blank
    const blankRequester = psql(RUN_DB, ['-c',
      `INSERT INTO "ChangeRequest" ("id","decisionId","reason","costImpact","timeImpactDays","status","requestedByRole","requestedByName")
       VALUES ('ss-cr-blank','ss-dec','x',0,0,'open','architect','   ')`]);
    expect(blankRequester.ok, 'a whitespace-only name must be REFUSED').toBe(false);
    expect(blankRequester.output).toMatch(/ChangeRequest_requested_pair_check/);

    // (3) the resolver pair, same rule at the other end
    const halfResolver = psql(RUN_DB, ['-c',
      `INSERT INTO "ChangeRequest" ("id","decisionId","reason","costImpact","timeImpactDays","status","resolvedByName")
       VALUES ('ss-cr-halfres','ss-dec','x',0,0,'withdrawn','Someone')`]);
    expect(halfResolver.ok, 'a resolver name without a role must be REFUSED').toBe(false);
    expect(halfResolver.output).toMatch(/ChangeRequest_resolved_pair_check/);

    // the all-null legacy shape survives, which is what makes the CHECK safe to add
    const legacyCr = psql(RUN_DB, ['-c',
      `INSERT INTO "ChangeRequest" ("id","decisionId","reason","costImpact","timeImpactDays","status")
       VALUES ('ss-cr-legacy','ss-dec','x',0,0,'open')`]);
    expect(legacyCr.ok, `a legacy request carrying no attribution must COMMIT:\n${legacyCr.output}`).toBe(true);
  }, 180_000);

  /**
   * #582's review round 17 — A CLASS DECLARATION, MEASURED.
   *
   * Round 17's sweep reported the consultation pair as fillable by a later UPDATE: the freeze
   * keys on `OLD IS NOT NULL`, and every rule the pair has lives in a BEFORE INSERT trigger. The
   * reasoning was right about the two triggers and WRONG about the database, and this arm is what
   * found that out — the "stripped ⇒ accepted" half of the strip arm written for it came back
   * REFUSED, by an object the arm had never named.
   *
   * `phase6_t4c_consultation_append_only` is a DELIVERED 4c seal installed on both tables as
   * `<table>_t4c_append_only` BEFORE UPDATE OR DELETE. PostgreSQL fires row triggers in NAME
   * order, `_t4c_` sorts before `_t4d_`, and it refuses every update outright — so the whole of
   * `phase6_t4d_consultation_attribution_frozen` is unreachable, freeze and all.
   *
   * That is why both `_t4d_attribution` triggers sit in `COVERED_BY_CLASS` rather than having
   * strip arms. A class declaration is a claim, and this unit has now been bitten twice by claims
   * that were never driven, so the claim is driven here: the update is attempted on a WHOLE
   * migration and the refusal must come from the delivered seal BY NAME. If a later unit replaces
   * or re-orders that seal, this arm goes red and the rule that is currently unreachable becomes
   * a rule that has to work.
   */
  it('the 4d attribution freeze is unreachable, and the DELIVERED 4c append-only seal is why', () => {
    buildRun([]);

    const born = psql(RUN_DB, ['-c',
      `INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
         VALUES ('ss-cmd-con-u','project','ss-org','ss-proj','ss-user','consultations.request','ss-key-con-u','ss-hash-con-u','reserved');
       INSERT INTO "DecisionConsultation"
         ("id","projectId","decisionId","requestedById","consulteeMembershipId","consulteeUserId","question","openCycle","sourceCommandId")
       VALUES ('ss-con-u','ss-proj','ss-dec','ss-user','ss-mem-c','ss-client','born with no attribution at all',0,'ss-cmd-con-u');
       UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = 'ss-con-u' WHERE "id" = 'ss-cmd-con-u'`]);
    expect(born.ok, `a consultation with the all-null legacy pair must COMMIT — it is the drain shape:\n${born.output}`).toBe(true);

    const fill = psql(RUN_DB, ['-c',
      `UPDATE "DecisionConsultation" SET "requestedByRole" = 'architect', "requestedByName" = 'SS User' WHERE "id" = 'ss-con-u'`]);
    expect(fill.ok, 'handing a consultation an attribution pair it was not born with must be REFUSED').toBe(false);
    expect(fill.output,
      'the refusal must come from the DELIVERED 4c append-only seal — that is the whole reason the '
      + '4d attribution freeze is declared covered by its class instead of being stripped, and if '
      + 'some other object answers here that declaration no longer holds')
      .toMatch(/phase6_t4c_consultation_append_only/);

    // the same, on the response table, because the class entry covers BOTH
    const fillResponse = psql(RUN_DB, ['-At', '-c',
      `SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND t.tgname = 'DecisionConsultationResponse_t4c_append_only'
          AND c.relname = 'DecisionConsultationResponse' AND t.tgenabled = 'O'
          AND t.tgtype = 27`]);   // ROW(1) + BEFORE(2) + DELETE(8) + UPDATE(16)
    expect(fillResponse.output.trim(),
      'the response table must carry the same delivered append-only seal, enabled, on UPDATE and DELETE')
      .toBe('1');
  }, 180_000);

  /**
   * #582's review round 18, findings 4 and 6 — THE REGISTERS' UNSTATED DEPENDENCY.
   *
   * Both findings were reported as live holes and NEITHER is one. Codex read the projection
   * triggers correctly — `platform_t4d_project_org` projects `Project` INSERTs only, and
   * `phase6_t4d_membership_role_standing` takes both coordinates from NEW, so a re-key would
   * leave the old standing row behind — and then assumed nothing refuses the source write. Four
   * things do, and each was DRIVEN before this arm was written:
   *
   *   · `UPDATE "Project" SET "orgId"` → `phase6_t4b2_project_org_frozen`
   *   · `UPDATE "Membership" SET "projectId"` / `SET "userId"` → `membership_t4b_identity_frozen`
   *   · `UPDATE "OrgMembership" SET "userId"` → `phase6_t4b2_org_membership_guard`
   *   · `UPDATE "User" SET "id"` → this unit's own `UserIdentity_userId_fkey`
   *
   * THE FINDINGS ARE WRONG AND THE CLASS IS REAL, which is why this arm exists rather than a
   * reply alone. Three of those four protections live in a MERGED migration this unit never
   * names, and 4d-i's registers are exactly as trustworthy as they are: the day one is dropped or
   * narrowed, `ProjectUserStanding` starts authorising a user on a project they left and
   * `platform_user_orchestration_authority` starts answering for the wrong organisation — in
   * silence, because every probe this unit owns would still be green. An unstated dependency is a
   * dependency nobody maintains.
   *
   * So it is stated, and driven. The refusal must come from the named object in each case: if a
   * later unit replaces one of these with something weaker, this goes red instead of the
   * registers going quietly wrong.
   */
  it('the registers rest on FOUR source-identity freezes this unit does not own, and each one still refuses', () => {
    buildRun([]);

    const setup = psql(RUN_DB, ['-c',
      `INSERT INTO "Org" ("id","name","slug") VALUES ('ss-org2','SS Org Two','ss-org-2');
       INSERT INTO "Project" ("id","orgId","name","short","descriptor","stage","siteCode","projStart","projEnd","elapsedPct","todayDay","milestonePct")
         VALUES ('ss-proj2','ss-org','SS Site Two','SS2','','Finishing','SS-02','01 Jan 2026','31 Dec 2026',0,0,0);
       INSERT INTO "OrgMembership" ("id","orgId","userId","role") VALUES ('ss-om','ss-org','ss-user','owner');
       -- a MEMBERSHIP-LESS account, because the answer to a user re-key depends on whether one
       -- exists: see the two User cases below. (No backticks in this block: it lives inside a
       -- TypeScript template literal.)
       INSERT INTO "User" ("id","projectId","role","name","phone")
         VALUES ('ss-loner','ss-proj','engineer','SS Loner','+910000000009')`]);
    expect(setup.ok, `the second org/project fixture must build:\n${setup.output}`).toBe(true);

    const cases: ReadonlyArray<{ what: string; sql: string; by: RegExp }> = [
      {
        what: 'a project may not be re-tenanted — ProjectOrg would keep the old org and go on ' +
              'authorising its owners',
        sql: `UPDATE "Project" SET "orgId" = 'ss-org2' WHERE "id" = 'ss-proj'`,
        by: /phase6_t4b2_project_org_frozen|frozen standing-derivation chain/,
      },
      {
        what: 'a membership may not be re-keyed to another project — the old ProjectUserStanding ' +
              'row is never retracted by the projection',
        sql: `UPDATE "Membership" SET "projectId" = 'ss-proj2' WHERE "id" = 'ss-mem'`,
        by: /membership_t4b_identity_frozen|user\/project identity is frozen/,
      },
      {
        what: 'a membership may not be re-keyed to another user — two standing rows would carry ' +
              'one membershipId',
        sql: `UPDATE "Membership" SET "userId" = 'ss-client' WHERE "id" = 'ss-mem'`,
        by: /membership_t4b_identity_frozen|user\/project identity is frozen/,
      },
      {
        what: 'an org membership may not be re-keyed — OrgUserAuthority mirrors it',
        sql: `UPDATE "OrgMembership" SET "userId" = 'ss-client' WHERE "id" = 'ss-om'`,
        by: /org_membership_guard|org-membership identity is frozen/,
      },
      // A USER RE-KEY IS REFUSED TWICE OVER, and which answer arrives depends on the account —
      // measured, not assumed, because the first form of this arm expected the FK for both and
      // the membership case answered first. `Membership.userId` cascades on update, so an account
      // WITH a membership meets the cascade's own identity freeze before the FK is ever reached;
      // an account WITHOUT one meets this unit's `UserIdentity` FK, which is `NO ACTION`. Both
      // paths are driven, because "no path re-keys a user silently" is the claim.
      {
        what: 'a user account WITH a membership may not be re-keyed — the update cascades into ' +
              'Membership.userId, which is itself frozen',
        sql: `UPDATE "User" SET "id" = 'ss-user-x' WHERE "id" = 'ss-user'`,
        by: /membership_t4b_identity_frozen|user\/project identity is frozen/,
      },
      {
        what: 'a membership-less user account may not be re-keyed either — UserIdentity mirrors ' +
              'the id and the frozen name is read through it',
        sql: `UPDATE "User" SET "id" = 'ss-loner-x' WHERE "id" = 'ss-loner'`,
        by: /UserIdentity_userId_fkey/,
      },
    ];

    for (const c of cases) {
      const r = psql(RUN_DB, ['-c', c.sql]);
      expect(r.ok, `${c.what} — this write must be REFUSED, and it COMMITTED`).toBe(false);
      expect(r.output,
        `${c.what} — refused, but not by the object this unit depends on. The registers' ` +
        'correctness rests on that specific protection, so a different answer here means the ' +
        'dependency moved and nothing said so')
        .toMatch(c.by);
    }
  }, 180_000);

  /**
   * #582's review round 17 — THE FROZEN-PAIR REGISTER, AND WHY IT IS DISCOVERED RATHER THAN LISTED.
   *
   * Five rounds of this PR have found the same defect: a frozen `<act>ByRole`/`<act>ByName` pair
   * given the rules about its SHAPE — written together, each half nonblank — and never the rule
   * that makes it evidence, which is that it is TRUE of the actor it names. Round 11 found it at
   * the approval pair, round 16 at the consultation pair and the change request's resolver, round
   * 17 at the kernel envelope and the change request's BIRTH pair. Each round fixed the pairs its
   * findings NAMED and the next round found another.
   *
   * A list of pairs maintained by hand reproduces exactly that failure, so this arm does not keep
   * one. It ASKS THE DATABASE for every column whose name ends in `ByRole` (or is `actorRole`)
   * and which has the matching name column beside it, and requires the register below to have an
   * entry for each. A pair added by a later unit therefore cannot be silent: it fails here the
   * day its column lands, before anything can write to it.
   *
   * For each pair the register names TWO objects, because the class has two halves and this PR
   * has now been caught by both:
   *
   *   · `judgedBy` — the seal that judges the pair when it is WRITTEN. Its body must call the
   *     shared correspondence (`phase6_t4d_actor_bound`, or `phase6_t4d_actor_pair_true` where
   *     the fact-side preconditions do not apply). Nonblank is not correspondence.
   *   · `frozenBy` + `firstWrite` — the seal that governs the pair AFTERWARDS, and a token from
   *     its body witnessing that it refuses the pair ARRIVING later rather than only being
   *     rewritten. A one-way rule keyed on `OLD IS NOT NULL` governs the second write and says
   *     nothing about the first, which is how the consultation pair stayed fillable by UPDATE
   *     through sixteen rounds.
   *
   * This arm is STRUCTURAL and does not replace the driven ones: the three strip arms above prove
   * the refusals actually happen, one named seal at a time. What this adds is that no pair can be
   * left out of them in silence.
   */
  const FROZEN_PAIRS: Record<string,
    { judgedBy: string; frozenBy: string; firstWrite: string } | { judgedBy: null; why: string }> = {
    'ChangeRequest.requestedByRole': {
      judgedBy: 'phase6_t4d_change_request_birth_pair',
      frozenBy: 'phase6_t4d_change_request_evidence_frozen', firstWrite: 'at its BIRTH',
    },
    'ChangeRequest.resolvedByRole': {
      judgedBy: 'phase6_t4d_change_request_evidence_frozen',
      frozenBy: 'phase6_t4d_change_request_evidence_frozen', firstWrite: 'does not CLOSE it',
    },
    'DecisionApprovalRevision.approvedByRole': {
      judgedBy: 'phase6_t4d_revision_birth',
      frozenBy: 'phase6_t4d_revision_one_flip',
      firstWrite: 'IS DISTINCT FROM OLD."approvedByRole"',
    },
    'DecisionConsultation.requestedByRole': {
      judgedBy: 'phase6_t4d_consultation_attribution_present',
      frozenBy: 'phase6_t4d_consultation_attribution_frozen', firstWrite: 'was not born with',
    },
    'DecisionConsultationResponse.respondedByRole': {
      judgedBy: 'phase6_t4d_consultation_attribution_present',
      frozenBy: 'phase6_t4d_consultation_attribution_frozen', firstWrite: 'was not born with',
    },
    'DecisionCountersign.countersignedByRole': {
      judgedBy: 'phase6_t4d_countersign_seal',
      frozenBy: 'phase6_t4d_fact_append_only', firstWrite: 'append-only register',
    },
    'DecisionForward.forwardedByRole': {
      judgedBy: 'phase6_t4d_forward_seal',
      frozenBy: 'phase6_t4d_fact_append_only', firstWrite: 'append-only register',
    },
    'DecisionStrandedResolution.resolvedByRole': {
      judgedBy: 'phase6_t4d_stranded_seal',
      frozenBy: 'phase6_t4d_fact_append_only', firstWrite: 'append-only register',
    },
    'MembershipTransition.actorRole': {
      judgedBy: 'phase6_t4d_membership_transition_seal',
      frozenBy: 'phase6_t4d_membership_transition_immutable', firstWrite: 'is immutable',
    },
    'DomainEvent.actorRole': {
      judgedBy: 'platform_t4d_event_envelope',
      frozenBy: 'platform_t4d_event_envelope', firstWrite: 'is immutable',
    },

    // THE ONE DISCOVERED PAIR THIS UNIT DOES NOT BIND, named rather than left silent.
    //
    // `DecisionEvent.actorRole`/`actorName` is DELIVERED — `20260920000000_phase1_change_control_
    // _diagnostic` added it, and it is a merged migration whose bytes do not change. It is written
    // by the CURRENTLY DEPLOYED release through `resolveActor`, which takes the pair from
    // `User.role` and `User.name`. That is a DIFFERENT AUTHORITY from the register this unit
    // installs: `ProjectUserStanding` is projected from `Membership.role`, and the two disagree
    // for any account whose `User.role` is not its membership role. Binding this pair in 4d-i
    // would therefore refuse writes from the release that is still serving, mid-drain — the one
    // thing a dark migration may not do — so it is 4d-ii's, where the writer itself moves onto the
    // register. 4d-i does make the exposure permanent (`DecisionEvent_t4d_append_only` freezes the
    // row), and the reserved-value audit in the decisions half is what keeps the 4d-only kinds out
    // of it in the meantime.
    'DecisionEvent.actorRole': {
      judgedBy: null,
      why: 'delivered by the merged phase-1 migration and written from User.role by the deployed '
        + 'release; binding it here would refuse that writer through the drain (4d-ii owns it)',
    },
  };

  it('every frozen role/name pair is DISCOVERED from the database, and each one this unit adds is judged against its actor', () => {
    buildRun([]);

    const discovery = psql(RUN_DB, ['-At', '-c',
      `SELECT c.table_name || '.' || c.column_name
         FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND (c.column_name LIKE '%ByRole' OR c.column_name = 'actorRole')
          AND EXISTS (SELECT 1 FROM information_schema.columns n
                       WHERE n.table_schema = 'public' AND n.table_name = c.table_name
                         AND n.column_name = replace(replace(c.column_name, 'ByRole', 'ByName'),
                                                     'actorRole', 'actorName'))
        ORDER BY 1`]);
    expect(discovery.ok, `the pair discovery query failed:\n${discovery.output}`).toBe(true);
    const found = discovery.output.split('\n').map((l) => l.trim()).filter(Boolean);

    expect(found.length, 'the discovery found no frozen pairs at all — the query is broken, not the schema')
      .toBeGreaterThan(0);
    expect(found.slice().sort()).toEqual(Object.keys(FROZEN_PAIRS).sort());

    const src = psql(RUN_DB, ['-At', '-R', '\u0001', '-F', '\u0002', '-c',
      `SELECT p.proname, p.prosrc FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'`]);
    expect(src.ok, `reading the installed function bodies failed:\n${src.output}`).toBe(true);
    const bodies = new Map<string, string>(
      src.output.split('\u0001').map((r) => r.split('\u0002')).filter((r) => r.length === 2)
        .map(([name, body]) => [name.trim(), body] as [string, string]));

    for (const [pair, entry] of Object.entries(FROZEN_PAIRS)) {
      if (entry.judgedBy === null) continue;
      const judge = bodies.get(entry.judgedBy);
      expect(judge, `${pair} names ${entry.judgedBy} as its judge and no such function is installed`)
        .toBeTruthy();
      expect(judge,
        `${pair} is judged by ${entry.judgedBy}, whose body never calls the shared correspondence — `
        + 'a pair with rules only about its SHAPE attributes an act to whoever the writer names')
        .toMatch(/phase6_t4d_actor_(bound|pair_true)/);

      const freeze = bodies.get(entry.frozenBy);
      expect(freeze, `${pair} names ${entry.frozenBy} as its freeze and no such function is installed`)
        .toBeTruthy();
      expect(freeze,
        `${pair} is frozen by ${entry.frozenBy}, whose body does not carry ${JSON.stringify(entry.firstWrite)} — `
        + 'nothing there refuses the pair ARRIVING after the act, which is a write the judge above never sees')
        .toContain(entry.firstWrite);
    }
  }, 180_000);

  /**
   * #582's review round 9, finding 5 — THE AUDIT COUNT RUNS BOTH WAYS.
   *
   * Round 7 replaced an existence check with a count and stopped there. Every audit row demanded
   * exactly one event; nothing demanded exactly one audit row. One act, one event, TWO immutable
   * audit claims, and each deferred invocation saw `v_events = 1` and passed.
   */
  it('one act appends ONE audit row, not two that each see their single event', () => {
    buildRun([]);

    // `change_requested` is used because the audit map is keyed by (type, resulting status) and
    // this pair needs no entry into `approved` — the entry seal is not what this arm measures.
    expect(psql(RUN_DB, ['-c', `UPDATE "Decision" SET "status" = 'change' WHERE "id" = 'ss-dec'`]).ok).toBe(true);

    // one valid allocation + ONE event + TWO audit rows for the same act
    const doubled = psql(RUN_DB, ['-c', `
      BEGIN;
      UPDATE "ProjectEventStream" SET "nextPosition" = "nextPosition" + 1 WHERE "projectId" = 'ss-proj';
      INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","actorKind","systemActor","entityType","entityId","dispatchIntent")
        SELECT 'ss-ev-dbl','decision.change_requested',1,'ss-org','ss-proj',s."nextPosition" - 1,'system','system:seed','Decision','ss-dec',
               jsonb_build_object('effectKey','decision.change_requested','coverageVersion',c."coverageVersion",'invalidate',c."invalidate")
          FROM "ProjectEventStream" s, "ExternalEffectCatalog" c
         WHERE s."projectId" = 'ss-proj' AND c."effectKey" = 'decision.change_requested'
           AND c."coverageVersion" = '${COVERAGE}';
      INSERT INTO "DecisionEvent" ("id","decisionId","type","actor") VALUES ('ss-de-1','ss-dec','change_requested','X');
      INSERT INTO "DecisionEvent" ("id","decisionId","type","actor") VALUES ('ss-de-2','ss-dec','change_requested','X');
      COMMIT;
    `]);
    expect(
      doubled.ok,
      'two audit rows for one act must be REFUSED — each one sees its single event and passes the '
      + `one-sided count, which is exactly the hole round 7 left:\n${doubled.output}`,
    ).toBe(false);
    expect(doubled.output).toMatch(/audit rows written by this transaction/);

    // ONE row for the same act still commits — the fix narrows, it does not close the path
    const single = psql(RUN_DB, ['-c', `
      BEGIN;
      UPDATE "ProjectEventStream" SET "nextPosition" = "nextPosition" + 1 WHERE "projectId" = 'ss-proj';
      INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","actorKind","systemActor","entityType","entityId","dispatchIntent")
        SELECT 'ss-ev-one','decision.change_requested',1,'ss-org','ss-proj',s."nextPosition" - 1,'system','system:seed','Decision','ss-dec',
               jsonb_build_object('effectKey','decision.change_requested','coverageVersion',c."coverageVersion",'invalidate',c."invalidate")
          FROM "ProjectEventStream" s, "ExternalEffectCatalog" c
         WHERE s."projectId" = 'ss-proj' AND c."effectKey" = 'decision.change_requested'
           AND c."coverageVersion" = '${COVERAGE}';
      INSERT INTO "DecisionEvent" ("id","decisionId","type","actor") VALUES ('ss-de-ok','ss-dec','change_requested','X');
      COMMIT;
    `]);
    expect(single.ok, `one audit row for one event must COMMIT:\n${single.output}`).toBe(true);
  }, 180_000);

  /**
   * #582's review round 23, finding 1 — AN APPROVAL ENTRY IS A NAMED PAIR OF TRANSITIONS, not
   * every move that happens to land on `approved`.
   *
   * Round 22 built the transition register because only the UPDATE itself, holding OLD, can tell
   * an act from a state. It then recorded ANY change into `approved`, while the exception message
   * it feeds — and the comment three lines above it — both say `pending`/`change` -> `approved`.
   * The delivered `Decision_t4b_attribution_seal` is where that pair comes from: the approval
   * tuple may first be written only by that move, and `DecisionApprovalRevision.approvedFrom`
   * carries a CHECK admitting those two sources and no third.
   *
   * After 4d-iii there IS a third move onto `approved` — the stranded completion, which finishes
   * an already-made provisional approval out of `awaiting_countersign` and writes no new approval
   * at all. A bundle that performs a genuine one can ride it: mint a real `decisions.approve`
   * receipt, insert a higher-version FINALIZED revision beside it, and the birth seal sees a
   * register entry, an `approved` end state and one new revision. The fabricated approval becomes
   * the immutable head and inflates the cycle count 4c reads.
   *
   * Two-sided, because a register that recorded NOTHING would also refuse the first half.
   */
  it('a finalized revision rides an approval ENTRY, and a stranded completion is not one', () => {
    // The three 4d-i objects that stand in front of an `awaiting_countersign` decision at all —
    // the reservation door, the entry seal's architect demand, and the provisional-birth pairing.
    // The seal under test, `DecisionApprovalRevision_t4d_birth_paired`, stays installed.
    buildRun(['Decision_t4d_awaiting_reserved', 'Decision_t4d_entry_seal', 'Decision_t4d_awaiting_paired']);

    // parked by an EARLIER transaction, which is what a decision awaiting its countersigner is
    expect(psql(RUN_DB, ['-c',
      `UPDATE "Decision" SET "status" = 'awaiting_countersign' WHERE "id" = 'ss-dec'`]).ok).toBe(true);

    const stranded = psql(RUN_DB, ['-c', `
      BEGIN;
      INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
        VALUES ('ss-cmd-str','project','ss-org','ss-proj','ss-user','decisions.approve','ss-key-str','ss-hash-str','reserved');
      UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = 'ss-dec' WHERE "id" = 'ss-cmd-str';
      UPDATE "Decision" SET "status" = 'approved' WHERE "id" = 'ss-dec';
      INSERT INTO "DecisionApprovalRevision" ("id","projectId","decisionId","version","optionKey","approvedAt","approvedById","sourceCommandId")
        VALUES ('ss-rev-str','ss-proj','ss-dec',1,'a',now(),'ss-user','ss-cmd-str');
      COMMIT;
    `]);
    expect(
      stranded.ok,
      'a FINALIZED revision born on an `awaiting_countersign` -> `approved` completion must be '
      + 'REFUSED — that move finishes an approval already made and writes no new one, so a '
      + `revision riding it is an approval cycle nobody performed:\n${stranded.output}`,
    ).toBe(false);
    expect(stranded.output).toMatch(/transition of decision/);

    // AND THE REAL ENTRY STILL COMMITS. A register that recorded no move would refuse this too,
    // which is the shape this half exists to exclude.
    const born = psql(RUN_DB, ['-c', `
      BEGIN;
      INSERT INTO "Decision" ("id","projectId","title","room","status","photoSwatch","publishedAt")
        VALUES ('ss-dec3','ss-proj','SS Entry','Hall','pending','sw',NULL);
      INSERT INTO "DecisionOption" ("id","decisionId","label","optionKey","material","delta","swatch","order")
        VALUES ('ss-opt3-a','ss-dec3','Option A','a','Granite',0,'sw1',0),
               ('ss-opt3-b','ss-dec3','Option B','b','Quartz',100,'sw2',1);
      UPDATE "Decision" SET "publishedAt" = now() WHERE "id" = 'ss-dec3';
      COMMIT;
    `]);
    expect(born.ok, `the entry fixture must commit:\n${born.output}`).toBe(true);

    const entry = psql(RUN_DB, ['-c', `
      BEGIN;
      INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
        VALUES ('ss-cmd-ent','project','ss-org','ss-proj','ss-user','decisions.approve','ss-key-ent','ss-hash-ent','reserved');
      UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = 'ss-dec3' WHERE "id" = 'ss-cmd-ent';
      UPDATE "Decision" SET "status" = 'approved' WHERE "id" = 'ss-dec3';
      INSERT INTO "DecisionApprovalRevision" ("id","projectId","decisionId","version","optionKey","approvedAt","approvedById","sourceCommandId")
        VALUES ('ss-rev-ent','ss-proj','ss-dec3',1,'a',now(),'ss-user','ss-cmd-ent');
      COMMIT;
    `]);
    expect(entry.ok, `a real \`pending\` -> \`approved\` entry must COMMIT:\n${entry.output}`).toBe(true);
  }, 180_000);

  /**
   * #582's review round 23, finding 2 — THE CLOSURE RECEIPT'S ADMITTED RESULT IS THE DECISION,
   * for BOTH writers, and round 22 wrote the opposite for one of them.
   *
   * §D settles this in terms the plan states twice and then lists under "Deliberately NOT done":
   * a `ChangeRequest` CLOSURE is admitted with a `resultRef` naming the closed row's `decisionId`,
   * "which is what both writers already return", and re-pointing `withdrawChange`'s receipt at the
   * request is the alternative the plan REJECTS — a command whose subject is the decision does not
   * get its receipt moved to satisfy a seal. Round 22 split the rule by command anyway and
   * demanded `NEW."id"` on the withdrawal arm, which refuses every ordinary withdrawal the moment
   * 4d-ii starts writing the column: `decisions.service.ts` completes it with `resultRef:
   * decisionId`.
   *
   * Two-sided, because a binding that admitted ANY receipt would also pass the first half.
   */
  it('a closure cites the receipt its command actually completes — the decision, for both writers', () => {
    buildRun([]);

    const shipped = psql(RUN_DB, ['-c', `
      BEGIN;
      INSERT INTO "ChangeRequest" ("id","decisionId","projectId","reason","costImpact","timeImpactDays","status")
        VALUES ('ss-cr-wd','ss-dec','ss-proj','withdraw me',0,0,'open');
      INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
        VALUES ('ss-cmd-wd','project','ss-org','ss-proj','ss-user','decisions.withdrawChange','ss-key-wd','ss-hash-wd','reserved');
      UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = 'ss-dec' WHERE "id" = 'ss-cmd-wd';
      UPDATE "ChangeRequest" SET "resolvedByCommandId" = 'ss-cmd-wd', "resolvedById" = 'ss-user',
             "resolvedByRole" = 'pmc', "resolvedByName" = 'SS User', "status" = 'withdrawn',
             "resolution" = 'withdrawn', "resolvedAt" = now()
       WHERE "id" = 'ss-cr-wd';
      COMMIT;
    `]);
    expect(
      shipped.ok,
      'the SHIPPED withdrawal bundle must COMMIT — `decisions.withdrawChange` completes its '
      + 'receipt with `resultRef: decisionId`, and §D admits exactly that shape for a closure:\n'
      + `${shipped.output}`,
    ).toBe(true);

    // AND A RECEIPT FOR ANOTHER DECISION IS STILL REFUSED: the admitted shape is THIS row's
    // decision, not any decision.
    const borrowed = psql(RUN_DB, ['-c', `
      BEGIN;
      INSERT INTO "ChangeRequest" ("id","decisionId","projectId","reason","costImpact","timeImpactDays","status")
        VALUES ('ss-cr-wd2','ss-dec','ss-proj','borrowed result',0,0,'open');
      INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
        VALUES ('ss-cmd-wd2','project','ss-org','ss-proj','ss-user','decisions.withdrawChange','ss-key-wd2','ss-hash-wd2','reserved');
      UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = 'ss-dec2' WHERE "id" = 'ss-cmd-wd2';
      UPDATE "ChangeRequest" SET "resolvedByCommandId" = 'ss-cmd-wd2', "resolvedById" = 'ss-user',
             "resolvedByRole" = 'pmc', "resolvedByName" = 'SS User', "status" = 'withdrawn',
             "resolution" = 'withdrawn', "resolvedAt" = now()
       WHERE "id" = 'ss-cr-wd2';
      COMMIT;
    `]);
    expect(
      borrowed.ok,
      `a closure receipt naming ANOTHER decision must still be refused:\n${borrowed.output}`,
    ).toBe(false);
    expect(borrowed.output).toMatch(/not this request's decision|closes the request of the decision it moved/);
  }, 180_000);

  /**
   * #582's review round 23, finding 3 — THE EFFECT ACTOR BINDING IS PER-BRANCH, and round 19's
   * finding 4 bound ONE branch.
   *
   * That round's own words are "the act's records are bound to the act's ROW", and the row it
   * named was the approval revision. The correspondence seal, though, answers for nine branches,
   * and each of the others has an act row of its own written in the same transaction: the change
   * request's `requestedById` and `resolvedById`, the countersign's `countersignedById`, the
   * stranded resolution's `resolvedById`, the forward's `forwardedById`. Gating the whole binding
   * on `decision.approved`/`decision.reapproved` left every one of those unasked — so a request
   * recorded as A can append its audit row and emit its event as B, permanently.
   *
   * Two-sided, because a binding that refused every mismatch AND every match would pass the first
   * half while breaking the shipped writer.
   */
  it('every decision effect names the actor its OWN act row recorded, branch by branch', () => {
    buildRun([]);

    const forged = psql(RUN_DB, ['-c', `
      BEGIN;
      UPDATE "Decision" SET "status" = 'change' WHERE "id" = 'ss-dec';
      INSERT INTO "ChangeRequest" ("id","decisionId","projectId","reason","costImpact","timeImpactDays","status","requestedById","requestedByRole","requestedByName")
        VALUES ('ss-cr-actor','ss-dec','ss-proj','who asked?',0,0,'open','ss-user','pmc','SS User');
      UPDATE "ProjectEventStream" SET "nextPosition" = "nextPosition" + 1 WHERE "projectId" = 'ss-proj';
      INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","actorKind","systemActor","entityType","entityId","dispatchIntent")
        SELECT 'ss-ev-actor','decision.change_requested',1,'ss-org','ss-proj',s."nextPosition" - 1,'system','system:seed','Decision','ss-dec',
               jsonb_build_object('effectKey','decision.change_requested','coverageVersion',c."coverageVersion",'invalidate',c."invalidate")
          FROM "ProjectEventStream" s, "ExternalEffectCatalog" c
         WHERE s."projectId" = 'ss-proj' AND c."effectKey" = 'decision.change_requested'
           AND c."coverageVersion" = '${COVERAGE}';
      INSERT INTO "DecisionEvent" ("id","decisionId","type","actor","actorId")
        VALUES ('ss-de-actor','ss-dec','change_requested','SS Client','ss-client');
      COMMIT;
    `]);
    expect(
      forged.ok,
      'an audit row attributing a change request to someone other than its requester must be '
      + `REFUSED — both rows are immutable, and the register would carry two answers:\n${forged.output}`,
    ).toBe(false);
    expect(forged.output).toMatch(/change request this transaction opened/);

    // AND THE TRUTHFUL BUNDLE COMMITS, which is the shipped `requestChange` path.
    buildRun([]);
    const truthful = psql(RUN_DB, ['-c', `
      BEGIN;
      UPDATE "Decision" SET "status" = 'change' WHERE "id" = 'ss-dec';
      INSERT INTO "ChangeRequest" ("id","decisionId","projectId","reason","costImpact","timeImpactDays","status","requestedById","requestedByRole","requestedByName")
        VALUES ('ss-cr-actor-ok','ss-dec','ss-proj','who asked?',0,0,'open','ss-user','pmc','SS User');
      UPDATE "ProjectEventStream" SET "nextPosition" = "nextPosition" + 1 WHERE "projectId" = 'ss-proj';
      INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","actorKind","systemActor","entityType","entityId","dispatchIntent")
        SELECT 'ss-ev-actor-ok','decision.change_requested',1,'ss-org','ss-proj',s."nextPosition" - 1,'system','system:seed','Decision','ss-dec',
               jsonb_build_object('effectKey','decision.change_requested','coverageVersion',c."coverageVersion",'invalidate',c."invalidate")
          FROM "ProjectEventStream" s, "ExternalEffectCatalog" c
         WHERE s."projectId" = 'ss-proj' AND c."effectKey" = 'decision.change_requested'
           AND c."coverageVersion" = '${COVERAGE}';
      INSERT INTO "DecisionEvent" ("id","decisionId","type","actor","actorId")
        VALUES ('ss-de-actor-ok','ss-dec','change_requested','SS User','ss-user');
      COMMIT;
    `]);
    expect(truthful.ok, `the truthful bundle must COMMIT:\n${truthful.output}`).toBe(true);
  }, 180_000);

  /**
   * #582's review round 24, finding 1 — AN UNLISTED PAIR IS NOT AN UNGOVERNED ONE.
   *
   * The correspondence table is keyed by (audit kind, the status the decision committed in), and
   * its `ELSE NULL` returned unchecked. Round 15 reserved the four 4d-ONLY kinds, which closed the
   * hole for those; every ORDINARY kind still fell through whenever its decision ended in a status
   * the table does not list. A standalone `approved` audit row beside a `pending` decision — no
   * transition, no event, no revision — therefore committed, `DecisionEvent_t4d_append_only` froze
   * it, and the next real approval counts it in `priorApprovals` and hands the immutable revision
   * an inflated version.
   *
   * Two-sided, because the ungoverned kinds are real: `issued`, `withdrawn`, `recorded`,
   * `draft_updated` are previous-release audit kinds with no 4d correspondence obligation, and a
   * seal that refused them would refuse the shipped writers.
   */
  it('an audit kind this unit governs is refused in a state its table does not admit', () => {
    buildRun([]);

    // ss-dec is `pending`: no arm of the table pairs `approved` with `pending`
    const stray = psql(RUN_DB, ['-c',
      `INSERT INTO "DecisionEvent" ("id","decisionId","type","actor")
         VALUES ('ss-de-stray','ss-dec','approved','X')`]);
    expect(
      stray.ok,
      'a standalone `approved` audit row beside a `pending` decision must be REFUSED — nothing '
      + 'approved anything, the append-only seal is about to make the row permanent, and the next '
      + `real approval counts it:\n${stray.output}`,
    ).toBe(false);
    expect(stray.output).toMatch(/no correspondence rule/);

    // AND THE UNGOVERNED KINDS STILL COMMIT. `issued` is a previous-release audit kind this unit
    // states no obligation for, and a seal that refused it would refuse the shipped writer.
    const ordinary = psql(RUN_DB, ['-c',
      `INSERT INTO "DecisionEvent" ("id","decisionId","type","actor")
         VALUES ('ss-de-ord','ss-dec','issued','X')`]);
    expect(
      ordinary.ok,
      `a previous-release audit kind must still COMMIT:\n${ordinary.output}`,
    ).toBe(true);
  }, 180_000);

  /**
   * #582's review round 24, finding 2 — THE REGISTER IS APPEND-ONLY ROW BY ROW AND TRUNCATABLE
   * WHOLE.
   *
   * This unit makes every `DecisionEvent` row immutable through row-level UPDATE/DELETE triggers.
   * TRUNCATE fires neither. The only truncate seal on the table is the DELIVERED
   * `DecisionEvent_t4a_no_truncate`, which refuses only while an `approved` or `reapproved` row
   * exists — so a register holding `change_requested`, `change_withdrawn`, `forwarded` or
   * `countersign_renotified` rows and no approval could be erased whole, taking with it exactly
   * the evidence this unit's correspondence seals spent four rounds binding.
   *
   * Two-sided against the SANCTIONED RESET, which is the reason this seal must be nameable: the
   * harness and the seed truncate this table by contract, and they do it by disabling the seal by
   * name.
   */
  it('the audit register cannot be truncated whole, approval rows present or not', () => {
    buildRun([]);

    // a register with NO approval row — exactly the shape the delivered t4a seal permits
    expect(psql(RUN_DB, ['-c',
      `INSERT INTO "DecisionEvent" ("id","decisionId","type","actor")
         VALUES ('ss-de-tr','ss-dec','issued','X')`]).ok).toBe(true);

    const wiped = psql(RUN_DB, ['-c', `TRUNCATE "DecisionEvent"`]);
    expect(
      wiped.ok,
      'TRUNCATE of the audit register must be REFUSED even with no approval row present — row-level '
      + `immutability that a whole-table statement walks past is not immutability:\n${wiped.output}`,
    ).toBe(false);
    expect(wiped.output).toMatch(/attributable audit register/);

    // AND THE SANCTIONED RESET STILL WORKS, by name. Forty-odd shared-database resets truncate
    // this table by contract; a seal with no nameable bypass would break every one of them.
    const sanctioned = psql(RUN_DB, ['-c', `
      BEGIN;
      ALTER TABLE "DecisionEvent" DISABLE TRIGGER "DecisionEvent_t4d_no_truncate";
      ALTER TABLE "DecisionEvent" DISABLE TRIGGER "DecisionEvent_t4a_no_truncate";
      TRUNCATE "DecisionEvent";
      ALTER TABLE "DecisionEvent" ENABLE TRIGGER "DecisionEvent_t4a_no_truncate";
      ALTER TABLE "DecisionEvent" ENABLE TRIGGER "DecisionEvent_t4d_no_truncate";
      COMMIT;
    `]);
    expect(
      sanctioned.ok,
      `the sanctioned reset must still truncate the register:\n${sanctioned.output}`,
    ).toBe(true);

    // AND THE STREAM, which is where the sweep behind this finding landed. `DomainEvent` carries
    // four row triggers — two delivered, two this unit's — and carried no statement-level arm,
    // while every register derived from it (`Notification`, `DomainEventPairingClaim`,
    // `ProjectEventStream`) was already sealed against a wipe.
    const stream = psql(RUN_DB, ['-c', `TRUNCATE "DomainEvent" CASCADE`]);
    expect(
      stream.ok,
      'TRUNCATE of the delivery stream must be REFUSED — every 4d correspondence, claim and actor '
      + 'binding is a statement about a row in it, judged once at write time and never again:\n'
      + `${stream.output}`,
    ).toBe(false);
    expect(stream.output).toMatch(/delivery stream/);
  }, 180_000);

  /**
   * #582's review round 24, finding 3 — THE NOTICE'S EVENT IS THIS TRANSACTION'S TOO.
   *
   * "The receipt is THIS transaction's" is a rule this PR has now applied four times — to the
   * kernel's event lookup (round 1, finding 2), to the decision facts' receipts (round 4, finding
   * 3), to the change request's birth receipt (round 20) and to its closure receipt (round 22).
   * The notice's EVENT was never brought into it: the binding resolved the referenced
   * `DomainEvent` by identity alone, so a direct writer could bind a kinded notice to an event
   * from any past transaction, satisfy the kind and entity clauses, and leave a fabricated
   * duplicate feed item that `Notification_t4d_binding` immediately makes undeletable — and the
   * notification converse, which runs from the EVENT side, never revisits a row already there.
   *
   * Two-sided: the bundle 4d-ii actually writes — event and notice in one transaction — commits.
   * No shipped writer sets `eventId` at all (the column is dark until 4d-ii), so nothing in this
   * release can be refused by the new demand.
   */
  it('a kinded notice names an event THIS transaction emitted, not one lying in the stream', () => {
    buildRun([]);

    // `ss-ev1` is the fixture's own committed `decision.published` event — real, same project,
    // and from an earlier transaction, which is the whole point.
    const borrowed = psql(RUN_DB, ['-c',
      `INSERT INTO "Notification" ("id","projectId","text","color","time","kind","eventId","decisionId")
         VALUES ('ss-note-old','ss-proj','borrowed','#000','just now','decision.published','ss-ev1','ss-dec')`]);
    expect(
      borrowed.ok,
      'a kinded notice bound to an event from an EARLIER transaction must be REFUSED — the notice '
      + 'is part of the act\'s bundle, and one minted against old history is a feed item for an '
      + `announcement that already happened:\n${borrowed.output}`,
    ).toBe(false);
    expect(borrowed.output).toMatch(/EARLIER transaction/);

    // AND THE BUNDLE COMMITS: allocate, emit, bind — one transaction, which is what 4d-ii writes.
    const bundle = psql(RUN_DB, ['-c', `
      BEGIN;
      UPDATE "ProjectEventStream" SET "nextPosition" = "nextPosition" + 1 WHERE "projectId" = 'ss-proj';
      INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","actorKind","systemActor","entityType","entityId","dispatchIntent")
        SELECT 'ss-ev-note','decision.published',1,'ss-org','ss-proj',s."nextPosition" - 1,'system','system:seed','Decision','ss-dec',
               jsonb_build_object('effectKey','decision.published','coverageVersion',c."coverageVersion",'invalidate',c."invalidate",
                                  'push', jsonb_build_object('body','ss','roles', jsonb_build_array('client')))
          FROM "ProjectEventStream" s, "ExternalEffectCatalog" c
         WHERE s."projectId" = 'ss-proj' AND c."effectKey" = 'decision.published'
           AND c."coverageVersion" = '${COVERAGE}';
      INSERT INTO "Notification" ("id","projectId","text","color","time","kind","eventId","decisionId")
        VALUES ('ss-note-new','ss-proj','bundled','#000','just now','decision.published','ss-ev-note','ss-dec');
      COMMIT;
    `]);
    expect(bundle.ok, `the same-transaction bundle must COMMIT:\n${bundle.output}`).toBe(true);
  }, 180_000);

  /**
   * #582's review round 24, finding 4 — THE FREEZE COVERED THE COLUMNS THIS UNIT ADDED AND NOT THE
   * ONE THEY ARE ABOUT.
   *
   * `ChangeRequest`'s evidence freeze guards `sourceCommandId` and the requester pair at birth,
   * and the receipt and resolver pair at closure. `requestedById` and `resolvedById` — the two
   * DELIVERED columns naming the people the frozen evidence describes — were in neither set. So
   * after a valid closure attributing the act to A, a direct update swaps `resolvedById` to B
   * while the immutable receipt, role and name still describe A: the delivered t4b seal freezes
   * `decisionId` alone, and the closure binding fires only on `resolvedByCommandId` going
   * NULL -> value, which this update does not touch. The row then permanently contradicts itself.
   *
   * BOTH SIDES, because it is one class and the birth side is the same shape: Codex named the
   * closure, and the requester is the identical omission one act earlier.
   */
  it('the requester and resolver a change request NAMES are frozen with the evidence about them', () => {
    buildRun([]);

    // a legitimate birth, pair and all
    expect(psql(RUN_DB, ['-c',
      `INSERT INTO "ChangeRequest" ("id","decisionId","projectId","reason","costImpact","timeImpactDays","status","requestedById","requestedByRole","requestedByName")
         VALUES ('ss-cr-id','ss-dec','ss-proj','who asked',0,0,'open','ss-user','pmc','SS User')`]).ok).toBe(true);

    const reQuester = psql(RUN_DB, ['-c',
      `UPDATE "ChangeRequest" SET "requestedById" = 'ss-client' WHERE "id" = 'ss-cr-id'`]);
    expect(
      reQuester.ok,
      'swapping `requestedById` under a frozen requester pair must be REFUSED — the pair is '
      + `immutable evidence ABOUT that person, and the row would name someone else:\n${reQuester.output}`,
    ).toBe(false);
    expect(reQuester.output).toMatch(/at its BIRTH and it may not be written, replaced or cleared/);

    // a legitimate closure, receipt and pair and all
    expect(psql(RUN_DB, ['-c', `
      BEGIN;
      INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
        VALUES ('ss-cmd-id','project','ss-org','ss-proj','ss-user','decisions.withdrawChange','ss-key-id','ss-hash-id','reserved');
      UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = 'ss-dec' WHERE "id" = 'ss-cmd-id';
      UPDATE "ChangeRequest" SET "resolvedByCommandId" = 'ss-cmd-id', "resolvedById" = 'ss-user',
             "resolvedByRole" = 'pmc', "resolvedByName" = 'SS User', "status" = 'withdrawn',
             "resolution" = 'withdrawn', "resolvedAt" = now()
       WHERE "id" = 'ss-cr-id';
      COMMIT;
    `]).ok).toBe(true);

    const reSolver = psql(RUN_DB, ['-c',
      `UPDATE "ChangeRequest" SET "resolvedById" = 'ss-client' WHERE "id" = 'ss-cr-id'`]);
    expect(
      reSolver.ok,
      'swapping `resolvedById` under a frozen receipt and resolver pair must be REFUSED — the '
      + 'receipt was run by one person and the row would name another, permanently and with '
      + `nothing left that can re-examine it:\n${reSolver.output}`,
    ).toBe(false);
    expect(reSolver.output).toMatch(/already records .* as provenance|the person the frozen/);
  }, 180_000);

  /**
   * #582's review round 25, finding 1 — ONE ACT HAS ONE APPROVAL FAMILY, and every count in this
   * seal asked only about the type in front of it.
   *
   * Round 7 made the event count EXACT, round 9 made the audit count exact in the converse
   * direction, and round 24 refused the (kind, status) pairs the table does not list. All three
   * are per-TYPE: each trigger invocation counts events matching ITS row's required types, and
   * audit rows of ITS row's own type. Nothing counted ACROSS the two types that describe the same
   * act. So a no-chain `pending` -> `approved` bundle carrying ONE valid revision can append an
   * `approved`/`decision.approved` pair AND a `reapproved`/`decision.reapproved` pair: each
   * invocation sees exactly one event and one audit row of its own type, and round 23's actor
   * binding resolves both to the same revision, so the whole thing commits. The register then
   * holds two immutable approval rows for one approval — `priorApprovals` counts both and the
   * next revision is stamped a version too high — and the stream carries a second announcement
   * the consumer will dispatch.
   *
   * Two-sided, because the single-family bundle is the shipped approval path and must commit.
   */
  it('one approval act announces ONE family — the second is refused across the types, not within them', () => {
    buildRun([]);

    expect(psql(RUN_DB, ['-c', `
      BEGIN;
      INSERT INTO "Decision" ("id","projectId","title","room","status","photoSwatch","publishedAt")
        VALUES ('ss-dec-fam','ss-proj','SS Family','Hall','pending','sw',NULL);
      INSERT INTO "DecisionOption" ("id","decisionId","label","optionKey","material","delta","swatch","order")
        VALUES ('ss-optf-a','ss-dec-fam','Option A','a','Granite',0,'sw1',0),
               ('ss-optf-b','ss-dec-fam','Option B','b','Quartz',100,'sw2',1);
      UPDATE "Decision" SET "publishedAt" = now() WHERE "id" = 'ss-dec-fam';
      COMMIT;
    `]).ok).toBe(true);

    // ONE revision, ONE transition — and TWO families announced around it.
    const doubled = psql(RUN_DB, ['-c', `
      BEGIN;
      INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
        VALUES ('ss-cmd-fam','project','ss-org','ss-proj','ss-user','decisions.approve','ss-key-fam','ss-hash-fam','reserved');
      UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = 'ss-dec-fam' WHERE "id" = 'ss-cmd-fam';
      UPDATE "Decision" SET "status" = 'approved' WHERE "id" = 'ss-dec-fam';
      INSERT INTO "DecisionApprovalRevision" ("id","projectId","decisionId","version","optionKey","approvedAt","approvedById","sourceCommandId")
        VALUES ('ss-rev-fam','ss-proj','ss-dec-fam',1,'a',now(),'ss-user','ss-cmd-fam');
      UPDATE "ProjectEventStream" SET "nextPosition" = "nextPosition" + 1 WHERE "projectId" = 'ss-proj';
      INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","actorKind","systemActor","entityType","entityId","dispatchIntent")
        SELECT 'ss-ev-fam1','decision.approved',1,'ss-org','ss-proj',s."nextPosition" - 1,'system','system:seed','Decision','ss-dec-fam',
               jsonb_build_object('effectKey','decision.approved','coverageVersion',c."coverageVersion",'invalidate',c."invalidate",
                                  'push', jsonb_build_object('body','ss approval','roles', c."pushRoles"))
          FROM "ProjectEventStream" s, "ExternalEffectCatalog" c
         WHERE s."projectId" = 'ss-proj' AND c."effectKey" = 'decision.approved'
           AND c."coverageVersion" = '${COVERAGE}';
      INSERT INTO "DecisionEvent" ("id","decisionId","type","actor","actorId")
        VALUES ('ss-de-fam1','ss-dec-fam','approved','SS User','ss-user');
      UPDATE "ProjectEventStream" SET "nextPosition" = "nextPosition" + 1 WHERE "projectId" = 'ss-proj';
      INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","actorKind","systemActor","entityType","entityId","dispatchIntent")
        SELECT 'ss-ev-fam2','decision.reapproved',1,'ss-org','ss-proj',s."nextPosition" - 1,'system','system:seed','Decision','ss-dec-fam',
               jsonb_build_object('effectKey','decision.reapproved','coverageVersion',c."coverageVersion",'invalidate',c."invalidate",
                                  'push', jsonb_build_object('body','ss approval','roles', c."pushRoles"))
          FROM "ProjectEventStream" s, "ExternalEffectCatalog" c
         WHERE s."projectId" = 'ss-proj' AND c."effectKey" = 'decision.reapproved'
           AND c."coverageVersion" = '${COVERAGE}';
      INSERT INTO "DecisionEvent" ("id","decisionId","type","actor","actorId")
        VALUES ('ss-de-fam2','ss-dec-fam','reapproved','SS User','ss-user');
      COMMIT;
    `]);
    expect(
      doubled.ok,
      'an approval bundle announcing BOTH families around one revision must be REFUSED — each '
      + 'per-type count passes, and the register is left with two immutable approval rows for one '
      + `act while the stream carries two announcements:\n${doubled.output}`,
    ).toBe(false);
    expect(doubled.output).toMatch(/approval-family audit rows|approval-family events/);

    // AND THE SHIPPED PATH COMMITS: one revision, one family, one announcement.
    buildRun([]);
    expect(psql(RUN_DB, ['-c', `
      BEGIN;
      INSERT INTO "Decision" ("id","projectId","title","room","status","photoSwatch","publishedAt")
        VALUES ('ss-dec-fam','ss-proj','SS Family','Hall','pending','sw',NULL);
      INSERT INTO "DecisionOption" ("id","decisionId","label","optionKey","material","delta","swatch","order")
        VALUES ('ss-optf-a','ss-dec-fam','Option A','a','Granite',0,'sw1',0),
               ('ss-optf-b','ss-dec-fam','Option B','b','Quartz',100,'sw2',1);
      UPDATE "Decision" SET "publishedAt" = now() WHERE "id" = 'ss-dec-fam';
      COMMIT;
    `]).ok).toBe(true);

    const single = psql(RUN_DB, ['-c', `
      BEGIN;
      INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
        VALUES ('ss-cmd-fam','project','ss-org','ss-proj','ss-user','decisions.approve','ss-key-fam','ss-hash-fam','reserved');
      UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = 'ss-dec-fam' WHERE "id" = 'ss-cmd-fam';
      UPDATE "Decision" SET "status" = 'approved' WHERE "id" = 'ss-dec-fam';
      INSERT INTO "DecisionApprovalRevision" ("id","projectId","decisionId","version","optionKey","approvedAt","approvedById","sourceCommandId")
        VALUES ('ss-rev-fam','ss-proj','ss-dec-fam',1,'a',now(),'ss-user','ss-cmd-fam');
      UPDATE "ProjectEventStream" SET "nextPosition" = "nextPosition" + 1 WHERE "projectId" = 'ss-proj';
      INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","actorKind","systemActor","entityType","entityId","dispatchIntent")
        SELECT 'ss-ev-fam1','decision.approved',1,'ss-org','ss-proj',s."nextPosition" - 1,'system','system:seed','Decision','ss-dec-fam',
               jsonb_build_object('effectKey','decision.approved','coverageVersion',c."coverageVersion",'invalidate',c."invalidate",
                                  'push', jsonb_build_object('body','ss approval','roles', c."pushRoles"))
          FROM "ProjectEventStream" s, "ExternalEffectCatalog" c
         WHERE s."projectId" = 'ss-proj' AND c."effectKey" = 'decision.approved'
           AND c."coverageVersion" = '${COVERAGE}';
      INSERT INTO "DecisionEvent" ("id","decisionId","type","actor","actorId")
        VALUES ('ss-de-fam1','ss-dec-fam','approved','SS User','ss-user');
      COMMIT;
    `]);
    expect(single.ok, `the shipped single-family approval must COMMIT:\n${single.output}`).toBe(true);
  }, 180_000);

  /**
   * #582's review round 9, finding 2 — A PRE-BASELINE CATALOG ROW THAT DISAGREES WITH THE LITERAL.
   *
   * Round 8 made this WORSE before round 9 fixed it: the outgoing-generation copy read the REAL
   * table, so one adopted bad row was propagated into a second generation. The seed now lands in a
   * temp table, the temp table is audited against what is already there, and BOTH generations are
   * seeded from the literal.
   */
  it('a pre-baseline catalog row that disagrees with the compiled definition aborts the apply', () => {
    psql('postgres', ['-c', `DROP DATABASE IF EXISTS "${RUN_DB}" WITH (FORCE)`]);
    expect(psql('postgres', ['-c', `CREATE DATABASE "${RUN_DB}" TEMPLATE "${BASE_DB}"`]).ok).toBe(true);

    // constraint-valid and WRONG: the right audience, but silent and non-invalidating.
    const seeded = psql(RUN_DB, ['-c', `
      CREATE TABLE "ExternalEffectCatalog" (
        "coverageVersion" TEXT NOT NULL, "effectKey" TEXT NOT NULL, "eventType" TEXT NOT NULL,
        "invalidate" BOOLEAN NOT NULL, "pushRoles" JSONB, "pushFamily" TEXT,
        "frozenAudience" BOOLEAN NOT NULL DEFAULT false, "requiresPush" BOOLEAN NOT NULL DEFAULT false,
        "audience" TEXT, "pushBody" TEXT, "pairingRequired" BOOLEAN NOT NULL DEFAULT false,
        "retiredAt" TIMESTAMP(3),
        CONSTRAINT "ExternalEffectCatalog_pkey" PRIMARY KEY ("coverageVersion","effectKey"));
      INSERT INTO "ExternalEffectCatalog"
        ("coverageVersion","effectKey","eventType","invalidate","pushRoles","pushFamily","frozenAudience","requiresPush","audience","pushBody","pairingRequired")
      VALUES ('${COVERAGE}', 'decision.approved', 'decision.approved', false,
              '["contractor","engineer","pmc"]'::jsonb, NULL, false, false, NULL, NULL, false);
    `]);
    expect(seeded.ok, seeded.output).toBe(true);

    const applied = psql(RUN_DB, ['-f', MIGRATION]);
    expect(applied.ok, 'the apply must REFUSE a catalog row that contradicts the compiled catalog').toBe(false);
    expect(applied.output).toMatch(/already exist at a key this migration seeds and DISAGREE with the compiled catalog/);
    expect(applied.output).toMatch(/decision\.approved/);

    // #582 round 12, finding 3 — AND THE OTHER GENERATION. Round 9 audited the INCOMING keys and
    // left the outgoing copy on a bare `ON CONFLICT DO NOTHING`, so a wrong row already sitting at
    // an OUTGOING key survived and was sealed — and that generation is the one that keeps a
    // still-serving previous release resolvable through the drain, so its ordinary intent would be
    // refused at commit. Same rule, the dimension the earlier fix did not sweep.
    expect(psql(RUN_DB, ['-c', `
      DELETE FROM "ExternalEffectCatalog";
      INSERT INTO "ExternalEffectCatalog"
        ("coverageVersion","effectKey","eventType","invalidate","pushRoles","pushFamily","frozenAudience","requiresPush","audience","pushBody","pairingRequired")
      VALUES ('${OUTGOING}', 'decision.approved', 'decision.approved', false,
              '["contractor","engineer","pmc"]'::jsonb, NULL, false, false, NULL, NULL, false);
    `]).ok).toBe(true);
    const outgoing = psql(RUN_DB, ['-f', MIGRATION]);
    expect(
      outgoing.ok,
      'a wrong row at an OUTGOING coverage key must REFUSE the apply too — the drain depends on '
      + 'that generation being the compiled definition',
    ).toBe(false);
    // #582 round 13 — the message is now the SHARED one, because there is now one audit rather
    // than two. The probe asserts the generation in the named pair instead of a per-generation
    // sentence, so it cannot pass against an audit that only looks at the incoming keys.
    expect(outgoing.output).toMatch(/already exist at a key this migration seeds and DISAGREE with the compiled catalog/);
    expect(outgoing.output).toContain(OUTGOING);

    // #582 round 13, finding 1 — AN EXTRA KEY. The audit was an inner JOIN, so it judged the
    // INTERSECTION of the catalog and the compiled set: a constraint-valid row at a key this
    // release never compiled matched nothing, survived, and was sealed. The envelope seal then
    // resolves a direct event against it — an invented event type with an invented dispatch
    // policy — because nothing ever asked whether the generation held keys the compiled set does
    // not.
    expect(psql(RUN_DB, ['-c', `
      DELETE FROM "ExternalEffectCatalog";
      INSERT INTO "ExternalEffectCatalog"
        ("coverageVersion","effectKey","eventType","invalidate","pushRoles","pushFamily","frozenAudience","requiresPush","audience","pushBody","pairingRequired")
      VALUES ('${COVERAGE}', 'forged.key', 'forged.key', false, NULL, NULL, false, false, NULL, NULL, false);
    `]).ok).toBe(true);
    const extra = psql(RUN_DB, ['-f', MIGRATION]);
    expect(
      extra.ok,
      'an UNCOMPILED key in a seeded generation must REFUSE the apply — an inner join judges the '
      + 'intersection and a row outside it is a working event nobody wrote',
    ).toBe(false);
    expect(extra.output).toMatch(/under a key this release never compiled/);
    expect(extra.output).toContain('forged.key');


    // and once removed, BOTH generations are seeded from the literal — the amplification round 8
    // introduced is gone, so the outgoing generation cannot inherit a row the literal never said.
    expect(psql(RUN_DB, ['-c', `DELETE FROM "ExternalEffectCatalog"`]).ok).toBe(true);
    const clean = applyWhole();
    expect(clean.ok, `after removing the conflicting row the apply must succeed:\n${clean.output}`).toBe(true);
    const gens = psql(RUN_DB, ['-t', '-A', '-c',
      `SELECT count(DISTINCT "coverageVersion") || ':' || count(*) FROM "ExternalEffectCatalog"
        WHERE "effectKey" = 'decision.approved' AND "invalidate" = true`]);
    expect(gens.output.trim(), 'both generations must carry the LITERAL definition').toBe('2:2');

    // #582 round 13, finding 6 — AND A COLUMN THE COMPARISON DID NOT NAME. The tuple listed nine
    // definition columns and omitted `retiredAt`, so an otherwise perfect row carrying a
    // retirement stamp passed, survived `ON CONFLICT DO NOTHING`, and made the envelope seal
    // refuse every ordinary event at that key from this migration's commit onward. Retirement is
    // 4d-iii's act; before it, a stamp is always wrong.
    //
    // The row is stamped on a GENUINELY SEEDED one rather than transcribed here: hand-writing the
    // other nine columns is the same projection mistake this finding is about, and the first
    // version of this probe proved it by tripping the DISAGREEMENT arm instead.
    expect(psql(RUN_DB, ['-c', `
      BEGIN;
      SET LOCAL vitan.phase6_4d_catalog = 'on';
      UPDATE "ExternalEffectCatalog" SET "retiredAt" = CURRENT_TIMESTAMP
       WHERE "effectKey" = 'decision.approved' AND "coverageVersion" = '${COVERAGE}';
      COMMIT;
    `]).ok).toBe(true);
    const retired = psql(RUN_DB, ['-f', MIGRATION]);
    expect(
      retired.ok,
      'a PRE-RETIRED row in a seeded generation must REFUSE the apply — nine of ten columns is a '
      + 'projection of the row, and the tenth closes the key',
    ).toBe(false);
    expect(retired.output).toMatch(/already stamped retired/);
  }, 300_000);

  /**
   * #582's review round 16, findings 1 and 5 — A DOOR THAT RESERVES A VALUE IS HALF AN ANSWER.
   *
   * The doors judge NEW and UPDATED rows. They cannot see a row that already holds the value, and
   * on the supported db-push/P3005 baseline one can: `schema.prisma` carries the widened
   * `DeciderKind` and `DecisionStatus`, and `DecisionEvent.type` is unconstrained TEXT. The
   * registers half has carried the other half — a diagnostic-first audit — for `Membership.role`
   * and `User.role` since round 1; `Decision` and `DecisionEvent` never got it, and round 15's own
   * kind door shipped protecting future inserts only.
   *
   * Three plants, repaired one at a time: each repair must move the abort on to the next, which is
   * how the arm proves three questions rather than one.
   */
  it('a pre-existing RESERVED value aborts the apply, one value at a time', () => {
    psql('postgres', ['-c', `DROP DATABASE IF EXISTS "${RUN_DB}" WITH (FORCE)`]);
    expect(psql('postgres', ['-c', `CREATE DATABASE "${RUN_DB}" TEMPLATE "${BASE_DB}"`]).ok).toBe(true);

    // the db-push baseline's vocabulary: `schema.prisma` declares both widened enums, so a
    // baselined database has the values before any raw trigger exists. ADD VALUE runs outside a
    // transaction here for the same reason the base builder applies such files that way.
    for (const alter of [
      `ALTER TYPE "DeciderKind" ADD VALUE IF NOT EXISTS 'architect'`,
      `ALTER TYPE "DecisionStatus" ADD VALUE IF NOT EXISTS 'awaiting_countersign'`,
    ]) expect(psql(RUN_DB, ['-c', alter]).ok, alter).toBe(true);

    const seeded = psql(RUN_DB, ['-c', `
      INSERT INTO "Org" ("id","name","slug") VALUES ('rv-org','RV Org','rv-org');
      INSERT INTO "Project" ("id","orgId","name","short","descriptor","stage","siteCode","projStart","projEnd","elapsedPct","todayDay","milestonePct")
        VALUES ('rv-proj','rv-org','RV Site','RV','','Finishing','RV-01','01 Jan 2026','31 Dec 2026',0,0,0);
      INSERT INTO "User" ("id","projectId","role","name","phone") VALUES
        ('rv-user','rv-proj','pmc','RV User','+910000000051'),
        ('rv-client','rv-proj','client','RV Client','+910000000052');
      INSERT INTO "Membership" ("id","projectId","userId","role","status") VALUES
        ('rv-mem','rv-proj','rv-user','pmc','active'),
        ('rv-mem-c','rv-proj','rv-client','client','active');
      -- born unpublished with their option floor and published in the SAME transaction, the shape
      -- the delivered 4b seals admit (the fixture at the top of this file does the same)
      BEGIN;
      INSERT INTO "Decision" ("id","projectId","title","room","status","photoSwatch","publishedAt")
        VALUES ('rv-await','rv-proj','RV Awaiting','Hall','pending','sw',NULL);
      -- the architect-held one is born holding the designation and stays a DRAFT: the delivered 4b
      -- freeze refuses re-pointing a published decision's decider, so on a real baseline a row
      -- like this arrives that way rather than being moved into it.
      INSERT INTO "Decision" ("id","projectId","title","room","status","photoSwatch","publishedAt","deciderKind")
        VALUES ('rv-arch','rv-proj','RV Architect','Hall','pending','sw',NULL,'architect');
      INSERT INTO "DecisionOption" ("id","decisionId","label","optionKey","material","delta","swatch","order") VALUES
        ('rv-o1','rv-await','A','a','Granite',0,'s1',0), ('rv-o2','rv-await','B','b','Quartz',1,'s2',1);
      UPDATE "Decision" SET "publishedAt" = now() WHERE "id" = 'rv-await';
      COMMIT;
      -- and THEN the reserved status, which on a db-push baseline arrives with no trigger to judge
      -- it: the vocabulary is in the enum and nothing in this release refuses the write.
      UPDATE "Decision" SET "status" = 'awaiting_countersign' WHERE "id" = 'rv-await';
      INSERT INTO "DecisionEvent" ("id","decisionId","type","actor","actorId","actorName","actorRole","payload")
        VALUES ('rv-de','rv-await','forwarded','RV User','rv-user','RV User','pmc','{}'::jsonb);
    `]);
    expect(seeded.ok, seeded.output).toBe(true);

    // the registers half is not implicated and applies
    const dark = psql(RUN_DB, ['-f', MIGRATION]);
    expect(dark.ok, `the registers half must apply:\n${dark.output}`).toBe(true);

    const awaiting = psql(RUN_DB, ['-f', FACTS]);
    expect(awaiting.ok, 'a decision already AWAITING must refuse the apply').toBe(false);
    expect(awaiting.output).toMatch(/already hold a value this unit RESERVES/);
    expect(awaiting.output).toMatch(/awaiting_countersign: 1 row\(s\) \[rv-await\]/);
    // all three are named in ONE abort — an operator repairs once, not three times
    expect(awaiting.output).toMatch(/architect: 1 row\(s\) \[rv-arch\]/);
    expect(awaiting.output).toMatch(/4d-only kinds: 1 row\(s\) \[rv-de\]/);

    // repair the decision states; the audit must then name only the audit row
    expect(psql(RUN_DB, ['-c',
      `UPDATE "Decision" SET "status" = 'pending' WHERE "id" = 'rv-await';
       DELETE FROM "Decision" WHERE "id" = 'rv-arch'`]).ok).toBe(true);
    const kinds = psql(RUN_DB, ['-f', FACTS]);
    expect(kinds.ok, 'a 4d-only audit kind must still refuse the apply').toBe(false);
    expect(kinds.output).toMatch(/4d-only kinds: 1 row\(s\) \[rv-de\]/);
    expect(kinds.output).not.toMatch(/awaiting_countersign: /);

    // and the named repair is the repair that works
    expect(psql(RUN_DB, ['-c', `DELETE FROM "DecisionEvent" WHERE "id" = 'rv-de'`]).ok).toBe(true);
    const clean = applyWhole();
    expect(clean.ok, `after the named repairs the apply must succeed:\n${clean.output}`).toBe(true);
  }, 300_000);

  /**
   * #582's review round 9, finding 1 — THE DARK FACT TABLES MUST BE EMPTY WHEN 4d-i SEALS THEM.
   *
   * Round 8 audited the four adopted REGISTERS and left the fact tables alone. Same db-push
   * exposure, and a stronger remedy: these tables are dark, 4d-ii is their first writer, so before
   * retirement the only correct population is none.
   */
  it('a pre-baseline row in a dark fact table aborts the apply', () => {
    psql('postgres', ['-c', `DROP DATABASE IF EXISTS "${RUN_DB}" WITH (FORCE)`]);
    expect(psql('postgres', ['-c', `CREATE DATABASE "${RUN_DB}" TEMPLATE "${BASE_DB}"`]).ok).toBe(true);

    // `schema.prisma` creates the table on a db-push baseline; nothing has sealed it yet. The
    // shape below is the migration's own CREATE TABLE, and the referents exist because the FKs
    // this file adds are checked against the rows already there.
    const seeded = psql(RUN_DB, ['-c', `
      INSERT INTO "Org" ("id","name","slug") VALUES ('df-org','DF Org','df-org');
      INSERT INTO "Project" ("id","orgId","name","short","descriptor","stage","siteCode","projStart","projEnd","elapsedPct","todayDay","milestonePct")
        VALUES ('df-proj','df-org','DF Site','DF','','Finishing','DF-01','01 Jan 2026','31 Dec 2026',0,0,0);
      INSERT INTO "User" ("id","projectId","role","name","phone") VALUES ('df-user','df-proj','pmc','DF User','+910000000041');
      INSERT INTO "Decision" ("id","projectId","title","room","status","photoSwatch","publishedAt")
        VALUES ('df-dec','df-proj','DF Decision','Hall','pending','sw',NULL);
      INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
        VALUES ('df-cmd','project','df-org','df-proj','df-user','decisions.forward','df-key','df-hash','reserved');
      UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = 'df-ghost' WHERE "id" = 'df-cmd';
      CREATE TABLE "DecisionForward" (
        "id" TEXT NOT NULL, "projectId" TEXT NOT NULL, "decisionId" TEXT NOT NULL,
        "fromDesignationKind" TEXT NOT NULL, "fromDesignationMembershipId" TEXT,
        "toDesignationKind" TEXT NOT NULL, "toDesignationMembershipId" TEXT,
        "forwardedById" TEXT NOT NULL, "forwardedByRole" TEXT NOT NULL, "forwardedByName" TEXT NOT NULL,
        "reason" TEXT NOT NULL, "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "sourceCommandId" TEXT NOT NULL,
        CONSTRAINT "DecisionForward_pkey" PRIMARY KEY ("id"));
      INSERT INTO "DecisionForward" ("id","projectId","decisionId","fromDesignationKind","toDesignationKind","forwardedById","forwardedByRole","forwardedByName","reason","sourceCommandId")
        VALUES ('df-ghost','df-proj','df-dec','client','pmc','df-user','pmc','DF User','a hand-off nobody performed','df-cmd');
    `]);
    expect(seeded.ok, seeded.output).toBe(true);

    const dark = psql(RUN_DB, ['-f', MIGRATION]);
    expect(dark.ok, `the registers half is not implicated and must apply:\n${dark.output}`).toBe(true);
    const applied = psql(RUN_DB, ['-f', FACTS]);
    expect(applied.ok, 'the apply must REFUSE a dark fact table that already holds rows').toBe(false);
    expect(applied.output).toMatch(/dark fact table\(s\) already hold rows before this unit seals them/);
    expect(applied.output).toMatch(/DecisionForward \(1 row\(s\)\)/);

    // and the named repair works
    expect(psql(RUN_DB, ['-c', `DELETE FROM "DecisionForward"`]).ok).toBe(true);
    const clean = applyWhole();
    expect(clean.ok, `after removing the ghost row the apply must succeed:\n${clean.output}`).toBe(true);
  }, 300_000);

  /**
   * #582's review round 8, finding 8 — THE ALLOCATOR'S CASCADE EXCEPTION NEEDS THE CASCADE.
   *
   * Raised at round 6 and not fixed then; this is the arm that would have caught it. The
   * transaction-local flag says only that SOME project is being deleted somewhere in the
   * transaction, and it stays `on` afterwards, so a direct delete of a SECOND project's allocator
   * rode it at depth 1. That project keeps its rows and loses its counter.
   */
  it('the project-deletion flag alone does not license deleting another project\'s allocator', () => {
    buildRun([]);

    // a second, unrelated project with its own allocator, and an event-free FIRST project whose
    // deletion sets the flag legitimately.
    const seed = psql(RUN_DB, ['-c', `
      INSERT INTO "Project" ("id","orgId","name","short","descriptor","stage","siteCode","projStart","projEnd","elapsedPct","todayDay","milestonePct")
        VALUES ('ss-proj-b','ss-org','SS B','SB','','Finishing','SB-01','01 Jan 2026','31 Dec 2026',0,0,0);
      -- no explicit allocator row: the project's own trigger creates it at 0, and inserting one
      -- here duplicates the primary key.
    `]);
    expect(seed.ok, seed.output).toBe(true);

    // ONE transaction: delete the event-free project B (a real cascade, which sets the flag), then
    // issue a DIRECT delete of project A's allocator. The second statement is at depth 1.
    const ride = psql(RUN_DB, ['-c', `
      BEGIN;
      DELETE FROM "Project" WHERE "id" = 'ss-proj-b';
      DELETE FROM "ProjectEventStream" WHERE "projectId" = 'ss-proj';
      COMMIT;
    `]);
    expect(
      ride.ok,
      'a direct delete of another project\'s allocator must be REFUSED even while the '
      + `project-deletion flag stands on — the flag is not evidence of THIS row's cascade:\n${ride.output}`,
    ).toBe(false);
    expect(ride.output).toMatch(/may not be DELETED/);

    // and the allocator is still there, so the project can still emit
    const left = psql(RUN_DB, ['-t', '-A', '-c',
      `SELECT count(*) FROM "ProjectEventStream" WHERE "projectId" = 'ss-proj'`]);
    expect(left.output.trim(), 'project A must keep its allocator').toBe('1');
  }, 180_000);

  /**
   * #582's review round 8, finding 6 — FACT-FIRST CANNOT KEY OFF RECEIPT PRESENCE.
   *
   * Round 6 enforced the order from the membership side, switched on by "a member-command receipt
   * exists in this transaction". A writer controls that timing: write the membership while no
   * receipt exists, reserve and complete the receipt afterwards, insert the fact last, and every
   * deferred check still passes at commit — while the fact's live authority read has seen the
   * standing the write just granted. The order is now enforced where it is a fact rather than a
   * signal: at the fact's insert, the membership must not already carry this transaction's `xmin`.
   */
  it('a membership written BEFORE its fact is refused however the receipt is timed', () => {
    buildRun([]);

    const seed = psql(RUN_DB, ['-c', `
      INSERT INTO "User" ("id","projectId","role","name","phone")
        VALUES ('ss-eng-p','ss-proj','engineer','SS Eng P','+910000000031');
      INSERT INTO "Membership" ("id","projectId","userId","role","status")
        VALUES ('ss-mem-p','ss-proj','ss-eng-p','engineer','active');
    `]);
    expect(seed.ok, seed.output).toBe(true);

    // the exact ordering round 6's switch admitted: MEMBERSHIP first, with no receipt in the
    // transaction yet, so the membership-side guard is off; the receipt and the fact follow.
    const promoted = psql(RUN_DB, ['-c', `
      BEGIN;
      UPDATE "Membership" SET "role" = 'pmc' WHERE "id" = 'ss-mem-p';
      INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
        VALUES ('ss-cmd-p','project','ss-org','ss-proj','ss-eng-p','members.updateRole','ss-key-p','ss-hash-p','reserved');
      UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = 'ss-mem-p' WHERE "id" = 'ss-cmd-p';
      INSERT INTO "MembershipTransition"
        ("id","projectId","membershipId","userId","fromRole","fromStatus","toRole","toStatus","actorId","actorRole","actorName","sourceCommandId")
      VALUES ('ss-mt-p','ss-proj','ss-mem-p','ss-eng-p','engineer','active','pmc','active','ss-eng-p','pmc','SS Eng P','ss-cmd-p');
      COMMIT;
    `]);
    expect(
      promoted.ok,
      'a transaction that writes the membership before its fact must be REFUSED — otherwise the '
      + `fact's authority read sees the standing the write itself granted:\n${promoted.output}`,
    ).toBe(false);
    expect(promoted.output).toMatch(/this transaction has ALREADY written/);

    // and the promotion did not happen
    const role = psql(RUN_DB, ['-t', '-A', '-c',
      `SELECT "role" FROM "Membership" WHERE "id" = 'ss-mem-p'`]);
    expect(role.output.trim(), 'the self-promotion must have rolled back').toBe('engineer');
  }, 180_000);

  /**
   * #582's review round 8, finding 7 — STEPPING DOWN IS NOT AN AUTHORITY.
   *
   * The seal carried a self arm admitting any transition whose subject was its actor and whose
   * direction was loss. An active contractor or engineer could therefore remove THEMSELVES with a
   * receipt-backed direct bundle, while the shipped `MembersService.remove` refuses self-removal
   * outright and the plan requires "a contractor's self-transition refused" (P29b). The arm is
   * gone: fact-first means an authorized actor still holds their standing when the fact is
   * written, so the exception it existed for cannot arise.
   */
  it('a member with no team-management authority may not write their own removal', () => {
    buildRun([]);

    const seed = psql(RUN_DB, ['-c', `
      INSERT INTO "User" ("id","projectId","role","name","phone")
        VALUES ('ss-con-s','ss-proj','contractor','SS Con S','+910000000032');
      INSERT INTO "Membership" ("id","projectId","userId","role","status")
        VALUES ('ss-mem-s','ss-proj','ss-con-s','contractor','active');
    `]);
    expect(seed.ok, seed.output).toBe(true);

    // fact FIRST, truthful frozen pair, real receipt, real membership write — everything correct
    // except that the actor was never given authority over the team.
    const selfOut = psql(RUN_DB, ['-c', `
      BEGIN;
      INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
        VALUES ('ss-cmd-s','project','ss-org','ss-proj','ss-con-s','members.remove','ss-key-s','ss-hash-s','reserved');
      UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = 'ss-mem-s' WHERE "id" = 'ss-cmd-s';
      INSERT INTO "MembershipTransition"
        ("id","projectId","membershipId","userId","fromRole","fromStatus","toRole","toStatus","actorId","actorRole","actorName","sourceCommandId")
      VALUES ('ss-mt-s','ss-proj','ss-mem-s','ss-con-s','contractor','active','contractor','removed','ss-con-s','contractor','SS Con S','ss-cmd-s');
      UPDATE "Membership" SET "status" = 'removed' WHERE "id" = 'ss-mem-s';
      COMMIT;
    `]);
    expect(
      selfOut.ok,
      'a contractor removing themselves must be REFUSED — the shipped service refuses it and the '
      + `plan names it explicitly:\n${selfOut.output}`,
    ).toBe(false);
    expect(selfOut.output).toMatch(/team management is an authorized act/);

    // the PMC doing the same removal still commits — the fix narrowed the rule, it did not
    // close the ordinary path.
    const byPmc = psql(RUN_DB, ['-c', `
      BEGIN;
      INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
        VALUES ('ss-cmd-s2','project','ss-org','ss-proj','ss-user','members.remove','ss-key-s2','ss-hash-s2','reserved');
      UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = 'ss-mem-s' WHERE "id" = 'ss-cmd-s2';
      INSERT INTO "MembershipTransition"
        ("id","projectId","membershipId","userId","fromRole","fromStatus","toRole","toStatus","actorId","actorRole","actorName","sourceCommandId")
      VALUES ('ss-mt-s2','ss-proj','ss-mem-s','ss-con-s','contractor','active','contractor','removed','ss-user','pmc','SS User','ss-cmd-s2');
      UPDATE "Membership" SET "status" = 'removed' WHERE "id" = 'ss-mem-s';
      COMMIT;
    `]);
    expect(byPmc.ok, `the PMC's removal of the same member must still commit:\n${byPmc.output}`).toBe(true);

    // AND THE CASE THE ARM EXISTED FOR STILL COMMITS, which is what licenses removing it rather
    // than narrowing it. P29b requires "a PMC's self-demotion accepted with the fact judged
    // before the flip (the live read IS the pre-state)". The PMC re-roles THEMSELVES down to
    // engineer: at the moment the fact is written they still hold `pmc`, so the ordinary
    // authority read passes and no exception is needed. Without fact-first this would be the
    // read that fails, and the arm would have been load-bearing after all.
    const stepDown = psql(RUN_DB, ['-c', `
      BEGIN;
      INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
        VALUES ('ss-cmd-d','project','ss-org','ss-proj','ss-user','members.updateRole','ss-key-d','ss-hash-d','reserved');
      UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = 'ss-mem' WHERE "id" = 'ss-cmd-d';
      INSERT INTO "MembershipTransition"
        ("id","projectId","membershipId","userId","fromRole","fromStatus","toRole","toStatus","actorId","actorRole","actorName","sourceCommandId")
      VALUES ('ss-mt-d','ss-proj','ss-mem','ss-user','pmc','active','engineer','active','ss-user','pmc','SS User','ss-cmd-d');
      UPDATE "Membership" SET "role" = 'engineer' WHERE "id" = 'ss-mem';
      COMMIT;
    `]);
    expect(
      stepDown.ok,
      'a PMC stepping down through their own re-role must still COMMIT — the removed self arm '
      + `existed for exactly this, and fact-first is what makes it unnecessary:\n${stepDown.output}`,
    ).toBe(true);
  }, 180_000);

  /**
   * #582's review round 8, finding 5 — BIRTH PROVENANCE IS WRITTEN AT INSERT OR NEVER.
   *
   * The freeze guarded every column with `OLD.<col> IS NOT NULL`, which admits NULL -> value on
   * all six. For the resolver set that IS the closure. For the birth set it is a forgery route: a
   * legacy request could be given a `requestedByRole` it never had, and the same freeze then made
   * the fabrication permanent.
   */
  it('a legacy request cannot be given birth provenance it never carried', () => {
    buildRun([]);

    const seed = psql(RUN_DB, ['-c',
      `INSERT INTO "ChangeRequest" ("id","decisionId","reason","costImpact","timeImpactDays","status")
       VALUES ('ss-cr-b','ss-dec','legacy',0,0,'open')`]);
    expect(seed.ok, seed.output).toBe(true);

    for (const col of ['requestedByRole', 'requestedByName', 'sourceCommandId']) {
      const value = col === 'sourceCommandId' ? 'ss-cmd' : (col === 'requestedByRole' ? 'architect' : 'Someone');
      const filled = psql(RUN_DB, ['-c',
        `UPDATE "ChangeRequest" SET "${col}" = '${value}' WHERE "id" = 'ss-cr-b'`]);
      expect(
        filled.ok,
        `filling \`${col}\` on an already-open request must be REFUSED — who opened a request is `
        + `settled when it is opened:\n${filled.output}`,
      ).toBe(false);
      expect(filled.output).toMatch(/at its BIRTH and it may not be written, replaced or cleared/);
    }

    // the RESOLVER set still closes once, which is the transition this freeze must not break —
    // and since round 16, finding 4, it closes ONLY as a whole: on the open -> closed transition,
    // naming the resolver, with the pair true of them. This is that shape.
    // AND THE CLOSURE RECEIPT IS NOW JUDGED (#582's review round 22, finding 2), so this statement
    // had to become a TRUE closure rather than a shaped one. It used to cite `ss-cmd` — a
    // `decisions.forward` receipt completed in the FIXTURE's transaction — and passed, because
    // nothing read the receipt's kind, actor or transaction. `ChangeRequest_t4d_closure_bound`
    // refuses exactly that now, so the arm mints its own withdrawal receipt in this statement's
    // transaction, by the ledger protocol (reserved on insert, completed by update — a receipt
    // born terminal is a command that never ran). One `-c` is one transaction, which is what the
    // binding requires and what a real `decisions.withdrawChange` does.
    // AND ITS RESULT IS THE DECISION (#582's review round 23, finding 2). Round 22 wrote
    // `resultRef = 'ss-cr-b'` here to match the rule it had just invented; §D's actual ruling is
    // the closed row's `decisionId`, which is what the shipped command returns. The probe moved
    // with the rule — leaving it citing the request would have kept this arm passing against a
    // seal no real writer can satisfy, which is the whole failure mode round 22 introduced.
    const closed = psql(RUN_DB, ['-c',
      `INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
         VALUES ('ss-cmd-wd','project','ss-org','ss-proj','ss-user','decisions.withdrawChange','ss-key-wd','ss-hash-wd','reserved');
       UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = 'ss-dec' WHERE "id" = 'ss-cmd-wd';
       UPDATE "ChangeRequest" SET "resolvedByCommandId" = 'ss-cmd-wd', "resolvedById" = 'ss-user',
              "resolvedByRole" = 'pmc', "resolvedByName" = 'SS User', "status" = 'withdrawn',
             "resolution" = 'withdrawn', "resolvedAt" = now()
        WHERE "id" = 'ss-cr-b'`]);
    expect(closed.ok, `the resolver set must still be fillable at closure:\n${closed.output}`).toBe(true);
  }, 180_000);

  /**
   * #582's review round 10, finding 1 — ONE HAND-OFF, ONE FACT.
   *
   * Not an ARM, for the reason the receipt probe above is not one: `DecisionForward_t4d_reserved`
   * stands in front of the table and would answer the whole-migration run with its own message. So
   * the DOOR is stripped on both sides and the pairing seal alone is the difference between them.
   *
   * The hostile bundle is truthful in every respect a reviewer would check by eye: two receipts,
   * each reserved and completed here, each naming its own forward as its result; two facts, each
   * displacing the holder the decision actually carries and naming the holder it actually gets;
   * one holder mutation. `DecisionForward_command_key` is `(projectId, sourceCommandId)`, so the
   * index bounds facts per RECEIPT and admits both — and the holder comparison, which each fact
   * passes separately, is exactly the check that cannot tell one act from two.
   */
  it('one holder mutation carries exactly ONE forward fact', () => {
    const cols = '("id","projectId","decisionId","fromDesignationKind","toDesignationKind",'
      + '"forwardedById","forwardedByRole","forwardedByName","reason","sourceCommandId")';
    const receipt = (id: string, ref: string): string =>
      `INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
         VALUES ('${id}','project','ss-org','ss-proj','ss-user','decisions.forward','key-${id}','hash-${id}','reserved');
       UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = '${ref}' WHERE "id" = '${id}';`;

    const twin = `${receipt('ss-cmd-d1', 'ss-fwd-d1')}${receipt('ss-cmd-d2', 'ss-fwd-d2')}
       INSERT INTO "DecisionForward" ${cols} VALUES
         ('ss-fwd-d1','ss-proj','ss-dec','client','pmc','ss-user','pmc','SS User','because','ss-cmd-d1'),
         ('ss-fwd-d2','ss-proj','ss-dec','client','pmc','ss-user','pmc','SS User','because','ss-cmd-d2');
       UPDATE "Decision" SET "deciderKind" = 'pmc' WHERE "id" = 'ss-dec'`;

    buildRun(['DecisionForward_t4d_reserved', 'DecisionForward_t4d_paired']);
    const stripped = psql(RUN_DB, ['-c', twin]);
    expect(
      stripped.ok,
      'with the pairing seal OMITTED the twin bundle must be ACCEPTED — if something else refuses '
      + `it, this probe measures that other object and proves nothing here:\n${stripped.output}`,
    ).toBe(true);

    buildRun(['DecisionForward_t4d_reserved']);
    const whole = psql(RUN_DB, ['-c', twin]);
    expect(
      whole.ok,
      'with the pairing seal STANDING two immutable facts may not claim one hand-off',
    ).toBe(false);
    expect(whole.output).toMatch(/DecisionForward rows written by THIS transaction for one hand-off/);

    // and the SINGLE fact must still commit, or the count above would be a seal that refuses
    // every forward and the probe would prove nothing about cardinality.
    buildRun(['DecisionForward_t4d_reserved']);
    const one = psql(RUN_DB, ['-c',
      `${receipt('ss-cmd-d3', 'ss-fwd-d3')}
       INSERT INTO "DecisionForward" ${cols}
       VALUES ('ss-fwd-d3','ss-proj','ss-dec','client','pmc','ss-user','pmc','SS User','because','ss-cmd-d3');
       UPDATE "Decision" SET "deciderKind" = 'pmc' WHERE "id" = 'ss-dec'`]);
    expect(one.ok, `one forward for one hand-off must COMMIT:\n${one.output}`).toBe(true);
  }, 300_000);

  /**
   * #582's review round 10, finding 2 — THE DISAGREEMENT'S DEMAND BELONGS ON THE TRANSITION, and
   * this probe is the regression test for a rule I put in the wrong place in round 8.
   *
   * Two halves, and both are needed. The first shows the demand is REAL where the transition is:
   * `awaiting_countersign → change` without its open `countersign_rejection` request is refused,
   * and with it commits. The second shows what round 8 broke: a GENERIC forward of a decision
   * already in `change` — whose open request is an ordinary `standard` one — must commit, because
   * moving a holder is not a disagreement. Round 8 keyed on the status the decision ENDED at, so
   * it aborted exactly that ordinary path.
   *
   * The three reservation doors are stripped on both sides: they are 4d-iii's to drop, and the
   * state under test is unreachable while they stand.
   */
  const AWAITING_DOORS = ['Decision_t4d_awaiting_reserved',
    'Membership_t4d_architect_reserved', 'User_t4d_architect_reserved'];

  /** an active architect, added FACT-FIRST, and a PROVISIONAL approval parked for them. */
  const PROVISIONAL = `
    INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
      VALUES ('ss-cmd-ar','project','ss-org','ss-proj','ss-user','members.add','ss-key-ar','ss-hash-ar','reserved');
    UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = 'ss-mem-ar' WHERE "id" = 'ss-cmd-ar';
    INSERT INTO "User" ("id","projectId","role","name","phone") VALUES ('ss-arch','ss-proj','architect','SS Arch','+910000000031');
    INSERT INTO "MembershipTransition"
      ("id","projectId","membershipId","userId","fromRole","fromStatus","toRole","toStatus","actorId","actorRole","actorName","sourceCommandId")
    VALUES ('ss-mt-ar','ss-proj','ss-mem-ar','ss-arch',NULL,NULL,'architect','active','ss-user','pmc','SS User','ss-cmd-ar');
    INSERT INTO "Membership" ("id","projectId","userId","role","status") VALUES ('ss-mem-ar','ss-proj','ss-arch','architect','active');
    INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
      VALUES ('ss-cmd-pv','project','ss-org','ss-proj','ss-client','decisions.approve','ss-key-pv','ss-hash-pv','reserved');
    UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = 'ss-dec' WHERE "id" = 'ss-cmd-pv';
    INSERT INTO "DecisionApprovalRevision"
      ("id","projectId","decisionId","version","optionKey","approvedAt","approvedById","sourceCommandId","finalized","approvedFrom","approvedByName","approvedByRole")
    VALUES ('ss-rev-p','ss-proj','ss-dec',1,'a',now(),'ss-client','ss-cmd-pv',FALSE,'pending','SS Client','client');
    UPDATE "Decision" SET "status" = 'awaiting_countersign' WHERE "id" = 'ss-dec';`;

  it('the awaiting_countersign to change transition owes its rejection request', () => {
    // THE DISAGREEMENT IS A SEPARATE COMMAND, and this probe drives it that way. An earlier draft
    // reused the provisional-approval block as setup INSIDE the same transaction, which made the
    // decision end at `change` — so `phase6_t4d_revision_birth_paired` refused the bundle before
    // this door was ever reached, and the arm measured the wrong object. Approve-then-disagree in
    // ONE transaction is not a path the plan gives a row to; the provisional act is committed
    // first, exactly as the architect's rejection arrives later.
    const bare = `UPDATE "Decision" SET "status" = 'change' WHERE "id" = 'ss-dec'`;
    const bundled = `INSERT INTO "ChangeRequest" ("id","decisionId","reason","costImpact","timeImpactDays","status","origin","revisionId")
         VALUES ('ss-cr-rej','ss-dec','the architect disagrees',0,0,'open','countersign_rejection','ss-rev-p');
       UPDATE "Decision" SET "status" = 'change' WHERE "id" = 'ss-dec'`;

    buildRun([...AWAITING_DOORS, 'Decision_t4d_disagreement_paired']);
    expect(psql(RUN_DB, ['-c', PROVISIONAL]).ok, 'the provisional act must commit first').toBe(true);
    const stripped = psql(RUN_DB, ['-c', bare]);
    expect(
      stripped.ok,
      `with the transition door OMITTED the bare disagreement must be ACCEPTED:\n${stripped.output}`,
    ).toBe(true);

    buildRun(AWAITING_DOORS);
    expect(psql(RUN_DB, ['-c', PROVISIONAL]).ok, 'the provisional act must commit first').toBe(true);
    const whole = psql(RUN_DB, ['-c', bare]);
    expect(whole.ok, 'the disagreement without its request must be REFUSED').toBe(false);
    expect(whole.output).toMatch(/in this transaction with no open .countersign_rejection. request/);

    // the BUNDLE — the same transition carrying the request — must commit, which is what makes
    // the refusal above a rule about the bundle rather than about the transition.
    buildRun(AWAITING_DOORS);
    expect(psql(RUN_DB, ['-c', PROVISIONAL]).ok, 'the provisional act must commit first').toBe(true);
    const ok = psql(RUN_DB, ['-c', bundled]);
    expect(ok.ok, `the disagreement BUNDLE must COMMIT:\n${ok.output}`).toBe(true);
  }, 300_000);

  it('a GENERIC forward of an already-changed decision still commits', () => {
    const cols = '("id","projectId","decisionId","fromDesignationKind","toDesignationKind",'
      + '"forwardedById","forwardedByRole","forwardedByName","reason","sourceCommandId")';
    buildRun(['DecisionForward_t4d_reserved']);

    // a decision in `change` carrying an ordinary STANDARD request — the state round 8's arm
    // could not tell apart from a disagreement, because it read the status and not the move.
    const changed = psql(RUN_DB, ['-c',
      `UPDATE "Decision" SET "status" = 'change' WHERE "id" = 'ss-dec';
       INSERT INTO "ChangeRequest" ("id","decisionId","reason","costImpact","timeImpactDays","status")
         VALUES ('ss-cr-std','ss-dec','please revisit',0,0,'open')`]);
    expect(changed.ok, `the standard change state must plant cleanly:\n${changed.output}`).toBe(true);

    // a SEPARATE transaction: nothing here is a disagreement, only the holder moves.
    const generic = psql(RUN_DB, ['-c',
      `INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
         VALUES ('ss-cmd-gf','project','ss-org','ss-proj','ss-user','decisions.forward','ss-key-gf','ss-hash-gf','reserved');
       UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = 'ss-fwd-gf' WHERE "id" = 'ss-cmd-gf';
       INSERT INTO "DecisionForward" ${cols}
       VALUES ('ss-fwd-gf','ss-proj','ss-dec','client','pmc','ss-user','pmc','SS User','handing on','ss-cmd-gf');
       UPDATE "Decision" SET "deciderKind" = 'pmc' WHERE "id" = 'ss-dec'`]);
    expect(
      generic.ok,
      'a generic forward of a decision already in `change` must COMMIT — the plan gives the holder '
      + 'mutation its own row and asks no request of it; round 8 aborted this at commit by reading '
      + `the status instead of the transition:\n${generic.output}`,
    ).toBe(true);
  }, 300_000);

  /**
   * #582's review round 10, finding 5, second arm — A PROVISIONAL BIRTH RIDES A TRANSITION.
   *
   * `finalized = false` is written by the provisional approve alone, and that command moves its
   * decision. A provisional revision inserted beside an untouched decision is an approval no act
   * performed — and, unlike the duplicate above, it is invisible to a count, because there is only
   * one of it.
   */
  it('a PROVISIONAL revision may not be born beside an untouched decision', () => {
    // everything of PROVISIONAL except the transition that ends it.
    const orphan = PROVISIONAL.replace(
      `UPDATE "Decision" SET "status" = 'awaiting_countersign' WHERE "id" = 'ss-dec';`, '');

    buildRun([...AWAITING_DOORS, 'DecisionApprovalRevision_t4d_birth_paired']);
    const stripped = psql(RUN_DB, ['-c', orphan]);
    expect(
      stripped.ok,
      `with the birth pairing OMITTED the orphan provisional revision must be ACCEPTED:\n${stripped.output}`,
    ).toBe(true);

    buildRun(AWAITING_DOORS);
    const whole = psql(RUN_DB, ['-c', orphan]);
    expect(whole.ok, 'a provisional revision with no transition behind it must be REFUSED').toBe(false);
    // #582 round 22, the class sweep — the arm's subject is unchanged (a provisional revision with
    // no transition behind it) but the rule it meets now names the MOVE rather than the end state,
    // because a no-op against an already-parked decision satisfied the state. The orphan here
    // performs no move at all, so it is the move-demand that answers first.
    expect(whole.output).toMatch(/born PROVISIONAL, but no move of decision .* INTO .awaiting_countersign./);

    // and the WHOLE provisional act — revision plus its transition — must commit.
    buildRun(AWAITING_DOORS);
    const paired = psql(RUN_DB, ['-c', PROVISIONAL]);
    expect(paired.ok, `the provisional approval and its transition must COMMIT:\n${paired.output}`).toBe(true);

    // #582 round 11, finding 3 — AND A NO-OP UPDATE IS NOT A TRANSITION. Round 10 bound the
    // provisional birth with `xmin` alone and I wrote down why; a write that changes nothing
    // satisfies it, so a SECOND provisional revision could be inserted beside the first while the
    // decision already sat in `awaiting_countersign`. The decision is left with two open
    // approvals and every revision below the head is beyond the reach of any finalizer.
    //
    // Run against the database the arm above just committed, which is the state the attack needs.
    const second = psql(RUN_DB, ['-c',
      `INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
         VALUES ('ss-cmd-pv2','project','ss-org','ss-proj','ss-client','decisions.approve','ss-key-pv2','ss-hash-pv2','reserved');
       UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = 'ss-dec' WHERE "id" = 'ss-cmd-pv2';
       UPDATE "Decision" SET "room" = "room" WHERE "id" = 'ss-dec';
       INSERT INTO "DecisionApprovalRevision"
         ("id","projectId","decisionId","version","optionKey","approvedAt","approvedById","sourceCommandId","finalized","approvedFrom","approvedByName","approvedByRole")
       VALUES ('ss-rev-p2','ss-proj','ss-dec',2,'a',now(),'ss-client','ss-cmd-pv2',FALSE,'pending','SS Client','client')`]);
    expect(
      second.ok,
      'a second provisional revision, admitted by a no-op UPDATE, must be REFUSED — one decision '
      + 'holds at most ONE open approval',
    ).toBe(false);
    expect(second.output).toMatch(/unfinalized approval revisions at commit/);

    // #582 round 12, finding 6 — THE CONVERSE DIRECTION. Everything above judges a revision by
    // its decision; nothing judged a decision by its revision, so the transition INTO
    // `awaiting_countersign` could commit carrying none at all — a decision parked for a
    // countersigner with no provisional head for either finalizer to act on.
    buildRun(AWAITING_DOORS);
    const architectOnly = PROVISIONAL
      .slice(0, PROVISIONAL.indexOf('INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")\n      VALUES (\'ss-cmd-pv\''));
    const bare = psql(RUN_DB, ['-c', `${architectOnly}
      UPDATE "Decision" SET "status" = 'awaiting_countersign' WHERE "id" = 'ss-dec'`]);
    expect(
      bare.ok,
      'a decision may not be parked for a countersigner with no provisional approval to finalize',
    ).toBe(false);
    expect(bare.output).toMatch(/entered `awaiting_countersign` in this transaction with 0 PROVISIONAL revisions/);
  }, 300_000);

  /**
   * #582's review round 26 — THE FROZEN-COLUMN COVERAGE ORACLE, AND WHY IT DRIVES.
   *
   * Rounds 18, 23, 24 and 25 were one defect wearing four faces: a rule stated over an inventory
   * and implemented over a subset. Round 24's is the clearest — the change request's evidence
   * freeze covered the frozen actor PAIR and not `requestedById`, the column naming the person
   * the pair is about, so a row could permanently name one person and vouch for another. Round 17
   * closed ONE instance of this class structurally, by discovering the inventory from the database
   * instead of keeping it by hand, and that class has not recurred since. This does the same for
   * the columns.
   *
   * THE QUESTION, asked of every table this unit installs an UPDATE-firing seal on: which of its
   * columns can still be rewritten after the fact, and is each of those deliberate? The table set
   * is DISCOVERED (`pg_trigger`, `_t4d_`, fires on UPDATE) and the column set is DISCOVERED
   * (`information_schema`), so a column added by a later unit — or a table that gains its first
   * seal — cannot be silent: it fails here the day it lands.
   *
   * AND IT DRIVES EACH COLUMN RATHER THAN READING THE SEAL. The first shape of this arm was going
   * to be structural, like round 17's: read the installed bodies out of `pg_proc` and treat "the
   * body mentions the column" as "the seal freezes it". Run against the real database that proxy
   * reports `Membership` completely covered — because a before-update body READS `NEW."userId"`
   * to look a standing row up. A read is not a freeze. That is round 2's finding word for word
   * ("my own oracle inherited the gap"), and an oracle built on a proxy for the property rather
   * than the property reproduces the very class it exists to close. So every column is DRIVEN:
   * the row is planted, the update is attempted with every seal ON, and the outcome is measured.
   *
   * A REFUSAL MUST NAME ITS REASON. For every column the register declares refused it also
   * records a fragment of the refusing message. Without that, a row whose referents happen to be
   * incoherent would be refused by a foreign key and score as "frozen by the seal" — the arm
   * would read green while the seal did nothing. The fragment is what makes the measurement about
   * the seal a reviewer is reading.
   *
   * THREE PROOF SHAPES, because three different mechanisms make a column unwritable:
   *
   *   · `columns` — this unit's seal names the column. The per-column drive is the proof.
   *   · `blanket` — a seal on the table refuses EVERY update, so no column is writable and there
   *     is nothing to enumerate. Proven by driving every column against it.
   *   · `gate`    — a seal admits only a SANCTIONED writer (`platform_t4d_register_writer` raises
   *     unconditionally at trigger depth 1), so a direct write of any column is refused whatever
   *     the column is. This shape is why the five adopted registers carry no per-column rules and
   *     are nonetheless closed.
   *
   * `writable` is the deliberate half, and every entry owes a reason that says why rewriting that
   * column does not change what the record says happened. "It is the closure" is a reason.
   * Silence is not one, and a blank string fails.
   */
  type FreezeEntry =
    | { proof: 'gate' | 'blanket'; by: string; refusal: string }
    | { proof: 'columns'; refused: Record<string, string | string[]>; writable: Record<string, string> };

  /**
   * THE REGISTER. Filled from this arm's own report, which prints a paste-ready block for
   * anything unclassified — so it can never drift silently behind the schema.
   */
  const FREEZE: Record<string, FreezeEntry> = {
    ChangeRequest: {
      proof: 'columns',
      refused: {
        // #582 round 31 — `status` STOPPED being writable. Round 30 classified it as the closure's
        // own act and therefore free; the lifecycle installed this round makes a bare status move
        // a closure with no outcome, no moment and no resolver, which is exactly what it refuses.
        // two of this unit's own rules can answer, depending on the state the probe row is in:
        // a planted row whose status is neither `open` nor a real closure is ALREADY CLOSED to the
        // lifecycle, so the terminal arm speaks; an `open` row gets the closure arm. Both are
        // refusals this unit owns, and round 29 is why the register names both instead of
        // pinning whichever the fixture happens to produce.
        status: [
          "is not a closure this system performs",
          "is already closed as",
        ],
        costImpact: "phase6 4d-i: change request changerequest-probe records costImpact at",
        createdAt: "phase6 4d-i: change request changerequest-probe records createdAt at i",
        decisionId: "phase6-4b: a change request stays with the decision it was raised agai",
        id: "phase6 4d-i: ChangeRequest.changerequest-probe is the identity of a re",
        origin: "phase6 4d-i: change request changerequest-probe is evidence",
        projectId: "phase6 4d-i: change request changerequest-probe is evidence",
        reason: "phase6 4d-i: change request changerequest-probe records reason at its",
        requestedById: "phase6 4d-i: change request changerequest-probe records requestedById",
        requestedByName: "phase6 4d-i: change request changerequest-probe records requestedByNam",
        requestedByRole: "phase6 4d-i: change request changerequest-probe records requestedByRol",
        resolution: "phase6 4d-i: change request changerequest-probe already records resolu",
        resolvedAt: "phase6 4d-i: change request changerequest-probe already records resolv",
        resolvedByCommandId: "phase6 4d-i: change request changerequest-probe already records resolv",
        resolvedById: "phase6 4d-i: change request changerequest-probe already records resolv",
        resolvedByName: "phase6 4d-i: change request changerequest-probe already records resolv",
        resolvedByRole: "phase6 4d-i: change request changerequest-probe already records resolv",
        revisionId: "phase6 4d-i: change request changerequest-probe is evidence",
        sourceCommandId: "phase6 4d-i: change request changerequest-probe records sourceCommandI",
        timeImpactDays: "phase6 4d-i: change request changerequest-probe records timeImpactDays",
      },
      writable: {
      },
    },
    Decision: {
      proof: 'columns',
      refused: {
        approvedDeciderKind: "phase6-4b: approval attribution may first be written only by an approv",
        approvedDeciderLabel: "violates check constraint",
        approvedDeciderMembershipId: "violates check constraint",
        authorId: "phase6-4b: decision authorship is frozen from birth",
        deciderKind: "phase6-4b: a published or attributed decision keeps its holder",
        deciderMembershipId: "phase6-4b: a published or attributed decision keeps its holder",
        id: "phase6-4b: decision register identity is frozen from birth",
        nodeId: "violates foreign key constraint",
        projectId: "phase6-4b: decision register identity is frozen from birth",
        withdrawReason: "phase6-t4a: withdrawal evidence may exist only on a withdrawn decision",
        withdrawnAt: "phase6-t4a: withdrawal evidence may exist only on a withdrawn decision",
        withdrawnById: "phase6-t4a: withdrawal evidence may exist only on a withdrawn decision",
        withdrawnByName: "phase6-t4a: withdrawal evidence may exist only on a withdrawn decision",
      },
      writable: {
        ageDays:
          "a derived display counter recomputed from `date`; it records no act and vouches for nobody",
        approvedById:
          "a delivered denormalisation of the head revision's approver; the authoritative, immutable record is `DecisionApprovalRevision`, which this unit freezes in full",
        approvedOption:
          "a delivered denormalisation of the head revision's `optionKey`, which this unit freezes on the revision itself",
        approver:
          "the DELIVERED display label; the attributable record of who approved is the immutable revision register, and 4b's attribution seal owns this column's correctness",
        cost:
          "the decision's own editable content, owned by 4b's draft rules, not by this unit",
        createdAt:
          "the draft's own birth, before any act this unit records exists to be evidence about",
        date:
          "the decision's own editable content, owned by 4b's draft rules, not by this unit",
        material:
          "the decision's own editable content, owned by 4b's draft rules, not by this unit",
        onBehalfOf:
          "a delivered denormalisation of the head revision's `onBehalfOf`, which this unit freezes on the revision itself",
        photoSwatch:
          "presentation of the decision's own content, owned by 4b's draft rules",
        publishedAt:
          "set when the draft is published and read by 4b's entry seals; the publication act is what 4b judges, and 4d-i adds no rule about it",
        room:
          "the decision's own editable content, owned by 4b's draft rules, not by this unit",
        status:
          "the decision's LIFECYCLE \u2014 every transition this unit judges is a status move, and the transition recorder reads it rather than freezing it",
        title:
          "the decision's own editable content; 4d-i is DARK and does not own what a decision SAYS \u2014 4b owns the draft/publish boundary and refuses edits to a published head",
      },
    },
    DecisionApprovalRevision: {
      proof: 'columns',
      refused: {
        approvedAt: "DecisionApprovalRevision is append-only apart from ONE transition: rev",
        approvedById: "DecisionApprovalRevision is append-only apart from ONE transition: rev",
        approvedByName: "DecisionApprovalRevision is append-only apart from ONE transition: rev",
        approvedByRole: "DecisionApprovalRevision is append-only apart from ONE transition: rev",
        approvedFrom: "DecisionApprovalRevision is append-only apart from ONE transition: rev",
        decisionId: "DecisionApprovalRevision is append-only apart from ONE transition: rev",
        id: "DecisionApprovalRevision is append-only apart from ONE transition: rev",
        onBehalfOf: "DecisionApprovalRevision is append-only apart from ONE transition: rev",
        optionKey: "DecisionApprovalRevision is append-only apart from ONE transition: rev",
        projectId: "DecisionApprovalRevision is append-only apart from ONE transition: rev",
        sourceCommandId: "DecisionApprovalRevision is append-only apart from ONE transition: rev",
        version: "DecisionApprovalRevision is append-only apart from ONE transition: rev",
      },
      writable: {
        finalized:
          "the ONE admitted flip \u2014 false -> true is the finalisation this register exists to record, and `_t4d_one_flip` is the seal that allows it exactly once",
      },
    },
    DecisionConsultation: {
      proof: 'columns',
      refused: {
        consulteeMembershipId: "phase6-4c: DecisionConsultation is append-only evidence",
        consulteeUserId: "phase6-4c: DecisionConsultation is append-only evidence",
        decisionId: "phase6-4c: DecisionConsultation is append-only evidence",
        id: "phase6-4c: DecisionConsultation is append-only evidence",
        openCycle: "phase6-4c: DecisionConsultation is append-only evidence",
        projectId: "phase6-4c: DecisionConsultation is append-only evidence",
        question: "phase6-4c: DecisionConsultation is append-only evidence",
        requestedAt: "phase6-4c: DecisionConsultation is append-only evidence",
        requestedById: "phase6-4c: DecisionConsultation is append-only evidence",
        requestedByName: "phase6-4c: DecisionConsultation is append-only evidence",
        requestedByRole: "phase6-4c: DecisionConsultation is append-only evidence",
        sourceCommandId: "phase6-4c: DecisionConsultation is append-only evidence",
      },
      writable: {
      },
    },
    DecisionConsultationResponse: {
      proof: 'columns',
      refused: {
        consultationId: "phase6-4c: DecisionConsultationResponse is append-only evidence",
        decisionId: "phase6-4c: DecisionConsultationResponse is append-only evidence",
        id: "phase6-4c: DecisionConsultationResponse is append-only evidence",
        projectId: "phase6-4c: DecisionConsultationResponse is append-only evidence",
        recommendedOptionId: "phase6-4c: DecisionConsultationResponse is append-only evidence",
        respondedAt: "phase6-4c: DecisionConsultationResponse is append-only evidence",
        respondedById: "phase6-4c: DecisionConsultationResponse is append-only evidence",
        respondedByName: "phase6-4c: DecisionConsultationResponse is append-only evidence",
        respondedByRole: "phase6-4c: DecisionConsultationResponse is append-only evidence",
        response: "phase6-4c: DecisionConsultationResponse is append-only evidence",
        sourceCommandId: "phase6-4c: DecisionConsultationResponse is append-only evidence",
      },
      writable: {
      },
    },
    DecisionCountersign: {
      proof: 'columns',
      refused: {
        at: "phase6 4d-i: DecisionCountersign is an append-only register and its ro",
        countersignedById: "phase6 4d-i: DecisionCountersign is an append-only register and its ro",
        countersignedByName: "phase6 4d-i: DecisionCountersign is an append-only register and its ro",
        countersignedByRole: "phase6 4d-i: DecisionCountersign is an append-only register and its ro",
        decisionId: "phase6 4d-i: DecisionCountersign is an append-only register and its ro",
        id: "phase6 4d-i: DecisionCountersign is an append-only register and its ro",
        projectId: "phase6 4d-i: DecisionCountersign is an append-only register and its ro",
        revisionId: "phase6 4d-i: DecisionCountersign is an append-only register and its ro",
        sourceCommandId: "phase6 4d-i: DecisionCountersign is an append-only register and its ro",
      },
      writable: {
      },
    },
    DecisionEvent: {
      proof: 'columns',
      refused: {
        actor: "phase6 4d-i: DecisionEvent is the attributable audit register and is a",
        actorId: "phase6 4d-i: DecisionEvent is the attributable audit register and is a",
        actorName: "phase6 4d-i: DecisionEvent is the attributable audit register and is a",
        actorRole: "phase6 4d-i: DecisionEvent is the attributable audit register and is a",
        at: "phase6 4d-i: DecisionEvent is the attributable audit register and is a",
        decisionId: "phase6 4d-i: DecisionEvent is the attributable audit register and is a",
        id: "phase6 4d-i: DecisionEvent is the attributable audit register and is a",
        payload: "phase6 4d-i: DecisionEvent is the attributable audit register and is a",
        type: "phase6 4d-i: DecisionEvent is the attributable audit register and is a",
      },
      writable: {
      },
    },
    DecisionForward: {
      proof: 'columns',
      refused: {
        at: "phase6 4d-i: DecisionForward is an append-only register and its rows a",
        decisionId: "phase6 4d-i: DecisionForward is an append-only register and its rows a",
        forwardedById: "phase6 4d-i: DecisionForward is an append-only register and its rows a",
        forwardedByName: "phase6 4d-i: DecisionForward is an append-only register and its rows a",
        forwardedByRole: "phase6 4d-i: DecisionForward is an append-only register and its rows a",
        fromDesignationKind: "phase6 4d-i: DecisionForward is an append-only register and its rows a",
        fromDesignationMembershipId: "phase6 4d-i: DecisionForward is an append-only register and its rows a",
        id: "phase6 4d-i: DecisionForward is an append-only register and its rows a",
        projectId: "phase6 4d-i: DecisionForward is an append-only register and its rows a",
        reason: "phase6 4d-i: DecisionForward is an append-only register and its rows a",
        sourceCommandId: "phase6 4d-i: DecisionForward is an append-only register and its rows a",
        toDesignationKind: "phase6 4d-i: DecisionForward is an append-only register and its rows a",
        toDesignationMembershipId: "phase6 4d-i: DecisionForward is an append-only register and its rows a",
      },
      writable: {
      },
    },
    DecisionStrandedResolution: {
      proof: 'columns',
      refused: {
        at: "phase6 4d-i: DecisionStrandedResolution is an append-only register and",
        decisionId: "phase6 4d-i: DecisionStrandedResolution is an append-only register and",
        id: "phase6 4d-i: DecisionStrandedResolution is an append-only register and",
        outcome: "phase6 4d-i: DecisionStrandedResolution is an append-only register and",
        projectId: "phase6 4d-i: DecisionStrandedResolution is an append-only register and",
        reason: "phase6 4d-i: DecisionStrandedResolution is an append-only register and",
        resolvedById: "phase6 4d-i: DecisionStrandedResolution is an append-only register and",
        resolvedByName: "phase6 4d-i: DecisionStrandedResolution is an append-only register and",
        resolvedByRole: "phase6 4d-i: DecisionStrandedResolution is an append-only register and",
        revisionId: "phase6 4d-i: DecisionStrandedResolution is an append-only register and",
        sourceCommandId: "phase6 4d-i: DecisionStrandedResolution is an append-only register and",
      },
      writable: {
      },
    },
    DomainEvent: {
      proof: 'columns',
      refused: {
        actorId: "DomainEvent is append-only: UPDATE is not permitted",
        actorKind: "DomainEvent is append-only: UPDATE is not permitted",
        actorName: "DomainEvent is append-only: UPDATE is not permitted",
        actorRole: "DomainEvent is append-only: UPDATE is not permitted",
        causedByEventId: "DomainEvent is append-only: UPDATE is not permitted",
        correlationId: "DomainEvent is append-only: UPDATE is not permitted",
        dispatchIntent: "DomainEvent is append-only: UPDATE is not permitted",
        entityId: "DomainEvent is append-only: UPDATE is not permitted",
        entityType: "DomainEvent is append-only: UPDATE is not permitted",
        eventId: "DomainEvent is append-only: UPDATE is not permitted",
        eventType: "DomainEvent is append-only: UPDATE is not permitted",
        occurredAt: "DomainEvent is append-only: UPDATE is not permitted",
        organizationId: "DomainEvent is append-only: UPDATE is not permitted",
        payload: "DomainEvent is append-only: UPDATE is not permitted",
        payloadVersion: "DomainEvent is append-only: UPDATE is not permitted",
        projectId: "DomainEvent is append-only: UPDATE is not permitted",
        siteId: "DomainEvent is append-only: UPDATE is not permitted",
        streamPosition: "DomainEvent is append-only: UPDATE is not permitted",
        systemActor: "DomainEvent is append-only: UPDATE is not permitted",
      },
      writable: {
      },
    },
    DomainEventPairingClaim: {
      proof: 'columns',
      refused: {
        claimedAt: "phase6 4d-i: DomainEventPairingClaim is a platform REGISTER projected",
        claimedBy: "phase6 4d-i: DomainEventPairingClaim is a platform REGISTER projected",
        claimedById: "phase6 4d-i: DomainEventPairingClaim is a platform REGISTER projected",
        eventId: "phase6 4d-i: DomainEventPairingClaim is a platform REGISTER projected",
        projectId: "phase6 4d-i: DomainEventPairingClaim is a platform REGISTER projected",
      },
      writable: {
      },
    },
    ExternalEffectCatalog: {
      proof: 'columns',
      refused: {
        audience: "phase6 4d-i: catalog entry `activity.completion_requested` at coverage",
        coverageVersion: "phase6 4d-i: catalog entry `activity.completion_requested` at coverage",
        effectKey: "phase6 4d-i: catalog entry `activity.completion_requested` at coverage",
        eventType: "phase6 4d-i: catalog entry `activity.completion_requested` at coverage",
        frozenAudience: "phase6 4d-i: catalog entry `activity.completion_requested` at coverage",
        invalidate: "phase6 4d-i: catalog entry `activity.completion_requested` at coverage",
        pairingRequired: "phase6 4d-i: catalog entry `activity.completion_requested` at coverage",
        pushBody: "phase6 4d-i: catalog entry `activity.completion_requested` at coverage",
        pushFamily: "phase6 4d-i: catalog entry `activity.completion_requested` at coverage",
        pushRoles: "phase6 4d-i: catalog entry `activity.completion_requested` at coverage",
        requiresPush: "phase6 4d-i: catalog entry `activity.completion_requested` at coverage",
        retiredAt: "phase6 4d-i: catalog entry `activity.completion_requested` is retired",
      },
      writable: {
      },
    },
    Membership: {
      proof: 'columns',
      refused: {
        id: "phase6 4d-i: Membership.ss-mem is the identity of a recorded row and i",
        projectId: "phase6-4b: membership user/project identity is frozen",
        userId: "phase6-4b: membership user/project identity is frozen",
      },
      writable: {
        approvalLimit:
          "an authority ceiling that is deliberately adjustable; each approval is judged against the limit standing AT THE TIME, and the revision register records that judgement immutably",
        createdAt:
          "when the membership row was provisioned; the attributable record of joining is the transition register, which is append-only",
        discipline:
          "a member's trade, corrected as people's details are corrected; it attributes no act",
        role:
          "a standing CHANGE is the act, not a rewrite of evidence \u2014 the transition register records each move and this unit's fact-first seal requires the fact BEFORE the write",
        status:
          "a standing change, recorded by `MembershipTransition` rather than prevented; the same rule as `role`",
      },
    },
    MembershipTransition: {
      proof: 'columns',
      refused: {
        actorId: "phase6 4d-i: MembershipTransition membershiptransition-probe is immuta",
        actorName: "phase6 4d-i: MembershipTransition membershiptransition-probe is immuta",
        actorRole: "phase6 4d-i: MembershipTransition membershiptransition-probe is immuta",
        at: "phase6 4d-i: MembershipTransition membershiptransition-probe is immuta",
        fromRole: "phase6 4d-i: MembershipTransition membershiptransition-probe is immuta",
        fromStatus: "phase6 4d-i: MembershipTransition membershiptransition-probe is immuta",
        id: "phase6 4d-i: MembershipTransition membershiptransition-probe is immuta",
        membershipId: "phase6 4d-i: MembershipTransition membershiptransition-probe is immuta",
        projectId: "phase6 4d-i: MembershipTransition membershiptransition-probe is immuta",
        sourceCommandId: "phase6 4d-i: MembershipTransition membershiptransition-probe is immuta",
        toRole: "phase6 4d-i: MembershipTransition membershiptransition-probe is immuta",
        toStatus: "phase6 4d-i: MembershipTransition membershiptransition-probe is immuta",
        userId: "phase6 4d-i: MembershipTransition membershiptransition-probe is immuta",
      },
      writable: {
      },
    },
    Notification: {
      proof: 'columns',
      refused: {
        at: "phase6 4d-i: notice notification-probe is KINDED",
        color: "phase6 4d-i: notice notification-probe is KINDED",
        decisionId: "phase6 4d-i: notice notification-probe announces event ss-ev1 about de",
        eventId: "phase6 4d-i: notice notification-probe is bound to event ss-ev1 and ma",
        id: "phase6 4d-i: Notification.notification-probe is the identity of a reco",
        kind: "phase6 4d-i: notice notification-probe's kind",
        projectId: "phase6 4d-i: notice notification-probe may not change project",
        text: "phase6 4d-i: notice notification-probe is KINDED",
        time: "phase6 4d-i: notice notification-probe is KINDED",
      },
      writable: {
      },
    },
    OrgMembership: {
      proof: 'columns',
      refused: {
        id: "phase6 4d-i: OrgMembership.orgmembership-probe is the identity of a re",
        orgId: "phase6-4b: org-membership identity is frozen",
        userId: "phase6-4b: org-membership identity is frozen",
      },
      writable: {
        createdAt:
          "when the org membership row was provisioned; it records no act this unit attributes",
        role:
          "an org standing change \u2014 the same act-not-evidence rule as `Membership.role`, projected into `OrgUserAuthority` by this unit's own trigger",
      },
    },
    OrgUserAuthority: {
      proof: 'columns',
      refused: {
        orgId: "phase6 4d-i: OrgUserAuthority is a platform REGISTER projected from th",
        role: "phase6 4d-i: OrgUserAuthority is a platform REGISTER projected from th",
        userId: "phase6 4d-i: OrgUserAuthority is a platform REGISTER projected from th",
      },
      writable: {
      },
    },
    ProjectEventStream: {
      proof: 'columns',
      refused: {
        nextPosition: "phase6 4d-i: the event-stream allocator for project ss-proj moves by e",
        projectId: "phase6 4d-i: the event-stream allocator for project ss-proj moves by e",
      },
      writable: {
      },
    },
    ProjectOrg: {
      proof: 'columns',
      refused: {
        orgId: "phase6 4d-i: project ss-proj is registered to org ss-org and may not b",
        projectId: "phase6 4d-i: ProjectOrg is a platform REGISTER projected from the orgs",
      },
      writable: {
      },
    },
    ProjectRoleStanding: {
      proof: 'columns',
      refused: {
        activeCount: "phase6 4d-i: ProjectRoleStanding is a platform REGISTER projected from",
        changedAt: "phase6 4d-i: ProjectRoleStanding is a platform REGISTER projected from",
        projectId: "phase6 4d-i: ProjectRoleStanding is a platform REGISTER projected from",
        role: "phase6 4d-i: ProjectRoleStanding is a platform REGISTER projected from",
      },
      writable: {
      },
    },
    ProjectUserStanding: {
      proof: 'columns',
      refused: {
        membershipId: "phase6 4d-i: ProjectUserStanding is a platform REGISTER projected from",
        projectId: "phase6 4d-i: ProjectUserStanding is a platform REGISTER projected from",
        role: "phase6 4d-i: ProjectUserStanding is a platform REGISTER projected from",
        userId: "phase6 4d-i: ProjectUserStanding is a platform REGISTER projected from",
      },
      writable: {
      },
    },
    ReleaseLease: {
      proof: 'columns',
      refused: {
        catalogVersion: "phase6 4d-i: release lease ss-instance's identity",
        instanceId: "phase6 4d-i: release lease ss-instance's identity",
        release: "phase6 4d-i: release lease ss-instance's identity",
        startedAt: "phase6 4d-i: release lease ss-instance's identity",
      },
      writable: {
        leaseUntil:
          "the HEARTBEAT \u2014 a serving process extends its own lease, which is the entire purpose of the column; everything identifying WHICH process holds it is frozen",
      },
    },
    RolloutRetirement: {
      proof: 'columns',
      refused: {
        retiredAt: "RolloutRetirement is append-only",
        retiredBy: "RolloutRetirement is append-only",
        unit: "RolloutRetirement is append-only",
      },
      writable: {
      },
    },
    User: {
      proof: 'columns',
      refused: {
        // refused twice over: the identity register's foreign key, and the membership identity
        // seal through the cascade. Both are this unit's; which reports first is PostgreSQL's.
        id: [
          "phase6-4b: membership user/project identity is frozen",
          "violates foreign key constraint",
        ],
        projectId: "violates foreign key constraint",
      },
      writable: {
        createdAt:
          "when the account row was provisioned; it records no act this unit attributes",
        credentialVersion:
          "the rotation counter that INVALIDATES old sessions; it must move for revocation to work",
        email:
          "account contact detail, changed by the account's owner; it attributes no act",
        emailVerifiedAt:
          "set when verification completes and cleared when the address changes; part of the credential lifecycle",
        name:
          "a person's name changes, and the register mirrors it; every act already recorded carries its own frozen name pair, so renaming does not rewrite any attribution",
        passwordHash:
          "a credential, rotated by design; freezing it would make password change impossible",
        phone:
          "account contact detail, changed by the account's owner; it attributes no act",
        role:
          "the account's coarse role, changed as people's jobs change; the RESERVED values this unit protects are refused by the reservation door, and every project act is judged against membership standing rather than this column",
      },
    },
    UserIdentity: {
      proof: 'columns',
      refused: {
        displayName: "phase6 4d-i: UserIdentity is a platform REGISTER projected from the or",
        userId: "phase6 4d-i: UserIdentity is a platform REGISTER projected from the or",
      },
      writable: {
      },
    },
  };

  /** A value guaranteed DIFFERENT from whatever the column holds, derived from its type. */
  function otherValue(col: string, dataType: string, udt: string): string | null {
    switch (dataType) {
      case 'text': case 'character varying': case 'character':
        return `'t4d-probe-' || coalesce("${col}", '')`;
      case 'boolean':
        return `NOT coalesce("${col}", false)`;
      case 'integer': case 'bigint': case 'smallint':
      case 'numeric': case 'double precision': case 'real':
        return `coalesce("${col}", 0) + 37`;
      case 'timestamp without time zone': case 'timestamp with time zone':
        return `coalesce("${col}", now()) + interval '37 days'`;
      case 'date':
        return `coalesce("${col}", now()::date) + 37`;
      case 'jsonb':
        return `jsonb_build_object('t4dProbe', true)`;
      case 'json':
        return `json_build_object('t4dProbe', true)`;
      case 'ARRAY':
        return `ARRAY['t4d-probe']::${udt.replace(/^_/, '')}[]`;
      case 'USER-DEFINED':
        // an enum: any label that is not the one the row carries
        return `(SELECT e.enumlabel FROM pg_enum e JOIN pg_type ty ON ty.oid = e.enumtypid`
          + ` WHERE ty.typname = '${udt}' AND e.enumlabel IS DISTINCT FROM "${col}"::text`
          + ` ORDER BY e.enumsortorder LIMIT 1)::"${udt}"`;
      default:
        return null;   // reported by name, never skipped in silence
    }
  }

  /** Quoting is normalised away before a refusal is compared with the fragment the register
   *  records. PostgreSQL quotes identifiers in its own messages, so a fragment carrying a quote
   *  is brittle for no gain — the fragment's job is to say WHICH refusal happened, not to
   *  reproduce its punctuation. */
  const unquoted = (t: string): string => t.replace(/"/g, '');

  /** the first line of a psql error, for a report that stays readable at 300 columns */
  function firstLine(output: string): string {
    return output.split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? '(no output)';
  }

  it('every column of every table this unit seals on UPDATE is DISCOVERED, DRIVEN and classified', () => {
    buildRun([]);

    // ── the table set, discovered rather than listed ────────────────────────────────────────
    const tablesQ = psql(RUN_DB, ['-At', '-c',
      `SELECT DISTINCT c.relname
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND t.tgname LIKE '%\\_t4d\\_%'
          AND (t.tgtype & 16) <> 0
        ORDER BY 1`]);
    expect(tablesQ.ok, `discovering the sealed tables failed:\n${tablesQ.output}`).toBe(true);
    const tables = tablesQ.output.split('\n').map((s) => s.trim()).filter(Boolean);
    expect(tables.length,
      'the discovery found no UPDATE-sealed tables at all — the query is broken, not the migration')
      .toBeGreaterThan(0);
    expect(tables.slice().sort(),
      'a table gained (or lost) an UPDATE-firing t4d seal and the register did not move with it')
      .toEqual(Object.keys(FREEZE).sort());

    const unclassified: string[] = [];
    const wrong: string[] = [];

    for (const table of tables) {
      const entry = FREEZE[table]!;

      const colsQ = psql(RUN_DB, ['-At', '-F', '~', '-c',
        `SELECT column_name, data_type, udt_name
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = '${table}'
          ORDER BY ordinal_position`]);
      expect(colsQ.ok, `reading the columns of ${table} failed:\n${colsQ.output}`).toBe(true);
      const cols = colsQ.output.split('\n').map((l) => l.trim()).filter(Boolean)
        .map((l) => l.split('~') as [string, string, string]);

      // A table the arm cannot measure is REPORTED, never skipped. The first two runs of this
      // oracle returned a bare null here and six tables — `ChangeRequest` among them, where the
      // candidates are — vanished from the report with no reason given. An oracle that goes quiet
      // about what it could not measure is the same defect as a rule with a sibling left standing.
      const probe = probeRowWhere(table, cols);
      if ('failed' in probe) {
        unclassified.push(`${table}: NOT MEASURED — ${probe.failed}`);
        continue;
      }
      const { where } = probe;

      for (const [col, dataType, udt] of cols) {
        const value = otherValue(col, dataType, udt);
        if (value === null) {
          unclassified.push(`${table}.${col}: no probe value exists for type ${dataType} (${udt})`);
          continue;
        }
        const r = psql(RUN_DB, ['-c',
          `BEGIN; UPDATE "${table}" SET "${col}" = ${value} WHERE ${where}; ROLLBACK;`]);

        if (entry.proof !== 'columns') {
          // a blanket or a gate refuses whatever the column is, so every column proves it
          if (r.ok) {
            wrong.push(`${table}.${col} was ACCEPTED, but the register calls the table ${entry.proof}d by ${entry.by}`);
          } else if (!unquoted(r.output).includes(unquoted(entry.refusal))) {
            wrong.push(`${table}.${col} was refused, but not by ${entry.by} — the refusal does not `
              + `carry ${JSON.stringify(entry.refusal)}:\n  ${firstLine(r.output)}`);
          }
          continue;
        }

        const declaredRefusal = entry.refused[col];
        const declaredWritable = entry.writable[col];
        if (declaredRefusal === undefined && declaredWritable === undefined) {
          unclassified.push(`${table}.${col}: ${r.ok ? 'ACCEPTED' : `REFUSED — ${unquoted(firstLine(r.output))}`}`);
          continue;
        }
        if (declaredRefusal !== undefined && declaredWritable !== undefined) {
          wrong.push(`${table}.${col} is declared BOTH refused and writable`);
          continue;
        }
        if (declaredWritable !== undefined) {
          if (declaredWritable.trim().length < 20) {
            wrong.push(`${table}.${col} is declared writable with no real reason — the reason has `
              + 'to say why rewriting it does not change what the record says happened');
          } else if (!r.ok) {
            wrong.push(`${table}.${col} is declared WRITABLE and was refused:\n  ${firstLine(r.output)}`);
          }
          continue;
        }
        // A refusal may name ALTERNATIVES, and `User.id` is why. That rewrite is refused twice
        // over — the identity register holds a foreign key to it, AND the membership identity seal
        // is reached through the cascade — and WHICH ONE REPORTS is not something this unit
        // decides. PostgreSQL picks among eligible constraint triggers; this machine and CI picked
        // differently on identical code. Round 28's first attempt blamed the probe row and ordered
        // the selection; the next CI run failed identically, which is the evidence that the row
        // was never the variable and that a single expected message was the wrong shape of claim.
        //
        // This does not let the register go quiet. Every alternative must still be a refusal this
        // unit can name, so an unrelated rejection fails the arm exactly as before; what it
        // records is the true state — the column is closed by more than one rule at once.
        const accepted = Array.isArray(declaredRefusal) ? declaredRefusal : [declaredRefusal];
        if (r.ok) {
          wrong.push(`${table}.${col} is declared REFUSED and the update was ACCEPTED — the seal does not cover it`);
        } else if (!accepted.some((f) => unquoted(r.output).includes(unquoted(f)))) {
          wrong.push(`${table}.${col} was refused, but not for any reason the register records. `
            + `Expected the message to carry one of ${JSON.stringify(accepted)}; got:\n  ${firstLine(r.output)}`);
        }
      }
    }

    expect(unclassified,
      'these columns of tables this unit seals on UPDATE are in no class. Each is either evidence '
      + 'the seal has to freeze, or a deliberate exception that owes a reason. Silence is how '
      + 'rounds 18, 23, 24 and 25 each shipped a rule with a sibling left standing.')
      .toEqual([]);
    expect(wrong, 'the register disagrees with what the database actually did').toEqual([]);
  }, 600_000);

  /**
   * A row of `table` to drive the per-column updates against, returned as a WHERE clause.
   *
   * `ctid` rather than a primary key, because the point is to address ONE row of ANY table —
   * including the ones whose key this unit freezes, where naming the key in the WHERE would make
   * the probe of that very key untestable. An UPDATE evaluates its WHERE before its SET, so a
   * probe that rewrites the key still finds its row.
   *
   * Where the fixture already planted a row it is used as-is. Where it did not, one is planted
   * under `session_replication_role = 'replica'` — every trigger off, foreign keys included. That
   * is deliberate and it is the honest shape: the claim under test is about the UPDATE path, and
   * the INSERT seals are a different unit of work with their own arms above. Referent-shaped
   * columns still take the fixture's ids so the planted row is COHERENT — a row with dangling
   * referents would be refused at UPDATE by a foreign key, and the arm would score that as the
   * seal doing its job.
   */
  const FIXTURE_IDS: Record<string, string> = {
    projectId: 'ss-proj', orgId: 'ss-org', userId: 'ss-user', decisionId: 'ss-dec',
    eventId: 'ss-ev1', membershipId: 'ss-mem', actorId: 'ss-user', approvedById: 'ss-user',
    requestedById: 'ss-user', resolvedById: 'ss-user', sourceCommandId: 'ss-cmd',
  };

  /**
   * The literals a CHECK constraint ADMITS for a column, read from the constraint itself.
   *
   * The first fully-populated plant failed on six tables with `violates check constraint
   * "ChangeRequest_origin_check"` and five like it: the generic `'t4d-probe'` string is not one of
   * the values those columns are allowed to hold. Retyping the admitted values here by hand would
   * be the very habit this arm exists to break, so they are READ OUT of `pg_get_constraintdef` —
   * a unit that adds a value, or narrows one, moves the probe with it and nothing goes stale.
   */
  function admittedLiterals(table: string, mode: 'full' | 'minimal'): Record<string, string> {
    // The columns come from `conkey`, not from reading the printed definition. The first version
    // of this matched `"col"` in the text and found nothing on `CHECK ((origin = ANY (...)))` —
    // PostgreSQL prints a lower-case identifier unquoted, so five tables stayed unmeasurable while
    // the constraint that named their admitted values sat right there. The catalog is the
    // authority on which columns a constraint covers; the text is only where the literals are.
    const q = psql(RUN_DB, ['-At', '-F', '~', '-c',
      `SELECT pg_get_constraintdef(c.oid),
              (SELECT string_agg(a.attname, ',') FROM unnest(c.conkey) k
                 JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k)
         FROM pg_constraint c
        WHERE c.contype = 'c' AND c.conrelid = '"${table}"'::regclass`]);
    const out: Record<string, string> = {};
    const allowed: Record<string, string[]> = {};
    if (!q.ok) return out;
    for (const row of q.output.split('\n')) {
      const [def, key] = row.split('~');
      if (def === undefined || key === undefined) continue;
      const named = key.split(',').map((c) => c.trim()).filter(Boolean);
      const literals = [...def.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
      // only a SINGLE-column membership test tells us what that column may hold; a cross-column
      // constraint ("these two must differ") names no admitted value, and is satisfied instead by
      // the per-column default below never repeating itself.
      if (named.length === 1 && literals.length > 0 && out[named[0]!] === undefined) {
        out[named[0]!] = literals[0]!;
      }
    }

    // SECOND PASS — the CONDITIONAL PRESENCE shape, which overrides the plain pick above.
    //
    // ONLY for a fully populated row. In `minimal` mode the companion column is NULLABLE and is
    // deliberately left empty, so taking the literal that REQUIRES it would make the row
    // unplantable; the plain pick above is the one that wants the companion absent.
    // In `minimal` mode the companion is deliberately left NULL, so the discriminator takes a
    // literal that does NOT require it — any admitted value other than the biconditional's own.
    // (Skipping this pass entirely was not enough: a discriminator named ONLY by a two-column
    // check gets no literal from the single-column pass either, falls back to the generic string,
    // and fails the membership test — which is why `DecisionForward` stayed unmeasurable.)
    if (mode === 'minimal') {
      for (const row of q.output.split('\n')) {
        const [def, key] = row.split('~');
        if (def === undefined || key === undefined) continue;
        const named = key.split(',').map((c) => c.trim()).filter(Boolean);
        if (named.length !== 2 || !def.includes('IS NOT NULL')) continue;
        const m = def.match(/"?([A-Za-z0-9_]+)"?\s*=\s*'([^']+)'/);
        if (!m || !named.includes(m[1]!)) continue;
        const others = [...def.matchAll(/'([^']+)'/g)].map((x) => x[1]!).filter((l) => l !== m[2]!);
        if (others.length > 0) {
          out[m[1]!] = others[0]!;
          allowed[m[1]!] = others;
        }
      }
      // AND A PAIR THE SCHEMA REQUIRES TO DIFFER MUST BE GIVEN DIFFERENT VALUES. Two
      // discriminators drawn from the same admitted list both take its first entry, and a
      // `a IS DISTINCT FROM b` check then rejects the row — `DecisionForward` again, one
      // constraint further on. The second column takes the next value its OWN list allows.
      for (const row of q.output.split('\n')) {
        const [def, key] = row.split('~');
        if (def === undefined || key === undefined || !def.includes('IS DISTINCT FROM')) continue;
        // the PAIRS come from the constraint's own text, not from catalog order: `conkey` lists
        // all four columns of `designation_moves_check` by attnum, so walking it adjacently
        // compares `fromKind` with `fromMembershipId` and never with `toKind` — the two the
        // constraint actually requires to differ.
        for (const m2 of def.matchAll(/"([A-Za-z0-9_]+)"\s+IS DISTINCT FROM\s+"([A-Za-z0-9_]+)"/g)) {
          const a = m2[1]!; const b = m2[2]!;
          if (out[a] === undefined || out[a] !== out[b]) continue;
          const alt = (allowed[b] ?? []).find((l) => l !== out[a]);
          if (alt !== undefined) out[b] = alt;
        }
      }
      return out;
    }
    //
    // `CHECK ((origin = 'countersign_rejection') = ("revisionId" IS NOT NULL))` and
    // `CHECK (... AND (("fromDesignationKind" = 'member') = ("fromDesignationMembershipId" IS NOT
    // NULL)))` say the same thing in two tables: ONE value of a discriminator column REQUIRES its
    // companion to be filled, and every other value requires it to be empty. The first pass picks
    // the first literal it sees, which is the wrong half of the biconditional, and the fully
    // populated row is then rejected — which is how `ChangeRequest`, the table this round most
    // needs measured, stayed unmeasurable for four runs.
    //
    // Taking the literal that makes the companion REQUIRED is the right resolution rather than a
    // convenient one: the alternative is to null the companion, and a probe row with empty
    // columns is exactly the under-reporting shape this arm already had to correct once.
    for (const row of q.output.split('\n')) {
      const [def, key] = row.split('~');
      if (def === undefined || key === undefined) continue;
      const named = key.split(',').map((c) => c.trim()).filter(Boolean);
      if (named.length !== 2 || !def.includes('IS NOT NULL')) continue;
      const m = def.match(/"?([A-Za-z0-9_]+)"?\s*=\s*'([^']+)'/);
      if (m && named.includes(m[1]!)) out[m[1]!] = m[2]!;
    }
    return out;
  }

  function seedValue(table: string, col: string, dataType: string, udt: string,
                     admitted: Record<string, string>): string {
    if (col === 'id') return `'${table.toLowerCase()}-probe'`;
    const allowed = admitted[col];
    if (allowed !== undefined) return `'${allowed.replace(/'/g, "''")}'`;
    const fixture = FIXTURE_IDS[col];
    if (fixture !== undefined && (dataType === 'text' || dataType === 'character varying')) {
      return `'${fixture}'`;
    }
    switch (dataType) {
      // VARIES BY COLUMN. `MembershipTransition_moves_check` and
      // `DecisionForward_designation_moves_check` require two columns to DIFFER, and a constant
      // seed gives them the same value — the row is rejected and the table goes unmeasured. A
      // per-column string satisfies every such pair without naming any of them.
      case 'text': case 'character varying': case 'character': return `'t4d-${col}'`;
      case 'boolean': return 'false';
      case 'integer': case 'bigint': case 'smallint':
      case 'numeric': case 'double precision': case 'real': return '1';
      case 'timestamp without time zone': case 'timestamp with time zone': return 'now()';
      case 'date': return `now()::date`;
      case 'jsonb': return `'{}'::jsonb`;
      case 'json': return `'{}'::json`;
      case 'ARRAY': return `'{}'::${udt.replace(/^_/, '')}[]`;
      case 'USER-DEFINED':
        return `(SELECT e.enumlabel FROM pg_enum e JOIN pg_type ty ON ty.oid = e.enumtypid`
          + ` WHERE ty.typname = '${udt}' ORDER BY e.enumsortorder LIMIT 1)::"${udt}"`;
      default: return 'NULL';
    }
  }

  function probeRowWhere(table: string, cols: [string, string, string][],
                         mode: 'full' | 'minimal' = 'full'): { where: string } | { failed: string } {
    // ORDER BY, because `LIMIT 1` alone is not a choice — it is whatever the plan returns, and a
    // probe should say which row it means.
    //
    // THIS WAS NOT THE CI DIVERGENCE, and the correction is left here rather than quietly
    // dropped. Round 28 first read `User.id` reporting a different refusal on CI than here,
    // concluded the unordered pick was the cause, ordered it, gated the whole battery green and
    // pushed — and the next CI run failed identically. The row was never the variable; two
    // constraint triggers are both eligible and PostgreSQL chooses. The real fix is the
    // alternatives the register now records below. Ordering stays because it is right on its own
    // terms, not because it fixed anything.
    const existing = psql(RUN_DB, ['-At', '-c', `SELECT ctid FROM "${table}" ORDER BY ctid LIMIT 1`]);
    if (existing.ok && existing.output.trim() !== '') {
      return { where: `ctid = '${existing.output.trim()}'` };
    }

    // EVERY column, not only the required ones. The first run of this arm planted only the NOT
    // NULL columns and reported `Notification.text`/`color`/`decisionId` rewritable — seals round
    // 6 installed and proved. They were not rewritable; the PLANTED ROW was the wrong shape. Those
    // freezes govern a KINDED notice, `kind` is nullable, so a row with `kind` NULL exercises the
    // unconditional arms and nothing else. The same blank-row artefact made
    // `ChangeRequest.resolvedById` look open, when NULL -> value is the closure the one-way rule
    // deliberately admits.
    //
    // A freeze is a rule about a record that ALREADY CARRIES THE EVIDENCE, so that is the state
    // the probe has to be in: every column populated, and the rewrite attempted against a row
    // that has already recorded its act. A half-empty row does not exercise a conditional rule —
    // it silently skips it, and an oracle that under-reports is the same failure as a rule
    // implemented over a subset, committed one level up.
    const plantableQ = psql(RUN_DB, ['-At', '-c',
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = '${table}'
          AND is_identity = 'NO' AND is_generated = 'NEVER'
          ${mode === 'minimal' ? "AND is_nullable = 'NO' AND column_default IS NULL" : ''}
        ORDER BY ordinal_position`]);
    if (!plantableQ.ok) return { failed: `the column list could not be read:\n  ${firstLine(plantableQ.output)}` };
    const plantable = new Set(plantableQ.output.split('\n').map((s) => s.trim()).filter(Boolean));
    const planted = cols.filter(([c]) => plantable.has(c));
    if (planted.length === 0) return { failed: 'the table has no plantable column' };
    const admitted = admittedLiterals(table, mode);

    const plant = psql(RUN_DB, ['-c',
      `BEGIN;
       SET LOCAL session_replication_role = 'replica';
       INSERT INTO "${table}" (${planted.map(([c]) => `"${c}"`).join(', ')})
         VALUES (${planted.map(([c, d, u]) => seedValue(table, c, d, u, admitted)).join(', ')});
       COMMIT;`]);
    if (!plant.ok) return { failed: `the probe row would not plant:\n  ${firstLine(plant.output)}` };

    const after = psql(RUN_DB, ['-At', '-c', `SELECT ctid FROM "${table}" ORDER BY ctid LIMIT 1`]);
    if (!after.ok || after.output.trim() === '') {
      return { failed: 'the probe row planted and then could not be found' };
    }
    return { where: `ctid = '${after.output.trim()}'` };
  }

  /** An OPEN standard change request, legal in every respect the unit's INSERT seals judge:
   *  `origin = 'standard'` so `revision_by_origin` wants no revision, a real birth receipt, and a
   *  requester pair TRUE of `ss-user` so the birth-pair correspondence admits it. */
  const CR_OPEN = `
    INSERT INTO "CommandExecution" ("id","scopeKind","organizationId","projectId","actorId","commandType","idempotencyKey","requestHash","status")
      VALUES ('ss-cmd-r26','project','ss-org','ss-proj','ss-user','decisions.requestChange','ss-key-r26','ss-hash-r26','reserved');
    -- the BIRTH receipt's result is the REQUEST itself, not the decision (#582 round 20,
    -- finding 1 bound this): a receipt naming another result cannot be borrowed.
    UPDATE "CommandExecution" SET "status" = 'succeeded', "completedAt" = now(), "resultRef" = 'ss-cr-r26' WHERE "id" = 'ss-cmd-r26';
    INSERT INTO "ChangeRequest" ("id","projectId","decisionId","reason","costImpact","timeImpactDays","status","origin","sourceCommandId","requestedById","requestedByRole","requestedByName")
      VALUES ('ss-cr-r26','ss-proj','ss-dec','the original ask',0,2,'open','standard','ss-cmd-r26','ss-user','pmc','SS User');
  `;

  /** A KINDED notice, minted the way a real one is: its event allocated and inserted in the SAME
   *  transaction, and its `kind` equal to that event's `eventType`. Both are seals this unit
   *  already installs, so a notice planted any other way is refused before the arm under test
   *  ever runs. */
  const KINDED_NOTICE = `
    BEGIN;
    UPDATE "ProjectEventStream" SET "nextPosition" = "nextPosition" + 1 WHERE "projectId" = 'ss-proj';
    INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","actorKind","systemActor","entityType","entityId","dispatchIntent")
      SELECT 'ss-ev-r26','decision.published',1,'ss-org','ss-proj',s."nextPosition" - 1,'system','system:seed','Decision','ss-dec',
             jsonb_build_object('effectKey','decision.published','coverageVersion',c."coverageVersion",'invalidate',c."invalidate",
                                'push', jsonb_build_object('body','r26','roles', jsonb_build_array('client')))
        FROM "ProjectEventStream" s, "ExternalEffectCatalog" c
       WHERE s."projectId" = 'ss-proj' AND c."effectKey" = 'decision.published'
         AND c."coverageVersion" = '${COVERAGE}';
    INSERT INTO "Notification" ("id","projectId","text","color","time","kind","eventId","decisionId")
      VALUES ('ss-note-r26','ss-proj','published','#000','just now','decision.published','ss-ev-r26','ss-dec');
    COMMIT;
  `;

  /**
   * #582's review round 26 — THE THREE FINDINGS THE COVERAGE ORACLE FOUND, DRIVEN BY NAME.
   *
   * The oracle arm above proves a column is REFUSED. It does not prove WHICH seal refused it, and
   * on this PR that distinction has mattered twice (the `deciderKind = 'architect'` arm was
   * refused by a DELIVERED seal while the door under test never fired). So each finding is also
   * driven here in the strip-vs-whole shape: the named seal omitted, the hostile write ACCEPTED;
   * the whole unit, REFUSED by that seal's own message.
   */
  it('round 26: SUBSTANCE, MOMENT and IDENTITY are evidence too', () => {
    // ── F3: identity is frozen from birth, on every table that has one ──────────────────────
    // `Decision` already refused this through the delivered 4b seal; `ChangeRequest`,
    // `Notification`, `Membership` and `OrgMembership` did not refuse it at all. One shared
    // function over the inventory, so this arm drives the FUNCTION and the coverage declaration
    // carries its three siblings — each of which the oracle arm above drives independently.
    buildRun(['ChangeRequest_t4d_identity']);
    const crPlant = psql(RUN_DB, ['-c', CR_OPEN]);
    expect(crPlant.ok, `the request must plant for the identity arm:\n${crPlant.output}`).toBe(true);
    const idStripped = psql(RUN_DB, ['-c',
      `UPDATE "ChangeRequest" SET "id" = 'ss-cr-reparented' WHERE "id" = 'ss-cr-r26'`]);
    expect(idStripped.ok,
      'with the identity seal stripped the id rewrite must COMMIT — otherwise this arm proves nothing')
      .toBe(true);

    buildRun([]);
    { const r = psql(RUN_DB, ['-c', CR_OPEN]); expect(r.ok, r.output).toBe(true); }
    const idWhole = psql(RUN_DB, ['-c',
      `UPDATE "ChangeRequest" SET "id" = 'ss-cr-reparented' WHERE "id" = 'ss-cr-r26'`]);
    expect(idWhole.ok, 'a recorded row may not be re-pointed to a different identity').toBe(false);
    expect(idWhole.output).toMatch(/is the identity of a recorded row and is frozen from birth/);

    // ── F1: what the request SAID is evidence, exactly as its `origin` already was ──────────
    buildRun(['ChangeRequest_t4d_evidence_frozen']);
    { const r = psql(RUN_DB, ['-c', CR_OPEN]); expect(r.ok, r.output).toBe(true); }
    const saidStripped = psql(RUN_DB, ['-c',
      `UPDATE "ChangeRequest" SET "reason" = 'a completely different ask',
                                  "costImpact" = 900000, "timeImpactDays" = 40
        WHERE "id" = 'ss-cr-r26'`]);
    expect(saidStripped.ok, 'with the freeze stripped the substance rewrite must COMMIT').toBe(true);

    buildRun([]);
    { const r = psql(RUN_DB, ['-c', CR_OPEN]); expect(r.ok, r.output).toBe(true); }
    const saidWhole = psql(RUN_DB, ['-c',
      `UPDATE "ChangeRequest" SET "reason" = 'a completely different ask',
                                  "costImpact" = 900000, "timeImpactDays" = 40
        WHERE "id" = 'ss-cr-r26'`]);
    expect(saidWhole.ok,
      'the ask, the money it claimed and the days it claimed are what the record SAYS happened')
      .toBe(false);
    expect(saidWhole.output).toMatch(/records \w+ at its BIRTH/);

    // and the CLOSURE's moment and outcome, which round 24 left beside the actor it froze.
    // One-way: the closure itself must still be admitted, so this drives the REWRITE of a
    // resolver set that is already filled.
    buildRun([]);
    { const r = psql(RUN_DB, ['-c', CR_OPEN]); expect(r.ok, r.output).toBe(true); }
    const closed = psql(RUN_DB, ['-c',
      `UPDATE "ChangeRequest"
          SET "status" = 'withdrawn', "resolution" = 'withdrawn', "resolvedById" = 'ss-user',
              "resolvedAt" = now()
        WHERE "id" = 'ss-cr-r26'`]);
    expect(closed.ok,
      `the real closure must stay admitted — the serving release writes exactly this:\n${closed.output}`)
      .toBe(true);
    const reclosed = psql(RUN_DB, ['-c',
      `UPDATE "ChangeRequest" SET "resolvedAt" = now() + interval '7 days',
                                  "resolution" = 'reapproved'
        WHERE "id" = 'ss-cr-r26'`]);
    expect(reclosed.ok,
      'a closed request may not be moved to a different moment, or relabelled as a different outcome')
      .toBe(false);
    expect(reclosed.output).toMatch(/already records \w+ as provenance/);

    // ── round 27 F1: the resolver set may not be FILLED except by the closure ──────────────
    // Codex's finding, and the reproduce-first evidence for it. `resolvedById` is given a value
    // on an OPEN request — no status moves, nothing closes. Stripped, it commits and the one-way
    // arm then makes it permanent, which is what leaves the request unclosable by its real
    // resolver. Whole, the closure-only predicate refuses it.
    buildRun(['ChangeRequest_t4d_evidence_frozen']);
    { const r = psql(RUN_DB, ['-c', CR_OPEN]); expect(r.ok, r.output).toBe(true); }
    const fillStripped = psql(RUN_DB, ['-c',
      `UPDATE "ChangeRequest" SET "resolvedById" = 'ss-client' WHERE "id" = 'ss-cr-r26'`]);
    expect(fillStripped.ok,
      'with the freeze stripped, stamping a resolver onto an OPEN request must COMMIT').toBe(true);

    buildRun([]);
    { const r = psql(RUN_DB, ['-c', CR_OPEN]); expect(r.ok, r.output).toBe(true); }
    const fillWhole = psql(RUN_DB, ['-c',
      `UPDATE "ChangeRequest" SET "resolvedById" = 'ss-client' WHERE "id" = 'ss-cr-r26'`]);
    expect(fillWhole.ok,
      'a resolver may not be stamped onto a request that is not being closed — the one-way arm '
      + 'would then make it permanent and refuse the genuine closure').toBe(false);
    expect(fillWhole.output).toMatch(/gains resolver provenance on an update that does not CLOSE it/);

    // and the two columns round 26 added to the one-way set have the same rule, which is the
    // half that round missed: they were frozen against REWRITE and open to being FILLED.
    const fillAt = psql(RUN_DB, ['-c',
      `UPDATE "ChangeRequest" SET "resolvedAt" = now() WHERE "id" = 'ss-cr-r26'`]);
    expect(fillAt.ok, 'a closing MOMENT may not be stamped onto a request that is not closing').toBe(false);
    const fillRes = psql(RUN_DB, ['-c',
      `UPDATE "ChangeRequest" SET "resolution" = 'withdrawn' WHERE "id" = 'ss-cr-r26'`]);
    expect(fillRes.ok, 'an OUTCOME may not be stamped onto a request that is not closing').toBe(false);

    // ── F2: WHEN a kinded notice announced is part of the cache round 6 froze ───────────────
    buildRun(['Notification_t4d_binding']);
    const notePlant = psql(RUN_DB, ['-c', KINDED_NOTICE]);
    expect(notePlant.ok, `the kinded notice must plant:\n${notePlant.output}`).toBe(true);
    const whenStripped = psql(RUN_DB, ['-c',
      `UPDATE "Notification" SET "at" = now() + interval '9 days', "time" = '11:11'
        WHERE "id" = 'ss-note-r26'`]);
    expect(whenStripped.ok, 'with the binding stripped the time rewrite must COMMIT').toBe(true);

    buildRun([]);
    { const r = psql(RUN_DB, ['-c', KINDED_NOTICE]); expect(r.ok, r.output).toBe(true); }
    const whenWhole = psql(RUN_DB, ['-c',
      `UPDATE "Notification" SET "at" = now() + interval '9 days', "time" = '11:11'
        WHERE "id" = 'ss-note-r26'`]);
    expect(whenWhole.ok,
      'moving a kinded notice re-places it among the acts either side of it with every word of it still true')
      .toBe(false);
    expect(whenWhole.output).toMatch(/WHEN it announced is a cache of its event/);
  }, 600_000);

  /**
   * #582's review round 27, finding 4 (SELF-FOUND) — THE OTHER HALF OF THE QUESTION.
   *
   * The arm above asks ONE thing: can a column that ALREADY HOLDS A VALUE be rewritten? It plants
   * a fully populated row and attempts an update. Round 26 shipped it as the closer for the
   * frozen-column class, and round 27's finding 1 landed one commit later on a column it had
   * measured and passed — because the attack was never a rewrite. It was a FILL: `resolvedById`
   * empty on an open request, given a value by a direct writer at a moment when nothing closed,
   * made permanent by the very one-way rule that protects it from being rewritten afterwards.
   *
   * A one-way rule is TWO rules, and they fail independently:
   *
   *   · "it may not be REWRITTEN once set"  — the arm above measures this.
   *   · "it may not be SET except by the act it describes" — nothing measured this.
   *
   * That second rule is where this unit has been caught three separate times: round 8's finding 5
   * (the birth set admitted NULL -> value on all six columns), round 16's finding 4 (the resolver
   * set was fillable on an open request, one column at a time), and now round 27's finding 1. An
   * instrument built after the third recurrence that still cannot see the axis is not an
   * instrument, and round 26's claim that no column could go unexamined was true only of the
   * question it happened to ask.
   *
   * So this arm plants the row EMPTY — only the columns the schema forces — and drives every
   * nullable column NULL -> value on an update that performs NO transition of any kind. Each
   * outcome is registered: REFUSED means the fill is bound to an act, and the fragment records
   * which seal said so; FILLABLE means a writer may supply it at any moment, and owes a reason
   * why doing so claims nothing about an act that did not happen.
   */
  type FillEntry = { refused: Record<string, string>; fillable: Record<string, string> };

  const FILL: Record<string, FillEntry> = {
    ChangeRequest: {
      refused: {
        requestedById: "phase6 4d-i: change request changerequest-probe records requestedById",
        requestedByName: "phase6 4d-i: change request changerequest-probe records requestedByNam",
        requestedByRole: "phase6 4d-i: change request changerequest-probe records requestedByRol",
        resolution: "phase6 4d-i: change request changerequest-probe gains resolver provena",
        resolvedAt: "phase6 4d-i: change request changerequest-probe gains resolver provena",
        resolvedByCommandId: "phase6 4d-i: change request changerequest-probe gains resolver provena",
        resolvedById: "phase6 4d-i: change request changerequest-probe gains resolver provena",
        resolvedByName: "phase6 4d-i: change request changerequest-probe gains resolver provena",
        resolvedByRole: "phase6 4d-i: change request changerequest-probe gains resolver provena",
        revisionId: "phase6 4d-i: change request changerequest-probe is evidence",
        sourceCommandId: "phase6 4d-i: change request changerequest-probe records sourceCommandI",
      },
      fillable: {
      },
    },
    Decision: {
      refused: {
        approvedDeciderKind: "phase6-4b: approval attribution may first be written only by an approv",
        approvedDeciderLabel: "violates check constraint",
        approvedDeciderMembershipId: "violates check constraint",
        authorId: "phase6-4b: decision authorship is frozen from birth",
        deciderMembershipId: "phase6-4b: a published or attributed decision keeps its holder",
        nodeId: "violates foreign key constraint",
        withdrawReason: "phase6-t4a: withdrawal evidence may exist only on a withdrawn decision",
        withdrawnAt: "phase6-t4a: withdrawal evidence may exist only on a withdrawn decision",
        withdrawnById: "phase6-t4a: withdrawal evidence may exist only on a withdrawn decision",
        withdrawnByName: "phase6-t4a: withdrawal evidence may exist only on a withdrawn decision",
      },
      fillable: {
        ageDays:
          "a derived display counter computed from `date`; supplying it asserts nothing about any act",
        approvedById:
          "a delivered denormalisation the approval transition writes; the attributable record is `DecisionApprovalRevision`, whose birth this unit binds to the act",
        approvedOption:
          "a delivered denormalisation of the head revision's `optionKey`, written by the approval transition 4b judges",
        approver:
          "the delivered display label for the approval; the attributable record is the immutable revision register, which this unit freezes in full and whose own fill is bound to the approval",
        cost:
          "the decision's own content, supplied while it is a draft; 4b owns the draft/publish boundary",
        date:
          "the decision's own content, supplied while it is a draft; 4b owns the draft/publish boundary",
        material:
          "the decision's own content, supplied while it is a draft; 4b owns the draft/publish boundary and this unit states no rule about what a decision SAYS",
        onBehalfOf:
          "a delivered denormalisation of the head revision's `onBehalfOf`, written by the approval transition 4b judges",
        photoSwatch:
          "presentation of the decision's own content, supplied while it is a draft",
        publishedAt:
          "PUBLICATION is an act, and it is 4b's act \u2014 `Decision_t4d_entry_seal` and the delivered 4b seals judge the publish transition at the moment it happens. 4d-i adds no rule about it, so it must not refuse the write that performs it",
      },
    },
    DecisionApprovalRevision: {
      refused: {
        approvedById: "DecisionApprovalRevision is append-only apart from ONE transition: rev",
        approvedByName: "DecisionApprovalRevision is append-only apart from ONE transition: rev",
        approvedByRole: "DecisionApprovalRevision is append-only apart from ONE transition: rev",
        approvedFrom: "DecisionApprovalRevision is append-only apart from ONE transition: rev",
        onBehalfOf: "DecisionApprovalRevision is append-only apart from ONE transition: rev",
        sourceCommandId: "DecisionApprovalRevision is append-only apart from ONE transition: rev",
      },
      fillable: {
      },
    },
    DecisionConsultation: {
      refused: {
        requestedByName: "phase6-4c: DecisionConsultation is append-only evidence",
        requestedByRole: "phase6-4c: DecisionConsultation is append-only evidence",
      },
      fillable: {
      },
    },
    DecisionConsultationResponse: {
      refused: {
        recommendedOptionId: "phase6-4c: DecisionConsultationResponse is append-only evidence",
        respondedByName: "phase6-4c: DecisionConsultationResponse is append-only evidence",
        respondedByRole: "phase6-4c: DecisionConsultationResponse is append-only evidence",
      },
      fillable: {
      },
    },
    DecisionEvent: {
      refused: {
        actorId: "phase6 4d-i: DecisionEvent is the attributable audit register and is a",
        actorName: "phase6 4d-i: DecisionEvent is the attributable audit register and is a",
        actorRole: "phase6 4d-i: DecisionEvent is the attributable audit register and is a",
        payload: "phase6 4d-i: DecisionEvent is the attributable audit register and is a",
      },
      fillable: {
      },
    },
    DecisionForward: {
      refused: {
        fromDesignationMembershipId: "phase6 4d-i: DecisionForward is an append-only register and its rows a",
        toDesignationMembershipId: "phase6 4d-i: DecisionForward is an append-only register and its rows a",
      },
      fillable: {
      },
    },
    DomainEvent: {
      refused: {
        actorId: "DomainEvent is append-only: UPDATE is not permitted",
        actorName: "DomainEvent is append-only: UPDATE is not permitted",
        actorRole: "DomainEvent is append-only: UPDATE is not permitted",
        causedByEventId: "DomainEvent is append-only: UPDATE is not permitted",
        correlationId: "DomainEvent is append-only: UPDATE is not permitted",
        dispatchIntent: "DomainEvent is append-only: UPDATE is not permitted",
        payload: "DomainEvent is append-only: UPDATE is not permitted",
        siteId: "DomainEvent is append-only: UPDATE is not permitted",
        systemActor: "DomainEvent is append-only: UPDATE is not permitted",
      },
      fillable: {
      },
    },
    ExternalEffectCatalog: {
      refused: {
        audience: "phase6 4d-i: catalog entry `activity.completion_requested` at coverage",
        pushBody: "phase6 4d-i: catalog entry `activity.completion_requested` at coverage",
        pushFamily: "phase6 4d-i: catalog entry `activity.completion_requested` at coverage",
        pushRoles: "phase6 4d-i: catalog entry `activity.completion_requested` at coverage",
        retiredAt: "phase6 4d-i: catalog entry `activity.completion_requested` is retired",
      },
      fillable: {
      },
    },
    Membership: {
      refused: {
      },
      fillable: {
        approvalLimit:
          "an authority ceiling set when the member is given one; each approval is judged against the limit standing AT THE TIME and the revision register records that judgement immutably",
        discipline:
          "a member's trade, recorded when it becomes known; it attributes no act and no fact cites it",
      },
    },
    MembershipTransition: {
      refused: {
        fromRole: "phase6 4d-i: MembershipTransition membershiptransition-probe is immuta",
        fromStatus: "phase6 4d-i: MembershipTransition membershiptransition-probe is immuta",
      },
      fillable: {
      },
    },
    Notification: {
      refused: {
        eventId: "phase6 4d-i: notice notification-probe is bound to event <null> and ma",
        kind: "phase6 4d-i: notice notification-probe's kind",
      },
      fillable: {
        decisionId:
          "a LEGACY KINDLESS notice carries no event and records no act, so naming the decision it concerns claims nothing. It cannot become evidence afterwards either: `kind` is refused on the fill axis by the same seal, so a kindless row stays kindless, and a KINDED notice's `decisionId` is frozen from birth",
      },
    },
    ProjectUserStanding: {
      refused: {
        membershipId: "phase6 4d-i: ProjectUserStanding is a platform REGISTER projected from",
      },
      fillable: {
      },
    },
    User: {
      refused: {
      },
      fillable: {
        email:
          "account contact detail, supplied by the account's owner; it attributes no act",
        emailVerifiedAt:
          "set when verification completes \u2014 the act it records IS this write, and it is the auth unit's act, not one this unit attributes",
        passwordHash:
          "a credential, set when the account gains one; freezing its first write would make password setup impossible",
        phone:
          "account contact detail, supplied by the account's owner; it attributes no act",
      },
    },
    // every column of DecisionCountersign is NOT NULL — there is nothing to fill later.
    DecisionCountersign: { refused: {}, fillable: {} },
    // every column of DecisionStrandedResolution is NOT NULL — there is nothing to fill later.
    DecisionStrandedResolution: { refused: {}, fillable: {} },
    // every column of DomainEventPairingClaim is NOT NULL — there is nothing to fill later.
    DomainEventPairingClaim: { refused: {}, fillable: {} },
    // every column of OrgMembership is NOT NULL — there is nothing to fill later.
    OrgMembership: { refused: {}, fillable: {} },
    // every column of OrgUserAuthority is NOT NULL — there is nothing to fill later.
    OrgUserAuthority: { refused: {}, fillable: {} },
    // every column of ProjectEventStream is NOT NULL — there is nothing to fill later.
    ProjectEventStream: { refused: {}, fillable: {} },
    // every column of ProjectOrg is NOT NULL — there is nothing to fill later.
    ProjectOrg: { refused: {}, fillable: {} },
    // every column of ProjectRoleStanding is NOT NULL — there is nothing to fill later.
    ProjectRoleStanding: { refused: {}, fillable: {} },
    // every column of ReleaseLease is NOT NULL — there is nothing to fill later.
    ReleaseLease: { refused: {}, fillable: {} },
    // every column of RolloutRetirement is NOT NULL — there is nothing to fill later.
    RolloutRetirement: { refused: {}, fillable: {} },
    // every column of UserIdentity is NOT NULL — there is nothing to fill later.
    UserIdentity: { refused: {}, fillable: {} },
  };

  it('round 27: every NULLABLE column is driven NULL to value at a moment that performs no act', () => {
    buildRun([]);

    const tablesQ = psql(RUN_DB, ['-At', '-c',
      `SELECT DISTINCT c.relname
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND t.tgname LIKE '%\\_t4d\\_%'
          AND (t.tgtype & 16) <> 0
        ORDER BY 1`]);
    expect(tablesQ.ok, `discovering the sealed tables failed:\n${tablesQ.output}`).toBe(true);
    const tables = tablesQ.output.split('\n').map((x) => x.trim()).filter(Boolean);
    expect(tables.slice().sort(),
      'a table gained (or lost) an UPDATE-firing t4d seal and the fill register did not move with it')
      .toEqual(Object.keys(FILL).sort());

    const unclassified: string[] = [];
    const wrong: string[] = [];

    for (const table of tables) {
      const entry = FILL[table]!;

      // TWO lists, and they are not the same list. The PLANTER needs every column of the table —
      // it decides for itself which ones the schema forces — while the PROBE walks only the
      // nullable ones. Handing the planter the nullable subset made it find nothing it was
      // allowed to plant and report six tables unmeasurable, `ChangeRequest` among them.
      const allQ = psql(RUN_DB, ['-At', '-F', '~', '-c',
        `SELECT column_name, data_type, udt_name, is_nullable
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = '${table}'
          ORDER BY ordinal_position`]);
      expect(allQ.ok, `reading the columns of ${table} failed:\n${allQ.output}`).toBe(true);
      const rows = allQ.output.split('\n').map((l) => l.trim()).filter(Boolean)
        .map((l) => l.split('~') as [string, string, string, string]);
      const allCols = rows.map(([c, d, u]) => [c, d, u] as [string, string, string]);
      const cols = rows.filter((r) => r[3] === 'YES').map(([c, d, u]) => [c, d, u] as [string, string, string]);
      if (cols.length === 0) continue;   // every column forced: nothing can be filled later

      const probe = probeRowWhere(table, allCols, 'minimal');
      if ('failed' in probe) {
        unclassified.push(`${table}: NOT MEASURED — ${probe.failed}`);
        continue;
      }
      const { where } = probe;

      for (const [col, dataType, udt] of cols) {
        const value = otherValue(col, dataType, udt);
        if (value === null) {
          unclassified.push(`${table}.${col}: no probe value exists for type ${dataType} (${udt})`);
          continue;
        }
        // the update touches ONE column and nothing else — no status moves, no act occurs. A
        // column the unit lets through here is one a writer may fill whenever it likes.
        const r = psql(RUN_DB, ['-c',
          `BEGIN; UPDATE "${table}" SET "${col}" = ${value} WHERE ${where}; ROLLBACK;`]);

        const declaredRefusal = entry.refused[col];
        const declaredFillable = entry.fillable[col];
        if (declaredRefusal === undefined && declaredFillable === undefined) {
          unclassified.push(`${table}.${col}: ${r.ok ? 'FILLABLE' : `REFUSED — ${unquoted(firstLine(r.output))}`}`);
          continue;
        }
        if (declaredRefusal !== undefined && declaredFillable !== undefined) {
          wrong.push(`${table}.${col} is declared BOTH refused and fillable`);
          continue;
        }
        if (declaredFillable !== undefined) {
          if (declaredFillable.trim().length < 20) {
            wrong.push(`${table}.${col} is declared fillable with no real reason — the reason has to `
              + 'say why supplying it later claims nothing about an act that did not happen');
          } else if (!r.ok) {
            wrong.push(`${table}.${col} is declared FILLABLE and was refused:\n  ${firstLine(r.output)}`);
          }
          continue;
        }
        if (r.ok) {
          wrong.push(`${table}.${col} is declared REFUSED and the fill was ACCEPTED — the column can `
            + 'be given a value at a moment that performs no act, and the one-way rule then makes it permanent');
        } else if (!unquoted(r.output).includes(unquoted(declaredRefusal))) {
          wrong.push(`${table}.${col} was refused, but not for the reason the register records. `
            + `Expected the message to carry ${JSON.stringify(declaredRefusal)}; got:\n  ${firstLine(r.output)}`);
        }
      }
    }

    expect(unclassified,
      'these NULLABLE columns are in no class. Each is either bound to the act that fills it, or a '
      + 'deliberate exception that owes a reason. This is the axis rounds 8, 16 and 27 were each '
      + 'caught on, and the axis the frozen-column arm above cannot see.')
      .toEqual([]);
    expect(wrong, 'the fill register disagrees with what the database actually did').toEqual([]);
  }, 600_000);

  /**
   * #582's review round 31 — THE LIFECYCLE, AND A GATE THAT CHECKS WHAT.
   *
   * Round 30 put two rules about WHAT a closure says inside the branch governing WHEN its values
   * may be written, and Codex found three holes in that one placement. The rules now sit at
   * function level as a state machine, and this arm drives every edge of it — including the ones
   * that must still be ADMITTED, because a seal that refuses the product is not a fix.
   */
  it('round 31: a request has three states and two legal moves, and a gated write must be true', () => {
    const CLOSE = (status: string, resolution: string | null, at: string | null, by = `'ss-user'`) => `
      UPDATE "ChangeRequest"
         SET "status" = '${status}'
           , "resolution" = ${resolution === null ? 'NULL' : `'${resolution}'`}
           , "resolvedAt" = ${at ?? 'NULL'}
           , "resolvedById" = ${by}
       WHERE "id" = 'ss-cr-r26'`;

    // ── the two legal moves still close, first ──────────────────────────────────────────────
    for (const [status, resolution] of [['resolved', 'reapproved'], ['withdrawn', 'withdrawn']]) {
      buildRun([]);
      { const r = psql(RUN_DB, ['-c', CR_OPEN]); expect(r.ok, r.output).toBe(true); }
      const ok = psql(RUN_DB, ['-c', CLOSE(status!, resolution!, 'now()')]);
      expect(ok.ok, `the deployed release closes as \`${status}\`/\`${resolution}\` and must still `
        + `be admitted:\n${ok.output}`).toBe(true);
    }

    // ── (F1) CLOSED IS TERMINAL — the hole round 30's placement left ─────────────────────────
    // A status-only update touches no resolver column, so round 30's clauses never ran.
    buildRun(['ChangeRequest_t4d_evidence_frozen']);
    { const r = psql(RUN_DB, ['-c', CR_OPEN]); expect(r.ok, r.output).toBe(true); }
    expect(psql(RUN_DB, ['-c', CLOSE('resolved', 'reapproved', 'now()')]).ok).toBe(true);
    const reopenStripped = psql(RUN_DB, ['-c',
      `UPDATE "ChangeRequest" SET "status" = 'open' WHERE "id" = 'ss-cr-r26'`]);
    expect(reopenStripped.ok,
      `with the freeze stripped a closed request must be reopenable:\n${reopenStripped.output}`).toBe(true);

    buildRun([]);
    { const r = psql(RUN_DB, ['-c', CR_OPEN]); expect(r.ok, r.output).toBe(true); }
    expect(psql(RUN_DB, ['-c', CLOSE('resolved', 'reapproved', 'now()')]).ok).toBe(true);
    for (const to of ['open', 'withdrawn']) {
      const moved = psql(RUN_DB, ['-c',
        `UPDATE "ChangeRequest" SET "status" = '${to}' WHERE "id" = 'ss-cr-r26'`]);
      expect(moved.ok, `a closed request may not become \`${to}\``).toBe(false);
      expect(moved.output).toMatch(/is already closed as/);
    }

    // ── (F3) THE CORE SET IS COMPLETE ───────────────────────────────────────────────────────
    // Each of these was admitted by round 30 and is UNREPAIRABLE once it lands, because the
    // one-way arms refuse to fill the missing column after the row leaves `open`.
    const INCOMPLETE: [string, string, RegExp][] = [
      ['no outcome', CLOSE('resolved', null, 'now()'), /is not a closure this system performs/],
      ['no moment', CLOSE('resolved', 'reapproved', null), /does not say WHEN it happened/],
      // refused by the pre-existing provenance clause rather than the completeness one, because
      // the fill branch reaches it first. The PROPERTY is what this arm asserts — an incomplete
      // closure does not commit — and which of this unit's own clauses says so is not something
      // the arm should pin, exactly as round 29 had to learn for `User.id`.
      ['no resolver', CLOSE('resolved', 'reapproved', 'now()', 'NULL'),
        /who closed it|resolver provenance with no/],
    ];
    for (const [what, sql, message] of INCOMPLETE) {
      buildRun([]);
      { const r = psql(RUN_DB, ['-c', CR_OPEN]); expect(r.ok, r.output).toBe(true); }
      const r = psql(RUN_DB, ['-c', sql]);
      expect(r.ok, `a closure with ${what} must be refused, not frozen incomplete`).toBe(false);
      expect(r.output).toMatch(message);
    }

    // the contradictory pair, still
    buildRun([]);
    { const r = psql(RUN_DB, ['-c', CR_OPEN]); expect(r.ok, r.output).toBe(true); }
    const contradiction = psql(RUN_DB, ['-c', CLOSE('resolved', 'withdrawn', 'now()')]);
    expect(contradiction.ok, 'a status its own outcome denies must be refused').toBe(false);
    expect(contradiction.output).toMatch(/is not a closure this system performs/);

    // ── (F2) THE MOMENT IS THIS TRANSACTION'S ───────────────────────────────────────────────
    // Round 30 bounded this below by `createdAt`, so a long-open request could be closed with any
    // fabricated point in its own open life. `ss-cr-r26` is opened in the same test, so the
    // fabricated August is modelled by a moment well inside the request's life but not now.
    buildRun([]);
    { const r = psql(RUN_DB, ['-c', CR_OPEN]); expect(r.ok, r.output).toBe(true); }
    for (const at of [`now() - interval '2 hours'`, `now() + interval '30 days'`]) {
      const r = psql(RUN_DB, ['-c', CLOSE('withdrawn', 'withdrawn', at)]);
      expect(r.ok, `a closure stamped ${at} is not this transaction's closure`).toBe(false);
      expect(r.output).toMatch(/but this closing transaction is running at/);
    }
    // and the skew a real writer has is still admitted, in both directions
    for (const at of [`now() - interval '5 seconds'`, `now() + interval '5 seconds'`]) {
      buildRun([]);
      { const r = psql(RUN_DB, ['-c', CR_OPEN]); expect(r.ok, r.output).toBe(true); }
      const r = psql(RUN_DB, ['-c', CLOSE('withdrawn', 'withdrawn', at)]);
      expect(r.ok, `an honest writer's clock skew (${at}) must be admitted:\n${r.output}`).toBe(true);
    }

    // ── (F4) A GATED WRITE MUST BE TRUE OF ITS SOURCE ───────────────────────────────────────
    // The flag authorises the writer. It never said the row is true of the orgs table the
    // register mirrors, so a re-used gated statement could forge standing the seals then trust.
    buildRun([]);
    const forge = (guc: string) => `
      BEGIN;
      SELECT set_config('${guc}', 'on', true);
      INSERT INTO "ProjectUserStanding" ("projectId","userId","role","membershipId")
        VALUES ('ss-proj','ss-client','architect','ss-mem-c');
      COMMIT;`;
    for (const guc of ['vitan.phase6_4d_standing_backfill', 'vitan.phase6_4d_standing_reprojection']) {
      const r = psql(RUN_DB, ['-c', forge(guc)]);
      expect(r.ok, `\`${guc}\` must not admit a standing row no Membership supports`).toBe(false);
      expect(r.output).toMatch(/writes a row the orgs tables do not support|is fenced to/);
    }
    // and the backfill gate is INSERT-only: a correction is not a backfill
    const correct = psql(RUN_DB, ['-c', `
      BEGIN;
      SELECT set_config('vitan.phase6_4d_standing_backfill', 'on', true);
      UPDATE "UserIdentity" SET "displayName" = 'Forged' WHERE "userId" = 'ss-user';
      COMMIT;`]);
    expect(correct.ok, 'the backfill gate admits INSERT only').toBe(false);
    expect(correct.output).toMatch(/admits INSERT only/);
  }, 600_000);
});
