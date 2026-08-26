import type { PrismaClient } from '@prisma/client';

/**
 * SCHEMA ENFORCEMENT — does every guard this database carries actually BITE?
 *
 * WHY THIS IS NOT A LINTER. Two predecessors (PRs #423 and #430) tried to state one invariant —
 * *a migration that verifies a prerequisite object must verify the object ENFORCES, not merely that
 * it EXISTS* — by STATICALLY ANALYSING migration SQL. Across four rounds they drew sixteen findings
 * of a single shape: a check narrower than the object it judges. The last round made the ceiling
 * explicit rather than incidental — to know a guard CONCLUDES correctly you need its polarity and
 * how its caller uses the result, which is control-flow analysis of arbitrary PL/pgSQL. That is not
 * a bug to fix; it is the wrong question. Source text is evidence ABOUT a database. This unit asks
 * the database.
 *
 * The class of defect cannot recur here. There is no rule engine, no corpus, no exemption ledger,
 * no parse tree, and nothing to keep in step with a migration's wording — a guard written in a
 * shape nobody anticipated, in dynamic SQL, in a SQL-language helper, or in no migration at all,
 * lands in `pg_trigger` and `pg_constraint` like every other, and is judged there.
 *
 * ─── THE INVARIANT, STATED TOTALLY ──────────────────────────────────────────────────────────────
 *
 * Not a list of expected objects. Enumeration is the defect that killed both predecessors: a list
 * is only ever as complete as the day it was written, and a checker that asks about ten named
 * foreign keys says nothing about the eleventh. These are two closed properties of the WHOLE
 * application schema, universally quantified over whatever that schema happens to contain:
 *
 *   1. NO TRIGGER IS DISABLED.  This repository's design is DB-enforced seals — append-only
 *      triggers, frozen-column triggers, constraint triggers that re-derive a conservation rule at
 *      commit. A trigger that does not fire is not a weaker seal; it is no seal. So a disabled
 *      trigger is ALWAYS wrong at rest, and the property needs no exceptions.
 *
 *      The apparent exceptions are deliberate and are a FEATURE, not a false positive. EVERY path in
 *      this repository that disables a trigger does so inside ONE transaction and re-enables it
 *      before commit — VERIFIED by reading each, not assumed:
 *
 *        · the T45, T2C and T3C repair engines disable named `*_append_only` triggers to apply an
 *          operator's plan, then re-enable them and ASSERT the full immutability set is enabled,
 *          all inside `prisma.$transaction` (t45-repair.service.ts:186-201, t2c:218-231,
 *          t3c:940-959);
 *        · `prisma/seed.ts` disables two named seals for its sanctioned destructive wipe, inside
 *          `prisma.$transaction([…])` (seed.ts:63-80 and 116-147), and says so in its own comment;
 *        · migrations 20261222 / 20261224 / 20270420 disable a frozen-column trigger to rewrite a
 *          snapshot and re-enable it in the same file, which `prisma migrate deploy` runs in a
 *          transaction.
 *
 *      DDL is transactional in PostgreSQL, so a rollback undoes the DISABLE too, and the ACCESS
 *      EXCLUSIVE lock the ALTER takes means a concurrent reader sees the pre-transaction state. This
 *      check runs BEFORE Prisma and AFTER a completed deploy, never during one. So no committed
 *      database is ever legitimately at rest with a trigger off — and a database left dirty by an
 *      aborted repair, seed or restore is exactly what this catches.
 *
 *   2. NO FOREIGN KEY IS UNVALIDATED.  `NOT VALID` means existing rows were never checked, so the
 *      key's promise is retroactively untrue however well it behaves from now on.
 *
 * ─── `tgenabled`: THE EXACT POINT THE LAST ROUND FAILED ON ──────────────────────────────────────
 *
 * The column holds one of four states, and the mistake is to treat it as a set to be compared
 * against rather than a question with a right answer. Codex's final P1 on #430 was precisely that:
 * a check that accepted a comparison with ANY member of `D`/`R`/`O`/`A` — so a guard testing
 * `tgenabled = 'D'` satisfied it.
 *
 *   O  origin    fires on an ordinary connection            ENFORCING
 *   A  always    fires regardless of session_replication_role ENFORCING
 *   D  disabled  never fires                                 NOT ENFORCING
 *   R  replica   fires ONLY when session_replication_role = 'replica'
 *                — so on an ordinary application connection it does NOT fire   NOT ENFORCING
 *
 * `R` is the state that makes this a question and not a formality: it LOOKS enabled, it is not `D`,
 * and it is silently inert for every connection the application ever opens. MEASURED on PG 16.13:
 * a constraint trigger whose body unconditionally raises was set to `R`, and an INSERT that must
 * have raised committed silently; the same trigger returned to `O` raised as written. So the
 * predicate below is stated positively — ENFORCING ⟺ `O` OR `A` — and everything else is a
 * finding. There is no membership test anywhere in this file.
 *
 * ─── WHAT IS COVERED, AND WHY IT IS MORE THAN THE USER TRIGGERS ─────────────────────────────────
 *
 * A foreign key is not a flag on a table; it is IMPLEMENTED as internal `RI_ConstraintTrigger`
 * rows (MEASURED: 4 per key on PG 16), reached from the constraint through `tgconstraint`. This is
 * why clause 2 alone would be a check narrower than the object it judges — the same defect shape,
 * one level down. MEASURED: `ALTER TABLE child DISABLE TRIGGER ALL` set the key's internal triggers
 * to `D`, an INSERT of an orphaned row COMMITTED, and `pg_constraint.convalidated` stayed `true`
 * throughout. The catalog row that says the key is valid is not the thing that enforces it.
 *
 * So every trigger in the application schema is judged, by one query, with no regard to what kind
 * it is: internal RI triggers behind foreign keys, user `CREATE TRIGGER` seals, and user
 * `CREATE CONSTRAINT TRIGGER` seals (the shape `20270920000000_decision_option_kinds` installs,
 * which no `migrate.sh` check previously covered at all). Each finding is ATTRIBUTED — an internal
 * trigger is reported as the foreign key it implements, because "RI_ConstraintTrigger_c_24644 is
 * disabled" is not something an operator can act on.
 *
 * ─── CLAUSE 3: PRESENCE, NOT ONLY STATE — THE SAME DEFECT SHAPE ONE LEVEL DOWN AGAIN ────────────
 *
 * Clauses 1 and 2 judge the STATE of objects that EXIST. Absence is a failure mode neither can see,
 * and absence permits exactly the writes they refuse. MEASURED on PG 16.13: with one referencing-side
 * `RI_FKey_check_ins` trigger removed from `pg_trigger` by catalog surgery — what a partial restore
 * or a hand repair amounts to, and the only way this arises, since PostgreSQL refuses `DROP TRIGGER`
 * on an internal one — an INSERT of an orphaned row COMMITTED, `convalidated` stayed `true`, AND
 * CLAUSE 1 REPORTED NOTHING, because the two surviving triggers were both `O`.
 *
 * So each key is correlated with its REQUIRED inventory, MEASURED rather than assumed. A key between
 * two ORDINARY tables is exactly FOUR internal row triggers, in four fixed SLOTS:
 *
 *   on the REFERENCING table   an INSERT row trigger   and   an UPDATE row trigger
 *   on the REFERENCED  table   a  DELETE row trigger   and   an UPDATE row trigger
 *
 * The action only chooses which FUNCTION fills a parent-side slot (`RI_FKey_noaction_del`,
 * `_cascade_del`, `_setnull_del`, `_setdefault_del`, `_restrict_del`, and the `_upd` series) — never
 * how many slots there are. MEASURED across all 25 `ON DELETE` × `ON UPDATE` pairs, plus a
 * self-referential key (both sides one table), a composite key, a `MATCH FULL` key, a `DEFERRABLE
 * INITIALLY DEFERRED` key and a `NOT VALID` key: four every time. So the requirement is stated by
 * SLOT, and needs no table of action-to-function names to keep in step with.
 *
 * The slot must be filled by an ENFORCING trigger, which is why this is not clause 1 restated: a
 * trigger absent and a trigger present at `D` are the same physical fact — the slot does not fire —
 * and one predicate covers both. It also closes a hole clause 1 has by construction: clause 1 is
 * scoped by the TRIGGER'S table, so a key referencing a table in another schema had its parent-side
 * triggers outside the question; here they are reached through `tgconstraint` wherever they live.
 *
 * AND IT FAILS CLOSED. An enumeration treated as the whole is the defect that closed both
 * predecessors, so the shapes above are not a list of what to check — they are a list of what was
 * MEASURED, and anything outside it REFUSES. A key refuses when its action code is not one measured
 * here; when either participating relation is not an ordinary table (MEASURED: a PARTITIONED
 * participant produces a genuinely different inventory — a leaf partition's derived constraint
 * carries only the 2 referencing-side triggers, and a partitioned REFERENCED side splits the
 * parent-side slots one pair per partition); or when it is a derived constraint (`conparentid <> 0`)
 * rather than one an operator declared. No such key exists in this schema — all 387 are ordinary,
 * non-derived and four-triggered — and if one appears, the deploy stops and names it.
 */

/** ENFORCING ⟺ `O` (origin) or `A` (always). Stated once, positively, and nowhere else. */
export const ENFORCING_TRIGGER_STATES = ['O', 'A'] as const;

/**
 * …AND ONLY IF THE SESSION IS IN AN ENFORCING ROLE. Firing is a property of `tgenabled` RELATIVE to
 * `session_replication_role`, so the clause above is half a question until this one is asked.
 * MEASURED on PG 16.13 with an `O` seal that raises and a key whose internal RI triggers are `O`:
 * under `origin` and under `local` the seal raised and the orphan was REFUSED — under `replica` the
 * seal was INERT and THE ORPHAN COMMITTED, while every trigger stayed `O` and the key stayed
 * `convalidated`, so clauses 1-3 see a perfect schema over a database that enforces nothing. The
 * check and the API share one `DATABASE_URL`: a role or database defaulted to `replica` is inert
 * for both. A role outside the two measured here REFUSES rather than passes.
 */
export const ENFORCING_SESSION_ROLES = ['origin', 'local'] as const;

const roleEnforces = (role: string): boolean => (ENFORCING_SESSION_ROLES as readonly string[]).includes(role);

/**
 * How many offending objects are PRINTED. Every one is COUNTED and returned; this bounds the
 * report, never the judgement. A restore that disabled one table's triggers produces dozens of
 * findings and an operator needs the shape of the damage, not the first row of it.
 */
export const SAMPLE_LIMIT = 25;

/**
 * THE APPLICATION RELATION UNIVERSE — stated once here, and derived from nowhere else.
 *
 * WHY THIS EXISTS. #436 and #437 drew FOUR review findings and every one was the same defect: a
 * clause whose reach was written as its own filter, so widening one left the others behind.
 * Excluded cross-schema parents, then a relkind filter that excluded foreign tables, then an
 * applicability count that still excluded them one level up. Each fix was correct and each exposed
 * the next seam, because there were four independent answers to "which relations does this check
 * judge?" — see docs/reviews/schema-enforcement-convergence.md.
 *
 * A relation is in the universe when it is IN the application schema, or when an application-schema
 * FOREIGN KEY REFERENCES it — clause 3 already judges a key by its whole implementation including
 * parent-side triggers that live elsewhere, so the parent is in scope for every clause or for none.
 *
 * THERE IS NO relkind FILTER, and that absence is the point. Foreign tables carry row triggers
 * (verified on PG16), views carry INSTEAD OF triggers, partitioned tables carry both. Every list of
 * "kinds that can be sealed" is a list that a later PostgreSQL outgrows, and enumerating them is
 * what produced findings 3 and 4. Membership is "PostgreSQL has a pg_class row for it here"; what
 * each clause ASKS of a member is driven by what that member actually HAS — triggers present, a
 * flag off, a constraint unvalidated — never by what kind it is. A relation with no triggers has
 * nothing to bypass and is simply never reported.
 */
const UNIVERSE = `
  WITH universe AS (
    SELECT oid, nspname, relname, bool_or(in_schema) AS in_schema
      FROM (
        SELECT c.oid, n.nspname, c.relname, true AS in_schema
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1
        UNION ALL
        SELECT f.oid, fn.nspname, f.relname, false
          FROM pg_constraint k
          JOIN pg_class c ON c.oid = k.conrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_class f ON f.oid = k.confrelid
          JOIN pg_namespace fn ON fn.oid = f.relnamespace
         WHERE n.nspname = $1 AND k.contype = 'f' AND k.confrelid <> 0
      ) u
     GROUP BY oid, nspname, relname
  )`;

export interface TriggerFinding {
  table: string;
  trigger: string;
  /** The raw `tgenabled` state, so the report says WHICH non-enforcing state was found. */
  state: string;
  /** `D` never fires; `R` fires only under `session_replication_role = 'replica'`. */
  why: string;
  /** For an internal RI trigger, the foreign key it implements — the object an operator acts on. */
  implements: string | null;
}

export interface ConstraintFinding {
  table: string;
  constraint: string;
}

/**
 * The referential-action codes `pg_constraint.confdeltype` / `confupdtype` hold, each MEASURED on
 * PG 16.13 to produce the same four-slot inventory. A code outside this map is a shape this file has
 * not measured, and is REFUSED rather than assumed to behave like these.
 */
export const MEASURED_REFERENTIAL_ACTIONS: Readonly<Record<string, string>> = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT',
};

/** MEASURED, not assumed: four slots, for every action pair, self-reference, MATCH FULL and DEFERRABLE. */
export const REQUIRED_RI_TRIGGERS = 4;

/** A foreign key whose internal implementation is incomplete, or whose shape was never measured. */
export interface ForeignKeyShapeFinding {
  table: string;
  constraint: string;
  /** What is wrong, in the terms an operator acts on. */
  why: string;
  /** Enforcing internal RI triggers actually attached to the constraint, against the required 4. */
  enforcingTriggers: number;
}

/**
 * A table PostgreSQL skips the triggers of, whatever those triggers' own states say.
 *
 * `pg_class.relhastriggers` is the executor's fast path: when it is false, the table's triggers are
 * NOT LOOKED UP AT ALL. Every row in `pg_trigger` survives, every `tgenabled` still reads `O`, and
 * clause 1 — which asks each trigger about itself — reports the table perfectly sealed. The seals
 * are simply never consulted.
 *
 * MEASURED against the merged check on live PG16 before this clause was written: with
 * `relhastriggers = false` on "DecisionOption", `enforcement verify` returned `ok: true,
 * enforcing: true`. That is the same shape as the defect this whole unit exists to refuse — a check
 * narrower than the object it judges — so it is stated as its own closed property rather than left
 * to clause 1, which structurally cannot see it.
 *
 * PostgreSQL maintains this flag itself, so at rest it is true for any table carrying a trigger. It
 * goes false through a direct catalog write (`allow_system_table_mods`), or a restore or replication
 * tool that rebuilds `pg_class` rows — the same provenance as the states the other clauses catch.
 */
export interface TriggerBypassFinding {
  /**
   * NOT always the application schema. A foreign key declared here may REFERENCE a table
   * elsewhere, and clause 3 already judges that table's parent-side RI triggers without a schema
   * filter — so a bypass there is exactly as invisible, and is scanned for the same reason.
   */
  schema: string;
  table: string;
  /** Triggers the table carries that PostgreSQL will not consult while the flag is false. */
  triggers: number;
  /**
   * A ready-to-run repair statement, quoted BY POSTGRESQL (`format('%I')` + `quote_literal`) rather
   * than by interpolating catalog text into SQL here. An identifier may legally contain a quote,
   * and a restored object name is exactly where an odd one turns up: interpolated raw, it produces
   * invalid SQL at best, and at worst terminates the literal so that an operator who copies the
   * advertised command runs a statement this file appended for them.
   */
  repair: string;
}

export interface EnforcementReport {
  schema: string;
  /** False only for a database with no application tables at all (fresh/empty). */
  applicable: boolean;
  note: string;
  enforcing: boolean;
  counts: { relations: number; triggers: number; foreignKeys: number };
  /** The live session's `session_replication_role`. `O` triggers are inert unless it enforces. */
  sessionReplicationRole: string;
  disabledTriggers: { total: number; sample: TriggerFinding[] };
  unvalidatedForeignKeys: { total: number; sample: ConstraintFinding[] };
  /** Clause 3: a key missing part of its internal implementation, or of an unmeasured shape. */
  incompleteForeignKeys: { total: number; sample: ForeignKeyShapeFinding[] };
  /** Clause 4: a table whose triggers PostgreSQL skips wholesale, regardless of their own states. */
  bypassedTables: { total: number; sample: TriggerBypassFinding[] };
}

/**
 * The schema Prisma is pointed at. Read from `DATABASE_URL`'s `schema` parameter exactly as Prisma
 * reads it, defaulting to `public`. It is reported in the JSON so an operator can SEE which schema
 * was judged: a checker that silently examined the wrong schema would report every database clean,
 * which is the one failure mode this must not have.
 */
export function applicationSchema(databaseUrl = process.env.DATABASE_URL ?? ''): string {
  try {
    const schema = new URL(databaseUrl).searchParams.get('schema');
    return schema && schema.trim() ? schema.trim() : 'public';
  } catch {
    return 'public';
  }
}

type Client = Pick<PrismaClient, '$queryRawUnsafe'>;

/**
 * Ask the live catalog. One statement per property, both scoped to the application schema by name
 * so system catalogs (`pg_catalog`, `information_schema`) and any other schema are outside the
 * question rather than filtered out of it.
 */
export async function checkEnforcement(prisma: Client, schema = applicationSchema()): Promise<EnforcementReport> {
  // Applicability, the trigger count and the key count all read the SAME universe, so none of them
  // can drift from the clauses below. `relations` counts only the members IN the schema: a parent in
  // another schema extends what the clauses REACH, and does not make an empty schema non-empty.
  const [{ relations, triggers, foreignKeys, role }] = await prisma.$queryRawUnsafe<
    Array<{ relations: number; triggers: number; foreignKeys: number; role: string }>
  >(
    `${UNIVERSE}
     SELECT
       current_setting('session_replication_role') AS "role",
       (SELECT count(*)::int FROM universe WHERE in_schema) AS "relations",
       (SELECT count(*)::int FROM pg_trigger t JOIN universe u ON u.oid = t.tgrelid) AS "triggers",
       (SELECT count(*)::int FROM pg_constraint k JOIN universe u ON u.oid = k.conrelid
         WHERE k.contype = 'f' AND u.in_schema) AS "foreignKeys"`,
    schema,
  );

  // A database with no application tables is not a database with intact seals — it is a database
  // with nothing to say. Reported as NOT APPLICABLE rather than clean, and the two callers in
  // migrate.sh then differ on what that means: before Prisma it passes (the migrations that build
  // the schema still have to run), after a successful deploy it is a failure.
  if (relations === 0) {
    return {
      schema,
      applicable: false,
      note: `schema "${schema}" contains no relations at all — fresh or empty database, nothing to verify`,
      enforcing: roleEnforces(role),
      counts: { relations, triggers, foreignKeys },
      sessionReplicationRole: role,
      disabledTriggers: { total: 0, sample: [] },
      unvalidatedForeignKeys: { total: 0, sample: [] },
      incompleteForeignKeys: { total: 0, sample: [] },
      bypassedTables: { total: 0, sample: [] },
    };
  }

  // CLAUSE 1. Every trigger, whatever kind. The predicate is `NOT (O or A)`, so `D` and `R` are
  // BOTH findings and any state PostgreSQL might add later is a finding too — the closed form of
  // the question, rather than a list of bad states that a new release could outgrow.
  const disabled = await prisma.$queryRawUnsafe<
    Array<{ table: string; trigger: string; state: string; internal: boolean; implements: string | null }>
  >(
    `${UNIVERSE}
     SELECT u.relname AS "table",
            t.tgname  AS "trigger",
            t.tgenabled::text AS "state",
            t.tgisinternal AS "internal",
            k.conname AS "implements"
       FROM pg_trigger t
       JOIN universe u ON u.oid = t.tgrelid
       LEFT JOIN pg_constraint k ON k.oid = t.tgconstraint
      WHERE NOT (t.tgenabled = 'O' OR t.tgenabled = 'A')
      ORDER BY u.nspname, u.relname, t.tgname`,
    schema,
  );

  // CLAUSE 4. Tables PostgreSQL skips the triggers of. Asked of the TABLE, because clause 1 asks
  // each trigger about itself and every one of them answers "enabled" while none of them runs.
  const bypassed = await prisma.$queryRawUnsafe<
    Array<{ schema: string; table: string; triggers: number; repair: string }>
  >(
    // NO relkind filter, deliberately. A FOREIGN TABLE (relkind 'f') carries row triggers and a
    // relhastriggers flag like any other relation — VERIFIED on PG16 rather than assumed — and so
    // do partitioned tables and views with INSTEAD OF triggers. Clause 1 judges a trigger wherever
    // it lives, so restricting this clause to ordinary tables would let a bypass on any other kind
    // through while clause 1 still read that trigger's tgenabled as enabled. The EXISTS on
    // pg_trigger is the only filter that matters: a relation with no triggers has nothing to skip.
    //
    // The scanned set matches CLAUSE 3's reach deliberately. A key declared in this schema is
    // judged by its WHOLE implementation, including the parent-side triggers on a referenced table
    // in another schema — so `relhastriggers = false` on that referenced table hides a bypass that
    // clause 3 then counts as four enforcing triggers, and a DELETE there can orphan a row while
    // this check reports `enforcing: true`. Scanning only `$1` would be narrower than the object
    // being judged, which is the defect this whole check exists to refuse.
    `${UNIVERSE}
     SELECT u.nspname AS "schema",
            u.relname AS "table",
            (SELECT count(*)::int FROM pg_trigger t WHERE t.tgrelid = u.oid) AS "triggers",
            quote_literal(format('%I.%I', u.nspname, u.relname)) AS "repair"
       FROM universe u
       JOIN pg_class c ON c.oid = u.oid
      WHERE NOT c.relhastriggers
        AND EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = u.oid)
      ORDER BY u.nspname, u.relname`,
    schema,
  );

  // CLAUSE 2. `NOT VALID` foreign keys. Kept even though clause 1 covers the disabled case,
  // because it is a different failure: the key fires from now on and never checked what is already
  // there. Both are "the catalog claims a guarantee the data does not have".
  const unvalidated = await prisma.$queryRawUnsafe<Array<{ table: string; constraint: string }>>(
    `SELECT c.relname AS "table", k.conname AS "constraint"
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND k.contype = 'f' AND NOT k.convalidated
      ORDER BY c.relname, k.conname`,
    schema,
  );

  // CLAUSE 3. Every foreign key's internal implementation is COMPLETE and firing. The four slots
  // are counted with the ENFORCING predicate applied, so an absent trigger and a trigger present at
  // `D` are one answer: the slot does not fire. The triggers are reached through `tgconstraint`
  // WITHOUT a schema filter — a key declared in this schema is judged by its whole implementation,
  // including a parent-side trigger that lives on a table somewhere else.
  const keys = await prisma.$queryRawUnsafe<
    Array<{
      table: string; constraint: string; upd: string; del: string;
      derived: boolean; childKind: string; parentKind: string;
      enforcing: number; insOnChild: number; updOnChild: number; delOnParent: number; updOnParent: number;
    }>
  >(
    `SELECT c.relname AS "table", k.conname AS "constraint",
            k.confupdtype::text AS "upd", k.confdeltype::text AS "del",
            (k.conparentid <> 0) AS "derived",
            c.relkind::text AS "childKind", f.relkind::text AS "parentKind",
            (SELECT count(*)::int FROM pg_trigger t
              WHERE t.tgconstraint = k.oid AND (t.tgenabled = 'O' OR t.tgenabled = 'A')) AS "enforcing",
            (SELECT count(*)::int FROM pg_trigger t
              WHERE t.tgconstraint = k.oid AND (t.tgenabled = 'O' OR t.tgenabled = 'A')
                AND t.tgrelid = k.conrelid  AND (t.tgtype::int & 1) = 1 AND (t.tgtype::int & 4)  = 4)  AS "insOnChild",
            (SELECT count(*)::int FROM pg_trigger t
              WHERE t.tgconstraint = k.oid AND (t.tgenabled = 'O' OR t.tgenabled = 'A')
                AND t.tgrelid = k.conrelid  AND (t.tgtype::int & 1) = 1 AND (t.tgtype::int & 16) = 16) AS "updOnChild",
            (SELECT count(*)::int FROM pg_trigger t
              WHERE t.tgconstraint = k.oid AND (t.tgenabled = 'O' OR t.tgenabled = 'A')
                AND t.tgrelid = k.confrelid AND (t.tgtype::int & 1) = 1 AND (t.tgtype::int & 8)  = 8)  AS "delOnParent",
            (SELECT count(*)::int FROM pg_trigger t
              WHERE t.tgconstraint = k.oid AND (t.tgenabled = 'O' OR t.tgenabled = 'A')
                AND t.tgrelid = k.confrelid AND (t.tgtype::int & 1) = 1 AND (t.tgtype::int & 16) = 16) AS "updOnParent"
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_class f ON f.oid = k.confrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND k.contype = 'f'
      ORDER BY c.relname, k.conname`,
    schema,
  );

  const keyFindings: ForeignKeyShapeFinding[] = [];
  for (const k of keys) {
    const at = { table: k.table, constraint: k.constraint, enforcingTriggers: Number(k.enforcing) };

    // UNMEASURED SHAPES REFUSE. Not "these are the interesting cases" — these are the cases the
    // four-slot inventory below was measured against, and a key outside them is judged by nothing.
    if (k.derived) {
      keyFindings.push({ ...at, why: 'a DERIVED constraint (conparentid <> 0) — its inventory is split across a partition hierarchy, a shape this check has not measured; refusing rather than judging it by a rule measured on ordinary keys' });
      continue;
    }
    if (k.childKind !== 'r' || k.parentKind !== 'r') {
      keyFindings.push({ ...at, why: `relkind ${JSON.stringify(k.childKind)} references relkind ${JSON.stringify(k.parentKind)} — the four-slot inventory was measured for ORDINARY tables only (a PARTITIONED participant splits the slots per partition); refusing` });
      continue;
    }
    // `Object.hasOwn`, not `in`: `in` walks the prototype chain, so a code of "constructor" or
    // "toString" would read as measured. The domain is a single char today and cannot produce one —
    // but a fail-closed test that has an exception for two strings is not fail-closed.
    if (!Object.hasOwn(MEASURED_REFERENTIAL_ACTIONS, k.upd) || !Object.hasOwn(MEASURED_REFERENTIAL_ACTIONS, k.del)) {
      keyFindings.push({ ...at, why: `ON UPDATE code ${JSON.stringify(k.upd)} / ON DELETE code ${JSON.stringify(k.del)} — at least one is not a referential action this check has measured; refusing` });
      continue;
    }

    // The MEASURED requirement. `enforcing !== 4` alone catches every removal, because the four
    // slots are distinct triggers; the per-slot predicates then SAY WHICH ONE, and pin the shape
    // against a key that somehow carries four triggers in the wrong places. For a SELF-referential
    // key both sides are one table, so its two UPDATE triggers satisfy both UPDATE slots — and the
    // count of four is what makes losing one of them a finding.
    const missing: string[] = [];
    if (k.insOnChild < 1) missing.push('the referencing-side INSERT check');
    if (k.updOnChild < 1) missing.push('the referencing-side UPDATE check');
    if (k.delOnParent < 1) missing.push(`the referenced-side DELETE action (ON DELETE ${MEASURED_REFERENTIAL_ACTIONS[k.del]})`);
    if (k.updOnParent < 1) missing.push(`the referenced-side UPDATE action (ON UPDATE ${MEASURED_REFERENTIAL_ACTIONS[k.upd]})`);

    if (missing.length > 0) {
      keyFindings.push({ ...at, why: `missing or not firing: ${missing.join(', ')} — the key is validated in the catalog and does not enforce` });
    } else if (Number(k.enforcing) !== REQUIRED_RI_TRIGGERS) {
      keyFindings.push({ ...at, why: `${k.enforcing} enforcing internal trigger(s), and PostgreSQL 16 implements this key with exactly ${REQUIRED_RI_TRIGGERS}` });
    }
  }

  const triggerFindings: TriggerFinding[] = disabled.map((row) => ({
    table: row.table,
    trigger: row.trigger,
    state: row.state,
    why:
      row.state === 'D'
        ? 'disabled — never fires'
        : row.state === 'R'
          ? "replica — fires ONLY when session_replication_role = 'replica', so it does NOT fire for the application"
          : `unrecognised tgenabled state ${JSON.stringify(row.state)} — not one of the enforcing states O or A`,
    implements: row.internal ? row.implements : null,
  }));

  return {
    schema,
    applicable: true,
    note: `schema "${schema}": ${triggers} triggers and ${foreignKeys} foreign keys over ${relations} `
      + 'relations (this schema, plus every relation its foreign keys reference)',
    enforcing: roleEnforces(role)
      && triggerFindings.length === 0 && unvalidated.length === 0 && keyFindings.length === 0
      && bypassed.length === 0,
    counts: { relations, triggers, foreignKeys },
    sessionReplicationRole: role,
    disabledTriggers: { total: triggerFindings.length, sample: triggerFindings.slice(0, SAMPLE_LIMIT) },
    unvalidatedForeignKeys: { total: unvalidated.length, sample: unvalidated.slice(0, SAMPLE_LIMIT) },
    incompleteForeignKeys: { total: keyFindings.length, sample: keyFindings.slice(0, SAMPLE_LIMIT) },
    bypassedTables: { total: bypassed.length, sample: bypassed.slice(0, SAMPLE_LIMIT) },
  };
}

/** The NAMED diagnostic: every offending object identified, with the count it was sampled from. */
export function summarizeEnforcement(report: EnforcementReport): string {
  const lines: string[] = [];
  const {
    disabledTriggers: dt, unvalidatedForeignKeys: fk, incompleteForeignKeys: ik, bypassedTables: bt,
  } = report;

  // First, because when it fires the three clauses below all read CLEAN and say nothing.
  if (!roleEnforces(report.sessionReplicationRole)) {
    lines.push(`NOT ENFORCING — this connection's session_replication_role is `
      + `${JSON.stringify(report.sessionReplicationRole)}, so every 'O' (origin) trigger is INERT for it, `
      + `INCLUDING the internal triggers implementing every foreign key. The API connects with the same `
      + `DATABASE_URL role, so its seals do not fire either — and the clauses below cannot see this, `
      + `because every trigger is present and enabled. Enforcing roles: ${ENFORCING_SESSION_ROLES.join(', ')}.`);
  }

  if (dt.total > 0) {
    lines.push(`NOT ENFORCING — ${dt.total} trigger(s) in schema "${report.schema}" do not fire:`);
    for (const f of dt.sample) {
      const attribution = f.implements
        ? ` [internal trigger implementing FOREIGN KEY "${f.implements}"]`
        : '';
      lines.push(`  ${report.schema}."${f.table}" trigger "${f.trigger}" tgenabled=${f.state} — ${f.why}${attribution}`);
    }
    if (dt.total > dt.sample.length) lines.push(`  … and ${dt.total - dt.sample.length} more (sample bounded at ${SAMPLE_LIMIT}).`);
  }

  if (fk.total > 0) {
    lines.push(`NOT VALIDATED — ${fk.total} foreign key(s) in schema "${report.schema}" never checked their existing rows:`);
    for (const f of fk.sample) lines.push(`  ${report.schema}."${f.table}" constraint "${f.constraint}" is NOT VALID`);
    if (fk.total > fk.sample.length) lines.push(`  … and ${fk.total - fk.sample.length} more (sample bounded at ${SAMPLE_LIMIT}).`);
  }

  if (ik.total > 0) {
    lines.push(`NOT ENFORCING — ${ik.total} foreign key(s) in schema "${report.schema}" are not completely implemented:`);
    for (const f of ik.sample) {
      lines.push(`  ${report.schema}."${f.table}" constraint "${f.constraint}" has ${f.enforcingTriggers}/${REQUIRED_RI_TRIGGERS} enforcing internal triggers — ${f.why}`);
    }
    if (ik.total > ik.sample.length) lines.push(`  … and ${ik.total - ik.sample.length} more (sample bounded at ${SAMPLE_LIMIT}).`);
  }

  // Last, and for the same reason the role check is first: while this fires, clause 1 reads CLEAN
  // for every trigger on the table and says nothing at all about it.
  if (bt.total > 0) {
    lines.push(`NOT ENFORCING — ${bt.total} table(s) reachable from schema "${report.schema}" have `
      + `relhastriggers = FALSE, so PostgreSQL does not consult their triggers at all `
      + `(every tgenabled still reads as enabled):`);
    for (const f of bt.sample) {
      const elsewhere = f.schema === report.schema ? '' : ' [referenced from this schema, and judged by clause 3]';
      lines.push(`  ${f.schema}.${f.table} carries ${f.triggers} trigger(s), none of which can fire${elsewhere}. `
        + `Repair: UPDATE pg_class SET relhastriggers = true WHERE oid = ${f.repair}::regclass;`);
    }
    if (bt.total > bt.sample.length) lines.push(`  … and ${bt.total - bt.sample.length} more (sample bounded at ${SAMPLE_LIMIT}).`);
  }

  return lines.join('\n');
}
