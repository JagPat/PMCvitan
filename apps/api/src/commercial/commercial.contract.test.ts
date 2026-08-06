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
    'commercial.payment.approve': { file: 'commercial/commercial-payment.service.ts', needle: "commandType: 'commercial.payment.approve'" },
    'commercial.payment.record': { file: 'commercial/commercial-payment.service.ts', needle: "commandType: 'commercial.payment.record'" },
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
    'commercial.payments': "Get('commercial/bills/:billId/payments')",
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

    // A fold can also be serialized by a lock this function did not take: the row the fold is SCOPED
    // to may already be held by the statement that FIRED the trigger. That is invisible to a text
    // scan, so it is named here one function at a time — never inferred by a pattern.
    //
    // A general "a fold scoped by NEW.id is fine" rule would be a hole, not an exemption: the firing
    // row being locked only helps if the COUNTERPART writer reaches for that same row, and nothing
    // in this file can check that. So each entry costs a named counterpart and a probe that fails
    // when the counterpart is removed. Anything new still trips the pin.
    const SERIALIZED_BY_THE_FIRING_ROW: Record<string, string> = {
      // Fires AFTER UPDATE on "BillCertificate", so the transaction holds FOR NO KEY UPDATE on that
      // row until commit — including when the DEFERRED body folds "BillDeduction" scoped to it.
      // Counterpart: `BillDeduction_targets_live` (BEFORE INSERT, immediate) takes FOR UPDATE on the
      // same certificate, which conflicts, so neither can pass the other.
      // Proof, not argument: PROBE 21 in `phase5-t5c-deductions.test.ts` pins the block in BOTH
      // directions and goes RED when `BillDeduction_targets_live` is disabled.
      // It takes no lock of its own BECAUSE it must not: reaching for the bill here inverted the
      // honest bill → certificate order and PostgreSQL answered with a deadlock (Codex round 6).
      phase5_t5c_supersede_needs_release: 'BillDeduction',
    };

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
        if (SERIALIZED_BY_THE_FIRING_ROW[name] === stmt[1]) {
          // the exemption has to EARN itself: it only holds while the fold is scoped to the firing
          // row, so if that scoping ever disappears the pin fires again
          expect(
            stmt[0],
            `${name} claims the firing row serializes its "${stmt[1]}" fold, but no longer scopes the fold to it`,
          ).toMatch(/NEW\."id"/u);
          continue;
        }
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
      // the ordering that makes the running-balance fold sound: a release may not predate the
      // withholding it discharges. The parent's `recordedAt` is append-only, so the insert-time
      // read cannot go stale — but the fold this protects is the §H floor, and the round-4 rule is
      // that a guard deciding on another table re-checks where the transaction ends
      phase5_t5c_release_not_before_deduction: 'phase5_t5c_release_coherent',
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
      field: 'MEASURED', owner: 'commercial', readVia: 'measuredForPoLines',
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
      field: 'APPROVED', owner: 'commercial', readVia: 'approvedAmountFor',
      why: '§J defines `certified-payable` as `NET_PAYABLE − APPROVED`, so authorising a payment lowers exposure and can CLEAR an open over-budget exception — a headroom mover with no procurement or certification write anywhere',
      writers: [{ file: 'commercial/commercial-payment.service.ts', method: 'approve' }],
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
    //
    // CLOSURE 8 (Task 6A, Codex round 2). Task 5C widened this from `this.bills.*` to
    // `(?:bills|deductions)` — a hand-written alternation of the owners that existed that day. Task
    // 6A then taught the fold to read `this.payments.approvedAmountFor`, and this test, whose whole
    // purpose is to fail when the fold gains an unclaimed input, said nothing: the new owner was
    // not in the literal. The `payment_approval` mover was missed for exactly that reason, and the
    // budget went on reporting a breach an approval had already cleared.
    //
    // That is this file's own stated root — "a list of sites was the same mistake one level up" —
    // reproduced INSIDE the closure written to prevent it. So the owner set is no longer written
    // here either. It is derived from the fold's CONSTRUCTOR: every injected commercial-owned
    // collaborator is scanned, so adding one to the constructor is what makes its calls visible,
    // and there is no second place to remember.
    const ctor = /export class CommercialBudgetQuery\s*\{\s*constructor\(([\s\S]*?)\n\s*\)\s*\{\}/u.exec(fold)?.[1] ?? '';
    const owners = [...ctor.matchAll(/private readonly (\w+):\s*(Commercial\w+)/gu)].map((m) => m[1]!);
    expect(owners.length, 'the budget query constructor could not be parsed — the pin is not deriving its owner set').toBeGreaterThan(1);
    const callPattern = new RegExp(`this\\.(?:${owners.join('|')})\\.(\\w+)\\(`, 'gu');
    const read = [...fold.matchAll(callPattern)].map((m) => m[1]!);
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

  /**
   * CLOSURE 9 — EVERY SERVICE REFUSAL ON THE MONEY PATH IS CLASSIFIED AGAINST WHAT ENFORCES IT
   * BELOW (Task 6A convergence audit, root "sealed in one place only").
   *
   * The root, stated plainly because it has now recurred after being named: Task 6A's round-1
   * audit recorded "I sealed the arithmetic and left the authority to the service." The round-1
   * corrections then fixed the stale-approval rule IN THE SERVICE and never mirrored it at
   * PostgreSQL, and round 2 found exactly that — twice, in the same head. Noticing a root is not a
   * closure. A closure is a thing that fails.
   *
   * So every `ConflictException` and `ForbiddenException` this service raises must appear here with
   * an answer to one question: what refuses this to a writer that never called the service? A row
   * either NAMES the PostgreSQL object that does, and the test proves that object exists in the
   * migration, or it says `seal: null` with a reason — which is a legitimate answer for a guard
   * that is not about persisted state, and an illegitimate one for a guard that is.
   *
   * Adding a guard without a row fails here. That is the whole mechanism.
   */
  const AUTHORITY_GUARDS: Array<{ match: string; seal: string | null; why: string }> = [
    {
      match: 'Approving a payment is a pmc surface',
      seal: null,
      why: 'a ROLE policy, not a property of a row: `ROLE_POLICY` is the single statement and `RolesFor` plus the route-policy tripwire are its enforcement. What a bypass writer defeats by skipping it is §I, and §I is sealed at `PaymentApproval_approver_not_certifier`',
    },
    {
      match: 'Recording a payment is a pmc surface',
      seal: null,
      why: 'same policy surface as approving; the money invariant a bypass writer would defeat is bound 5, sealed at `phase5_t6a_paid_bound_check`',
    },
    {
      match: 'The commercial register is a pmc/engineer surface',
      seal: null,
      why: 'a READ guard — it authorises no write, so there is no persisted state for a seal to protect',
    },
    {
      match: 'has no live certification',
      seal: 'PaymentApproval_authority_live',
      why: 'an approval draws on a LIVE certificate; the three-column FK proves the certificate is this bill’s and says nothing about it standing',
    },
    {
      match: 'no longer holds pmc standing',
      seal: 'phase5_t6a_approval_override_valid',
      why: 'the grant-backed override chain — a grant whose approver has lost standing cannot be spent, and the seal re-proves the grant’s own receipt',
    },
    {
      match: 'granted against an earlier claim version',
      seal: 'phase5_t6a_approval_override_valid',
      why: 'the seal pins the grant to the certificate’s own `versionId`, so a stale grant cannot excuse an approval on an amended claim',
    },
    {
      match: 'may not also approve its payment',
      seal: 'PaymentApproval_approver_not_certifier',
      why: '§I’s payment half, sealed at PG with the override path honoured rather than banned',
    },
    {
      match: 'would take the approved total past',
      seal: 'phase5_t6a_approved_bound_check',
      why: '§G bound 4, re-derived at COMMIT under the bill lock over whatever the transaction leaves behind',
    },
    {
      match: 'authorisation was consumed concurrently',
      seal: 'SodGrant_consumed_together',
      why: 'the grant is single-use; the CAS loses the race and the CHECK plus 5B’s one-way consume trigger make a second spend unrepresentable',
    },
    {
      match: 'no longer hold the standing on this project',
      seal: null,
      why: 'standing is ORGS-owned and orgs-enforced; the money row’s own §I seal is `PaymentApproval_approver_not_certifier`, and a PG copy of the role predicate here would be a second statement of a rule this module does not own',
    },
    {
      match: 'above your approval ceiling',
      seal: null,
      why: '§I ceilings are per-MEMBERSHIP authority, not a property of the money row: the ceiling can be raised or lowered after the fact, so a PG check on the approval would refuse a row that was legitimate when written. `Membership_approvalLimit_nonnegative` is the only invariant the column itself has',
    },
    {
      match: 'has since been superseded',
      seal: 'Payment_authority_live',
      why: 'money leaves against the authority that covered it — the row-level question the bill-scoped bound cannot ask',
    },
    {
      match: 'would take the paid total past',
      seal: 'phase5_t6a_paid_bound_check',
      why: '§G bound 5 at the BILL, re-derived at COMMIT and also fired when a certificate is SUPERSEDED, which moves the right-hand side with no `Payment` insert to notice',
    },
    {
      match: 'above the',
      seal: 'phase5_t6a_approval_paid_check',
      why: '§G bound 5 at the APPROVAL — the bill fold is conserved while one authority is overdrawn, so the row-level question is asked where the row is (this closure caught the guard the moment it was written, which is the whole point of it)',
    },
  ];

  it('every money-path refusal in the payment service is classified against a seal', () => {
    const src = readFileSync(join(HERE, 'commercial-payment.service.ts'), 'utf8');
    // derived, not remembered: the guards are READ out of the service, so a new one arrives here
    // unclassified and this fails
    const guards = [...src.matchAll(/throw new (?:Conflict|Forbidden)Exception\(([\s\S]{0,400}?)\);\n/gu)]
      .map((m) => m[1]!);
    expect(guards.length, 'no refusals found — the pin is not actually reading the service').toBeGreaterThan(5);

    const unclassified = guards.filter((g) => !AUTHORITY_GUARDS.some((r) => g.includes(r.match)));
    expect(
      unclassified,
      'a refusal on the money path is not classified in AUTHORITY_GUARDS — name the PostgreSQL object that refuses the same thing to a writer that never called the service, or say `seal: null` and why that is right',
    ).toEqual([]);

    // …and no row may claim a refusal the service no longer makes, which would leave a seal
    // "covered" by a guard that is gone
    for (const row of AUTHORITY_GUARDS) {
      expect(
        guards.some((g) => g.includes(row.match)),
        `AUTHORITY_GUARDS claims "${row.match}" but the payment service no longer raises it`,
      ).toBe(true);
    }
  });

  it('every seal AUTHORITY_GUARDS names exists in the migrations', () => {
    const dir = join(SRC, '..', 'prisma', 'migrations');
    const sql = readdirSync(dir)
      .filter((d) => d.startsWith('2027'))
      .map((d) => {
        try { return readFileSync(join(dir, d, 'migration.sql'), 'utf8'); } catch { return ''; }
      })
      .join('\n');
    expect(sql.length, 'no Phase-5 migrations read — the pin is not actually reading the schema').toBeGreaterThan(1000);
    for (const row of AUTHORITY_GUARDS) {
      if (row.seal === null) continue;
      expect(
        sql.includes(row.seal),
        `AUTHORITY_GUARDS names ${row.seal} as the seal for "${row.match}", and no migration defines it — a named seal that does not exist is worse than an admitted gap`,
      ).toBe(true);
    }
  });

  /**
   * CLOSURE 10 — A SET ENUMERATED IN MORE THAN ONE PLACE MUST AGREE ACROSS ALL OF THEM
   * (Task 6A convergence audit, root A — the open item that audit carries into 6B).
   *
   * Root A is "the fix lands on the instance a finding names, the sibling survives". It is the
   * oldest live root in this module: named in the PR #284 audit, still producing findings in
   * PR #286, where it accounted for THREE of round 3's four. The two roots that got a MECHANICAL
   * closure in round 2 — E (`AUTHORITY_GUARDS`) and the fold-owner set (`FOLD_INPUTS`) — produced
   * none at all in the same round. That asymmetry is the entire argument for this pin. Root A's
   * closure was a paragraph: "when a fix names a direction, a side, or a half, write down what the
   * opposite one is." A paragraph does not fail, and the audit says so in as many words: naming a
   * root is not a closure, a closure is a thing that fails.
   *
   * Both of round 3's mechanizable instances have ONE physical shape — a SET whose members are
   * written down in more than one place, and a change that added a member to one place only:
   *
   *   - `payment_approval` was admitted by `BudgetException_raisedBy_check` and left OUT of the
   *     shared DTO union. A label the server can return and the client is told is impossible is a
   *     client that mishandles the first real one it sees.
   *   - `consumedByApprovalId` joined `SodGrant`'s consumption-target family under an append-only
   *     path whose validation clause is guarded on `consumedByCertificateId IS NOT NULL`, so the
   *     new target skipped validation ENTIRELY — a false authority in a register that has no
   *     correcting row.
   *
   * So the rule is mechanical: DERIVE the member set from the authority that defines it, and
   * require every other enumeration to carry exactly those members. Adding the next one to a
   * single place fails here, at the desk, with no database.
   *
   * NOT pinned here, stated rather than glossed: round 3's third instance — `approvalAuthorityFor`'s
   * org arm resting on `forUpdate`, which locks rows that EXIST, on the arm *defined by* the absence
   * of one — is a semantic argument about a lock's reach, not a set with two spellings. Claiming it
   * as covered would be exactly the overclaim this root is made of.
   */
  const MIGRATION_DIR = join(SRC, '..', 'prisma', 'migrations');
  const orderedMigrationSql = (): string[] =>
    readdirSync(MIGRATION_DIR)
      .filter((d) => /^\d{14}_/u.test(d))
      .sort()
      .map((d) => {
        try {
          return readFileSync(join(MIGRATION_DIR, d, 'migration.sql'), 'utf8');
        } catch {
          return '';
        }
      });

  it('the raisedBy label set is identical in PostgreSQL and the shared contract', () => {
    // derived from the LAST definition, because each migration drops and re-adds the constraint and
    // it is the final one that is live — reading any earlier one would pin a set nothing enforces
    const defs = orderedMigrationSql().flatMap((sql) => [
      ...sql.matchAll(/ADD CONSTRAINT "BudgetException_raisedBy_check"\s*CHECK \("raisedBy" IN \(([^)]*)\)\)/gu),
    ].map((m) => m[1]!));
    expect(defs.length, 'no BudgetException_raisedBy_check definition found — the pin is not reading the schema').toBeGreaterThan(0);
    const admitted = [...defs[defs.length - 1]!.matchAll(/'([a-z_]+)'/gu)].map((m) => m[1]!).sort();
    expect(admitted.length, 'the live CHECK admits nothing — the pin parsed an empty set').toBeGreaterThan(5);

    const contract = readFileSync(join(SRC, '..', '..', '..', 'packages', 'shared', 'src', 'contracts', 'commercial.ts'), 'utf8');
    const union = /\n\s*raisedBy:\s*([^;]+);/u.exec(contract);
    expect(union, 'BudgetExceptionDto.raisedBy not found in the shared contract').not.toBeNull();
    const declared = [...union![1]!.matchAll(/'([a-z_]+)'/gu)].map((m) => m[1]!).sort();

    expect(
      declared,
      'the `raisedBy` labels PostgreSQL admits and the labels the shared DTO declares are different sets. Whichever side you added to, add to the other: a label only the CHECK knows is one the server can return and every client believes impossible; a label only the union knows is one no write can ever produce',
    ).toEqual(admitted);
  });

  it('every SodGrant consumption target is named by the XOR check and validated by a trigger', () => {
    const schema = readFileSync(join(SRC, '..', 'prisma', 'schema.prisma'), 'utf8');
    const model = /model SodGrant \{([\s\S]*?)\n\}/u.exec(schema);
    expect(model, 'model SodGrant not found — the pin is not reading the schema').not.toBeNull();
    // the family is DERIVED from the model, so a third target arrives here the moment it is declared
    const family = [...model![1]!.matchAll(/^\s*(consumedBy[A-Za-z]*Id)\s+String\?/gmu)].map((m) => m[1]!);
    expect(
      family.length,
      'fewer than two consumption targets found — this pin exists because the family GREW, so parsing one member means the parse is wrong',
    ).toBeGreaterThan(1);

    const sql = orderedMigrationSql().join('\n');

    // (i) the XOR check — last definition wins — must name every member, or a new target can be
    // stamped alongside an existing one with nothing to refuse the pair
    const checks = [...sql.matchAll(/ADD CONSTRAINT "SodGrant_consumed_together"\s*CHECK \(([\s\S]*?)\);/gu)].map((m) => m[1]!);
    expect(checks.length, 'no SodGrant_consumed_together definition found — the pin is not reading the schema').toBeGreaterThan(0);
    const live = checks[checks.length - 1]!;
    for (const column of family) {
      expect(
        live.includes(`"${column}"`),
        `${column} is a consumption target and the live SodGrant_consumed_together CHECK does not mention it — the grant is single-use only for the targets the CHECK counts`,
      ).toBe(true);
    }

    // (ii) …and each member must be reachable by a trigger that can actually REFUSE, which is the
    // half `consumedByApprovalId` skipped: it was added to the CHECK and to no validation clause
    const refusingFunctions = sql
      .split(/CREATE OR REPLACE FUNCTION/u)
      .slice(1)
      .filter((body) => body.includes('RAISE EXCEPTION'));
    expect(refusingFunctions.length, 'no refusing trigger functions parsed — the pin is not reading the migrations').toBeGreaterThan(0);
    for (const column of family) {
      expect(
        refusingFunctions.some((body) => body.includes(`"${column}"`)),
        `${column} is a consumption target that no trigger function validates — a grant can be stamped consumed by an act that carries no matching override, and an append-only register has no correcting row`,
      ).toBe(true);
    }
  });
});
