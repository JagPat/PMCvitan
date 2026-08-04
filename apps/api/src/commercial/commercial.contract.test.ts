import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMERCIAL_COMMANDS, COMMERCIAL_QUERIES } from '@vitan/shared';
import { commercialManifest } from './commercial.manifest';

const HERE = join(__dirname);
const SRC = join(__dirname, '..');

/**
 * Phase 5 Task 2 — the two MECHANICAL closures the PR #270 convergence audit
 * (`docs/reviews/pr-270-convergence.md`) makes due. Both roots are recorded there; this file is
 * where each stops being a thing a reviewer has to notice.
 *
 * These are structural pins over source text, deliberately. They run in `pnpm check` with no
 * database, so they fail at the desk rather than in a review round — which is the whole point:
 * seven of the PR's findings were "declared but unreachable" or "the rule was re-stated as a list
 * and the list went stale", and neither class needs a live database to catch.
 */
describe('commercial contract closure (Phase 5 Task 2 convergence)', () => {
  /**
   * CLOSURE 1 — EVERY DECLARED SURFACE IS REACHABLE (audit root 1).
   *
   * Three of the seven findings were the same sentence in different words: `commercial.budget`
   * declared with no route, `BudgetLine` shipped with no command, the headroom fold written with
   * no caller. A declaration nobody can reach is worse than an absent one — the manifest asserts
   * a capability the product does not have, and every reader downstream believes it.
   *
   * So the declaration itself is the test: each entry in `COMMERCIAL_COMMANDS`/`COMMERCIAL_QUERIES`
   * must name a real handler. Declaring the NEXT one without building it fails here.
   */
  const commandSite: Record<(typeof COMMERCIAL_COMMANDS)[number], { file: string; needle: string }> = {
    'commercial.costHead.define': { file: 'commercial/commercial.service.ts', needle: "commandType: 'commercial.costHead.define'" },
    'commercial.attribution.reattribute': { file: 'commercial/commercial.service.ts', needle: "commandType: 'commercial.attribution.reattribute'" },
    'commercial.budget.set': { file: 'commercial/commercial-budget.service.ts', needle: "commandType: 'commercial.budget.set'" },
    // Task 3 (§D) — both measurement writes run through ONE `append`, which passes the caller's
    // `commandType` straight to `executeCommand`; the union type on that parameter is what makes
    // the two literals reachable, so the needle is the type rather than a call-site string.
    'commercial.measurement.take': { file: 'commercial/commercial-measurement.service.ts', needle: "'commercial.measurement.take'" },
    'commercial.measurement.correct': { file: 'commercial/commercial-measurement.service.ts', needle: "'commercial.measurement.correct'" },
    // Task 4 (§F) — the claim lifecycle. `submit`/`beginVerification`/`reject` share ONE
    // `transition` helper that passes the caller's `commandType` straight to `executeCommand`,
    // so — exactly as for the two measurement writes — the needle is the union member on that
    // parameter rather than a call-site string.
    'commercial.bill.record': { file: 'commercial/commercial-bill.service.ts', needle: "commandType: 'commercial.bill.record'" },
    'commercial.bill.submit': { file: 'commercial/commercial-bill.service.ts', needle: "'commercial.bill.submit'" },
    'commercial.bill.beginVerification': { file: 'commercial/commercial-bill.service.ts', needle: "'commercial.bill.beginVerification'" },
    'commercial.bill.amend': { file: 'commercial/commercial-bill.service.ts', needle: "commandType: 'commercial.bill.amend'" },
    'commercial.bill.reject': { file: 'commercial/commercial-bill.service.ts', needle: "'commercial.bill.reject'" },
    // Phase 5 Task 5A (§E) — the verdict lives in its OWN service, not on the bill service: it
    // reads four modules' evidence under a five-step lock order, and folding that into the claim
    // lifecycle would make one file own both "what the vendor says" and "whether it is true".
    'commercial.bill.verify': { file: 'commercial/commercial-verification.service.ts', needle: "'commercial.bill.verify'" },
    'commercial.bill.certify': { file: 'commercial/commercial-certification.service.ts', needle: "'commercial.bill.certify'" },
    'commercial.sod.grant': { file: 'commercial/commercial-certification.service.ts', needle: "'commercial.sod.grant'" },
    'commercial.deduction.record': { file: 'commercial/commercial-deduction.service.ts', needle: "commandType: 'commercial.deduction.record'" },
    'commercial.deduction.release': { file: 'commercial/commercial-deduction.service.ts', needle: "commandType: 'commercial.deduction.release'" },
    'commercial.certificate.supersede': { file: 'commercial/commercial-certification.service.ts', needle: "'commercial.certificate.supersede'" },
  };
  const querySite: Record<(typeof COMMERCIAL_QUERIES)[number], string> = {
    'commercial.costHeads': "Get('commercial/cost-heads')",
    'commercial.attributions': "Get('commercial/attributions')",
    'commercial.budget': "Get('commercial/budget')",
    'commercial.measurements': "Get('commercial/labour-po-lines/:labourPoLineId/measurements')",
    'commercial.bills': "Get('commercial/bills')",
    'commercial.bill': "Get('commercial/bills/:billId')",
    'commercial.verification': "Get('commercial/bills/:billId/verification')",
    'commercial.certificate': "Get('commercial/bills/:billId/certificate')",
    'commercial.deductions': "Get('commercial/bills/:billId/deductions')",
  };

  it('every declared command has an executeCommand site with that exact commandType', () => {
    for (const command of COMMERCIAL_COMMANDS) {
      const site = commandSite[command];
      expect(site, `${command} is declared but this table does not say where it is executed`).toBeDefined();
      const src = readFileSync(join(SRC, site.file), 'utf8');
      expect(
        src.includes(site.needle),
        `${command} is declared in COMMERCIAL_COMMANDS but ${site.file} runs no such command — a declared write path that cannot be reached`,
      ).toBe(true);
    }
    expect(Object.keys(commandSite).sort()).toEqual([...COMMERCIAL_COMMANDS].sort());
  });

  it('every declared query has a GET route on the commercial controller', () => {
    const controller = readFileSync(join(HERE, 'commercial.controller.ts'), 'utf8');
    for (const query of COMMERCIAL_QUERIES) {
      const route = querySite[query];
      expect(route, `${query} is declared but this table does not say which route serves it`).toBeDefined();
      expect(
        controller.includes(route),
        `${query} is declared in COMMERCIAL_QUERIES but no ${route} exists — clients cannot read what the manifest promises`,
      ).toBe(true);
    }
    expect(Object.keys(querySite).sort()).toEqual([...COMMERCIAL_QUERIES].sort());
    // and the manifest agrees with the shared contract, so there is ONE declaration, not two
    expect([...commercialManifest.commands].sort()).toEqual([...COMMERCIAL_COMMANDS].sort());
    expect([...commercialManifest.queries].sort()).toEqual([...COMMERCIAL_QUERIES].sort());
  });

  /**
   * CLOSURE 3 — A GUARD THAT READS A PARENT ROW TO DECIDE ABOUT A CHILD WRITE MUST LOCK IT
   * (PR #284 convergence audit, root A).
   *
   * Root A — "a rule reaching the artifact it creates but not the sibling already there" — produced
   * findings in all three review rounds of Task 5C, and every one was the same physical shape: a
   * plpgsql guard that SELECTs a parent row, decides on what it read, and did not take `FOR UPDATE`.
   * Round 1 fixed the withholding bound. Round 2 found its twin, the release bound. Round 3 found
   * the liveness trigger — written in round 2, one function away from the lock round 2 had added.
   *
   * Three rounds of finding twins by hand is the signal that the closure should not be prose. Every
   * other root in this module got a mechanical one (`FOLD_INPUTS`, the accept-first upgrade-proof
   * pairs); this is root A's.
   *
   * THE RULE HAS TWO HALVES, and the first draft of this pin had only one — it flagged the
   * withholding bound's FOLD, which is not a defect and could not be fixed as stated, because
   * PostgreSQL forbids `FOR UPDATE` with an aggregate. You cannot lock a fold. You lock the row that
   * SCOPES it, and the fold is then serialized by that lock. So:
   *
   *   1. a ROW read that decides (`SELECT … INTO`, no aggregate) must itself carry `FOR UPDATE`;
   *   2. a SET read that decides (an aggregate fold, or an `EXISTS` probe) must be PRECEDED, in the
   *      same function, by a `FOR UPDATE` — the scoping row must already be held.
   *
   * Writing the halves down is the same discipline root A is about: the first draft named one side
   * of the distinction and left the other implicit, which is how this root produces findings.
   */
  it('every deciding guard in the 5C migration is serialized against a concurrent writer', () => {
    const raw = readFileSync(
      join(SRC, '../prisma/migrations/20270520000000_phase5_t5c_deductions/migration.sql'),
      'utf8',
    );

    // COMMENTS MUST GO BEFORE ANALYSIS, and this is not tidiness — it is the pin's own root-B
    // moment. The comment above the liveness read explains the fix in prose and contains the words
    // "SELECT" and "FOR UPDATE". Analysed raw, the statement match STARTED inside that comment and
    // then found `FOR UPDATE` in it, so the guard passed on its own explanation. Removing the lock
    // from the migration left this pin GREEN until the comments were stripped.
    // ONE left-to-right pass, comments consumed before quotes are considered — a per-line quote
    // scan gets this backwards, because the prose is full of apostrophes (`§H's`, `Task 6's`) that
    // are not string literals at all.
    let sql = '';
    let inString = false;
    let inComment = false;
    for (let i = 0; i < raw.length; i += 1) {
      const c = raw[i]!;
      if (inComment) {
        if (c === '\n') { inComment = false; sql += c; }
        continue;
      }
      if (inString) {
        sql += c;
        if (c === "'") inString = false;
        continue;
      }
      if (c === '-' && raw[i + 1] === '-') { inComment = true; i += 1; continue; }
      if (c === "'") inString = true;
      sql += c;
    }
    // the stripper is evidence too: if a future string literal carries `--`, this says so rather
    // than silently truncating the statement the pin is about to analyse
    expect(sql, 'a `--` survived comment stripping — the scanner mis-parsed a string literal').not.toMatch(/--/u);

    const functions = [...sql.matchAll(/CREATE OR REPLACE FUNCTION (\w+)[\s\S]*?\$\$ LANGUAGE plpgsql;/gu)];
    expect(functions.length, 'no plpgsql functions parsed — the pin is not reading the migration').toBeGreaterThan(3);

    // Tables another transaction can change UNDER a deciding read. `CommandExecution` is deliberately
    // NOT here and the exemption is mechanical, not prose: a command row is created AND finalized
    // inside the single transaction that also writes the ledger row citing it (`executeCommand`
    // reserves, runs, and stamps `succeeded` in one `$transaction`), so there is no second writer to
    // race. The pin below re-derives that from the source rather than trusting this comment.
    const SHARED = ['BillCertificate', 'BillDeduction', 'BillDeductionRelease', 'VendorBill'];
    const AGGREGATE = /\b(?:SUM|COUNT|MIN|MAX|AVG|BOOL_OR|BOOL_AND)\s*\(/iu;

    const offenders: string[] = [];
    for (const fn of functions) {
      const body = fn[0];
      const name = fn[1]!;
      // only guards DECIDE; a function that raises nothing cannot be raced into a bad state
      if (!body.includes('RAISE EXCEPTION')) continue;

      // (1) row reads must lock themselves
      for (const shared of SHARED) {
        const pattern = new RegExp('SELECT[^;]*?INTO[^;]*?FROM "' + shared + '"[^;]*;', 'gsu');
        for (const stmt of body.matchAll(pattern)) {
          if (AGGREGATE.test(stmt[0])) continue; // a fold — half (2) covers it
          if (!/FOR UPDATE/u.test(stmt[0])) {
            offenders.push(`${name} reads a "${shared}" row without FOR UPDATE`);
          }
        }
      }

      // (2) set reads must be preceded by a lock — you cannot lock a fold, so the scoping row must
      // already be held when it runs
      const setReads = [
        ...body.matchAll(/SELECT[^;]*?INTO[^;]*?FROM "(\w+)"[^;]*;/gsu),
        ...body.matchAll(/IF\s+EXISTS\s*\(\s*SELECT[\s\S]*?FROM "(\w+)"/gu),
      ];
      for (const stmt of setReads) {
        const isFold = AGGREGATE.test(stmt[0]);
        const isExists = stmt[0].startsWith('IF');
        if (!isFold && !isExists) continue;
        if (!SHARED.includes(stmt[1]!)) continue;
        const before = body.slice(0, stmt.index!);
        if (!/FOR UPDATE/u.test(before)) {
          offenders.push(`${name} folds "${stmt[1]}" with no FOR UPDATE taken before it`);
        }
      }
    }
    expect(
      offenders,
      'a guard decides on state it did not serialize — two concurrent writers can each pass it (PR #284 root A)',
    ).toEqual([]);
  });

  /**
   * CLOSURE 4 — AN INSERT-TIME GUARD OVER MUTABLE STATE NEEDS A COMMIT-TIME TWIN (root A, round 4).
   *
   * Round 4's three findings were one shape: a rule enforced at BEFORE INSERT but not at COMMIT, or
   * in the service but not in the database. A BEFORE INSERT trigger sees the world MID-transaction,
   * so a bypass writer can insert against a live certificate and then supersede it before
   * committing — every insert-time check having already passed. What a transaction leaves behind is
   * what a seal has to be about.
   *
   * CLOSURE 3 covers the LOCKING dimension of root A. This covers the TIMING one: if a table has a
   * BEFORE INSERT guard that decides on another table's rows, it must also carry a deferred
   * commit-time constraint trigger.
   */
  it('every insert-time guard over another table is backed by a commit-time seal', () => {
    const sql = readFileSync(
      join(SRC, '../prisma/migrations/20270520000000_phase5_t5c_deductions/migration.sql'),
      'utf8',
    );
    const bodies = new Map(
      [...sql.matchAll(/CREATE OR REPLACE FUNCTION (\w+)[\s\S]*?\$\$ LANGUAGE plpgsql;/gu)]
        .map((m) => [m[1]!, m[0]]),
    );
    // The twin is DECLARED, not inferred, and that is the point: "the table has some deferred
    // trigger" is not a closure, because `BillDeduction` already had two and the hole was still
    // open. Naming the twin means a new insert-time guard cannot be added without deciding what
    // re-checks it at commit — the check below fails on an undeclared one.
    const COMMIT_TIME_TWIN: Record<string, string> = {
      phase5_t5c_deduction_targets_live: 'phase5_t5c_deduction_coherent',
      // the command's TYPE is immutable once minted, so the insert-time read cannot go stale; its
      // STATUS can, which is exactly what the deferred twin re-reads
      phase5_t5c_ledger_command_type: 'phase5_t5c_ledger_command_succeeded',
    };
    const deferredOn = new Map<string, string[]>();
    for (const m of sql.matchAll(/CREATE CONSTRAINT TRIGGER "[^"]+"\s+AFTER \w+ ON "(\w+)" DEFERRABLE INITIALLY DEFERRED\s+FOR EACH ROW EXECUTE FUNCTION (\w+)\(\)/gu)) {
      deferredOn.set(m[1]!, [...(deferredOn.get(m[1]!) ?? []), m[2]!]);
    }
    const beforeInsert = [...sql.matchAll(/CREATE TRIGGER "[^"]+" BEFORE INSERT ON "(\w+)"\s+FOR EACH ROW EXECUTE FUNCTION (\w+)\(\)/gu)];
    expect(beforeInsert.length, 'no BEFORE INSERT triggers parsed — the pin is not reading the migration').toBeGreaterThan(0);
    expect(deferredOn.size, 'no deferred constraint triggers parsed — the pin is not reading the migration').toBeGreaterThan(0);

    const foreignReads = (fn: string, table: string): string[] =>
      [...new Set([...(bodies.get(fn) ?? '').matchAll(/FROM "(\w+)"/gu)].map((r) => r[1]!))]
        .filter((t) => t !== table);

    const gaps: string[] = [];
    for (const [, table, fn] of beforeInsert) {
      const body = bodies.get(fn!) ?? '';
      if (!body.includes('RAISE EXCEPTION')) continue;
      // its own row is fully known at insert; another table's rows can still change before commit
      const reads = foreignReads(fn!, table!);
      if (reads.length === 0) continue;

      const twin = COMMIT_TIME_TWIN[fn!];
      if (!twin) { gaps.push(`${fn} guards "${table}" on ${reads.join(', ')} at insert and declares no commit-time twin`); continue; }
      if (!(deferredOn.get(table!) ?? []).includes(twin)) {
        gaps.push(`${fn}'s declared twin ${twin} is not a deferred constraint trigger on "${table}"`);
        continue;
      }
      const covered = foreignReads(twin, table!);
      const missing = reads.filter((r) => !covered.includes(r));
      if (missing.length > 0) gaps.push(`${twin} does not re-read ${missing.join(', ')} at commit, which ${fn} decided on at insert`);
    }

    expect(
      gaps,
      'an insert-time guard decides on state that can still change before COMMIT, and nothing re-checks it there (PR #284 root A, round 4)',
    ).toEqual([]);
  });

  /**
   * The `CommandExecution` exemption above, re-derived from the source instead of asserted. If a
   * second write site ever appears — one that could flip `status` under another transaction's
   * deferred check — the exemption stops holding and this fails, which is the point.
   */
  it('a CommandExecution row has exactly one writer: the transaction that mints it', () => {
    const commands = readFileSync(join(SRC, 'platform/commands.ts'), 'utf8');
    const writes = [...commands.matchAll(/commandExecution\.(create|update|updateMany|upsert|delete)\b/gu)];
    expect(
      writes.map((w) => w[1]),
      'CommandExecution write sites changed — re-check the exemption in the guard-serialization pin',
    ).toEqual(['create', 'update']);

    const otherModules = execFileSync(
      'grep',
      ['-rlE', 'commandExecution\\.(create|update|updateMany|upsert|delete)\\b', '--include=*.ts', SRC],
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter((f) => f && !f.endsWith('.test.ts') && !f.endsWith('platform/commands.ts'));
    expect(
      otherModules,
      'a module outside the command ledger writes CommandExecution — the single-writer exemption no longer holds',
    ).toEqual([]);
  });

  /**
   * CLOSURE 2 — THE MOVER SET IS DERIVED FROM THE FOLD'S INPUTS (audit root 2).
   *
   * §B's rule is "the exception is raised from EVERY write that can move headroom". The section
   * NAMES three; the first implementation copied the three and lost the rule, so a changed fold
   * silently created a fourth mover. Round 2's closure was a hand-kept list of SITES — and round 3
   * found three more movers it did not contain, because the fold reads `receivedQty`, `ACCEPTED`
   * and labour `committedQty`, and writes to those are movers wherever they live.
   *
   * A list of sites was the same mistake one level up. So the mover set is derived from what the
   * fold READS: `FOLD_INPUTS` names each input field and every write path that can change it, and
   * the first test PINS that table against the query contracts' actual `select`s. Teaching the
   * fold to read a new field now fails here until its writers are named and made to evaluate.
   */
  const FOLD_INPUTS: Array<{
    field: string; owner: string; why: string;
    /** the `CommercialBillQuery` method the fold reads this field through, when it reads one.
     *  Unit C's addition to the closure: the second pin below extracts every `this.bills.*` call
     *  in the fold and requires a row to CLAIM it, so a new bill-side term cannot be read without
     *  naming its writers — the same derivation the `MaterialCommittedLine` pin performs for the
     *  procurement contract. Root 1 of the 5A audit is why both halves exist: fixing the member a
     *  finding names leaves its siblings, and `BILLED_AMOUNT` was exactly such a sibling — read by
     *  this fold since Task 4 with no row here, because nothing derived the bill-side set. */
    readVia?: string;
    writers: Array<{ file: string; method: string }>;
  }> = [
    {
      field: 'committedAmountBase', owner: 'procurement',
      why: 'the frozen obligation itself — it enters and leaves exposure with the ATTRIBUTION, and every PO lifecycle site reaches the register through the participant',
      writers: [
        { file: 'commercial/commercial.participant.ts', method: 'attribute' },
        { file: 'commercial/commercial.participant.ts', method: 'replaceAttribution' },
        { file: 'commercial/commercial.participant.ts', method: 'releaseAttribution' },
      ],
    },
    {
      field: 'receivedQty', owner: 'procurement',
      why: 'a CLOSED-SHORT line releases `qty - receivedQty`, so receipt progress re-prices the release',
      writers: [
        { file: 'inventory/inventory.service.ts', method: 'recordReceipt' },
        { file: 'inventory/inventory.service.ts', method: 'reject' },
        { file: 'inventory/inventory.service.ts', method: 'reverse' },
      ],
    },
    {
      field: 'ACCEPTED', owner: 'inventory',
      why: 'the consumed term, and OVERAGE raises exposure with no commitment released against it',
      writers: [
        { file: 'inventory/inventory.service.ts', method: 'accept' },
        { file: 'inventory/inventory.service.ts', method: 'reverse' },
      ],
    },
    {
      field: 'committedQty', owner: 'labour',
      why: 'a CLOSED-SHORT labour line releases `personShiftQty - committedQty`, so a capacity default frees the whole remainder',
      writers: [
        { file: 'labour/labour-procurement.service.ts', method: 'commitCapacity' },
        { file: 'labour/labour-procurement.service.ts', method: 'defaultCapacity' },
      ],
    },
    {
      field: 'MEASURED', owner: 'commercial',
      why: 'measured person-shifts are the labour CONSUMPTION term, so they move money between the committed and received buckets',
      writers: [
        { file: 'commercial/commercial-measurement.service.ts', method: 'append' },
      ],
    },
    {
      field: 'BILLED_AMOUNT', owner: 'commercial', readVia: 'billedAmountFor',
      why: 'a claim moves money out of received-not-billed and into awaiting-certification, and it can RAISE exposure outright when it exceeds the received value — §E has not yet disputed the rate, so the excess is real exposure until it does',
      writers: [
        { file: 'commercial/commercial-bill.service.ts', method: 'transition' },
        { file: 'commercial/commercial-bill.service.ts', method: 'amend' },
        { file: 'commercial/commercial-bill.service.ts', method: 'disputeClaimsBeyondEvidence' },
        { file: 'commercial/commercial-verification.service.ts', method: 'verify' },
      ],
    },
    {
      field: 'CERTIFIED', owner: 'commercial', readVia: 'certifiedAmountFor',
      why: '§J `certified-payable` — certification moves money out of awaiting-certification, and 5C deductions and Task 6 approvals will subtract into the same term',
      writers: [
        { file: 'commercial/commercial-certification.service.ts', method: 'certify' },
        { file: 'commercial/commercial-certification.service.ts', method: 'supersede' },
      ],
    },
    {
      field: 'WITHHELD', owner: 'commercial', readVia: 'withheldAmountFor',
      why: '§H — withheld money is not payable, so a deduction LOWERS §J `certified-payable` and can CLEAR an open over-budget exception; a release raises it again',
      writers: [
        { file: 'commercial/commercial-deduction.service.ts', method: 'record' },
        { file: 'commercial/commercial-deduction.service.ts', method: 'release' },
      ],
    },
    {
      field: 'BUDGET', owner: 'commercial',
      why: 'authority down is a breach with no commitment write anywhere — §B calls it the most ordinary case',
      writers: [{ file: 'commercial/commercial-budget.service.ts', method: 'setBudget' }],
    },
  ];

  it('FOLD_INPUTS covers every amount-bearing field the owning-module read contracts expose', () => {
    // The pin that makes this table derived rather than remembered: the fold consumes exactly the
    // fields these contracts return, so a new one must arrive here with its writers.
    const declared = new Set(FOLD_INPUTS.map((i) => i.field));
    const material = readFileSync(join(SRC, 'procurement/procurement.query.ts'), 'utf8');
    const iface = /export interface MaterialCommittedLine \{([\s\S]*?)\n\}/u.exec(material)?.[1] ?? '';
    const fields = [...iface.matchAll(/^\s{2}(\w+):/gmu)].map((m) => m[1]!);
    expect(fields.length, 'MaterialCommittedLine could not be parsed — the pin is not actually reading the contract').toBeGreaterThan(4);
    // `qty`, `rate`, `taxAmount`, `freightAmount`, `live` and `closedShort` are all FROZEN at
    // issuance or moved by the PO lifecycle, so they travel with `committedAmountBase`'s writers.
    const frozenOrLifecycle = new Set(['qty', 'rate', 'taxAmount', 'freightAmount', 'live', 'closedShort', 'committedAmountBase']);
    for (const field of fields) {
      expect(
        declared.has(field) || frozenOrLifecycle.has(field),
        `${field} is read by the commercial fold but FOLD_INPUTS does not say which writes change it — name its writers, or classify it as frozen`,
      ).toBe(true);
    }
  });

  it('FOLD_INPUTS covers every commercial-owned fold the budget query reads', () => {
    // The same derivation as the pin above, for the OTHER contract the fold consumes. The
    // procurement pin reads an interface; this one reads the CALLS, because `CommercialBillQuery`
    // hands back one map per fold rather than one row with fields.
    const fold = readFileSync(join(SRC, 'commercial/commercial-budget.query.ts'), 'utf8');
    // Task 5C widened this from `this.bills.*` to every COMMERCIAL-OWNED query the fold reads.
    // The closure's own root applies to itself: naming one owner would leave the next one blind,
    // exactly as naming `CERTIFIED` and leaving `BILLED_AMOUNT` unclaimed did. The other four
    // owners the fold reads (procurement, labour, inventory, measurement) are covered by the
    // interface pin above, which derives their fields from the read contract itself.
    const read = [...fold.matchAll(/this\.(?:bills|deductions)\.(\w+)\(/gu)].map((m) => m[1]!);
    expect(read.length, 'no commercial-owned fold calls found — the pin is not actually reading the fold').toBeGreaterThan(0);
    const claimed = new Set(FOLD_INPUTS.map((i) => i.readVia).filter(Boolean));
    for (const method of new Set(read)) {
      expect(
        claimed.has(method),
        `the fold reads a commercial-owned ${method} but no FOLD_INPUTS row claims it — add the field with its writers, so §B's raise-or-clear covers the money it moves`,
      ).toBe(true);
    }
    // …and no row may claim a fold that is no longer read, which would leave a writer test
    // passing for a term the fold dropped
    for (const via of claimed) {
      expect(read.includes(via!), `FOLD_INPUTS claims ${via} but the fold no longer reads it`).toBe(true);
    }
  });

  for (const input of FOLD_INPUTS) {
    for (const writer of input.writers) {
      it(`${writer.file.split('/').pop()}#${writer.method} evaluates — it writes ${input.owner}.${input.field}`, () => {
        const src = readFileSync(join(SRC, writer.file), 'utf8');
        const start = src.indexOf(`async ${writer.method}(`);
        expect(start, `${writer.file}#${writer.method} not found — FOLD_INPUTS drifted from the code`).toBeGreaterThan(-1);
        const next = src.indexOf('\n  async ', start + 1);
        const body = src.slice(start, next === -1 ? undefined : next);
        expect(
          /evaluateBudgetForLine\(|this\.evaluate\(|this\.evaluateHeads\(|evaluateForTarget\(|evaluateClaimHeads\(|evaluateHeadsForBill\(|this\.evaluateHeadroom\(/u.test(body),
          `${writer.file}#${writer.method} writes ${input.field} (${input.why}) but never re-evaluates — §B requires raise-or-clear in the SAME transaction`,
        ).toBe(true);
      });
    }
  }

  /**
   * A multi-mutation act evaluates ONCE, at the end. Evaluating between an amend's three steps
   * reads a state that never existed at commit, and the register is APPEND-ONLY, so the resulting
   * clear/re-raise pair is permanent evidence of a headroom recovery that never happened.
   */
  it.each([
    ['procurement/purchase-orders.service.ts', 'replaceOnAmend'],
    ['labour/labour-procurement.service.ts', 'replaceLabourOnAmend'],
  ])('%s defers the amend evaluation to a single settle', (file, method) => {
    const src = readFileSync(join(SRC, file), 'utf8');
    const start = src.indexOf(`private async ${method}(`);
    expect(start, `${file} has no ${method} — the deferral pin drifted`).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('\n  private async begin', start));
    for (const call of ['replaceAttribution', 'attribute', 'releaseAttribution']) {
      const m = new RegExp(`commercial\\.${call}\\([\\s\\S]*?\\);`, 'u').exec(body);
      expect(m, `${file}#${method} does not call ${call}`).not.toBeNull();
      expect(
        m![0].includes('touched'),
        `${file}#${method} calls ${call} WITHOUT the deferral sink — it would evaluate on a partial amend state`,
      ).toBe(true);
    }
    expect(
      /evaluateDeferred\(tx, projectId, identity, touched\)/u.test(body),
      `${file}#${method} never settles the deferred evaluation — the amend's budget effect would be dropped entirely`,
    ).toBe(true);
  });

  it('every label the movers produce is recordable at PostgreSQL', () => {
    // scan EVERY migration: a task that adds a mover adds the CHECK in its OWN migration, and
    // pinning a single filename would silently stop checking the moment that happened
    const dir = join(SRC, '..', 'prisma/migrations');
    const migration = readdirSync(dir)
      .filter((d) => /phase5/u.test(d))
      .map((d) => readFileSync(join(dir, d, 'migration.sql'), 'utf8'))
      .join('\n');
    for (const label of ['commitment', 'budget_revision', 'reattribution', 'acceptance', 'receipt_progress', 'measurement']) {
      expect(
        migration.includes(`'${label}'`),
        `${label} is a headroom mover but PostgreSQL would refuse to record it (raisedBy CHECK)`,
      ).toBe(true);
    }
  });

  /**
   * CLOSURE 3 — THE LABEL DESCRIBES WHAT MOVED, NOT WHO NOTICED (audit root D).
   *
   * `raisedBy` is the durable explanation a human reads months later on an APPEND-ONLY row, so a
   * wrong-but-plausible one is worse than a vague one — nobody can correct it. Round 2 found the
   * first instance and fixed it by letting the CALLER name the label; round 4 found that the caller
   * cannot know either, because one PO amend can re-size some lines and reclassify others.
   *
   * So `replaceAttribution` must DERIVE the label per row from whether the head actually changed,
   * and must NOT accept one. These pins keep both halves true.
   */
  it('replaceAttribution derives the label per row and accepts none from its caller', () => {
    const src = readFileSync(join(HERE, 'commercial.participant.ts'), 'utf8');
    const start = src.indexOf('async replaceAttribution(');
    const body = src.slice(start, src.indexOf('\n  /**', start));
    expect(
      /const reclassified = Boolean\(active\) && active!\.costHeadCode !== code;/u.test(body),
      'replaceAttribution must DERIVE reclassification from the data — one amend can re-size some lines and reclassify others',
    ).toBe(true);
    // the signature must not carry a caller-supplied mover: that is the round-2 shape round 4 broke
    const signature = src.slice(start, start + body.indexOf('): Promise<void>'));
    expect(
      /raisedBy: HeadroomMover,/u.test(signature),
      'replaceAttribution must not take a caller-supplied `raisedBy` — the caller cannot know it per line',
    ).toBe(false);
  });

  it.each([
    ['accept', 'acceptance'],
    ['recordReceipt', 'receipt_progress'],
    ['reject', 'receipt_progress'],
  ])('inventory %s records the mover that actually moved (%s)', (method, label) => {
    const src = readFileSync(join(SRC, 'inventory/inventory.service.ts'), 'utf8');
    const start = src.indexOf(`async ${method}(`);
    const next = src.indexOf('\n  async ', start + 1);
    const body = src.slice(start, next === -1 ? undefined : next);
    expect(
      body.includes(`'${label}'`),
      `${method} must record '${label}' — a rejection reversal labelled 'acceptance' sends a PMC looking for a delivery that never happened`,
    ).toBe(true);
  });

  it('the reversal path picks its label from the reversed row type, not the branch', () => {
    const src = readFileSync(join(SRC, 'inventory/inventory.service.ts'), 'utf8');
    const start = src.indexOf('async reverse(');
    const body = src.slice(start, src.indexOf('\n  /**', start));
    expect(
      /target\.type === 'acceptance' \? 'acceptance' : 'receipt_progress'/u.test(body),
      "reverse must derive the label from what it reversed — hard-coding 'acceptance' mislabels every receipt/rejection reversal",
    ).toBe(true);
  });

  /**
   * The budget READ folds four owners' tables, so it must see ONE snapshot. Under PostgreSQL's
   * default READ COMMITTED each statement takes its own, and a PO issue landing mid-read returns
   * healthy headroom beside the exception it just opened.
   */
  it('the budget read runs at repeatable-read isolation', () => {
    const src = readFileSync(join(HERE, 'commercial-budget.service.ts'), 'utf8');
    const start = src.indexOf('async readBudget(');
    const body = src.slice(start, src.indexOf('\n  /**', start + 1));
    expect(
      body.includes('Prisma.TransactionIsolationLevel.RepeatableRead'),
      'readBudget folds four owners across several statements and must pin ONE snapshot, or it can report a headroom that never existed',
    ).toBe(true);
  });
});
