import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { AUTHORITY_GUARDS } from '../../src/commercial/commercial.authority-guards';
import { dtoRaisedByLabels, writerRaisedByLabels } from '../../src/commercial/commercial.raisedby-sets';

/**
 * CLOSURE 10, DATABASE HALF — what PostgreSQL CURRENTLY ENFORCES, asked of PostgreSQL.
 *
 * `docs/reviews/pr-287-convergence.md` is the audit that put this file here. Its two findings, in
 * order of depth:
 *
 *   1. SUBSTRATE. The closure asked about live database objects and answered by parsing migration
 *      text. Text cannot answer that: a later `DROP` makes an earlier `ADD CONSTRAINT` historical, a
 *      comment is indistinguishable from executed DDL, an unattached function refuses nothing, and
 *      41 of the 80 migrations wrap DDL in conditional `DO $$ BEGIN` blocks whose execution depends
 *      on runtime catalog predicates.
 *   2. QUESTION FORM. On the right substrate it still asked whether the right words were PRESENT
 *      where the invariant is whether the rule HOLDS, and still identified objects by NAME where a
 *      name is not an identity.
 *
 * So: reach every object the way PostgreSQL does — `conrelid` for a constraint, `tgfoid` for a body
 * — and where a hostile write is possible, prove the REFUSAL rather than inspect the seal.
 *
 * EVERY CHECK BELOW IS A COLLECTOR, not an inline assertion. A collector takes a database handle and
 * returns the violations it finds, so the hostile probes at the bottom can run the SAME predicate
 * against a deliberately broken catalog and require it to complain. A probe that asserts catalog
 * state directly proves nothing about the closure: delete the closure's assertion and such a probe
 * still passes. These probes fail if the closure stops checking.
 *
 * The SOURCE half stays at the desk in `commercial.contract.test.ts`. Source text is the authority
 * for source facts; it is not the authority for this one.
 */
describe('CLOSURE 10 database half — the commercial seals, read from the live catalog', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t?.close();
  });

  /** Anything that can run raw SQL — the outer client, or a transaction handle inside a probe. */
  interface Sql {
    $queryRawUnsafe(sql: string, ...params: unknown[]): Promise<unknown>;
    $executeRawUnsafe(sql: string, ...params: unknown[]): Promise<unknown>;
  }

  const query = async <T>(db: Sql, sql: string, ...params: unknown[]): Promise<T[]> =>
    (await db.$queryRawUnsafe(sql, ...params)) as T[];

  /**
   * Run `fn` inside a transaction that ALWAYS rolls back. Every collector and every hostile probe
   * runs here: the probes need a transaction so their DDL is undone, and the collectors need one so
   * the behavioural checks can create temp tables and use savepoints.
   */
  const inTx = async (fn: (db: Sql) => Promise<void>): Promise<void> => {
    await t.prisma
      .$transaction(async (tx) => {
        await fn(tx as unknown as Sql);
        throw new Error('__rollback__');
      })
      .catch((e: Error) => {
        if (!/__rollback__/u.test(e.message)) throw e;
      });
  };

  /** `pg_trigger.tgtype` bits — `src/include/catalog/pg_trigger.h`. */
  const TG = { ROW: 1, BEFORE: 2, INSERT: 4, DELETE: 8, UPDATE: 16 } as const;
  const AFTER_INSERT_UPDATE_ROW = TG.ROW + TG.INSERT + TG.UPDATE;

  interface LiveTrigger {
    tgname: string;
    tgtype: number;
    enabled: string;
    is_constraint: boolean;
    deferrable: boolean;
    initdeferred: boolean;
    fn: string;
    prosrc: string;
    /** non-empty when the trigger is declared `UPDATE OF (cols)` — it then skips other columns */
    columns: string;
    /** true when the trigger carries a `WHEN (...)` clause — it may never fire at all */
    conditional: boolean;
    def: string;
  }

  const triggersOn = (db: Sql, table: string): Promise<LiveTrigger[]> =>
    query<LiveTrigger>(
      db,
      `SELECT t.tgname, t.tgtype::int AS tgtype, t.tgenabled AS enabled,
              (t.tgconstraint <> 0) AS is_constraint, t.tgdeferrable AS deferrable,
              t.tginitdeferred AS initdeferred, t.tgfoid::regproc::text AS fn,
              (SELECT p.prosrc FROM pg_proc p WHERE p.oid = t.tgfoid) AS prosrc,
              btrim(t.tgattr::text) AS columns,
              (t.tgqual IS NOT NULL) AS conditional,
              pg_get_triggerdef(t.oid) AS def
         FROM pg_trigger t
        WHERE t.tgrelid = to_regclass($1) AND NOT t.tgisinternal
        ORDER BY t.tgname`,
      `"${table}"`,
    );

  /**
   * A constraint's NAME is not its identity — `conname` is unique per table, not per database, so a
   * same-named CHECK on any other relation answers a lookup by name alone.
   */
  const constraintDef = async (db: Sql, name: string, table: string): Promise<string | null> => {
    const rows = await query<{ def: string }>(
      db,
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = $1 AND conrelid = to_regclass($2)`,
      name,
      `"${table}"`,
    );
    return rows[0]?.def ?? null;
  };

  /**
   * A helper function's own body, resolved UNAMBIGUOUSLY: `proname` alone can match an overload or a
   * same-named function in another schema, so the seal is the `public` one and there must be one.
   */
  const helperBody = async (db: Sql, fn: string): Promise<string | null> => {
    const rows = await query<{ prosrc: string }>(
      db,
      `SELECT prosrc FROM pg_proc WHERE proname = $1 AND pronamespace = 'public'::regnamespace`,
      fn,
    );
    return rows.length === 1 ? rows[0]!.prosrc : null;
  };

  const stripSqlComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/--[^\n]*/gu, ' ');

  /** Does `body` actually CALL `fn` — a call expression, not a mention in a comment? */
  const callsFunction = (body: string, fn: string): boolean =>
    new RegExp(`(?<![\\w.])${fn}\\s*\\(`, 'u').test(stripSqlComments(body));

  const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

  // ── the pinned expectations ───────────────────────────────────────────────────────────────────

  const CONSUME_VALIDATOR: Record<string, { trigger: string; fn: string; prosrcSha256: string }> = {
    consumedByCertificateId: {
      trigger: 'SodGrant_sealed',
      fn: 'phase5_t5_grant_sealed',
      prosrcSha256: '54265fe3058ee73c92be78c67b8f1ec838a5b5057fb24ee4a3558fca72215d6d',
    },
    consumedByApprovalId: {
      trigger: 'SodGrant_approval_consume_sealed',
      fn: 'phase5_t6a_grant_approval_consume_sealed',
      prosrcSha256: '670719cf027e35793159ab0cc850b95738fc4388037bd49ec07b5f9c6c372681',
    },
  };

  interface TriggerSeal {
    relation: string;
    /** exact `tgtype`: 7 = BEFORE INSERT ROW, 5 = AFTER INSERT ROW, 17 = AFTER UPDATE ROW */
    tgtype: number;
    fn: string;
    prosrcSha256: string;
    constraintTrigger: boolean;
  }

  const TRIGGER_SEALS: Record<string, TriggerSeal> = {
    PaymentApproval_authority_live: {
      relation: 'PaymentApproval',
      tgtype: 7,
      fn: 'phase5_t6a_approval_authority_live',
      prosrcSha256: '595e7e9054760d623729d527565b1130bc447c670abd666d76352bfe15db84dd',
      constraintTrigger: false,
    },
    Payment_authority_live: {
      relation: 'Payment',
      tgtype: 7,
      fn: 'phase5_t6a_payment_authority_live',
      prosrcSha256: 'e60503dd7b7f258d3b52a21a03099fbb7484347cb07976e909fe2d1043150b73',
      constraintTrigger: false,
    },
    PaymentApproval_approver_not_certifier: {
      relation: 'PaymentApproval',
      tgtype: 5,
      fn: 'phase5_t6a_approver_not_certifier',
      prosrcSha256: '84dfd52318f0d6bb5401e96881664e9342ebe77644db14dfd2a3fa2c84e8d4fe',
      constraintTrigger: true,
    },
  };

  const CONSTRAINT_SEALS: Record<string, { relation: string }> = {
    SodGrant_consumed_together: { relation: 'SodGrant' },
  };

  interface ExpectedCaller {
    trigger: string;
    relation: string;
    tgtype: number;
    callerFn: string;
    callerSha256: string;
  }

  const APPROVAL_BOUND_SEALED = {
    tgtype: 5,
    callerFn: 'phase5_t6a_approval_bound_sealed',
    callerSha256: '0a06e8a665e764fbc0c9470439a07c984958e9961d79911947a642ac6fc1de8b',
  };
  const PAYMENT_BOUND_SEALED = {
    tgtype: 5,
    callerFn: 'phase5_t6a_payment_bound_sealed',
    callerSha256: '47201aa6f7eac3a5c737c4645b84880f90f9c9ee55f14d0f115cdf067753888e',
  };

  const FUNCTION_SEAL_CALLERS: Record<string, ExpectedCaller[]> = {
    phase5_t6a_approved_bound_check: [
      { trigger: 'PaymentApproval_bound_sealed', relation: 'PaymentApproval', ...APPROVAL_BOUND_SEALED },
      { trigger: 'BillDeduction_approved_bound_sealed', relation: 'BillDeduction', ...APPROVAL_BOUND_SEALED },
    ],
    phase5_t6a_paid_bound_check: [
      { trigger: 'Payment_bound_sealed', relation: 'Payment', ...PAYMENT_BOUND_SEALED },
      {
        trigger: 'BillCertificate_paid_bound_sealed',
        relation: 'BillCertificate',
        tgtype: 17,
        callerFn: 'phase5_t6a_certificate_paid_bound_sealed',
        callerSha256: '954631d8d682222f91d6e7299f025cdf1da68b9cc0fcac18d96a4c25f8b03a1c',
      },
    ],
    phase5_t6a_approval_paid_check: [
      { trigger: 'Payment_bound_sealed', relation: 'Payment', ...PAYMENT_BOUND_SEALED },
    ],
    // Task 6B unit ii — the per-payment reversal bound. Its caller takes the PAYMENT row
    // `FOR UPDATE` before counting, which is what makes it a serialization point rather than a
    // count; the probe that proves the WAIT lives in `phase5-t6b-status-derivation.test.ts`, and
    // this asserts the object it waits on is really the one installed.
    phase5_t6b_ii_reversal_bound_check: [
      {
        trigger: 'PaymentReversal_bound_sealed',
        relation: 'PaymentReversal',
        tgtype: 5,
        callerFn: 'phase5_t6b_ii_reversal_bound_sealed',
        callerSha256: '498c8091a474011d6313fe59ba3dd8b91da435ed63fd693d60f1ce097356427d',
      },
    ],
    phase5_t6a_approval_override_valid: [
      {
        trigger: 'PaymentApproval_approver_not_certifier',
        relation: 'PaymentApproval',
        tgtype: 5,
        callerFn: 'phase5_t6a_approver_not_certifier',
        callerSha256: '84dfd52318f0d6bb5401e96881664e9342ebe77644db14dfd2a3fa2c84e8d4fe',
      },
      {
        trigger: 'SodException_approval_sealed',
        relation: 'SodException',
        tgtype: 5,
        callerFn: 'phase5_t6a_sod_exception_approval_sealed',
        callerSha256: '6a778ce2b143eac82bf75e0082892643370c41d7c0e6351fc5cc4acdb6e95f7d',
      },
    ],
  };

  const HELPER_BODIES: Record<string, string> = {
    phase5_t6a_approved_bound_check: '3e9b54c56b419b0bb2ab7d59de5c46223a1bbb45cc6634f113002be49e43aa23',
    // Task 6B unit ii CHANGED these two, and this pin is what caught it — which is the pin doing
    // exactly its job. §0 defines `PAID(bill)` as Σ payments MINUS Σ payment reversals, and both
    // bounds compute `PAID`; 6A's own comment on the first of them asked for the widening
    // ("Neither may be a raw `Σ` over positive rows once 6B adds reversals"). The hashes move
    // BECAUSE the bodies moved, and the source-side closure that requires the reversal term is
    // `commercial.contract.test.ts`'s CLOSURE B — the two together mean a twin cannot be widened
    // in the migration without this hash moving, nor this hash moved without the twin being widened.
    phase5_t6a_paid_bound_check: 'b106e57478bbbd11854868348bde8b2512910d1073b3bd89203396c8295e3674',
    phase5_t6a_approval_paid_check: '56e9a987063e9d20f57bb2f56e7a9a3dc20870cc071349def7e894a882952eb4',
    phase5_t6a_approval_override_valid: '75b32e8cb998339c677ab9a0033f839fca16b3268ee0801cfd061853068afee3',
    // …and the new one. A no-op body here would pass every caller pin: the trigger would still be
    // installed, deferred and bound to the right function, while the bound it names refused nothing.
    phase5_t6b_ii_reversal_bound_check: 'fd21ee591e5616ae0f794d96d41ed7b14ca02eb4517a7a2edfc671b662cea7d6',
  };

  const consumptionFamily = (): string[] => {
    const schema = readFileSync(join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');
    const model = /model SodGrant \{([\s\S]*?)\n\}/u.exec(schema);
    if (!model) throw new Error('model SodGrant not found — the pin is not reading the schema');
    return [...model[1]!.matchAll(/^\s*(consumedBy[A-Za-z]*Id)\s+String\?/gmu)].map((m) => m[1]!);
  };

  // ── behavioural probes: offer tuples to PostgreSQL and record what it does ────────────────────

  /**
   * The single-use cases, DERIVED from the family rather than hand-listed.
   *
   * Hand-listing gave `targetWithoutStamp` for the certificate arm only, so a CHECK that required
   * `consumedAt` for a certificate and forgot the newer approval arm passed every case — while a
   * direct writer could leave a grant pointing at an approval with `consumedAt` still null, which
   * reads as UNCONSUMED to the CAS path. Every target now gets its own without-stamp case, and every
   * PAIR of targets gets a both-set case, so the next target is covered the moment it is declared.
   */
  interface XorCase {
    name: string;
    stamp: string;
    set: string[];
    expected: 'accepted' | 'refused';
  }

  const xorCases = (family: string[]): XorCase[] => {
    const cases: XorCase[] = [
      { name: 'unconsumed', stamp: 'NULL', set: [], expected: 'accepted' },
      { name: 'stampWithoutTarget', stamp: 'now()', set: [], expected: 'refused' },
    ];
    for (const col of family) {
      cases.push({ name: `${col}Only`, stamp: 'now()', set: [col], expected: 'accepted' });
      cases.push({ name: `${col}WithoutStamp`, stamp: 'NULL', set: [col], expected: 'refused' });
    }
    for (let i = 0; i < family.length; i += 1) {
      for (let j = i + 1; j < family.length; j += 1) {
        cases.push({
          name: `${family[i]}+${family[j]}`,
          stamp: 'now()',
          set: [family[i]!, family[j]!],
          expected: 'refused',
        });
      }
    }
    return cases;
  };

  /** Install `checkDef` verbatim on a temp table and report what each tuple actually does. */
  const xorVerdicts = async (
    db: Sql,
    checkDef: string,
    family: string[],
    cases: XorCase[],
  ): Promise<Record<string, 'accepted' | 'refused'>> => {
    const expr = checkDef.replace(/^CHECK\s*/iu, '');
    const cols = family.map((c) => `"${c}" text`).join(', ');
    const out: Record<string, 'accepted' | 'refused'> = {};
    await db.$executeRawUnsafe('SAVEPOINT xor_outer');
    await db.$executeRawUnsafe(
      `CREATE TEMP TABLE xor_probe ("consumedAt" timestamptz, ${cols},
         CONSTRAINT xor_probe_ck CHECK ${expr}) ON COMMIT DROP`,
    );
    for (const c of cases) {
      const values = [c.stamp, ...family.map((col) => (c.set.includes(col) ? `'v-${col}'` : 'NULL'))];
      await db.$executeRawUnsafe('SAVEPOINT xor_case');
      try {
        await db.$executeRawUnsafe(`INSERT INTO xor_probe VALUES (${values.join(', ')})`);
        out[c.name] = 'accepted';
        await db.$executeRawUnsafe('RELEASE SAVEPOINT xor_case');
      } catch {
        out[c.name] = 'refused';
        await db.$executeRawUnsafe('ROLLBACK TO SAVEPOINT xor_case');
      }
    }
    await db.$executeRawUnsafe('ROLLBACK TO SAVEPOINT xor_outer');
    return out;
  };

  /** The same behavioural question for a single-column CHECK: which values does it ACCEPT? */
  const labelVerdicts = async (
    db: Sql,
    checkDef: string,
    column: string,
    values: string[],
  ): Promise<Record<string, 'accepted' | 'refused'>> => {
    const expr = checkDef.replace(/^CHECK\s*/iu, '');
    const out: Record<string, 'accepted' | 'refused'> = {};
    await db.$executeRawUnsafe('SAVEPOINT label_outer');
    await db.$executeRawUnsafe(
      `CREATE TEMP TABLE label_probe ("${column}" text,
         CONSTRAINT label_probe_ck CHECK ${expr}) ON COMMIT DROP`,
    );
    for (const value of values) {
      await db.$executeRawUnsafe('SAVEPOINT label_case');
      try {
        await db.$executeRawUnsafe('INSERT INTO label_probe VALUES ($1)', value);
        out[value] = 'accepted';
        await db.$executeRawUnsafe('RELEASE SAVEPOINT label_case');
      } catch {
        out[value] = 'refused';
        await db.$executeRawUnsafe('ROLLBACK TO SAVEPOINT label_case');
      }
    }
    await db.$executeRawUnsafe('ROLLBACK TO SAVEPOINT label_outer');
    return out;
  };

  // ── the collectors: every closure predicate, as a function the probes can run ─────────────────

  /**
   * A trigger's firing SHAPE, beyond its events. `AFTER UPDATE OF "someCol"` skips every other
   * column, and `WHEN (false)` never queues at all — both preserve relation, enabled state, tgtype,
   * bound function and canonical body, so a seal filtered away this way is invisible to everything
   * else here.
   */
  const firingViolations = (label: string, trg: LiveTrigger): string[] => {
    const out: string[] = [];
    if (trg.columns !== '') {
      out.push(
        `${label} is declared UPDATE OF a column list (${trg.columns}) — it does not fire for the other columns: ${trg.def}`,
      );
    }
    if (trg.conditional) {
      out.push(`${label} carries a WHEN clause and may never fire: ${trg.def}`);
    }
    return out;
  };

  const consumeSealViolations = async (db: Sql): Promise<string[]> => {
    const out: string[] = [];
    const family = consumptionFamily();
    if (family.length < 2) {
      out.push('fewer than two consumption targets parsed — this pin exists because the family GREW');
    }

    const xor = await constraintDef(db, 'SodGrant_consumed_together', 'SodGrant');
    if (xor === null) {
      out.push(
        'no LIVE SodGrant_consumed_together on SodGrant — the grant is not single-use at PostgreSQL at all',
      );
    } else {
      for (const column of family) {
        if (!xor.includes(`"${column}"`)) {
          out.push(`${column} is a consumption target the live XOR CHECK does not mention`);
        }
      }
      const cases = xorCases(family);
      const verdicts = await xorVerdicts(db, xor, family, cases);
      for (const c of cases) {
        if (verdicts[c.name] !== c.expected) {
          out.push(
            `single use not enforced: case ${c.name} was ${verdicts[c.name]}, expected ${c.expected}`,
          );
        }
      }
    }

    const live = await triggersOn(db, 'SodGrant');
    for (const column of family) {
      const want = CONSUME_VALIDATOR[column];
      if (!want) {
        out.push(`${column} is a consumption target with no entry in CONSUME_VALIDATOR`);
        continue;
      }
      const trg = live.find((x) => x.tgname === want.trigger);
      if (!trg) {
        out.push(
          `${want.trigger} is not ATTACHED to SodGrant — a validating function no trigger runs refuses nothing`,
        );
        continue;
      }
      if (trg.enabled !== 'O') out.push(`${want.trigger} is not enabled`);
      if (!(trg.is_constraint && trg.deferrable && trg.initdeferred)) {
        out.push(`${want.trigger} must be a DEFERRABLE INITIALLY DEFERRED constraint trigger`);
      }
      if (trg.tgtype !== AFTER_INSERT_UPDATE_ROW) {
        out.push(
          `${want.trigger} has tgtype ${trg.tgtype}, expected ${AFTER_INSERT_UPDATE_ROW} (AFTER INSERT OR UPDATE, FOR EACH ROW)`,
        );
      }
      out.push(...firingViolations(want.trigger, trg));
      if (trg.fn !== want.fn) out.push(`${want.trigger} is bound to ${trg.fn}, not ${want.fn}`);
      if (!trg.prosrc?.includes(`"${column}"`)) {
        out.push(`${want.fn} is attached but its live body never mentions ${column}`);
      }
      if (sha(trg.prosrc ?? '') !== want.prosrcSha256) {
        out.push(`${want.trigger} runs a body that is NOT the canonical ${want.fn}`);
      }
    }
    return out;
  };

  const authoritySealViolations = async (db: Sql): Promise<string[]> => {
    const out: string[] = [];
    const named = [...new Set(AUTHORITY_GUARDS.map((r) => r.seal).filter((s): s is string => s !== null))];

    for (const seal of named) {
      const kinds = [
        TRIGGER_SEALS[seal] ? 'trigger' : null,
        CONSTRAINT_SEALS[seal] ? 'constraint' : null,
        FUNCTION_SEAL_CALLERS[seal] ? 'function' : null,
      ].filter(Boolean);

      if (kinds.length !== 1) {
        out.push(
          `${seal} has ${kinds.length} expected-object specifications, expected exactly 1 — a seal with none is a claim with nothing behind it`,
        );
        continue;
      }

      if (TRIGGER_SEALS[seal]) {
        const want = TRIGGER_SEALS[seal]!;
        const trg = (await triggersOn(db, want.relation)).find((x) => x.tgname === seal);
        if (!trg) {
          out.push(
            `${seal} is not ATTACHED to ${want.relation} — a same-named trigger on another relation must not answer for it`,
          );
          continue;
        }
        if (trg.enabled !== 'O') out.push(`${seal} is attached to ${want.relation} but not enabled`);
        if (trg.tgtype !== want.tgtype) {
          out.push(`${seal} has tgtype ${trg.tgtype}, expected ${want.tgtype}`);
        }
        if ((trg.is_constraint && trg.deferrable && trg.initdeferred) !== want.constraintTrigger) {
          out.push(`${seal} deferral does not match its guard`);
        }
        out.push(...firingViolations(seal, trg));
        if (trg.fn !== want.fn) out.push(`${seal} is bound to ${trg.fn}, not ${want.fn}`);
        if (sha(trg.prosrc ?? '') !== want.prosrcSha256) {
          out.push(`${seal} runs a body that is NOT the canonical ${want.fn}`);
        }
        continue;
      }

      if (CONSTRAINT_SEALS[seal]) {
        const want = CONSTRAINT_SEALS[seal]!;
        const def = await constraintDef(db, seal, want.relation);
        if (def === null) out.push(`${seal} is not a live CHECK on ${want.relation}`);
        // its behaviour is proven by consumeSealViolations, which owns the single-use rule
        continue;
      }

      const callers = FUNCTION_SEAL_CALLERS[seal]!;
      const body = await helperBody(db, seal);
      if (body === null) {
        out.push(`${seal} does not resolve to exactly one public function`);
      } else if (sha(body) !== HELPER_BODIES[seal]) {
        out.push(
          `${seal} is reached by its callers but its OWN body is not canonical — a no-op here passes every caller pin`,
        );
      }
      for (const want of callers) {
        const trg = (await triggersOn(db, want.relation)).find((x) => x.tgname === want.trigger);
        if (!trg) {
          out.push(
            `${seal} is sealed by ${want.trigger} on ${want.relation}, and no such trigger is ATTACHED there`,
          );
          continue;
        }
        if (trg.enabled !== 'O') out.push(`${want.trigger} is not enabled`);
        if (!(trg.is_constraint && trg.deferrable && trg.initdeferred)) {
          out.push(`${want.trigger} must stay a DEFERRABLE INITIALLY DEFERRED constraint trigger`);
        }
        if (trg.tgtype !== want.tgtype) {
          out.push(`${want.trigger} has tgtype ${trg.tgtype}, expected ${want.tgtype}`);
        }
        out.push(...firingViolations(want.trigger, trg));
        if (trg.fn !== want.callerFn) out.push(`${want.trigger} is bound to ${trg.fn}, not ${want.callerFn}`);
        if (sha(trg.prosrc ?? '') !== want.callerSha256) {
          out.push(`${want.trigger} runs a body that is NOT the canonical ${want.callerFn}`);
        }
        if (!callsFunction(trg.prosrc ?? '', seal)) {
          out.push(`${want.callerFn} does not CALL ${seal} — a mention in a comment is not an invocation`);
        }
      }
    }
    return out;
  };

  const raisedBySetViolations = async (db: Sql): Promise<string[]> => {
    const out: string[] = [];
    const def = await constraintDef(db, 'BudgetException_raisedBy_check', 'BudgetException');
    if (def === null) return ['no LIVE BudgetException_raisedBy_check on BudgetException'];

    const admitted = [...def.matchAll(/'([a-z_]+)'::text/gu)].map((m) => m[1]!).sort();
    if (admitted.length < 5) out.push('the live CHECK admits nothing — the parse is wrong');

    const declared = dtoRaisedByLabels();
    const writes = writerRaisedByLabels();
    if (JSON.stringify(declared) !== JSON.stringify(admitted)) {
      out.push('the labels PostgreSQL admits and the labels the shared DTO declares are different sets');
    }
    if (JSON.stringify(writes) !== JSON.stringify(admitted)) {
      out.push('the labels PostgreSQL admits and the movers HeadroomMover can write are different sets');
    }

    const unknown = 'not_a_real_mover';
    const verdicts = await labelVerdicts(db, def, 'raisedBy', [...admitted, unknown]);
    for (const label of admitted) {
      if (verdicts[label] !== 'accepted') out.push(`the live CHECK refuses an admitted label: ${label}`);
    }
    if (verdicts[unknown] !== 'refused') {
      out.push(
        'the live raisedBy CHECK ACCEPTS an unknown label — it mentions an enumeration without enforcing one',
      );
    }
    return out;
  };

  // ── 1. the closure, run against the real database ────────────────────────────────────────────

  it('the live raisedBy CHECK admits exactly both source sets and REFUSES anything else', async () => {
    await inTx(async (db) => {
      expect(await raisedBySetViolations(db)).toEqual([]);
    });
  });

  it('every SodGrant consumption target is named, ENFORCED single-use, and validated by a live trigger', async () => {
    await inTx(async (db) => {
      expect(await consumeSealViolations(db)).toEqual([]);
    });
  });

  it('every seal AUTHORITY_GUARDS names is ENFORCED in the live catalog', async () => {
    await inTx(async (db) => {
      expect(await authoritySealViolations(db)).toEqual([]);
    });
  });

  it('no expected-object specification is STALE — every spec answers a seal AUTHORITY_GUARDS still names', () => {
    const named = new Set(AUTHORITY_GUARDS.map((r) => r.seal).filter((s): s is string => s !== null));
    const specified = [
      ...Object.keys(TRIGGER_SEALS),
      ...Object.keys(CONSTRAINT_SEALS),
      ...Object.keys(FUNCTION_SEAL_CALLERS),
    ];
    expect(
      specified.filter((s) => !named.has(s)),
      'a specification names a seal AUTHORITY_GUARDS no longer does — the pin would keep proving an object nothing claims',
    ).toEqual([]);
  });

  it('the derived XOR cases cover every target and every pair', () => {
    const family = consumptionFamily();
    const names = xorCases(family).map((c) => c.name);
    for (const col of family) {
      expect(names, `${col} has no without-stamp case`).toContain(`${col}WithoutStamp`);
      expect(names, `${col} has no only-this-target case`).toContain(`${col}Only`);
    }
    expect(names.length, 'the pair cases are missing').toBeGreaterThanOrEqual(2 + family.length * 2 + 1);
  });

  // ── 2. the closure is LOAD-BEARING: hostile catalog states, each RE-ASKING the closure ────────

  /**
   * Each probe breaks the catalog and then runs the SAME collector the passing tests run, requiring
   * it to complain about that exact break. Asserting the catalog directly would prove nothing: if a
   * later edit deletes the closure's attachment check, a direct-state probe still passes and the
   * "RED probe" is no longer evidence for anything.
   */
  const expectViolation = (violations: string[], needle: string): void => {
    expect(
      violations.some((v) => v.includes(needle)),
      `the closure did not report "${needle}". It found: ${JSON.stringify(violations, null, 2)}`,
    ).toBe(true);
  };

  it('RED probe — dropping the consume trigger ATTACHMENT is caught by the closure', async () => {
    await inTx(async (db) => {
      await db.$executeRawUnsafe('DROP TRIGGER "SodGrant_approval_consume_sealed" ON "SodGrant"');
      expectViolation(await consumeSealViolations(db), 'is not ATTACHED to SodGrant');
    });
  });

  it('RED probe — re-declaring the consume trigger INSERT-only is caught by the closure', async () => {
    await inTx(async (db) => {
      await db.$executeRawUnsafe('DROP TRIGGER "SodGrant_approval_consume_sealed" ON "SodGrant"');
      await db.$executeRawUnsafe(`
        CREATE CONSTRAINT TRIGGER "SodGrant_approval_consume_sealed"
          AFTER INSERT ON "SodGrant" DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW EXECUTE FUNCTION phase5_t6a_grant_approval_consume_sealed()`);
      expectViolation(await consumeSealViolations(db), 'expected 21');
    });
  });

  it('RED probe — a WHEN-filtered seal that never fires is caught by the closure', async () => {
    await inTx(async (db) => {
      await db.$executeRawUnsafe('DROP TRIGGER "SodGrant_approval_consume_sealed" ON "SodGrant"');
      await db.$executeRawUnsafe(`
        CREATE CONSTRAINT TRIGGER "SodGrant_approval_consume_sealed"
          AFTER INSERT OR UPDATE ON "SodGrant" DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW WHEN (false) EXECUTE FUNCTION phase5_t6a_grant_approval_consume_sealed()`);
      expectViolation(await consumeSealViolations(db), 'carries a WHEN clause');
    });
  });

  it('RED probe — an UPDATE OF column-list seal that skips the consume column is caught', async () => {
    await inTx(async (db) => {
      await db.$executeRawUnsafe('DROP TRIGGER "Payment_authority_live" ON "Payment"');
      await db.$executeRawUnsafe(`
        CREATE TRIGGER "Payment_authority_live" BEFORE UPDATE OF "amount" ON "Payment"
          FOR EACH ROW EXECUTE FUNCTION phase5_t6a_payment_authority_live()`);
      expectViolation(await authoritySealViolations(db), 'UPDATE OF a column list');
    });
  });

  it('RED probe — a same-name CHECK on ANOTHER relation does not answer for the real one', async () => {
    await inTx(async (db) => {
      await db.$executeRawUnsafe('ALTER TABLE "SodGrant" DROP CONSTRAINT "SodGrant_consumed_together"');
      await db.$executeRawUnsafe(`CREATE TEMP TABLE decoy_rel (
          "consumedAt" timestamptz, "consumedByCertificateId" text, "consumedByApprovalId" text,
          CONSTRAINT "SodGrant_consumed_together" CHECK (true)) ON COMMIT DROP`);
      expectViolation(await consumeSealViolations(db), 'no LIVE SodGrant_consumed_together');
    });
  });

  it('RED probe — a WEAKENED XOR that still mentions both targets is caught behaviourally', async () => {
    await inTx(async (db) => {
      await db.$executeRawUnsafe('ALTER TABLE "SodGrant" DROP CONSTRAINT "SodGrant_consumed_together"');
      // mentions both columns, and admits a grant consumed by BOTH at once
      await db.$executeRawUnsafe(`ALTER TABLE "SodGrant" ADD CONSTRAINT "SodGrant_consumed_together"
        CHECK ((("consumedAt" IS NULL) OR ("consumedByCertificateId" IS NOT NULL OR "consumedByApprovalId" IS NOT NULL)))`);
      expectViolation(await consumeSealViolations(db), 'single use not enforced');
    });
  });

  it('RED probe — an XOR that forgets the newer arm without a stamp is caught', async () => {
    await inTx(async (db) => {
      await db.$executeRawUnsafe('ALTER TABLE "SodGrant" DROP CONSTRAINT "SodGrant_consumed_together"');
      // requires consumedAt for the CERTIFICATE arm and forgets the approval arm entirely
      await db.$executeRawUnsafe(`ALTER TABLE "SodGrant" ADD CONSTRAINT "SodGrant_consumed_together"
        CHECK (
          (("consumedAt" IS NULL) AND ("consumedByCertificateId" IS NULL))
          OR (("consumedAt" IS NOT NULL) AND ((("consumedByCertificateId" IS NOT NULL))::integer + (("consumedByApprovalId" IS NOT NULL))::integer) <= 1)
          OR ("consumedAt" IS NULL AND "consumedByApprovalId" IS NOT NULL)
        )`);
      expectViolation(await consumeSealViolations(db), 'consumedByApprovalIdWithoutStamp');
    });
  });

  it('RED probe — a weakened helper CALLER is caught while the helper still exists', async () => {
    await inTx(async (db) => {
      await db.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION phase5_t6a_approver_not_certifier() RETURNS trigger AS $weak$
        BEGIN
          -- phase5_t6a_approval_override_valid(NEW."projectId", NEW."id")
          RETURN NEW;
        END;
        $weak$ LANGUAGE plpgsql`);
      const violations = await authoritySealViolations(db);
      expectViolation(violations, 'does not CALL phase5_t6a_approval_override_valid');
      // the helper itself is untouched — a presence test would have passed
      expect(await helperBody(db, 'phase5_t6a_approval_override_valid')).not.toBeNull();
    });
  });

  it('RED probe — a hollowed-out HELPER is caught while every caller stays byte-identical', async () => {
    await inTx(async (db) => {
      await db.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION phase5_t6a_paid_bound_check(p_project text, p_bill text)
        RETURNS void AS $noop$ BEGIN RETURN; END; $noop$ LANGUAGE plpgsql`);
      expectViolation(await authoritySealViolations(db), 'its OWN body is not canonical');
    });
  });

  it('RED probe — dropping a §G bound trigger while its helper remains is caught', async () => {
    await inTx(async (db) => {
      await db.$executeRawUnsafe('DROP TRIGGER "Payment_bound_sealed" ON "Payment"');
      expectViolation(await authoritySealViolations(db), 'no such trigger is ATTACHED there');
    });
  });

  it('RED probe — a same-named enabled trigger on a DECOY relation does not answer for the seal', async () => {
    await inTx(async (db) => {
      await db.$executeRawUnsafe('DROP TRIGGER "PaymentApproval_authority_live" ON "PaymentApproval"');
      await db.$executeRawUnsafe('CREATE TEMP TABLE decoy_rel_trg ("id" text) ON COMMIT DROP');
      await db.$executeRawUnsafe(`
        CREATE TRIGGER "PaymentApproval_authority_live" BEFORE INSERT ON decoy_rel_trg
          FOR EACH ROW EXECUTE FUNCTION phase5_t6a_approval_authority_live()`);
      expectViolation(await authoritySealViolations(db), 'is not ATTACHED to PaymentApproval');
    });
  });

  it('RED probe — an overloaded same-name function decoy cannot answer for the ATTACHED body', async () => {
    await inTx(async (db) => {
      await db.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION phase5_t6a_grant_approval_consume_sealed() RETURNS trigger AS $weak$
        BEGIN
          RETURN NEW;  -- "consumedByApprovalId" named here, and nothing is checked
        END;
        $weak$ LANGUAGE plpgsql`);
      await db.$executeRawUnsafe('CREATE SCHEMA IF NOT EXISTS decoy_ns');
      await db.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION decoy_ns.phase5_t6a_grant_approval_consume_sealed() RETURNS trigger
        AS $d$ BEGIN RETURN NEW; END; $d$ LANGUAGE plpgsql`);
      expectViolation(await consumeSealViolations(db), 'is NOT the canonical');
    });
  });

  it('RED probe — a weakened raisedBy CHECK that keeps every literal is caught behaviourally', async () => {
    await inTx(async (db) => {
      const def = await constraintDef(db, 'BudgetException_raisedBy_check', 'BudgetException');
      const expr = def!.replace(/^CHECK\s*/iu, '');
      await db.$executeRawUnsafe('ALTER TABLE "BudgetException" DROP CONSTRAINT "BudgetException_raisedBy_check"');
      await db.$executeRawUnsafe(
        `ALTER TABLE "BudgetException" ADD CONSTRAINT "BudgetException_raisedBy_check"
           CHECK (${expr} OR "raisedBy" IS NOT NULL)`,
      );
      expectViolation(await raisedBySetViolations(db), 'ACCEPTS an unknown label');
    });
  });

  // ── 3. why the substrate moved: the retired parser, shown accepting each hostile state ────────

  /**
   * These reproduce the RETIRED design's answers with no database. The audit's claim is not "the
   * parser had bugs" but "the parser cannot answer this question", and a claim like that should be
   * executable rather than asserted.
   */
  const retiredLiveCheckBody = (sql: string, constraint: string): string | null => {
    const stream = new RegExp(
      `DROP\\s+CONSTRAINT\\s+(?:IF\\s+EXISTS\\s+)?"${constraint}"`
        + `|ADD\\s+CONSTRAINT\\s+"${constraint}"\\s*CHECK\\s*\\(([\\s\\S]*?)\\);`,
      'gu',
    );
    let live: string | null = null;
    for (const op of sql.matchAll(stream)) live = op[1] ?? null;
    return live;
  };

  it('the retired parser accepts a COMMENTED example as live DDL', () => {
    const sql = [
      'ALTER TABLE "SodGrant" DROP CONSTRAINT "SodGrant_consumed_together";',
      '-- for reference, the shape we used to install was:',
      '--   ALTER TABLE "SodGrant" ADD CONSTRAINT "SodGrant_consumed_together" CHECK ("consumedAt" IS NULL);',
    ].join('\n');
    expect(
      retiredLiveCheckBody(sql, 'SodGrant_consumed_together'),
      'the retired parser reads a commented example as an installed CHECK; PostgreSQL has nothing here',
    ).not.toBeNull();
  });

  it('the retired parser cannot evaluate a conditional DO block, which 41 of 80 migrations use', () => {
    const sql = [
      'DO $$ BEGIN',
      "  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SodGrant_consumed_together') THEN",
      '    ALTER TABLE "SodGrant" ADD CONSTRAINT "SodGrant_consumed_together" CHECK ("consumedAt" IS NULL);',
      '  END IF;',
      'END $$;',
    ].join('\n');
    expect(
      retiredLiveCheckBody(sql, 'SodGrant_consumed_together'),
      'the retired parser reports this as installed regardless of the IF NOT EXISTS predicate',
    ).not.toBeNull();
  });
});
