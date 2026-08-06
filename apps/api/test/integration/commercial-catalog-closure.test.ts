import { createHash } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { AUTHORITY_GUARDS } from '../../src/commercial/commercial.authority-guards';
import { dtoRaisedByLabels, writerRaisedByLabels } from '../../src/commercial/commercial.raisedby-sets';

/**
 * CLOSURE 10, DATABASE HALF — what PostgreSQL CURRENTLY ENFORCES, asked of PostgreSQL.
 *
 * `docs/reviews/pr-287-convergence.md` is the audit that put this file here. The closure's first
 * two heads each drew three findings and all six were one defect: it asked about live database
 * objects and answered by parsing migration text. Text cannot answer that question —
 *
 *   - a later `DROP` makes an earlier `ADD CONSTRAINT` a historical fact, not a live one;
 *   - a commented-out example is indistinguishable from executed DDL;
 *   - a `CREATE OR REPLACE FUNCTION` that no trigger runs refuses nothing;
 *   - a trigger's name and bound function say nothing about WHEN it fires;
 *   - and 41 of the 80 migrations wrap DDL in conditional `DO $$ BEGIN` blocks whose execution
 *     depends on runtime catalog predicates, so on more than half of them a regex replay is not
 *     approximating the answer, it is guessing.
 *
 * The catalog has none of those failure modes: it is the post-migration state however it was
 * reached. This follows the cleared `src/labour/t3c` precedent, whose seal notes name three of
 * those defects in advance — `pg_trigger` for attachment, EXACT `tgtype` ("equality, not a
 * bitmask") for firing, and byte-equal `pg_proc.prosrc` because `CREATE OR REPLACE` preserves a
 * function's identity, so a seal that stops at a function's NAME accepts a weakened body.
 *
 * The SOURCE half of the closure stays at the desk in `commercial.contract.test.ts`. Source text
 * is the authority for source facts; it is not the authority for this one.
 */
describe('CLOSURE 10 database half — the commercial seals, read from the live catalog', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t?.close();
  });

  const raw = async <T>(sql: string, ...params: unknown[]): Promise<T[]> =>
    (await t.prisma.$queryRawUnsafe(sql, ...params)) as T[];

  /** `pg_trigger.tgtype` bits — `src/include/catalog/pg_trigger.h`. */
  const TG = { ROW: 1, BEFORE: 2, INSERT: 4, DELETE: 8, UPDATE: 16 } as const;
  /** AFTER INSERT OR UPDATE, FOR EACH ROW — what a deferred consume validator must be. */
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
  }

  const triggersOn = (table: string): Promise<LiveTrigger[]> =>
    raw<LiveTrigger>(
      `SELECT t.tgname, t.tgtype::int AS tgtype, t.tgenabled AS enabled,
              (t.tgconstraint <> 0) AS is_constraint, t.tgdeferrable AS deferrable,
              t.tginitdeferred AS initdeferred, t.tgfoid::regproc::text AS fn,
              (SELECT p.prosrc FROM pg_proc p WHERE p.oid = t.tgfoid) AS prosrc
         FROM pg_trigger t
        WHERE t.tgrelid = to_regclass($1) AND NOT t.tgisinternal
        ORDER BY t.tgname`,
      `"${table}"`,
    );

  /**
   * A constraint's NAME is not its identity — `conname` is unique per table, not per database, so a
   * same-named CHECK created on any other relation answers a lookup by name alone. The relation is
   * part of the question, exactly as `tgrelid` is for a trigger.
   */
  const constraintDef = async (name: string, table: string): Promise<string | null> => {
    const rows = await raw<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conname = $1 AND conrelid = to_regclass($2)`,
      name,
      `"${table}"`,
    );
    return rows[0]?.def ?? null;
  };

  /**
   * PL/pgSQL source with SQL comments removed. A body that merely NAMES a helper in a comment is
   * not a body that calls it — the round-2 comment finding, which was fixed in the migration-text
   * reader and survived here in `prosrc`. Root A does not stop being true because the substrate
   * changed.
   */
  const stripSqlComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//gu, ' ').replace(/--[^\n]*/gu, ' ');

  /** Does `body` actually CALL `fn` — a call expression, not a mention? */
  const callsFunction = (body: string, fn: string): boolean =>
    new RegExp(`(?<![\\w.])${fn}\\s*\\(`, 'u').test(stripSqlComments(body));

  /**
   * OFFER TUPLES TO POSTGRESQL AND RECORD WHAT IT DOES.
   *
   * The live CHECK expression is installed verbatim on a temp table and the six tuples that decide
   * "single use" are attempted, each under a savepoint so one refusal does not poison the rest. This
   * is the difference between asserting a constraint SAYS something and proving it ENFORCES it.
   */
  type XorCase =
    | 'unconsumed' | 'certificateOnly' | 'approvalOnly'
    | 'bothTargets' | 'targetWithoutStamp' | 'stampWithoutTarget';

  const XOR_TUPLES: Record<XorCase, [string, string, string]> = {
    unconsumed: ['NULL', 'NULL', 'NULL'],
    certificateOnly: ['now()', `'cert-1'`, 'NULL'],
    approvalOnly: ['now()', 'NULL', `'appr-1'`],
    bothTargets: ['now()', `'cert-1'`, `'appr-1'`],
    targetWithoutStamp: ['NULL', `'cert-1'`, 'NULL'],
    stampWithoutTarget: ['now()', 'NULL', 'NULL'],
  };

  /** What "single use" MEANS, written once and asserted by both the XOR test and the seal pin. */
  const SINGLE_USE_VERDICTS = {
    unconsumed: 'accepted',
    certificateOnly: 'accepted',
    approvalOnly: 'accepted',
    bothTargets: 'refused',
    targetWithoutStamp: 'refused',
    stampWithoutTarget: 'refused',
  } as const;

  /**
   * The same behavioural question for a single-column CHECK: which values does PostgreSQL actually
   * ACCEPT? Parsing the literals a CHECK mentions is not the same question — a weakened
   * `CHECK ("raisedBy" IN (...) OR "raisedBy" IS NOT NULL)` mentions exactly the same labels and
   * admits everything.
   */
  const labelVerdicts = async (
    checkDef: string,
    column: string,
    values: string[],
  ): Promise<Record<string, 'accepted' | 'refused'>> => {
    const expr = checkDef.replace(/^CHECK\s*/iu, '');
    const out: Record<string, 'accepted' | 'refused'> = {};
    await t.prisma
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `CREATE TEMP TABLE label_probe ("${column}" text, CONSTRAINT label_probe_ck CHECK ${expr})`,
        );
        for (const value of values) {
          await tx.$executeRawUnsafe('SAVEPOINT label_sp');
          try {
            await tx.$executeRawUnsafe(`INSERT INTO label_probe VALUES ($1)`, value);
            out[value] = 'accepted';
            await tx.$executeRawUnsafe('RELEASE SAVEPOINT label_sp');
          } catch {
            out[value] = 'refused';
            await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT label_sp');
          }
        }
        throw new Error('__rollback__');
      })
      .catch((e: Error) => {
        if (!/__rollback__/u.test(e.message)) throw e;
      });
    return out;
  };

  /**
   * A helper function's own body, resolved UNAMBIGUOUSLY. `proname` alone can match an overload or a
   * same-named function in another schema, so the seal is the `public` one and there must be exactly
   * one of it.
   */
  const helperBody = async (fn: string): Promise<string> => {
    const rows = await raw<{ prosrc: string }>(
      `SELECT prosrc FROM pg_proc WHERE proname = $1 AND pronamespace = 'public'::regnamespace`,
      fn,
    );
    expect(rows.length, `expected exactly one public ${fn}, found ${rows.length}`).toBe(1);
    return rows[0]!.prosrc;
  };

  /**
   * …and the canonical body of each. A caller can stay byte-identical and still call a helper that a
   * later migration replaced with a no-op, so pinning callers alone leaves the actual predicate
   * unpinned — the sibling of the caller pin, one level down the call graph.
   */
  const HELPER_BODIES: Record<string, string> = {
    phase5_t6a_approved_bound_check: '3e9b54c56b419b0bb2ab7d59de5c46223a1bbb45cc6634f113002be49e43aa23',
    phase5_t6a_paid_bound_check: 'da1653892c0fc87e5b8a71ab6f3d217272d42496a8d8385931196a3a23983e24',
    phase5_t6a_approval_paid_check: '000d68e8f42510361123bb9564077fc8870fc463c0ba32008581a2b03c819b35',
    phase5_t6a_approval_override_valid: '75b32e8cb998339c677ab9a0033f839fca16b3268ee0801cfd061853068afee3',
  };

  const xorVerdicts = async (checkDef: string): Promise<Record<XorCase, 'accepted' | 'refused'>> => {
    const expr = checkDef.replace(/^CHECK\s*/iu, '');
    const out = {} as Record<XorCase, 'accepted' | 'refused'>;
    await t.prisma
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`CREATE TEMP TABLE xor_probe (
            "consumedAt" timestamptz,
            "consumedByCertificateId" text,
            "consumedByApprovalId" text,
            CONSTRAINT xor_probe_ck CHECK ${expr})`);
        for (const [name, [stamp, cert, appr]] of Object.entries(XOR_TUPLES) as Array<
          [XorCase, [string, string, string]]
        >) {
          await tx.$executeRawUnsafe('SAVEPOINT xor_sp');
          try {
            await tx.$executeRawUnsafe(
              `INSERT INTO xor_probe VALUES (${stamp}, ${cert}, ${appr})`,
            );
            out[name] = 'accepted';
            await tx.$executeRawUnsafe('RELEASE SAVEPOINT xor_sp');
          } catch {
            out[name] = 'refused';
            await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT xor_sp');
          }
        }
        throw new Error('__rollback__');
      })
      .catch((e: Error) => {
        if (!/__rollback__/u.test(e.message)) throw e;
      });
    return out;
  };


  // ── 1. the raisedBy set, against its AUTHORITY ────────────────────────────────────────────────

  it('the live BudgetException_raisedBy_check admits exactly the labels both source sets carry', async () => {
    const def = await constraintDef('BudgetException_raisedBy_check', 'BudgetException');
    expect(
      def,
      'no LIVE BudgetException_raisedBy_check in pg_constraint — nothing constrains the column, so the desk-level source agreement is being compared against a rule PostgreSQL is not applying',
    ).not.toBeNull();

    const admitted = [...def!.matchAll(/'([a-z_]+)'::text/gu)].map((m) => m[1]!).sort();
    expect(admitted.length, 'the live CHECK admits nothing — the parse is wrong').toBeGreaterThan(5);

    expect(
      dtoRaisedByLabels(),
      'the labels PostgreSQL admits and the labels the shared DTO declares are different sets: a label only the CHECK knows is one the server can return and every client is told is impossible',
    ).toEqual(admitted);
    expect(
      writerRaisedByLabels(),
      'the labels PostgreSQL admits and the movers `HeadroomMover` can write are different sets: a mover the type allows and the CHECK refuses fails at runtime with a green build',
    ).toEqual(admitted);

    // …and the CHECK must actually REFUSE everything else. Parsing the literals it mentions cannot
    // tell an enumeration from `IN (...) OR "raisedBy" IS NOT NULL`, which mentions the same labels
    // and admits any string a direct writer invents.
    const probe = [...admitted, 'not_a_real_mover'];
    const verdicts = await labelVerdicts(def!, 'raisedBy', probe);
    const expected = Object.fromEntries(
      probe.map((v) => [v, v === 'not_a_real_mover' ? 'refused' : 'accepted']),
    );
    expect(
      verdicts,
      'the live raisedBy CHECK does not enforce the enumeration: every admitted label must be accepted and an unknown label REFUSED, or a direct writer can persist a label no client or mover handles',
    ).toEqual(expected);
  });

  // ── 2. every SodGrant consumption target is named AND really validated ─────────────────────────

  /**
   * The consumption-target family, and the function that must validate each. Derived from the
   * schema below rather than trusted from here — this map only says which trigger OWNS each
   * target, and a target with no entry fails.
   */
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

  const consumptionFamily = (): string[] => {
    const schema = require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', '..', 'prisma', 'schema.prisma'),
      'utf8',
    ) as string;
    const model = /model SodGrant \{([\s\S]*?)\n\}/u.exec(schema);
    expect(model, 'model SodGrant not found — the pin is not reading the schema').not.toBeNull();
    return [...model![1]!.matchAll(/^\s*(consumedBy[A-Za-z]*Id)\s+String\?/gmu)].map((m) => m[1]!);
  };

  /**
   * A CHECK that MENTIONS both columns is not a CHECK that enforces single use. A later migration
   * can keep both names and still admit `consumedAt` with BOTH targets set, and a mention test stays
   * green while the grant is spendable twice.
   *
   * So the rule is proven BEHAVIOURALLY, against the LIVE expression: the constraint definition is
   * read from `pg_constraint` and installed verbatim on a temp table, and the tuples that matter are
   * offered to PostgreSQL. What is asserted is what it accepts and refuses, not what it says.
   */
  it('the live XOR check ENFORCES single use, not merely mentions of each target', async () => {
    const family = consumptionFamily();
    expect(
      family.length,
      'fewer than two consumption targets found — this pin exists because the family GREW, so parsing one member means the parse is wrong',
    ).toBeGreaterThan(1);

    const xor = await constraintDef('SodGrant_consumed_together', 'SodGrant');
    expect(
      xor,
      'no LIVE SodGrant_consumed_together on SodGrant — the grant is not single-use at PostgreSQL at all, and naming targets is beside the point',
    ).not.toBeNull();

    for (const column of family) {
      expect(
        xor!.includes(`"${column}"`),
        `${column} is a consumption target and the live SodGrant_consumed_together CHECK does not mention it`,
      ).toBe(true);
    }

    const verdicts = await xorVerdicts(xor!);
    expect(
      verdicts,
      'the live SodGrant_consumed_together does not enforce single use. Required: unconsumed (all NULL) accepted; exactly ONE target with a stamp accepted; BOTH targets with a stamp REFUSED; a target without a stamp REFUSED; a stamp with no target REFUSED',
    ).toEqual(SINGLE_USE_VERDICTS);
  });

  it('every consumption target has an ATTACHED, enabled, DEFERRABLE INITIALLY DEFERRED row constraint trigger that fires on UPDATE and carries the canonical body', async () => {
    const family = consumptionFamily();
    const live = await triggersOn('SodGrant');
    expect(live.length, 'no live trigger is attached to SodGrant').toBeGreaterThan(0);

    for (const column of family) {
      const expected = CONSUME_VALIDATOR[column];
      expect(
        expected,
        `${column} is a consumption target with no entry in CONSUME_VALIDATOR — name the trigger that validates it, or it is a target nothing checks`,
      ).toBeDefined();

      const trg = live.find((x) => x.tgname === expected!.trigger);
      // attachment is the QUERY, not an inference from text
      expect(
        trg,
        `${expected!.trigger} is not ATTACHED to SodGrant in pg_trigger — a validating function that no trigger runs refuses nothing, which is exactly the state consumedByApprovalId shipped in`,
      ).toBeDefined();
      expect(trg!.enabled, `${expected!.trigger} is not enabled ('O')`).toBe('O');
      expect(
        trg!.is_constraint && trg!.deferrable && trg!.initdeferred,
        `${expected!.trigger} must be a DEFERRABLE INITIALLY DEFERRED constraint trigger: the service stamps the grant with updateMany and inserts the matching override LATER in the same transaction, so a non-deferred check fires before the override row exists`,
      ).toBe(true);
      // equality, not a bitmask: extra events are not harmless, and a missing UPDATE bit means the
      // consume path — which is an UPDATE — sails straight past it
      expect(
        trg!.tgtype,
        `${expected!.trigger} has tgtype ${trg!.tgtype}, expected ${AFTER_INSERT_UPDATE_ROW} (AFTER INSERT OR UPDATE, FOR EACH ROW). Missing events OR extra ones mean this is not that trigger`,
      ).toBe(AFTER_INSERT_UPDATE_ROW);
      expect(trg!.tgtype & TG.UPDATE, `${expected!.trigger} does not fire on UPDATE`).toBe(TG.UPDATE);
      expect(trg!.fn, `${expected!.trigger} is bound to ${trg!.fn}, not ${expected!.fn}`).toBe(expected!.fn);
      expect(
        trg!.prosrc.includes(`"${column}"`),
        `${expected!.fn} is attached but its live body never mentions ${column} — the trigger runs and the target is unvalidated`,
      ).toBe(true);

      // `CREATE OR REPLACE FUNCTION` preserves identity, so name + tgtype + attachment can all hold
      // while the body has been weakened. Byte-pin it (t3c precedent, hashed for size).
      //
      // Hash the body reached THROUGH `tgfoid` — the one this trigger actually runs. Re-querying
      // `pg_proc` by `proname` reintroduces the defect this whole file exists to remove: a name is
      // not an identity, and another schema or overload carrying the pinned body would answer for
      // a weakened function that is the one really attached.
      const sha = createHash('sha256').update(trg!.prosrc, 'utf8').digest('hex');
      expect(
        sha,
        `${expected!.fn} is attached with the right timing but its body is NOT the canonical one. If the change was deliberate, re-pin the hash in CONSUME_VALIDATOR in the same commit that changes the migration`,
      ).toBe(expected!.prosrcSha256);
    }
  });

  // ── 3. every AUTHORITY_GUARDS seal is really ENFORCED, not merely present ─────────────────────

  /**
   * A seal named as a FUNCTION is only a seal if a live trigger runs it. The three §G bound checks
   * and the §I override predicate are all function-valued, and a migration that drops or rewrites
   * `Payment_bound_sealed` while leaving `phase5_t6a_paid_bound_check` defined would leave a
   * presence test green while a direct writer can overpay with nothing firing at COMMIT.
   *
   * So each function-valued seal names its EXPECTED LIVE CALLERS, and every one must be attached to
   * the right relation, enabled, deferred to COMMIT, of the exact firing shape, and carrying the
   * canonical caller body — the body reached through `tgfoid`, byte-pinned, which is strictly
   * stronger than parsing the body for a call expression.
   */
  interface ExpectedCaller {
    trigger: string;
    relation: string;
    /** exact `tgtype`: 5 = AFTER INSERT ROW, 17 = AFTER UPDATE ROW */
    tgtype: number;
    callerFn: string;
    callerSha256: string;
  }

  const APPROVAL_BOUND_SEALED: Omit<ExpectedCaller, 'trigger' | 'relation'> = {
    tgtype: 5,
    callerFn: 'phase5_t6a_approval_bound_sealed',
    callerSha256: '0a06e8a665e764fbc0c9470439a07c984958e9961d79911947a642ac6fc1de8b',
  };
  const PAYMENT_BOUND_SEALED: Omit<ExpectedCaller, 'trigger' | 'relation'> = {
    tgtype: 5,
    callerFn: 'phase5_t6a_payment_bound_sealed',
    callerSha256: '47201aa6f7eac3a5c737c4645b84880f90f9c9ee55f14d0f115cdf067753888e',
  };

  const FUNCTION_SEAL_CALLERS: Record<string, ExpectedCaller[]> = {
    // §G bound 4 — the approved total, fired by both writers that can move it
    phase5_t6a_approved_bound_check: [
      { trigger: 'PaymentApproval_bound_sealed', relation: 'PaymentApproval', ...APPROVAL_BOUND_SEALED },
      { trigger: 'BillDeduction_approved_bound_sealed', relation: 'BillDeduction', ...APPROVAL_BOUND_SEALED },
    ],
    // §G bound 5 at the BILL — also fired on certificate supersession, which moves the right-hand
    // side with no Payment insert to notice (hence the AFTER UPDATE shape on BillCertificate)
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
    // §G bound 5 at the APPROVAL — the row-level question the bill fold cannot ask
    phase5_t6a_approval_paid_check: [
      { trigger: 'Payment_bound_sealed', relation: 'Payment', ...PAYMENT_BOUND_SEALED },
    ],
    // §I — the override predicate both guards defer to
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

  /**
   * TRIGGER-VALUED SEALS. A trigger name is not an identity either: `tgname` is unique per relation,
   * so an enabled same-named trigger on ANY other table answers a global lookup while the guarded
   * relation has none. `tgenabled = 'O'` on top of that proves only that the decoy is switched on.
   *
   * So a trigger seal is pinned the same way a consume validator is — owning relation, enabled,
   * exact firing shape, bound function, and the canonical body reached through `tgfoid`.
   */
  interface TriggerSeal {
    relation: string;
    /** exact `tgtype`: 7 = BEFORE INSERT ROW, 5 = AFTER INSERT ROW */
    tgtype: number;
    fn: string;
    prosrcSha256: string;
    /** true when the guard must be deferred to COMMIT rather than fire at statement time */
    constraintTrigger: boolean;
  }

  const TRIGGER_SEALS: Record<string, TriggerSeal> = {
    // an approval draws on a LIVE certificate — checked BEFORE the row lands
    PaymentApproval_authority_live: {
      relation: 'PaymentApproval',
      tgtype: 7,
      fn: 'phase5_t6a_approval_authority_live',
      prosrcSha256: '595e7e9054760d623729d527565b1130bc447c670abd666d76352bfe15db84dd',
      constraintTrigger: false,
    },
    // money leaves against the authority that covered it
    Payment_authority_live: {
      relation: 'Payment',
      tgtype: 7,
      fn: 'phase5_t6a_payment_authority_live',
      prosrcSha256: 'e60503dd7b7f258d3b52a21a03099fbb7484347cb07976e909fe2d1043150b73',
      constraintTrigger: false,
    },
    // §I's payment half, deferred so the override row may land later in the same transaction
    PaymentApproval_approver_not_certifier: {
      relation: 'PaymentApproval',
      tgtype: 5,
      fn: 'phase5_t6a_approver_not_certifier',
      prosrcSha256: '84dfd52318f0d6bb5401e96881664e9342ebe77644db14dfd2a3fa2c84e8d4fe',
      constraintTrigger: true,
    },
  };

  /**
   * CONSTRAINT-VALUED SEALS. Same defect, same fix: the owning relation is part of the identity, and
   * what the guard REQUIRES is a behaviour, not a definition string — so the seal is discharged by
   * the verdict table, the strongest form available.
   */
  const CONSTRAINT_SEALS: Record<string, { relation: string; behaviour: 'singleUse' }> = {
    SodGrant_consumed_together: { relation: 'SodGrant', behaviour: 'singleUse' },
  };

  const assertTriggerSeal = async (seal: string, want: TriggerSeal): Promise<void> => {
    const live = (await triggersOn(want.relation)).find((x) => x.tgname === seal);
    expect(
      live,
      `${seal} is not ATTACHED to ${want.relation} — a same-named enabled trigger on any other relation would satisfy a global tgname lookup while this one is unguarded`,
    ).toBeDefined();
    expect(live!.enabled, `${seal} is attached to ${want.relation} but not enabled`).toBe('O');
    expect(
      live!.tgtype,
      `${seal} has tgtype ${live!.tgtype}, expected ${want.tgtype} — equality, not a bitmask: a reattachment on the wrong event leaves the guard never firing on the path that matters`,
    ).toBe(want.tgtype);
    expect(
      live!.is_constraint && live!.deferrable && live!.initdeferred,
      `${seal} deferral does not match its guard: expected constraintTrigger=${want.constraintTrigger}`,
    ).toBe(want.constraintTrigger);
    expect(live!.fn, `${seal} is bound to ${live!.fn}, not ${want.fn}`).toBe(want.fn);
    expect(
      createHash('sha256').update(live!.prosrc, 'utf8').digest('hex'),
      `${seal} runs a body that is NOT the canonical ${want.fn}. If the change was deliberate, re-pin the hash in TRIGGER_SEALS in the same commit that changes the migration`,
    ).toBe(want.prosrcSha256);
  };

  it('every seal AUTHORITY_GUARDS names is ENFORCED in the live catalog', async () => {
    const named = [...new Set(AUTHORITY_GUARDS.map((r) => r.seal).filter((s): s is string => s !== null))];
    expect(named.length, 'no seals named — AUTHORITY_GUARDS is not being read').toBeGreaterThan(5);

    for (const seal of named) {
      const kinds = [
        TRIGGER_SEALS[seal] ? 'trigger' : null,
        CONSTRAINT_SEALS[seal] ? 'constraint' : null,
        FUNCTION_SEAL_CALLERS[seal] ? 'function' : null,
      ].filter(Boolean);

      // EVERY seal carries an explicit expected-object specification. Generic name/kind existence is
      // what let a decoy answer for the real object; there is no default arm any more.
      expect(
        kinds,
        `AUTHORITY_GUARDS names ${seal} and no expected live object is specified for it. Add it to TRIGGER_SEALS, CONSTRAINT_SEALS or FUNCTION_SEAL_CALLERS — a seal with no specification is a claim with nothing behind it`,
      ).toHaveLength(1);

      if (TRIGGER_SEALS[seal]) {
        await assertTriggerSeal(seal, TRIGGER_SEALS[seal]!);
        continue;
      }

      if (CONSTRAINT_SEALS[seal]) {
        const want = CONSTRAINT_SEALS[seal]!;
        const def = await constraintDef(seal, want.relation);
        expect(
          def,
          `${seal} is not a live CHECK on ${want.relation} — a same-named constraint on an unrelated relation must not answer for it`,
        ).not.toBeNull();
        expect(
          await xorVerdicts(def!),
          `${seal} is live on ${want.relation} but does not ENFORCE single use`,
        ).toEqual(SINGLE_USE_VERDICTS);
        continue;
      }

      // FUNCTION — presence proves nothing. Name the triggers that run it, and prove each one…
      const callers = FUNCTION_SEAL_CALLERS[seal]!;
      expect(callers.length, `${seal} names no callers`).toBeGreaterThan(0);

      // …AND pin the helper's own live body. Every caller can be byte-identical and still be calling
      // a predicate that a later migration hollowed out.
      const wantHelper = HELPER_BODIES[seal];
      expect(
        wantHelper,
        `${seal} is a function-valued seal with no canonical body pinned in HELPER_BODIES — the callers would be proven while the predicate they call is unconstrained`,
      ).toBeDefined();
      expect(
        createHash('sha256').update(await helperBody(seal), 'utf8').digest('hex'),
        `${seal} is reached by its callers but its OWN body is not the canonical one. A no-op here passes every caller pin while a direct writer overruns the bound with no exception at commit`,
      ).toBe(wantHelper);

      for (const want of callers) {
        const live = (await triggersOn(want.relation)).find((x) => x.tgname === want.trigger);
        expect(
          live,
          `${seal} is sealed by ${want.trigger} on ${want.relation}, and no such trigger is ATTACHED there — the function is still defined, so a presence test would pass while nothing fires`,
        ).toBeDefined();
        expect(live!.enabled, `${want.trigger} is not enabled`).toBe('O');
        expect(
          live!.is_constraint && live!.deferrable && live!.initdeferred,
          `${want.trigger} must stay a DEFERRABLE INITIALLY DEFERRED constraint trigger — these bounds are re-derived at COMMIT over whatever the transaction leaves behind`,
        ).toBe(true);
        expect(
          live!.tgtype,
          `${want.trigger} has tgtype ${live!.tgtype}, expected ${want.tgtype} — equality, not a bitmask`,
        ).toBe(want.tgtype);
        expect(live!.fn, `${want.trigger} is bound to ${live!.fn}, not ${want.callerFn}`).toBe(want.callerFn);
        expect(
          createHash('sha256').update(live!.prosrc, 'utf8').digest('hex'),
          `${want.trigger} runs a body that is NOT the canonical ${want.callerFn}. If the change was deliberate, re-pin the hash in FUNCTION_SEAL_CALLERS in the same commit that changes the migration`,
        ).toBe(want.callerSha256);
        expect(
          callsFunction(live!.prosrc, seal),
          `${want.callerFn} does not CALL ${seal} — a mention in a comment is not an invocation`,
        ).toBe(true);
      }
    }
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
      'a specification names a seal AUTHORITY_GUARDS no longer does — the pin would keep proving an object nothing claims, which is the mirror of the gap it exists to close',
    ).toEqual([]);
  });

  it('every function-valued seal that FUNCTION_SEAL_CALLERS names is actually reached by those callers', async () => {
    // the inverse direction: the map may not name a caller that does not really call the helper,
    // which would make the pin above assert the wrong thing confidently
    for (const [helper, callers] of Object.entries(FUNCTION_SEAL_CALLERS)) {
      for (const want of callers) {
        const live = (await triggersOn(want.relation)).find((x) => x.tgname === want.trigger);
        expect(live, `${want.trigger} not attached to ${want.relation}`).toBeDefined();
        expect(
          callsFunction(live!.prosrc, helper),
          `FUNCTION_SEAL_CALLERS claims ${want.trigger} seals ${helper}, and its live body does not call it`,
        ).toBe(true);
      }
    }
  });

  // ── 4. the closure is LOAD-BEARING: hostile catalog states, each rolled back ───────────────────

  /**
   * The probes above are only worth their runtime if they FAIL when the guarantee is removed. Each
   * of these mutates the live catalog inside a transaction, re-asks the closure's own question, and
   * rolls back — so the hostile state is real (not a mocked string) and leaves nothing behind.
   */
  const inRollback = async (fn: (tx: TestApp['prisma']) => Promise<void>): Promise<void> => {
    await t.prisma
      .$transaction(async (tx) => {
        await fn(tx as unknown as TestApp['prisma']);
        throw new Error('__rollback__');
      })
      .catch((e: Error) => {
        if (!/__rollback__/u.test(e.message)) throw e;
      });
  };

  it('RED probe — dropping the consume trigger ATTACHMENT makes the closure fail', async () => {
    await inRollback(async (tx) => {
      await tx.$executeRawUnsafe('DROP TRIGGER "SodGrant_approval_consume_sealed" ON "SodGrant"');
      const rows = (await tx.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM pg_trigger
          WHERE tgname = 'SodGrant_approval_consume_sealed' AND NOT tgisinternal`,
      )) as Array<{ n: number }>;
      // the FUNCTION is untouched and still mentions the column — which is precisely the state the
      // retired text parser called "validated"
      const fn = (await tx.$queryRawUnsafe(
        `SELECT (prosrc LIKE '%consumedByApprovalId%') AS m FROM pg_proc
          WHERE proname = 'phase5_t6a_grant_approval_consume_sealed'`,
      )) as Array<{ m: boolean }>;
      expect(fn[0]!.m, 'fixture invalid: the function body should still mention the column').toBe(true);
      expect(rows[0]!.n, 'the attachment is gone and the catalog closure must see that').toBe(0);
    });
  });

  it('RED probe — a weakened helper caller makes the closure fail while the helper still exists', async () => {
    await inRollback(async (tx) => {
      await tx.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION phase5_t6a_approver_not_certifier() RETURNS trigger AS $weak$
        BEGIN
          RETURN NEW;
        END;
        $weak$ LANGUAGE plpgsql`);
      const [row] = (await tx.$queryRawUnsafe(
        `SELECT (p.prosrc LIKE '%phase5_t6a_approval_override_valid%') AS calls
           FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
          WHERE t.tgname = 'PaymentApproval_approver_not_certifier' AND NOT t.tgisinternal`,
      )) as Array<{ calls: boolean }>;
      const [{ n }] = (await tx.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'phase5_t6a_approval_override_valid'`,
      )) as Array<{ n: number }>;
      expect(n, 'the helper itself is still defined — a presence test would pass here').toBe(1);
      expect(row!.calls, 'the caller no longer reaches the helper and the closure must see that').toBe(false);
    });
  });

  it('RED probe — re-declaring the consume trigger with the wrong timing changes its tgtype', async () => {
    await inRollback(async (tx) => {
      await tx.$executeRawUnsafe('DROP TRIGGER "SodGrant_approval_consume_sealed" ON "SodGrant"');
      // same name, same function, attached — and INSERT-only, so every consume UPDATE sails past
      await tx.$executeRawUnsafe(`
        CREATE CONSTRAINT TRIGGER "SodGrant_approval_consume_sealed"
          AFTER INSERT ON "SodGrant" DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW EXECUTE FUNCTION phase5_t6a_grant_approval_consume_sealed()`);
      const [row] = (await tx.$queryRawUnsafe(
        `SELECT tgtype::int AS tgtype FROM pg_trigger
          WHERE tgname = 'SodGrant_approval_consume_sealed' AND NOT tgisinternal`,
      )) as Array<{ tgtype: number }>;
      expect(row!.tgtype, 'fixture invalid: expected an INSERT-only row trigger').toBe(TG.ROW + TG.INSERT);
      expect(
        row!.tgtype === AFTER_INSERT_UPDATE_ROW,
        'an attached, enabled, correctly-bound, DEFERRABLE trigger that does not fire on UPDATE must NOT satisfy the closure',
      ).toBe(false);
      expect(row!.tgtype & TG.UPDATE, 'the hostile trigger fires on UPDATE, so the probe proves nothing').toBe(0);
    });
  });

  it('RED probe — a DROPped CHECK is invisible to the catalog even though the migration text still ADDs it', async () => {
    await inRollback(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "SodGrant" DROP CONSTRAINT "SodGrant_consumed_together"');
      const [{ n }] = (await tx.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'SodGrant_consumed_together'`,
      )) as Array<{ n: number }>;
      expect(
        n,
        'the CHECK is dropped; the migration files still contain its ADD CONSTRAINT verbatim, which is exactly why text is not the authority',
      ).toBe(0);
    });
  });


  it('RED probe — a same-name CHECK on ANOTHER relation must not answer for the real one', async () => {
    await inRollback(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "SodGrant" DROP CONSTRAINT "SodGrant_consumed_together"');
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE decoy_rel (
          "consumedAt" timestamptz, "consumedByCertificateId" text, "consumedByApprovalId" text,
          CONSTRAINT "SodGrant_consumed_together" CHECK (true))`);

      const byName = (await tx.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'SodGrant_consumed_together'`,
      )) as Array<{ n: number }>;
      const boundToSodGrant = (await tx.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM pg_constraint
          WHERE conname = 'SodGrant_consumed_together' AND conrelid = to_regclass('"SodGrant"')`,
      )) as Array<{ n: number }>;

      expect(byName[0]!.n, 'the decoy exists, so a lookup by conname alone still finds something').toBe(1);
      expect(
        boundToSodGrant[0]!.n,
        'the relation-bound lookup must see that SodGrant itself is now unprotected — this is the whole point of joining conrelid',
      ).toBe(0);
    });
  });

  it('RED probe — a WEAKENED XOR that still mentions both targets is caught by the behavioural check', async () => {
    // mentions both columns, and happily admits a grant consumed by BOTH at once
    const weakened =
      'CHECK ((("consumedAt" IS NULL) OR ("consumedByCertificateId" IS NOT NULL OR "consumedByApprovalId" IS NOT NULL)))';
    for (const column of ['consumedByCertificateId', 'consumedByApprovalId']) {
      expect(weakened.includes(`"${column}"`), 'fixture invalid: the weakened CHECK must still mention both').toBe(true);
    }
    const verdicts = await xorVerdicts(weakened);
    expect(
      verdicts.bothTargets,
      'the weakened CHECK admits two simultaneous consumption targets; a mention-only test would have passed it',
    ).toBe('accepted');
  });

  it('RED probe — an overloaded/same-name function decoy cannot answer for the ATTACHED body', async () => {
    await inRollback(async (tx) => {
      // weaken the REAL function the trigger runs…
      await tx.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION phase5_t6a_grant_approval_consume_sealed() RETURNS trigger AS $weak$
        BEGIN
          RETURN NEW;  -- "consumedByApprovalId" still named here, and nothing is checked
        END;
        $weak$ LANGUAGE plpgsql`);
      // …and park a same-named decoy in another schema
      await tx.$executeRawUnsafe('CREATE SCHEMA IF NOT EXISTS decoy_ns');
      await tx.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION decoy_ns.phase5_t6a_grant_approval_consume_sealed() RETURNS trigger AS $d$
        BEGIN
          RETURN NEW;
        END;
        $d$ LANGUAGE plpgsql`);

      const byName = (await tx.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'phase5_t6a_grant_approval_consume_sealed'`,
      )) as Array<{ n: number }>;
      expect(
        byName[0]!.n,
        'a proname lookup is now ambiguous — it can select either row, and nothing in the query orders them',
      ).toBe(2);

      // the body reached THROUGH tgfoid is unambiguous, and it is the weakened one
      const [viaTrigger] = (await tx.$queryRawUnsafe(
        `SELECT p.prosrc FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
          WHERE t.tgname = 'SodGrant_approval_consume_sealed' AND NOT t.tgisinternal`,
      )) as Array<{ prosrc: string }>;
      expect(
        viaTrigger!.prosrc.includes('RAISE EXCEPTION'),
        'the attached body is the weakened one, so hashing it must NOT match the canonical pin',
      ).toBe(false);
    });
  });

  it('RED probe — dropping a §G bound trigger while its helper remains must fail the seal', async () => {
    await inRollback(async (tx) => {
      await tx.$executeRawUnsafe('DROP TRIGGER "Payment_bound_sealed" ON "Payment"');
      const [{ fn }] = (await tx.$queryRawUnsafe(
        `SELECT count(*)::int AS fn FROM pg_proc WHERE proname = 'phase5_t6a_paid_bound_check'`,
      )) as Array<{ fn: number }>;
      const [{ trg }] = (await tx.$queryRawUnsafe(
        `SELECT count(*)::int AS trg FROM pg_trigger
          WHERE tgname = 'Payment_bound_sealed' AND NOT tgisinternal`,
      )) as Array<{ trg: number }>;
      expect(fn, 'the §G bound-5 helper is still defined — a presence test would report the seal live').toBe(1);
      expect(
        trg,
        'nothing fires it any more, so a direct writer can overpay with no COMMIT-time check; the caller pin must see this',
      ).toBe(0);
    });
  });

  it('RED probe — a COMMENT-ONLY mention of the helper is not an invocation', async () => {
    await inRollback(async (tx) => {
      await tx.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION phase5_t6a_approver_not_certifier() RETURNS trigger AS $fake$
        BEGIN
          -- phase5_t6a_approval_override_valid(NEW."projectId", NEW."id")
          RETURN NEW;
        END;
        $fake$ LANGUAGE plpgsql`);
      const [row] = (await tx.$queryRawUnsafe(
        `SELECT p.prosrc FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
          WHERE t.tgname = 'PaymentApproval_approver_not_certifier' AND NOT t.tgisinternal`,
      )) as Array<{ prosrc: string }>;

      expect(
        row!.prosrc.includes('phase5_t6a_approval_override_valid'),
        'fixture invalid: the raw substring must still be present — that is what made the old check green',
      ).toBe(true);
      expect(
        callsFunction(row!.prosrc, 'phase5_t6a_approval_override_valid'),
        'a helper named only inside a comment must NOT count as reached',
      ).toBe(false);
      expect(
        createHash('sha256').update(row!.prosrc, 'utf8').digest('hex'),
        'and the canonical-body pin — the preferred proof — must reject this body outright',
      ).not.toBe('84dfd52318f0d6bb5401e96881664e9342ebe77644db14dfd2a3fa2c84e8d4fe');
    });
  });


  it('RED probe — a same-named enabled trigger on a DECOY relation must not answer for the real seal', async () => {
    await inRollback(async (tx) => {
      // the guarded relation loses its authority check…
      await tx.$executeRawUnsafe('DROP TRIGGER "PaymentApproval_authority_live" ON "PaymentApproval"');
      // …and an enabled trigger of the same NAME appears on an unrelated relation
      await tx.$executeRawUnsafe('CREATE TABLE decoy_rel_trg ("id" text)');
      await tx.$executeRawUnsafe(`
        CREATE TRIGGER "PaymentApproval_authority_live" BEFORE INSERT ON decoy_rel_trg
          FOR EACH ROW EXECUTE FUNCTION phase5_t6a_approval_authority_live()`);

      const byName = (await tx.$queryRawUnsafe(
        `SELECT count(*)::int AS n, min(tgenabled) AS enabled FROM pg_trigger
          WHERE tgname = 'PaymentApproval_authority_live' AND NOT tgisinternal`,
      )) as Array<{ n: number; enabled: string }>;
      const onGuarded = (await tx.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM pg_trigger
          WHERE tgname = 'PaymentApproval_authority_live' AND NOT tgisinternal
            AND tgrelid = to_regclass('"PaymentApproval"')`,
      )) as Array<{ n: number }>;

      expect(byName[0]!.n, 'the decoy exists, so a global tgname lookup still finds a trigger').toBe(1);
      expect(
        byName[0]!.enabled,
        'and it is enabled, so the retired kind-exists-and-enabled arm would have passed',
      ).toBe('O');
      expect(
        onGuarded[0]!.n,
        'PaymentApproval now has NO authority check — approvals no longer require a live certificate, and the relation-bound seal must see that',
      ).toBe(0);
    });
  });

  it('RED probe — reattaching a trigger seal on the WRONG event keeps it enabled and named but changes tgtype', async () => {
    await inRollback(async (tx) => {
      await tx.$executeRawUnsafe('DROP TRIGGER "Payment_authority_live" ON "Payment"');
      // right name, right relation, right function, enabled — and it never fires on INSERT
      await tx.$executeRawUnsafe(`
        CREATE TRIGGER "Payment_authority_live" BEFORE DELETE ON "Payment"
          FOR EACH ROW EXECUTE FUNCTION phase5_t6a_payment_authority_live()`);
      const [row] = (await tx.$queryRawUnsafe(
        `SELECT tgtype::int AS tgtype, tgenabled AS enabled FROM pg_trigger
          WHERE tgname = 'Payment_authority_live' AND NOT tgisinternal
            AND tgrelid = to_regclass('"Payment"')`,
      )) as Array<{ tgtype: number; enabled: string }>;
      expect(row!.enabled, 'the decoy is enabled and on the right relation').toBe('O');
      expect(row!.tgtype, 'fixture invalid: expected BEFORE DELETE ROW').toBe(TG.ROW + TG.BEFORE + TG.DELETE);
      expect(
        row!.tgtype === 7,
        'a payment can now be recorded against a superseded authority with nothing firing; the exact-tgtype pin must refuse this',
      ).toBe(false);
    });
  });

  // ── 5. why the substrate moved: the retired parser, shown accepting each hostile state ─────────

  /**
   * These reproduce the RETIRED design's answers on the same states, with no database. They are
   * kept because the convergence audit's claim is not "the parser had bugs" but "the parser cannot
   * answer this question", and a claim like that should be executable rather than asserted.
   *
   * Each fixture is migration TEXT; each assertion shows the parser reporting a guarantee the live
   * catalog above does not make.
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
      '  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = \'SodGrant_consumed_together\') THEN',
      '    ALTER TABLE "SodGrant" ADD CONSTRAINT "SodGrant_consumed_together" CHECK ("consumedAt" IS NULL);',
      '  END IF;',
      'END $$;',
    ].join('\n');
    // The parser returns a body unconditionally. Whether PostgreSQL ran it depends on a predicate
    // evaluated against the catalog at deploy time — which the parser has no way to consult.
    expect(
      retiredLiveCheckBody(sql, 'SodGrant_consumed_together'),
      'the retired parser reports this as installed regardless of the IF NOT EXISTS predicate',
    ).not.toBeNull();
  });
});
