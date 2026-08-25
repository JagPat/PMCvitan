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
 *      The one apparent exception is deliberate and is a FEATURE, not a false positive. The T45,
 *      T2C and T3C repair engines disable named `*_append_only` triggers to apply an operator's
 *      plan — but they do so INSIDE `prisma.$transaction`, re-enable every one of them, and assert
 *      the full immutability set is enabled, all before commit (t45-repair.service.ts:186-201,
 *      t3c-repair.service.ts:940-959, t2c-repair.service.ts:218-231). VERIFIED by reading those
 *      engines, not assumed. DDL is transactional in PostgreSQL, so a rollback undoes the DISABLE
 *      too, and the ACCESS EXCLUSIVE lock the ALTER takes means a concurrent reader sees the
 *      pre-transaction state. Therefore no committed database is ever legitimately at rest with one
 *      of them off — and a database left dirty by an aborted repair is exactly what this catches.
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
 */

/** ENFORCING ⟺ `O` (origin) or `A` (always). Stated once, positively, and nowhere else. */
export const ENFORCING_TRIGGER_STATES = ['O', 'A'] as const;

/**
 * How many offending objects are PRINTED. Every one is COUNTED and returned; this bounds the
 * report, never the judgement. A restore that disabled one table's triggers produces dozens of
 * findings and an operator needs the shape of the damage, not the first row of it.
 */
export const SAMPLE_LIMIT = 25;

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

export interface EnforcementReport {
  schema: string;
  /** False only for a database with no application tables at all (fresh/empty). */
  applicable: boolean;
  note: string;
  enforcing: boolean;
  counts: { tables: number; triggers: number; foreignKeys: number };
  disabledTriggers: { total: number; sample: TriggerFinding[] };
  unvalidatedForeignKeys: { total: number; sample: ConstraintFinding[] };
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
  const [{ tables, triggers, foreignKeys }] = await prisma.$queryRawUnsafe<
    Array<{ tables: number; triggers: number; foreignKeys: number }>
  >(
    `SELECT
       (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relkind IN ('r','p')) AS "tables",
       (SELECT count(*)::int FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1) AS "triggers",
       (SELECT count(*)::int FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND k.contype = 'f') AS "foreignKeys"`,
    schema,
  );

  // A database with no application tables is not a database with intact seals — it is a database
  // with nothing to say. Reported as NOT APPLICABLE rather than clean, and the two callers in
  // migrate.sh then differ on what that means: before Prisma it passes (the migrations that build
  // the schema still have to run), after a successful deploy it is a failure.
  if (tables === 0) {
    return {
      schema,
      applicable: false,
      note: `schema "${schema}" contains no application tables — fresh or empty database, nothing to verify`,
      enforcing: true,
      counts: { tables, triggers, foreignKeys },
      disabledTriggers: { total: 0, sample: [] },
      unvalidatedForeignKeys: { total: 0, sample: [] },
    };
  }

  // CLAUSE 1. Every trigger, whatever kind. The predicate is `NOT (O or A)`, so `D` and `R` are
  // BOTH findings and any state PostgreSQL might add later is a finding too — the closed form of
  // the question, rather than a list of bad states that a new release could outgrow.
  const disabled = await prisma.$queryRawUnsafe<
    Array<{ table: string; trigger: string; state: string; internal: boolean; implements: string | null }>
  >(
    `SELECT c.relname AS "table",
            t.tgname  AS "trigger",
            t.tgenabled::text AS "state",
            t.tgisinternal AS "internal",
            k.conname AS "implements"
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_constraint k ON k.oid = t.tgconstraint
      WHERE n.nspname = $1
        AND NOT (t.tgenabled = 'O' OR t.tgenabled = 'A')
      ORDER BY c.relname, t.tgname`,
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
    note: `schema "${schema}": ${triggers} triggers and ${foreignKeys} foreign keys over ${tables} tables`,
    enforcing: triggerFindings.length === 0 && unvalidated.length === 0,
    counts: { tables, triggers, foreignKeys },
    disabledTriggers: { total: triggerFindings.length, sample: triggerFindings.slice(0, SAMPLE_LIMIT) },
    unvalidatedForeignKeys: { total: unvalidated.length, sample: unvalidated.slice(0, SAMPLE_LIMIT) },
  };
}

/** The NAMED diagnostic: every offending object identified, with the count it was sampled from. */
export function summarizeEnforcement(report: EnforcementReport): string {
  const lines: string[] = [];
  const { disabledTriggers: dt, unvalidatedForeignKeys: fk } = report;

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

  return lines.join('\n');
}
