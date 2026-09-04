import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaService } from '../../prisma.service';
import { PHASE6_4C_IIIR_MARKER_ACTION } from './inbox-repair';

/**
 * Phase 6 unit 4c-iii-r — the PHYSICAL-SEAL verifier for the repair marker, run on every deploy
 * BEFORE the repair step is allowed to trust a marker it finds.
 *
 * WHY THIS EXISTS (Codex F4 on `bee2ed9`). The repair skips itself when the marker row is present,
 * and `20271125000000_phase6_4c_iiir_marker_seal` is what makes that row mean anything: without its
 * three triggers the marker is freely insertable, rewritable and deletable, so "the marker is
 * there" stops being evidence that the rebuild ever ran. Installing them is a ONE-TIME event.
 * `prisma migrate deploy` proves the LEDGER is complete, not that the guards enforce — once the
 * migration is recorded nothing re-reads the file, so a database that has since been through a
 * partial restore deploys green with a trigger missing, switched off, or hollowed by a
 * `CREATE OR REPLACE FUNCTION` that kept the identity and replaced the body. The repair then finds
 * a marker that nothing protected and skips a rebuild the database still needs.
 *
 * The generic schema-enforcement check that already runs on this path cannot answer this. It
 * reports triggers it finds DISABLED and foreign keys it finds NOT VALID; a trigger that is simply
 * absent from the inventory is invisible to it, and `OutboxOperatorAction` carries no constraints
 * of its own for it to notice. This is the same reasoning that already puts `t3c seals` and
 * `b1 seals` on the ordinary success path, applied to the one table those two do not cover.
 *
 * THERE IS ONE INVENTORY, NOT TWO. The canonical function bodies are read from the migration file
 * itself — the same `$$ … $$` literals PostgreSQL was told to install FROM — so a hand-kept copy
 * cannot drift from what was actually deployed, and a drifted verifier reporting "sealed" is worse
 * than no verifier. The file ships in the deployed image (the Dockerfile copies the repository and
 * `prisma migrate deploy` needs `prisma/migrations` regardless), so it is the same trust root as
 * this code.
 *
 * WHAT IS ASKED, and why each:
 *
 *   PRESENT.   The trigger exists on the table, with the right timing/events and the right
 *              function. A dropped trigger is the cheapest way to unseal the marker.
 *   ENABLED.   `tgenabled = 'O'`. `ALTER TABLE … DISABLE TRIGGER` leaves the row in place, so
 *              presence alone answers a question nobody asked.
 *   THE BODY.  `prosrc` equals the migration's literal. `CREATE OR REPLACE FUNCTION` preserves the
 *              OID, name, signature and every property while replacing what the function DOES, so
 *              a no-op body passes presence and enablement together.
 *   THE OWNER. Ownership is the standing right to replace that body at any moment, so a seal owned
 *              by a role the table's owner does not control is not a seal. `pg_restore` sets
 *              ownership, which is precisely the event this verifier is for. Compared RELATIVELY
 *              to the table's own owner, as the B1 verifier does.
 *   NO `WHEN`.  `pg_trigger.tgqual` is NULL. A `WHEN` predicate is not part of `tgtype`, the body,
 *              the owner or the enablement, so `BEFORE INSERT … WHEN (false)` matches EVERY other
 *              check here while the trigger never fires — measured, and the forged marker was
 *              accepted while this verifier reported `sealed: true` (Codex round 11, P1). The
 *              canonical triggers carry no predicate at all, so the expected value is exact rather
 *              than a comparison: any predicate is a deviation.
 *
 * WHAT IS DELIBERATELY NOT ASKED. Nothing about rows: this verifies the guards, and the guards'
 * whole job is that the rows are already what they claim. In particular the presence or absence of
 * a marker is not this file's business — the repair step decides that, under its lock, after this
 * has established that a marker found there would mean something.
 */

export const MARKER_SEAL_MIGRATION = '20271125000000_phase6_4c_iiir_marker_seal';
export const MARKER_SEAL_TABLE = 'OutboxOperatorAction';

/**
 * `pg_trigger.tgtype` is a bitmask: ROW=1, BEFORE=2, INSERT=4, DELETE=8, UPDATE=16, TRUNCATE=32.
 *
 * The EXACT value is pinned, not a subset of its bits (Codex F1 on `42a1903`). An earlier draft
 * asked only BEFORE and row-vs-statement, which says nothing about WHICH events fire the trigger —
 * so a partial restore that recreated the insert gate under the same name, function, body, owner
 * and enablement but as `BEFORE UPDATE` (tgtype 19) passed the verifier while direct marker
 * INSERTs were once again accepted. Each expected value is the one the migration's own
 * `CREATE TRIGGER` produces, and is asserted against a live database by the test suite rather than
 * trusted to this arithmetic.
 */
export const MARKER_SEAL_TRIGGERS: ReadonlyArray<{ trigger: string; fn: string; tgtype: number; expects: string }> = [
  {
    trigger: 'OutboxOperatorAction_4c_iiir_marker_insert_gated',
    fn: 'phase6_4c_iiir_marker_insert_gated',
    tgtype: 1 + 2 + 4,
    expects: 'BEFORE INSERT, per row',
  },
  {
    trigger: 'OutboxOperatorAction_4c_iiir_marker_sealed',
    fn: 'phase6_4c_iiir_marker_sealed',
    tgtype: 1 + 2 + 8 + 16,
    expects: 'BEFORE UPDATE OR DELETE, per row',
  },
  {
    trigger: 'OutboxOperatorAction_4c_iiir_no_truncate',
    fn: 'phase6_4c_iiir_no_truncate',
    tgtype: 2 + 32,
    expects: 'BEFORE TRUNCATE, per statement',
  },
];

/**
 * The seals whose failure means a marker found on this database CANNOT BE VOUCHED FOR.
 *
 * Both of these stand between a writer holding the application's own database role and a marker it
 * never earned: the insert gate is the only guard an `INSERT` passes through (the row seal fires
 * BEFORE UPDATE OR DELETE and never sees one), and the row seal is the only guard against promotion
 * and rewriting. A finding against EITHER — absent, disabled, hollowed, re-pointed, re-masked or
 * foreign-owned — opens a window in which the marker now present could have been manufactured.
 *
 * `phase6_4c_iiir_no_truncate` is deliberately absent: it can only destroy markers, never make one.
 *
 * This is the SAME rule the migration's rerun-adoption test applies before it agrees that a marker
 * predating a re-run was written under enforcement, stated once and used in both places.
 */
export const MARKER_FORGERY_SEALS: ReadonlySet<string> = new Set([
  'phase6_4c_iiir_marker_insert_gated',
  'phase6_4c_iiir_marker_sealed',
]);

/**
 * Does this finding mean a marker on the database could have been MANUFACTURED?
 *
 * Two ways: one of the forgery-relevant seals was not enforcing, or an unexpected BEFORE row
 * trigger could rewrite an ordinary row into a marker (round 12). Either opens the window, so
 * either invalidates. A truncate-guard finding does not — it can only destroy.
 */
export function opensForgeryWindow(finding: MarkerSealFinding): boolean {
  // An inheritance child is a forgery window in its own right: any marker on this table may have
  // been written into that child, past every seal, so no marker found here is evidence of a repair.
  return finding.problem === 'unexpected-writer'
    || finding.problem === 'inherited-child'
    || MARKER_FORGERY_SEALS.has(finding.fn);
}

/** `dist/platform/projections` and `src/platform/projections` are both three levels under `apps/api`. */
function migrationSqlPath(): string {
  return join(__dirname, '..', '..', '..', 'prisma', 'migrations', MARKER_SEAL_MIGRATION, 'migration.sql');
}

export function readMarkerSealMigrationSql(): string {
  return readFileSync(migrationSqlPath(), 'utf8');
}

// ── THE WRITER FENCE, AND ITS OWN SEAL ────────────────────────────────────────────────────────
//
// `20271126000000` stamps `ProjectionGeneration.fencedAt` whenever a session that has not declared
// this release's serializer writes into a `DecisionProjection` row, which is what an
// already-running previous-release relay does. That fence is only worth what its own installation
// is worth: a dropped, disabled, hollowed or `proconfig`-altered trigger fences nothing while every
// other check on this deploy path still reports healthy. So it is verified on EVERY start, by the
// same closed-inventory rule the marker seals use, and the deploy refuses without it.
export const WRITER_FENCE_MIGRATION = '20271126000000_phase6_4c_iiir_writer_fence';
export const WRITER_FENCE_TABLE = 'DecisionProjection';
export const WRITER_FENCE_TRIGGER = 'DecisionProjection_4c_iiir_writer_fence';
export const WRITER_FENCE_FUNCTION = 'phase6_4c_iiir_fence_decision_projection_write';
/** The stamp seal: `fencedAt` is evidence, so once set it cannot be cleared or moved. */
export const WRITER_FENCE_STAMP_TABLE = 'ProjectionGeneration';
export const WRITER_FENCE_STAMP_TRIGGER = 'ProjectionGeneration_4c_iiir_fence_stamp_sealed';
export const WRITER_FENCE_STAMP_FUNCTION = 'phase6_4c_iiir_fence_stamp_sealed';
/** TRUNCATE fires no row trigger, so the fence carries a statement-level arm of its own. */
export const WRITER_FENCE_TRUNCATE_TRIGGER = 'DecisionProjection_4c_iiir_writer_fence_truncate';
export const WRITER_FENCE_TRUNCATE_FUNCTION = 'phase6_4c_iiir_fence_decision_projection_truncate';

export function readWriterFenceMigrationSql(): string {
  return readFileSync(
    join(__dirname, '..', '..', '..', 'prisma', 'migrations', WRITER_FENCE_MIGRATION, 'migration.sql'),
    'utf8',
  );
}

/**
 * The canonical `prosrc` PostgreSQL stores for one of the fence's functions — read from the
 * migration's own literal rather than restated here, so a copy cannot quietly stop matching what is
 * actually deployed. Each function is dollar-quoted with its own delimiter.
 */
export function canonicalFenceBody(delimiter: 'fence' | 'sealed' | 'truncate'): string {
  const sql = readWriterFenceMigrationSql();
  const match = new RegExp(`AS \\$${delimiter}\\$\\n([\\s\\S]*?)\\n\\$${delimiter}\\$;`, 'u').exec(sql);
  if (!match) throw new Error(`${WRITER_FENCE_MIGRATION}: cannot extract the $${delimiter}$ function body`);
  return `\n${match[1]}\n`;
}

export interface WriterFenceReport {
  installed: boolean;
  trigger: string;
  findings: string[];
}

/**
 * Verify the writer fence is installed and ENFORCING.
 *
 * The same questions the marker seals ask, for the same reasons and in the same order: does the
 * trigger exist, does it fire for ordinary writes (`tgenabled='O'`), does it run AFTER each ROW on
 * INSERT and UPDATE, does it execute OUR function, is that function's BODY the migration's own, is
 * its `proconfig` empty — an `ALTER FUNCTION ... SET vitan.decisions_inbox_catalog_version = '2'`
 * makes the fence declare on the writer's behalf while `prosrc` stays byte-identical, which is the
 * bypass measured on this codebase in rounds 5, 10, 11, 12 and 18 — and is it owned by the table's
 * owner, so it cannot be replaced by a role that does not already own the data.
 */
export async function verifyWriterFence(prisma: SealCatalogReader): Promise<WriterFenceReport> {
  const findings: string[] = [];
  const rows = await prisma.$queryRaw<Array<{
    tgenabled: string; tgtype: number; has_when: boolean; proname: string; prosrc: string;
    proconfig: string | null; owner: string; table_owner: string | null;
  }>>`
    SELECT t.tgenabled, t.tgtype::int AS tgtype,
           t.tgqual IS NOT NULL AS has_when,
           p.proname, p.prosrc,
           p.proconfig::text AS proconfig,
           pg_get_userbyid(p.proowner) AS owner,
           (SELECT pg_get_userbyid(c2.relowner) FROM pg_class c2 JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
             WHERE n2.nspname = 'public' AND c2.relname = ${WRITER_FENCE_TABLE}) AS table_owner
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE ns.nspname = 'public' AND c.relname = ${WRITER_FENCE_TABLE}
       AND t.tgname = ${WRITER_FENCE_TRIGGER} AND NOT t.tgisinternal`;

  const row = rows[0];
  if (!row) {
    findings.push(
      `the writer fence trigger "${WRITER_FENCE_TRIGGER}" is ABSENT from public."${WRITER_FENCE_TABLE}", `
      + 'so a previous-release relay can write v1 rows into a live generation and they will be SERVED',
    );
    return { installed: false, trigger: WRITER_FENCE_TRIGGER, findings };
  }
  if (row.tgenabled !== 'O') {
    findings.push(`the writer fence is DISABLED (tgenabled='${row.tgenabled}'), so it does not fire for ordinary writes`);
  }
  if (row.proname !== WRITER_FENCE_FUNCTION) {
    findings.push(`the writer fence executes ${row.proname}, not ${WRITER_FENCE_FUNCTION}`);
  }
  // AFTER (not BEFORE: tgtype bit 2 clear) FOR EACH ROW (bit 1) on INSERT (4), DELETE (8) and
  // UPDATE (16). DELETE is in the mask because a writer that REMOVES a row leaves the generation
  // incomplete without touching any row that survives (Codex on `6b3ff9e6`).
  const rowLevel = (row.tgtype & 1) !== 0;
  const after = (row.tgtype & 2) === 0;
  const covers = (row.tgtype & 4) !== 0 && (row.tgtype & 8) !== 0 && (row.tgtype & 16) !== 0;
  if (!rowLevel || !after || !covers) {
    findings.push(
      `the writer fence has the wrong timing or event mask (tgtype=${row.tgtype}); it must be AFTER `
      + 'INSERT OR UPDATE OR DELETE FOR EACH ROW, or a write it does not see is a write it does not '
      + 'fence',
    );
  }
  // A `WHEN` PREDICATE IS INVISIBLE TO EVERY OTHER CHECK (Codex on `6b3ff9e6`). It lives in
  // `tgqual`, not in `tgtype`, the body or `proconfig` — so `... FOR EACH ROW WHEN (false)` matches
  // enablement, function, mask, body, config and ownership while fencing nothing at all. The
  // marker-seal verifier has asked this since round 11; this one was written without it.
  if (row.has_when) {
    findings.push(
      'the writer fence carries a WHEN predicate, so it fires only for the rows that predicate '
      + 'admits — every other row is written unfenced while every other property still matches',
    );
  }
  if (row.proconfig !== null) {
    findings.push(
      `the writer fence function carries a per-function configuration (proconfig=${row.proconfig}). `
      + '`ALTER FUNCTION ... SET vitan.decisions_inbox_catalog_version` makes the fence read a '
      + 'declaration the WRITER never made, so every undeclared write passes while the body stays '
      + 'byte-identical',
    );
  }
  if (row.prosrc !== canonicalFenceBody('fence')) {
    findings.push('the writer fence function body is not the migration\'s own — it has been replaced');
  }
  if (row.table_owner && row.owner !== row.table_owner) {
    findings.push(
      `the writer fence function is owned by ${row.owner}, not by ${row.table_owner} which owns `
      + `public."${WRITER_FENCE_TABLE}" — that role can replace its body at will`,
    );
  }

  // AND THE STAMP SEAL, which is what makes the stamp EVIDENCE rather than a hint (Codex on
  // `6b3ff9e6`). Measured before it existed: `UPDATE "ProjectionGeneration" SET "fencedAt" = NULL`
  // returned a fenced generation to servable, and the legacy-shaped rows with it. A fence whose
  // record any writer can erase fences nothing durable, so its seal is verified on the same call
  // and by the same closed rule.
  const sealRows = await prisma.$queryRaw<Array<CompanionRow>>`
    SELECT t.tgenabled, t.tgtype::int AS tgtype, t.tgqual IS NOT NULL AS has_when,
           p.proname, p.prosrc, p.proconfig::text AS proconfig,
           pg_get_userbyid(p.proowner) AS owner,
           pg_get_userbyid(c.relowner) AS table_owner
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE ns.nspname = 'public' AND c.relname = ${WRITER_FENCE_STAMP_TABLE}
       AND t.tgname = ${WRITER_FENCE_STAMP_TRIGGER} AND NOT t.tgisinternal`;
  const seal = sealRows[0];
  checkCompanion(findings, seal, {
    label: 'fence stamp seal', table: WRITER_FENCE_STAMP_TABLE, trigger: WRITER_FENCE_STAMP_TRIGGER,
    fn: WRITER_FENCE_STAMP_FUNCTION, body: canonicalFenceBody('sealed'), tgtype: 19,
    absent:
      'so a stamped generation can be un-fenced with one UPDATE and its legacy-shaped rows served again',
    timing: 'BEFORE UPDATE FOR EACH ROW',
  });

  // AND THE TRUNCATE ARM. `TRUNCATE` fires no ROW trigger — measured: the register emptied and every
  // generation stayed unfenced, so a caught-up generation served an authoritative EMPTY register.
  const truncRows = await prisma.$queryRaw<Array<CompanionRow>>`
    SELECT t.tgenabled, t.tgtype::int AS tgtype, t.tgqual IS NOT NULL AS has_when,
           p.proname, p.prosrc, p.proconfig::text AS proconfig,
           pg_get_userbyid(p.proowner) AS owner,
           pg_get_userbyid(c.relowner) AS table_owner
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE ns.nspname = 'public' AND c.relname = ${WRITER_FENCE_TABLE}
       AND t.tgname = ${WRITER_FENCE_TRUNCATE_TRIGGER} AND NOT t.tgisinternal`;
  checkCompanion(findings, truncRows[0], {
    label: 'fence TRUNCATE arm', table: WRITER_FENCE_TABLE, trigger: WRITER_FENCE_TRUNCATE_TRIGGER,
    fn: WRITER_FENCE_TRUNCATE_FUNCTION, body: canonicalFenceBody('truncate'), tgtype: 34,
    absent: 'so TRUNCATE empties the register while every generation stays unfenced and servable',
    timing: 'BEFORE TRUNCATE FOR EACH STATEMENT',
  });

  // AND THE TABLE IS CLOSED, exactly as the marker table now is (Codex on `de9fa3b7`). A child
  // created with `INHERITS ("DecisionProjection")` takes rows that the unqualified parent query in
  // `decisions.query.ts` still returns, while NONE of the parent's triggers fire for DML against
  // it — so legacy-shaped data is served with `fencedAt` never stamped. The marker verifier learned
  // this one round ago; this one was written without it.
  const children = await prisma.$queryRaw<{ child: string }[]>`
    SELECT (c.relnamespace::regnamespace || '.' || c.relname) AS child
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class pt ON pt.oid = i.inhparent
      JOIN pg_namespace pn ON pn.oid = pt.relnamespace
     WHERE pt.relname = ${WRITER_FENCE_TABLE} AND pn.nspname = 'public'`;
  for (const child of children) {
    findings.push(
      `public."${WRITER_FENCE_TABLE}" has an inheritance child (${child.child}). Rows written `
      + 'directly into a child fire none of this table\'s triggers, while the read path — which '
      + 'reads the parent without ONLY — still serves them, so legacy-shaped rows reach a client '
      + 'with the generation never stamped',
    );
  }

  return { installed: findings.length === 0, trigger: WRITER_FENCE_TRIGGER, findings };
}

interface CompanionRow {
  tgenabled: string; tgtype: number; has_when: boolean;
  proname: string; prosrc: string; proconfig: string | null;
  owner: string; table_owner: string | null;
}

/**
 * Hold one of the fence's companion triggers to the SAME closed rule as the fence itself.
 *
 * Written once and applied to both because the round that added the stamp seal verified only that
 * the trigger EXISTED — never its body or its owner — so a `CREATE OR REPLACE FUNCTION` turning it
 * into a no-op passed every check while the stamp became clearable again (Codex on `de9fa3b7`).
 * Enumerating the questions per trigger is how that gap appeared; asking them from one place is how
 * it stops recurring.
 */
function checkCompanion(
  findings: string[],
  row: CompanionRow | undefined,
  spec: { label: string; table: string; trigger: string; fn: string; body: string; tgtype: number; absent: string; timing: string },
): void {
  if (!row) {
    findings.push(`the ${spec.label} "${spec.trigger}" is ABSENT from public."${spec.table}", ${spec.absent}`);
    return;
  }
  if (row.tgenabled !== 'O') findings.push(`the ${spec.label} is DISABLED (tgenabled='${row.tgenabled}'), so it does not fire for ordinary writes`);
  if (row.proname !== spec.fn) findings.push(`the ${spec.label} executes ${row.proname}, not ${spec.fn}`);
  if (row.tgtype !== spec.tgtype) findings.push(`the ${spec.label} has the wrong timing or event mask (tgtype=${row.tgtype}); it must be ${spec.timing}`);
  if (row.has_when) findings.push(`the ${spec.label} carries a WHEN predicate, so everything it does not admit passes unfenced`);
  if (row.proconfig !== null) findings.push(`the ${spec.label} function carries a per-function configuration (proconfig=${row.proconfig})`);
  if (row.prosrc !== spec.body) findings.push(`the ${spec.label} function body is not the migration's own — it has been replaced, and a no-op body passes every other check`);
  // OWNERSHIP WAS SELECTED AND THEN NEVER COMPARED (Codex on `9705dcdd`) — the column was in the
  // query and in this row's type, and nothing read it. A body check only catches a replacement that
  // is STILL THERE when the deploy looks: a role that owns the function can swap in a no-op, clear
  // `fencedAt`, and restore the canonical body before the next verification, and every check here
  // would pass over a generation that is once again servable. The primary fence has compared this
  // since it was written; its companions did not.
  if (row.table_owner && row.owner !== row.table_owner) {
    findings.push(
      `the ${spec.label} function is owned by ${row.owner}, not by ${row.table_owner} which owns `
      + `public."${spec.table}" — that role can replace its body at will, and restore it before the `
      + 'next deploy looks',
    );
  }
}

/**
 * The three `LANGUAGE plpgsql AS $$ … $$;` literals the migration installs its trigger functions
 * FROM, keyed by function name.
 *
 * Unforgiving on purpose. A file that yields fewer than the three expected functions, or a body
 * that does not terminate, is a REFUSAL rather than a silently smaller inventory: a verifier that
 * quietly asks nothing reports every database as sealed, which is the exact failure this whole file
 * exists to prevent one level down.
 */
export function extractCanonicalMarkerBodies(migrationSql: string): Map<string, string> {
  const out = new Map<string, string>();
  const pattern = /CREATE OR REPLACE FUNCTION (phase6_4c_iiir_[a-z_]+)\(\) RETURNS trigger\nLANGUAGE plpgsql AS \$\$/gu;
  for (const match of migrationSql.matchAll(pattern)) {
    const name = match[1];
    const bodyStart = (match.index ?? 0) + match[0].length;
    const bodyEnd = migrationSql.indexOf('$$;', bodyStart);
    if (bodyEnd < 0) {
      throw new Error(`4c-iii-r seals: an unterminated $$ literal for ${name} in ${MARKER_SEAL_MIGRATION}/migration.sql.`);
    }
    if (out.has(name)) {
      throw new Error(`4c-iii-r seals: ${MARKER_SEAL_MIGRATION}/migration.sql defines ${name} more than once.`);
    }
    out.set(name, migrationSql.slice(bodyStart, bodyEnd));
  }
  const expected = MARKER_SEAL_TRIGGERS.map((t) => t.fn);
  const missing = expected.filter((fn) => !out.has(fn));
  if (missing.length > 0) {
    throw new Error(
      `4c-iii-r seals: ${MARKER_SEAL_MIGRATION}/migration.sql carries no canonical body for ${missing.join(', ')}. `
      + 'The deployed image is not the reviewed one, so no statement can be made about this database\'s seals.',
    );
  }
  return out;
}

export interface MarkerSealFinding {
  trigger: string;
  fn: string;
  problem: 'absent' | 'disabled' | 'wrong-function' | 'wrong-timing' | 'conditional' | 'body-replaced' | 'config-altered' | 'foreign-owner' | 'unexpected-writer' | 'inherited-child';
  detail: string;
}

export interface MarkerSealRepairReport extends MarkerSealReport {
  /** markers removed because they could not be trusted through the window the seal was missing. */
  markersInvalidated: number;
}

/**
 * Everything the verifier needs, so it can be run INSIDE the repair's own transaction as easily as
 * on a pooled client: the state that decides whether a marker is invalidated has to be read by the
 * transaction that acts on it, or a seal restored between the two makes the decision stale.
 */
export type SealCatalogReader = Pick<PrismaService, '$queryRaw'>;

export interface MarkerSealReport {
  sealed: boolean;
  /** false when the table itself does not exist — on a deploy path that is a FAILURE, not a pass. */
  applicable: boolean;
  markerAction: string;
  checked: number;
  findings: MarkerSealFinding[];
}

interface TriggerRow {
  tgname: string;
  has_when: boolean;
  tgenabled: string;
  proname: string;
  prosrc: string;
  proconfig: string | null;
  prosecdef: boolean;
  provolatile: string;
  lanname: string;
  fn_owner: string;
  table_owner: string;
  tgtype: number;
}

/* eslint-disable-next-line complexity -- one linear pass over three seals; splitting it would hide the inventory. */
export async function verifyMarkerSeals(prisma: SealCatalogReader): Promise<MarkerSealReport> {
  const canonical = extractCanonicalMarkerBodies(readMarkerSealMigrationSql());

  const exists = await prisma.$queryRaw<Array<{ present: boolean }>>`
    SELECT to_regclass(${`public."${MARKER_SEAL_TABLE}"`}) IS NOT NULL AS present`;
  if (!exists[0]?.present) {
    return { sealed: false, applicable: false, markerAction: PHASE6_4C_IIIR_MARKER_ACTION, checked: 0, findings: [] };
  }

  const rows = await prisma.$queryRaw<TriggerRow[]>`
    SELECT t.tgname,
           t.tgenabled,
           t.tgtype,
           t.tgqual IS NOT NULL AS has_when,
           p.proname,
           p.prosrc,
           -- WHAT THE FUNCTION DOES IS NOT ONLY ITS BODY (Codex on 1eb5f20). proconfig carries
           -- per-function GUC settings applied on entry, so ALTER FUNCTION ... SET
           -- vitan.phase6_4c_iiir_repair = 'on' makes the gate's current_setting(...) return 'on'
           -- for EVERY invocation -- including a forged INSERT -- while prosrc, tgtype, tgqual, the
           -- owner and the enablement all stay identical. MEASURED: the forged insert is refused,
           -- the ALTER runs, md5(prosrc) is unchanged, and the same insert is then accepted.
           --
           -- So this closes the FUNCTION identity the way round 12 closed the trigger inventory,
           -- rather than adding a sixth property and meeting a seventh next round. These are every
           -- pg_proc column that can change what the function does: its body, the settings applied
           -- around it, whose rights it runs with, how the planner may treat it, and the language
           -- that interprets the body. Anything else (name, oid, acl, comments) cannot.
           p.proconfig::text AS proconfig,
           p.prosecdef,
           p.provolatile,
           l.lanname,
           pg_get_userbyid(p.proowner) AS fn_owner,
           pg_get_userbyid(c.relowner) AS table_owner
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = t.tgfoid
      JOIN pg_language l ON l.oid = p.prolang
     WHERE n.nspname = 'public'
       AND c.relname = ${MARKER_SEAL_TABLE}
       AND NOT t.tgisinternal`;
  const byName = new Map(rows.map((r) => [r.tgname, r]));

  const findings: MarkerSealFinding[] = [];
  for (const { trigger, fn, tgtype, expects } of MARKER_SEAL_TRIGGERS) {
    const row = byName.get(trigger);
    if (!row) {
      findings.push({ trigger, fn, problem: 'absent', detail: `no such trigger on public."${MARKER_SEAL_TABLE}" (expected ${expects})` });
      continue;
    }
    // 'O' = enabled for origin (the ordinary state). 'D' is disabled; 'R'/'A' are replica modes,
    // which for a seal on a primary is not enforcement either.
    if (row.tgenabled !== 'O') {
      findings.push({ trigger, fn, problem: 'disabled', detail: `tgenabled='${row.tgenabled}', so it does not fire for ordinary writes` });
    }
    if (row.proname !== fn) {
      findings.push({ trigger, fn, problem: 'wrong-function', detail: `executes ${row.proname}, not ${fn}` });
      continue;
    }
    // The WHOLE mask, so the EVENTS are pinned along with the timing — see MARKER_SEAL_TRIGGERS.
    if (row.tgtype !== tgtype) {
      findings.push({
        trigger,
        fn,
        problem: 'wrong-timing',
        detail: `tgtype=${row.tgtype} is not ${tgtype} ("${expects}") — the timing or the events it fires on have changed`,
      });
    }
    // A `WHEN` predicate is invisible to every check above — it lives in `tgqual`, not in `tgtype`,
    // the function, the body, the owner or the enablement. `BEFORE INSERT … WHEN (false)` therefore
    // reads as perfectly sealed while the trigger never fires once, which is worse than an absent
    // trigger because it is silent. The canonical triggers carry no predicate, so this is exact.
    if (row.has_when) {
      findings.push({
        trigger,
        fn,
        problem: 'conditional',
        detail:
          'the trigger carries a WHEN predicate, which this migration never installs — a predicate that '
          + 'excludes the marker leaves every other property identical while the trigger never fires',
      });
    }
    const want = canonical.get(fn);
    if (want !== undefined && row.prosrc !== want) {
      findings.push({
        trigger,
        fn,
        problem: 'body-replaced',
        detail:
          'the function still exists with its name and signature, but its body is not the one the migration installed — '
          + 'CREATE OR REPLACE FUNCTION keeps every identity property while replacing what it does',
      });
    }
    // The rest of the function's identity, closed (Codex on `1eb5f20`). Each of these changes what
    // the function DOES while leaving `prosrc` byte-identical, so a body-only comparison passes.
    const altered: string[] = [];
    if (row.proconfig !== null) {
      // the measured bypass: a per-function GUC that makes the gate's `current_setting` return 'on'
      altered.push(`proconfig=${row.proconfig} (canonical: none)`);
    }
    if (row.prosecdef) altered.push('SECURITY DEFINER (canonical: SECURITY INVOKER)');
    if (row.provolatile !== 'v') altered.push(`provolatile='${row.provolatile}' (canonical: 'v')`);
    if (row.lanname !== 'plpgsql') altered.push(`language ${row.lanname} (canonical: plpgsql)`);
    if (altered.length > 0) {
      findings.push({
        trigger,
        fn,
        problem: 'config-altered',
        detail:
          `the body is the migration's, but the function's execution settings are not: ${altered.join('; ')}. `
          + 'These change what the function does without touching a single byte of its body.',
      });
    }
    if (row.fn_owner !== row.table_owner) {
      findings.push({
        trigger,
        fn,
        problem: 'foreign-owner',
        detail: `owned by "${row.fn_owner}" while public."${MARKER_SEAL_TABLE}" is owned by "${row.table_owner}"; ownership is the standing right to replace the body`,
      });
    }
  }

  // ── THE INVENTORY IS CLOSED (Codex round 12, P1) ────────────────────────────────────────────
  //
  // Everything above asks "are OUR three triggers intact?". That is the wrong question, and asking
  // it four different ways is why this surface produced a finding in rounds 5, 10, 11 and 12: the
  // question is whether ANYTHING on this table can produce a marker row.
  //
  // PostgreSQL fires same-event BEFORE row triggers in NAME ORDER, each handing its `NEW` to the
  // next. So a trigger sorting after `OutboxOperatorAction_4c_iiir_marker_insert_gated` can rewrite
  // `NEW."action"` into the marker action AFTER the gate has already approved an ordinary row —
  // measured, and the forged marker committed while this verifier reported `sealed: true`. The same
  // trick defeats the row seal's promotion arm on UPDATE.
  //
  // Name order is NOT the test. A trigger sorting BEFORE the gate happens to be caught (the gate
  // then sees the marker action without the flag and refuses), but resting the seal on collation of
  // trigger names is exactly the kind of incidental property that produces the next finding. Any
  // unexpected BEFORE row trigger on INSERT or UPDATE is rejected, wherever it sorts.
  //
  // This table legitimately carries NOTHING but these three triggers — it is the operator audit
  // table, created by `20261026000000` with no triggers of its own — so a closed inventory costs
  // nothing real and a future trigger here is a deliberate decision that must come past this check.
  const expected = new Set(MARKER_SEAL_TRIGGERS.map((t) => t.trigger));
  for (const row of rows) {
    if (expected.has(row.tgname)) continue;
    const rewritesRows = (row.tgtype & 1) !== 0            // FOR EACH ROW
      && (row.tgtype & 2) !== 0                            // BEFORE
      && ((row.tgtype & 4) !== 0 || (row.tgtype & 16) !== 0); // INSERT or UPDATE
    if (!rewritesRows) continue;
    findings.push({
      trigger: row.tgname,
      fn: row.proname,
      problem: 'unexpected-writer',
      detail:
        `an unexpected BEFORE row trigger (tgtype=${row.tgtype}) runs on public."${MARKER_SEAL_TABLE}" `
        + 'and can rewrite NEW."action" into the marker action — PostgreSQL chains same-event BEFORE '
        + 'row triggers in name order, so one running after the gate forges a marker the gate already '
        + 'approved as an ordinary row',
    });
  }

  // ── AND THE TABLE ITSELF IS CLOSED (Codex on `44f2520`) ─────────────────────────────────────
  //
  // Every check above asks about triggers ON this table. A child table created with
  // `INHERITS ("OutboxOperatorAction")` makes that the wrong scope, because PostgreSQL splits the
  // two things this seal depends on:
  //
  //   • a plain `SELECT ... FROM "OutboxOperatorAction"` reads the parent AND its children (only
  //     `FROM ONLY` excludes them), so the marker lookup — Prisma's `findFirst`, the migration's
  //     adoption inventory — SEES a row that lives in the child; but
  //   • triggers defined on the parent DO NOT FIRE for DML issued directly against the child.
  //
  // MEASURED on this server: with the three seals installed and reporting `sealed: true`, an
  // `INSERT` into a child put a marker row where the parent lookup found it, and that row was then
  // freely `UPDATE`d and `DELETE`d. Every arm of the seal — gate, row seal, truncate guard — was
  // bypassed by writing one table over.
  //
  // So the inventory closes over the table too. `pg_inherits` children are rejected outright rather
  // than inspected: this table is the operator audit table and legitimately has none, so their
  // existence is itself the finding, and enumerating which child DML would be dangerous would be
  // the same incidental-property mistake the trigger inventory already learned to stop making.
  const children = await prisma.$queryRaw<{ child: string }[]>`
    SELECT (c.relnamespace::regnamespace || '.' || c.relname) AS child
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
      JOIN pg_namespace pn ON pn.oid = p.relnamespace
     WHERE p.relname = ${MARKER_SEAL_TABLE} AND pn.nspname = 'public'`;
  for (const row of children) {
    findings.push({
      trigger: row.child,
      fn: '(table inheritance)',
      problem: 'inherited-child',
      detail:
        `public."${MARKER_SEAL_TABLE}" has an inheritance child (${row.child}). A marker row written `
        + 'directly into a child fires NONE of this table\'s triggers, while the marker lookup — which '
        + 'reads the parent without ONLY — still finds it, so a forged marker there stays freely '
        + 'rewritable and deletable while every seal reports intact',
    });
  }

  return {
    sealed: findings.length === 0,
    applicable: true,
    markerAction: PHASE6_4C_IIIR_MARKER_ACTION,
    checked: MARKER_SEAL_TRIGGERS.length,
    findings,
  };
}

export function summarizeMarkerSeals(report: MarkerSealReport): string {
  return report.findings.map((f) => `  - ${f.trigger} [${f.problem}]: ${f.detail}`).join('\n');
}

/**
 * Reinstall the three seals from the migration's own statements, leaving rows untouched.
 *
 * THE MIGRATION IS NOT THE RECOVERY (Codex on `e8b6d8c`). Re-running
 * `20271125000000/migration.sql` to repair a partial restore only worked on a database with NO
 * marker: its first act is now to refuse any marker that predates the seal, so on the database that
 * actually needs repairing — one that HAS a genuine marker and has lost a trigger — re-running it
 * necessarily aborts. The runner proof papered over that by discarding the exit status and relying
 * on PostgreSQL having kept the pre-abort DDL, which is not a recovery anyone should depend on.
 *
 * So the recovery is this, and it is a different question from the migration's. The migration asks
 * "is this database in a state where installing the seal would bless something unverified?" — a
 * one-time, install-time question. This asks only "put the canonical seals back", which is safe
 * whether or not a marker exists, because it changes no rows and the marker it protects is either
 * genuine (and stays) or was never protected in the first place (and the seal now protects it going
 * forward, which is strictly better than leaving it unsealed).
 *
 * Idempotent by construction — `CREATE OR REPLACE FUNCTION`, `DROP TRIGGER IF EXISTS`,
 * `CREATE TRIGGER` — and it VERIFIES afterwards rather than assuming: a repair that cannot reach
 * a sealed state reports so and exits non-zero.
 */
/**
 * Thrown when the connected role cannot legally perform the repair's DDL. Distinct from a repair
 * that RAN and could not reach a sealed state: nothing has been attempted, so the database is
 * exactly as it was found.
 */
export class SealRepairPrivilegeError extends Error {}

async function readTableOwner(tx: SealCatalogReader): Promise<string> {
  const [row] = await tx.$queryRaw<Array<{ table_owner: string }>>`
    SELECT pg_get_userbyid(c.relowner) AS table_owner
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = ${MARKER_SEAL_TABLE}`;
  if (!row?.table_owner) {
    throw new SealRepairPrivilegeError(
      `4c-iii-r seal repair: "${MARKER_SEAL_TABLE}" does not exist on this database, so there is `
      + 'nothing to seal. Run `prisma migrate deploy` first. See docs/RUNBOOK.md §P64CIIIR.',
    );
  }
  return row.table_owner;
}

/**
 * REFUSE BEFORE THE FIRST STATEMENT WHEN THIS CONNECTION CANNOT DO THE WORK (Codex on `b5f7c1f`).
 *
 * `foreign-owner` is the finding this recovery exists for, and it is exactly the state in which an
 * ordinary connection cannot repair anything: PostgreSQL requires FUNCTION OWNERSHIP for
 * `CREATE OR REPLACE FUNCTION`, and an earlier head placed an `ALTER FUNCTION … OWNER TO` after
 * that loop believing the transfer would fix it.
 *
 * MEASURED, not reasoned: as a non-superuser that owns the TABLE but not the FUNCTION, BOTH
 * statements fail with `must be owner of function`. So the ordering was never the defect — the
 * transfer is not a way to ACQUIRE the right, it needs the same right it was meant to grant. The
 * previous round's test missed this only because it connected as the superuser, for whom every
 * check here passes vacuously.
 *
 * The deciding predicate is `pg_has_role(current_user, proowner, 'USAGE')` — true for the owner
 * itself, for a member of the owning role, and for a superuser; false otherwise, and both
 * statements then fail. Assignment needs the same right over the role being assigned TO, so both
 * are asked, and a connection failing either is refused HERE, with nothing attempted.
 */
async function assertOwnershipCapability(tx: SealCatalogReader, tableOwner: string): Promise<void> {
  const names = MARKER_SEAL_TRIGGERS.map((t) => t.fn);
  const blocked = await tx.$queryRaw<Array<{ fn: string; fn_owner: string; connected: string }>>`
    SELECT p.proname AS fn,
           pg_get_userbyid(p.proowner) AS fn_owner,
           current_user::text AS connected
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = ANY(${names})
       AND NOT pg_has_role(current_user, p.proowner, 'USAGE')
     ORDER BY p.proname`;
  const [assign] = await tx.$queryRaw<Array<{ ok: boolean; connected: string }>>`
    SELECT pg_has_role(current_user, ${tableOwner}::regrole::oid, 'USAGE') AS ok,
           current_user::text AS connected`;

  if (blocked.length === 0 && assign?.ok) return;

  const connected = blocked[0]?.connected ?? assign?.connected ?? 'the connected role';
  const detail = blocked.length > 0
    ? blocked.map((b) => `${b.fn}() is owned by "${b.fn_owner}"`).join('; ')
    : `the seal functions must be owned by "${tableOwner}", the owner of "${MARKER_SEAL_TABLE}"`;
  throw new SealRepairPrivilegeError(
    `4c-iii-r seal repair: "${connected}" cannot replace or re-own the seal functions — ${detail}. `
    + 'PostgreSQL requires ownership of a function to replace its body, and the ownership transfer '
    + 'needs that same right, so neither statement can acquire it. NOTHING has been attempted and '
    + 'the database is unchanged. Re-run this recovery on a connection that is a superuser or a '
    + `member of the owning role(s) — \`GRANT "<owner>" TO "${connected}"\` grants that membership. `
    + 'See docs/RUNBOOK.md §P64CIIIR.',
  );
}

/**
 * Put every EXISTING seal function under the table's owner — the role the verifier compares
 * against, so `OWNER TO CURRENT_USER` would leave a `foreign-owner` finding standing whenever the
 * connected role is not itself the table owner. Functions that do not exist yet are skipped: the
 * `CREATE OR REPLACE` that follows creates them owned by the creating role, and the capability
 * check above has already established that role can be reassigned from.
 */
async function realignFunctionOwners(tx: SealCatalogReader & Pick<PrismaService, '$executeRawUnsafe'>, tableOwner: string): Promise<void> {
  const names = MARKER_SEAL_TRIGGERS.map((t) => t.fn);
  const present = await tx.$queryRaw<Array<{ fn: string }>>`
    SELECT p.proname AS fn
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = ANY(${names})
       AND pg_get_userbyid(p.proowner) <> ${tableOwner}`;
  for (const { fn } of present) {
    if (!/^phase6_4c_iiir_\w+$/u.test(fn)) continue;            // the constant's own shape, never input
    await tx.$executeRawUnsafe(`ALTER FUNCTION ${fn}() OWNER TO "${tableOwner.replace(/"/gu, '""')}"`);
  }
}

export async function repairMarkerSeals(prisma: PrismaService): Promise<MarkerSealRepairReport> {
  const sql = readMarkerSealMigrationSql();
  // Only the seal DDL, never the migration's diagnostic: this deliberately does NOT re-ask the
  // install-time question, and one statement per call because PostgreSQL refuses multiple commands
  // in a prepared statement.
  const [functions, drops, creates] = [
    /CREATE OR REPLACE FUNCTION phase6_4c_iiir_\w+\(\)[\s\S]*?\$\$;/gu,
    /DROP TRIGGER IF EXISTS "[^"]+" ON "OutboxOperatorAction";/gu,
    /CREATE TRIGGER "[^"]+"[\s\S]*?EXECUTE FUNCTION phase6_4c_iiir_\w+\(\);/gu,
  ].map((pattern) => {
    const statements = [...sql.matchAll(pattern)].map((m) => m[0].replace(/;$/u, ''));
    if (statements.length !== MARKER_SEAL_TRIGGERS.length) {
      throw new Error(
        `4c-iii-r seal repair: ${MARKER_SEAL_MIGRATION}/migration.sql yielded ${statements.length} of `
        + `${MARKER_SEAL_TRIGGERS.length} statements for one group. The deployed image is not the `
        + 'reviewed one, so a partial reinstall is refused rather than attempted.',
      );
    }
    return statements;
  });

  // THE MARKER GOES FIRST (Codex on `8eea3ca`). This runs precisely because a seal was missing, and
  // while it was missing any marker on this database could have been inserted, promoted or
  // rewritten by anyone with the application's role. Restoring the seal AROUND such a row would
  // make an unverifiable marker permanent evidence, and the next deploy would skip the rebuild on
  // its word. So the marker is removed as part of the repair, and the next start must earn a new
  // one by running the repair and verifying it. Nothing is lost: the marker is not the repair, and
  // a rebuild is recompute-only.
  //
  // WHICH markers cannot be vouched for is decided by WHICH seal is broken, not by the fact that
  // this command was run. Exactly two of the three seals stand between an attacker and a marker
  // they did not earn, and a finding against EITHER opens the window (Codex round 10, finding 1):
  //
  //   the INSERT GATE  — the only thing stopping a plain `INSERT … 'projection.rebuild.phase6-4c-iii-r'`
  //                      by anyone holding the application's role. The row seal fires BEFORE UPDATE
  //                      OR DELETE and never sees an INSERT, so a gate that is absent, disabled,
  //                      hollowed, re-pointed or re-masked leaves the CHEAPEST forgery of all wide
  //                      open while every other seal reads as intact. An earlier draft keyed
  //                      invalidation on the row seal alone and therefore preserved exactly those
  //                      markers, then reinstalled the gate around them — making a forgery
  //                      permanent evidence, which is the opposite of the repair's purpose.
  //   the ROW SEAL     — the only thing stopping promotion (`UPDATE … SET action = <marker>`) and
  //                      the rewriting of a genuine marker's own columns.
  //
  // The TRUNCATE guard is deliberately NOT in that set. It can only DESTROY markers, never
  // manufacture one, so its absence leaves the markers that survive it exactly as trustworthy as
  // they were; invalidating on it would delete good evidence to punish a risk that ran the other
  // way. (A truncate-then-forge sequence still has to get past the insert gate, and if that gate
  // was also broken this invalidates anyway, on the gate's own finding.)
  // ORDER, and why it is one transaction. With the row seal intact PostgreSQL REFUSES the delete —
  // measured, by the production-runner proof's state F7 — and the insert-gate window is precisely
  // the case where the row seal IS intact. So the drops come first and the delete runs through the
  // gap they open, rather than the delete being skipped because the seal it must bypass is working.
  // All of it commits together: a repair that died between the drop and the create would otherwise
  // leave the table with no seal at all, which is strictly worse than the state it was called on.
  //
  // The DECISION is read inside that transaction too, before its first statement. Read outside it,
  // a seal reinstalled by someone else in between would make the answer describe a database that no
  // longer exists — and this command's whole job is to act on what it found.
  let removed = 0;
  await prisma.$transaction(async (tx) => {
    // THE LOCK COMES BEFORE THE ASSESSMENT (Codex on `9e187be`). `verifyMarkerSeals` is a catalog
    // READ and takes no lock on the table, while the first statement that does — `DROP TRIGGER` —
    // is several statements later. In between, another session can drop the insert gate, INSERT a
    // forged marker and commit. This transaction would then invalidate nothing (its `untrustworthy`
    // answer describes a database that no longer exists), reinstall the canonical seals AROUND the
    // forged row, and report success: the forgery becomes permanent, sealed evidence.
    //
    // The window is widest in exactly the cases the repair is most routine — an idempotent call on
    // an intact table, or one where only the truncate guard is broken — because those are the runs
    // whose assessment says "nothing to invalidate".
    //
    // `SHARE ROW EXCLUSIVE` is the migration's own choice for the same question (round 13), stated
    // once and used in both places: it excludes every writer and conflicts with itself, so no
    // concurrent INSERT and no concurrent repair can interleave, while the `ACCESS EXCLUSIVE` the
    // later `DROP TRIGGER` needs conflicts with everything and cannot be taken around it either.
    // Held to COMMIT, so the assessment and the act it decides describe one state.
    await tx.$executeRawUnsafe(`LOCK TABLE "${MARKER_SEAL_TABLE}" IN SHARE ROW EXCLUSIVE MODE`);

    // READ THE OWNER UNDER THE LOCK, NOT BEFORE IT (Codex on `44f2520`). This read used to be the
    // transaction's first statement, so a concurrent `ALTER TABLE ... OWNER TO` could commit between
    // it and the lock: the capability check and `realignFunctionOwners` would then both use the
    // STALE role, the functions would be recreated owned by it, and the post-transaction verify would
    // report `foreign-owner` — leaving the documented recovery undeployable after having already
    // rewritten the seals. `SHARE ROW EXCLUSIVE` conflicts with the `ACCESS EXCLUSIVE` that
    // `ALTER TABLE ... OWNER TO` takes, so reading it here pins the owner for the transaction.
    const tableOwner = await readTableOwner(tx);

    const before = await verifyMarkerSeals(tx);
    const untrustworthy = before.findings.some(opensForgeryWindow);

    // AN INHERITANCE CHILD IS NOT REPAIRABLE FROM HERE (Codex on `44f2520`). Recreating the three
    // triggers does nothing about it: they are defined on the parent and do not fire for DML against
    // a child, so the moment this returns, another marker can be written there past every seal.
    // Deleting the markers would not help either — `DELETE` without `ONLY` clears the child's rows,
    // but the child survives to receive the next forgery. Dropping someone else's table is not this
    // command's business, so it REFUSES and names what a human must remove. A repair that reported
    // success here would be restoring a seal that is not a seal.
    const inherited = before.findings.filter((f) => f.problem === 'inherited-child');
    if (inherited.length > 0) {
      throw new SealRepairPrivilegeError(
        `4c-iii-r seal repair: public."${MARKER_SEAL_TABLE}" has ${inherited.length} inheritance `
        + `child(ren) — ${inherited.map((f) => f.trigger).join(', ')}. A marker written directly into `
        + 'a child fires none of this table\'s triggers while the marker lookup still finds it, so no '
        + 'seal this command installs would hold. Recreating the triggers would report a success that '
        + 'is not true. Drop the child table(s) — after establishing where they came from, because '
        + 'nothing in this application creates one — then re-run this repair. See docs/RUNBOOK.md '
        + '§P64CIIIR.',
      );
    }

    await assertOwnershipCapability(tx, tableOwner);
    for (const statement of functions) await tx.$executeRawUnsafe(statement);
    for (const statement of drops) await tx.$executeRawUnsafe(statement);
    if (untrustworthy) {
      removed = Number(await tx.$executeRawUnsafe(
        `DELETE FROM "${MARKER_SEAL_TABLE}" WHERE "action" = $1`, PHASE6_4C_IIIR_MARKER_ACTION));
    }
    for (const statement of creates) await tx.$executeRawUnsafe(statement);

    // RE-OWN AFTER THE BODIES EXIST, NOT BEFORE (Codex on `9e187be`). An earlier head aligned
    // ownership first and skipped any function that was ABSENT — so on the documented recovery
    // where a seal function is missing and the operator connects as a superuser or role member
    // rather than as the table owner, `CREATE OR REPLACE FUNCTION` created it owned by the
    // CONNECTED role, the post-verify reported `foreign-owner`, and the CLI exited 3 with the
    // deployment still blocked until someone ran the recovery a second time.
    //
    // Running it here covers both populations at once — functions that already existed under a
    // foreign owner, and functions this transaction has just created. The earlier ordering was
    // justified as protecting the end state "under a partial failure", which was simply WRONG:
    // this is ONE transaction, so a throw anywhere rolls the whole thing back and there is no
    // partial state to protect. `assertOwnershipCapability` above has already established that
    // this connection may perform every one of these transfers.
    await realignFunctionOwners(tx, tableOwner);
  }, { timeout: 60_000, maxWait: 30_000 });

  return { ...(await verifyMarkerSeals(prisma)), markersInvalidated: removed };
}
