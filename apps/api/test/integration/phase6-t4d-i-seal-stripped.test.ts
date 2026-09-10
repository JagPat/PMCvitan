import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

const MIGRATION = join(
  __dirname, '..', '..', 'prisma', 'migrations',
  '20271220000000_phase6_t4d_i_dark_migration', 'migration.sql',
);
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'prisma', 'migrations');
const UNIT_DIR = '20271220000000_phase6_t4d_i_dark_migration';

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
function stripSeal(sql: string, name: string): string {
  const re = new RegExp(`(^[ \\t]*)CREATE (?:CONSTRAINT )?TRIGGER "${name}"[\\s\\S]*?;`, 'gm');
  const matches = sql.match(re);
  if (matches !== null) {
    expect(matches, `"${name}" must be created exactly once for the strip to mean anything`).toHaveLength(1);
    return sql.replace(re, (_m, indent: string) => (indent.length > 0 ? `${indent}NULL;` : ''));
  }
  const table = name.replace(/_t4d_.*$/, '');
  const suffix = name.slice(table.length);
  expect(
    sql.includes(`t || '${suffix}'`),
    `"${name}" appears in the migration neither as a literal CREATE nor as a loop over '${suffix}' — `
    + 'the strip would omit nothing and the arm would be a tautology',
  ).toBe(true);
  return `${sql}\n-- seal-stripped harness: this ONE named object omitted\nDROP TRIGGER "${name}" ON "${table}";\n`;
}

/** Build a scratch database at the point BEFORE this unit's migration. */
function buildBase(): void {
  psql('postgres', ['-c', `DROP DATABASE IF EXISTS "${BASE_DB}" WITH (FORCE)`]);
  const created = psql('postgres', ['-c', `CREATE DATABASE "${BASE_DB}"`]);
  expect(created.ok, created.output).toBe(true);
  for (const dir of readdirSync(MIGRATIONS_DIR).filter((d) => d !== UNIT_DIR && !d.endsWith('.toml')).sort()) {
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

  let sql = readFileSync(MIGRATION, 'utf8');
  for (const name of strip) sql = stripSeal(sql, name);
  const file = join(tmp, 'migration.sql');
  writeFileSync(file, sql);
  const applied = psql(RUN_DB, ['-f', file]);
  expect(
    applied.ok,
    `the ${strip.length === 0 ? 'whole' : `${strip.join('+')}-stripped`} migration must APPLY:\n${applied.output}`,
  ).toBe(true);

  for (const name of strip) {
    const present = psql(RUN_DB, ['-t', '-A', '-c',
      `SELECT count(*) FROM pg_trigger WHERE tgname = '${name}' AND NOT tgisinternal`]);
    expect(present.output.trim(), `"${name}" must be ABSENT from the stripped database`).toBe('0');
  }

  const fx = psql(RUN_DB, ['-c', FIXTURE]);
  expect(fx.ok, `the world every arm writes against must plant cleanly:\n${fx.output}`).toBe(true);
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
   WHERE s."projectId" = 'ss-proj' AND c."effectKey" = 'decision.published';
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
    // to countersign). Both are 4d-i's; the door is the one whose message the whole run returns,
    // because a BEFORE trigger fires in NAME order and `_awaiting_` precedes `_entry_`.
    alsoStrip: ['Decision_t4d_entry_seal'],
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
               WHERE s."projectId" = 'ss-proj' AND c."effectKey" = 'decision.drafted';
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
               WHERE s."projectId" = 'ss-proj' AND c."effectKey" = 'decision.published';
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
               WHERE s."projectId" = 'ss-proj' AND c."effectKey" = 'decision.approved';
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
    seal: 'ChangeRequest_t4d_evidence_frozen',
    what: 'a written command receipt cannot be CLEARED off a change request',
    // #582 round 3, finding 4 — the delivered `ChangeRequest_t4b2_seal` freezes `decisionId`
    // alone, and it is a MERGED migration, so every evidence column this unit adds arrived with
    // no freeze. The NULLing is the shape P33 names: the row keeps saying a request was raised
    // and stops saying which command raised it, and 4d-iii then seals that.
    hostile: `INSERT INTO "ChangeRequest" ("id","decisionId","reason","costImpact","timeImpactDays","status","sourceCommandId")
              VALUES ('ss-cr-ev','ss-dec','x',0,0,'withdrawn','ss-cmd');
              UPDATE "ChangeRequest" SET "sourceCommandId" = NULL WHERE "id" = 'ss-cr-ev'`,
    refusal: /may not be replaced or cleared/,
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
];

/**
 * Seals NOT individually stripped, each with the arm whose MECHANISM it shares. Every entry is a
 * seal that is the SAME plpgsql function as its representative, installed on a sibling table by
 * the same loop or the same paragraph of the migration — so stripping it would re-measure a
 * function this suite already measured. A seal with its OWN body does not belong here.
 */
const COVERED_BY_CLASS: Record<string, string> = {
  // platform_t4d_register_no_truncate — one function, many registers
  ChangeRequest_t4d_no_truncate: 'ExternalEffectCatalog_t4d_no_truncate',
  DecisionCountersign_t4d_no_truncate: 'ExternalEffectCatalog_t4d_no_truncate',
  DecisionForward_t4d_no_truncate: 'ExternalEffectCatalog_t4d_no_truncate',
  DecisionStrandedResolution_t4d_no_truncate: 'ExternalEffectCatalog_t4d_no_truncate',
  DomainEventPairingClaim_t4d_no_truncate: 'ExternalEffectCatalog_t4d_no_truncate',
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
  Notification_t4d_binding: 'Notification_t4d_no_truncate',
  Notification_t4d_binding_bound: 'Notification_t4d_no_truncate',
  // seals whose subject is a 4d-ii/4d-iii SERVICE path — unreachable while the doors stand, so
  // their hostile write cannot be constructed on a 4d-i database at all. They are proven by the
  // integration suite driving the delivered writers, and by 4d-ii's own probes.
  Decision_t4d_holder_standing: 'Decision_t4d_awaiting_reserved',
  Membership_t4d_holder_guard: 'Membership_t4d_architect_reserved',
  MembershipTransition_t4d_append_only: 'DecisionForward_t4d_reserved',
  MembershipTransition_t4d_provenance_bound: 'DecisionForward_t4d_reserved',
  MembershipTransition_t4d_seal: 'DecisionForward_t4d_reserved',
  DecisionApprovalRevision_t4d_birth: 'Decision_t4d_awaiting_reserved',
  DecisionApprovalRevision_t4d_one_flip: 'Decision_t4d_awaiting_reserved',
  DecisionApprovalRevision_t4d_flip_paired: 'Decision_t4d_awaiting_reserved',
  DecisionConsultation_t4d_attribution: 'Decision_t4d_awaiting_reserved',
  DecisionConsultationResponse_t4d_attribution: 'Decision_t4d_awaiting_reserved',
  DecisionEvent_t4d_correspondence: 'DecisionEvent_t4d_append_only',
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

  it('every installed _t4d_ seal is either stripped by an arm or declared covered by its class', () => {
    buildRun([]);
    const listed = psql(RUN_DB, ['-t', '-A', '-c',
      `SELECT tgname FROM pg_trigger WHERE tgname LIKE '%\\_t4d\\_%' AND NOT tgisinternal ORDER BY 1`]);
    expect(listed.ok, listed.output).toBe(true);
    const installed = listed.output.trim().split('\n').filter(Boolean);
    expect(installed.length, 'the unit installs a substantial inventory; an empty read is a broken query')
      .toBeGreaterThan(60);

    const stripped = new Set(ARMS.flatMap((a) => [a.seal, ...(a.alsoStrip ?? [])]));
    const undeclared = installed.filter((n) => !stripped.has(n) && !(n in COVERED_BY_CLASS));
    expect(
      undeclared,
      'these seals are installed by 4d-i and neither stripped by an arm here nor declared in '
      + 'COVERED_BY_CLASS with the arm that exercises their mechanism. A seal nobody can point at '
      + 'is a seal nobody proved.',
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
   */
  it('the migration is ONE transaction: a raise at the end leaves no object behind', () => {
    psql('postgres', ['-c', `DROP DATABASE IF EXISTS "${RUN_DB}" WITH (FORCE)`]);
    const created = psql('postgres', ['-c', `CREATE DATABASE "${RUN_DB}" TEMPLATE "${BASE_DB}"`]);
    expect(created.ok, created.output).toBe(true);

    const sql = readFileSync(MIGRATION, 'utf8');
    expect(sql.includes('\nBEGIN;\n'), 'the migration must open its own transaction').toBe(true);
    expect(sql.trimEnd().endsWith('COMMIT;'), 'the migration must close its own transaction').toBe(true);

    // the raise goes BEFORE the COMMIT, so everything above it has already run
    const poisoned = sql.replace(
      /COMMIT;\s*$/,
      "DO $probe$ BEGIN RAISE EXCEPTION 'seal-stripped harness: atomicity probe'; END $probe$;\nCOMMIT;\n",
    );
    const file = join(tmp, 'atomicity.sql');
    writeFileSync(file, poisoned);
    const applied = psql(RUN_DB, ['-f', file]);
    expect(applied.ok, 'the poisoned apply must FAIL — otherwise the probe measured nothing').toBe(false);
    expect(applied.output).toMatch(/atomicity probe/);

    // and nothing it created survives
    const left = psql(RUN_DB, ['-t', '-A', '-c',
      `SELECT (SELECT count(*) FROM pg_trigger WHERE tgname LIKE '%\\_t4d\\_%' AND NOT tgisinternal)
            + (SELECT count(*) FROM pg_class WHERE relname IN ('RolloutRetirement','ExternalEffectCatalog','ReleaseLease','MembershipTransition','DomainEventPairingClaim'))
            + (SELECT count(*) FROM pg_proc WHERE proname LIKE 'phase6\\_t4d\\_%')`]);
    expect(left.ok, left.output).toBe(true);
    expect(
      left.output.trim(),
      'the failed apply left objects behind — the unit is NOT atomic, and §P6T4D\'s recovery would '
      + 'be telling an operator something untrue',
    ).toBe('0');
  }, 180_000);

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
    const again = psql(RUN_DB, ['-f', MIGRATION]);
    expect(again.ok, `after the named repair the apply must succeed:\n${again.output}`).toBe(true);
  }, 180_000);
});
