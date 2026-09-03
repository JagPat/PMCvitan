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
  return finding.problem === 'unexpected-writer' || MARKER_FORGERY_SEALS.has(finding.fn);
}

/** `dist/platform/projections` and `src/platform/projections` are both three levels under `apps/api`. */
function migrationSqlPath(): string {
  return join(__dirname, '..', '..', '..', 'prisma', 'migrations', MARKER_SEAL_MIGRATION, 'migration.sql');
}

export function readMarkerSealMigrationSql(): string {
  return readFileSync(migrationSqlPath(), 'utf8');
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
  problem: 'absent' | 'disabled' | 'wrong-function' | 'wrong-timing' | 'conditional' | 'body-replaced' | 'foreign-owner' | 'unexpected-writer';
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
           pg_get_userbyid(p.proowner) AS fn_owner,
           pg_get_userbyid(c.relowner) AS table_owner
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = t.tgfoid
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
    const before = await verifyMarkerSeals(tx);
    const untrustworthy = before.findings.some(opensForgeryWindow);
    for (const statement of functions) await tx.$executeRawUnsafe(statement);
    for (const statement of drops) await tx.$executeRawUnsafe(statement);
    if (untrustworthy) {
      removed = Number(await tx.$executeRawUnsafe(
        `DELETE FROM "${MARKER_SEAL_TABLE}" WHERE "action" = $1`, PHASE6_4C_IIIR_MARKER_ACTION));
    }
    for (const statement of creates) await tx.$executeRawUnsafe(statement);
  }, { timeout: 60_000, maxWait: 30_000 });

  return { ...(await verifyMarkerSeals(prisma)), markersInvalidated: removed };
}
