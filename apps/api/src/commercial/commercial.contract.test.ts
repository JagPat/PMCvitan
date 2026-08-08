import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMERCIAL_COMMANDS, COMMERCIAL_QUERIES, BILL_STATUSES_PAST_CERTIFICATION, DOMAIN_EVENT_TYPES, isPastCertification, VENDOR_BILL_STATUSES } from '@vitan/shared';
import { commercialManifest } from './commercial.manifest';
import { COMMERCIAL_MONEY_EVENT, FORECAST_EVENT_TYPES, makeCashForecastProjectionConsumer } from './cash-forecast.projection';
import { CommercialCommandRunner } from './commercial-command.runner';
import type { EmittedEventMeta } from '../platform/outbox/registry';
import { EXTERNAL_EFFECTS } from '../platform/external-effects';
import { AUTHORITY_GUARDS } from './commercial.authority-guards';
import { dtoRaisedByLabels, writerRaisedByLabels } from './commercial.raisedby-sets';
import { DERIVED_BILL_STATUSES, isDerivedBillStatus } from './commercial-status';

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
    'commercial.payment.reverse': { file: 'commercial/commercial-payment.service.ts', needle: "commandType: 'commercial.payment.reverse'" },
    'commercial.advance.pay': { file: 'commercial/commercial-deduction.service.ts', needle: "commandType: 'commercial.advance.pay'" },
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
    'commercial.cash-forecast': "Get('commercial/cash-forecast')",
    'commercial.money-position': "Get('commercial/money-position')",
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
   * …AND THE REVERSE (Codex round 4, 7B-i). The test above walks the DECLARED set and checks each
   * has a route — so an UNDECLARED route is invisible to it. That is exactly how
   * `commercial/money-position` reached the web gateway while `COMMERCIAL_QUERIES` still enumerated
   * only the older reads: the manifest promised less than the controller served, which is the
   * stale-manifest class this contract exists to prevent, arriving from the direction it was not
   * looking.
   *
   * So the CONTROLLER is the source here and the manifest is the derived check: every commercial
   * GET must be declared. Root A's answer once more — make the source the checker — applied to the
   * one direction the original pin left open.
   */
  it('every GET the commercial controller serves is a DECLARED query', () => {
    const controller = readFileSync(join(HERE, 'commercial.controller.ts'), 'utf8');
    const served = [...controller.matchAll(/@Get\('([^']+)'\)/gu)].map((m) => `Get('${m[1]}')`);
    expect(served.length, 'no GET routes were extracted — this pin would scan nothing').toBeGreaterThan(5);
    const declaredRoutes = new Set(Object.values(querySite));
    const undeclared = served.filter((r) => !declaredRoutes.has(r));
    expect(
      undeclared,
      `the commercial controller serves these reads and no COMMERCIAL_QUERIES entry declares them, so `
      + `every registry and contract consumer believes they do not exist: ${undeclared.join(', ')}`,
    ).toEqual([]);
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
    /**
     * PARTITION-ONLY: the fold reads this term to SPLIT an existing exposure across two buckets,
     * and it provably cannot move the total. Task 7A introduced the first one and the reason is an
     * identity rather than a judgement — §J defines `approved` as `APPROVED − PAID` and `paid` as
     * `PAID`, so the two sum to `APPROVED` for every value of `PAID`. Paying money changes WHICH
     * bucket holds the exposure and not how much there is, exactly as certification does when it
     * moves money from `awaiting-certification` to `certified-payable`.
     *
     * A row marked this way is exempt from the writer/evaluator pin below — and ONLY from that.
     * It must still be declared, so the "no fold is read without a row" half still catches it, and
     * `why` must state the identity that makes the exemption true rather than asserting the
     * exemption. **The identity is also PROVEN at runtime** (`phase5-t7a-cash-forecast.test.ts`,
     * the partition probe): paying moves the buckets and leaves `exposure` and `headroom`
     * untouched. A claim like this one is the shape that goes stale silently, so it is not left as
     * a comment.
     */
    partitionOnly?: true;
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
      field: 'APPROVED', owner: 'commercial', readVia: 'approvedAmountFor', partitionOnly: true,
      // Task 7A RECLASSIFIED this row, and the reclassification was a TEST FAILURE rather than a
      // judgement. Task 6A wrote it as a headroom mover — "authorising a payment lowers exposure
      // and can CLEAR an open over-budget exception" — and that was TRUE while `approved` was not
      // yet a bucket: subtracting `APPROVED` from `certified-payable` with nowhere for it to go
      // genuinely lowered the total. Task 7A added the bucket §J always specified, and PROBE 20 of
      // the 6A suite failed on the spot, because an approval no longer heals anything.
      //
      // That is the correct behaviour and the old row was the incomplete one: money a practice has
      // authorised is money it still owes. §B's `payment_approval` label STAYS wired for the same
      // reason `measurement` does — the closure's rule is mechanical, and carving out an exception
      // on the strength of my own arithmetic is what went wrong twice in Task 2.
      why: '§J defines `certified-payable` as `NET_PAYABLE − APPROVED` and `approved` as `APPROVED − PAID`, and those two sum to `NET_PAYABLE − PAID` identically — so authorising moves exposure BETWEEN buckets and can never move the total. An approval cannot clear an over-budget exception, because authorising money does not unspend it',
      writers: [{ file: 'commercial/commercial-payment.service.ts', method: 'approve' }],
    },
    {
      field: 'PAID', owner: 'commercial', readVia: 'paidAmountFor', partitionOnly: true,
      why: '§J splits `APPROVED` into `approved` (= `APPROVED − PAID`) and `paid` (= `PAID`), and those two sum to `APPROVED` identically — so paying moves exposure BETWEEN buckets and can never move the total. `payments.record` and `payments.reverse` are therefore not headroom movers, and making them evaluate would append a raise-or-clear observation labelled against a write that moved no headroom, which is the label drift §B round 4 removed',
      writers: [
        { file: 'commercial/commercial-payment.service.ts', method: 'record' },
        { file: 'commercial/commercial-payment.service.ts', method: 'reverse' },
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

  for (const input of FOLD_INPUTS.filter((i) => !i.partitionOnly)) {
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
   * §J's REFRESH is a SEPARATE obligation from §B's raise-or-clear, and Task 7A learned the
   * difference the hard way.
   *
   * 7A hung the §J announcement off `CommercialBudgetService.evaluate`, on the derivation that
   * "moved headroom" and "moved a §J bucket" are the same predicate. They are ALMOST the same, and
   * the gap is exactly the partition-only rows: paying and reversing move a bucket without moving
   * the total, so they are rightly exempt from the evaluator — and were therefore silently exempt
   * from §J too. The stored forecast would have gone on reporting money as authorised-and-unpaid
   * forever after it left the bank.
   *
   * So the obligation is pinned over the WHOLE table rather than the non-exempt part of it: every
   * writer announces, through an evaluator (which announces at its end) or directly.
   */
  for (const input of FOLD_INPUTS) {
    for (const writer of input.writers) {
      it(`${writer.file.split('/').pop()}#${writer.method} announces the §J move — it writes ${input.owner}.${input.field}`, () => {
        const src = readFileSync(join(SRC, writer.file), 'utf8');
        const start = src.indexOf(`async ${writer.method}(`);
        expect(start, `${writer.file}#${writer.method} not found — FOLD_INPUTS drifted from the code`).toBeGreaterThan(-1);
        const next = src.indexOf('\n  async ', start + 1);
        const body = src.slice(start, next === -1 ? undefined : next);
        expect(
          /evaluateBudgetForLine\(|this\.evaluate\(|this\.evaluateHeads\(|evaluateForTarget\(|evaluateClaimHeads\(|evaluateHeadsForBill\(|this\.evaluateHeadroom\(|announceMoneyMoved\(/u.test(body),
          `${writer.file}#${writer.method} writes ${input.field} — a §J bucket — but neither evaluates nor calls announceMoneyMoved, so nothing announces the move and the stored cash forecast keeps a figure this write already changed`,
        ).toBe(true);
      });
    }
  }

  /**
   * The partition-only EXEMPTION is itself constrained, or it becomes a way to opt out of §B.
   *
   * Two things it may not do: name a writer that does not exist (which would hide a drifted method
   * behind the exemption), and assert the exemption without stating the identity that earns it.
   * What it may not do at all is stand alone — the runtime partition probe is what proves the
   * identity holds, and this only proves the DECLARATION is honest.
   */
  it('a partition-only fold input names real writers and states the identity that exempts it', () => {
    const exempt = FOLD_INPUTS.filter((i) => i.partitionOnly);
    expect(exempt.length, 'no partition-only row exists — this pin would pass vacuously').toBeGreaterThan(0);
    for (const input of exempt) {
      expect(input.readVia, `${input.field} is partition-only but names no fold method`).toBeTruthy();
      expect(
        /sum to|sums to|identically/u.test(input.why),
        `${input.field} claims the partition-only exemption without stating the identity that earns it — "these two sum to X for every value of Y" is the claim, and anything vaguer is an assertion that the writers need not evaluate`,
      ).toBe(true);
      for (const writer of input.writers) {
        const src = readFileSync(join(SRC, writer.file), 'utf8');
        expect(
          src.includes(`async ${writer.method}(`),
          `${writer.file}#${writer.method} does not exist — a partition-only row must still name real writers, or the exemption hides a drift`,
        ).toBe(true);
      }
    }
  });

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
   * either NAMES the PostgreSQL object that does, or it says `seal: null` with a reason — which is
   * a legitimate answer for a guard that is not about persisted state, and an illegitimate one for
   * a guard that is.
   *
   * Adding a guard without a row fails here. That is the whole mechanism.
   *
   * The rows themselves live in `commercial.authority-guards.ts`, because TWO closures on
   * different substrates read them: this one proves every refusal the SERVICE raises is classified
   * (a source fact), and `test/integration/commercial-catalog-closure.test.ts` proves every named
   * seal is really installed in the LIVE database (a database fact — see the PR #287 convergence
   * audit for why migration text cannot answer that).
   */

  it('no AUTHORITY_GUARDS matcher is AMBIGUOUS — each names exactly one refusal', () => {
    // A matcher made of common words classifies the NEXT guard that happens to contain them, so a
    // new refusal ships already "classified" against someone else's seal and the closure never asks
    // what enforces it. Fixing the one broad matcher is not the fix; forbidding the class is.
    const src = readFileSync(join(HERE, 'commercial-payment.service.ts'), 'utf8');
    const guards = [...src.matchAll(/throw new (?:Conflict|Forbidden)Exception\(([\s\S]{0,400}?)\);\n/gu)]
      .map((m) => m[1]!);

    for (const row of AUTHORITY_GUARDS) {
      const hits = guards.filter((g) => g.includes(row.match));
      expect(
        hits.length,
        `AUTHORITY_GUARDS matcher "${row.match}" matches ${hits.length} refusals. It must name exactly one: a matcher this broad silently adopts the next guard that contains the same words, seal and all`,
      ).toBe(1);
    }

    // …and no two rows may claim the same refusal
    const claimed = AUTHORITY_GUARDS.map((r) => guards.findIndex((g) => g.includes(r.match)));
    expect(new Set(claimed).size, 'two AUTHORITY_GUARDS rows classify the same refusal').toBe(claimed.length);
  });

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

  /**
  /**
   * CLOSURE 10 — A SET ENUMERATED IN MORE THAN ONE PLACE MUST AGREE ACROSS ALL OF THEM
   * (Task 6A convergence audit, root A — the open item that audit carries into 6B).
   *
   * Root A is "the fix lands on the instance a finding names, the sibling survives". It is the
   * oldest live root in this module: named in the PR #284 audit, still producing findings in
   * PR #286, where it accounted for THREE of round 3's four.
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
   * THE CLOSURE IS SPLIT BY SUBSTRATE, and that split is the PR #287 convergence audit's finding.
   * Its first two heads each drew three findings, all one defect: it asked what PostgreSQL
   * currently enforces and answered by parsing migration text. Text cannot answer that — 41 of the
   * 80 migrations wrap DDL in conditional `DO $$ BEGIN` blocks whose execution depends on runtime
   * catalog predicates, so on more than half of them a regex replay is guessing. So:
   *
   *   - the SOURCE half stays here, at the desk, with no database: the DTO union against the
   *     `HeadroomMover` writer union.
   *   - the DATABASE half moved to `test/integration/commercial-catalog-closure.test.ts`, which
   *     reads `pg_constraint`, `pg_trigger` and `pg_proc` after migrations — the substrate that
   *     OWNS the fact, following the cleared `labour/t3c` precedent.
   *
   * The lesson root A now carries: a closure must be built on the substrate that owns the fact it
   * asserts. Naming a root is not a closure; a closure is a thing that fails — and a closure that
   * can only fail on a proxy for its subject is a paragraph wearing a test's clothes.
   *
   * NOT pinned in either half, stated rather than glossed: round 3's third instance —
   * `approvalAuthorityFor`'s org arm resting on `forUpdate`, which locks rows that EXIST, on the
   * arm *defined by* the absence of one — is a semantic argument about a lock's reach, not a set
   * with two spellings.
   */
  it('the raisedBy label set is identical in the two SOURCE enumerations', () => {
    // The THIRD enumeration — the live `BudgetException_raisedBy_check` — is the AUTHORITY, and it
    // is NOT read here. It is a database fact, and `docs/reviews/pr-287-convergence.md` records why
    // migration text cannot answer one: the live set is proven against `pg_constraint` by
    // `test/integration/commercial-catalog-closure.test.ts`, which compares it to BOTH sets below.
    //
    // What remains at the desk is the pair that is genuinely source-to-source, and it is the pair
    // the first draft of this closure MISSED — root A inside the closure for root A: the fix landed
    // on CHECK-vs-DTO and the sibling survived. A mover added to `HeadroomMover` without widening
    // the DTO is a label every client is told is impossible; a DTO label no mover writes is a
    // promise nothing keeps.
    const declared = dtoRaisedByLabels();
    const writes = writerRaisedByLabels();
    expect(declared.length, 'the shared DTO declares nothing — the pin parsed an empty set').toBeGreaterThan(5);
    expect(
      writes,
      'the `raisedBy` labels the shared DTO declares and the movers `HeadroomMover` can write are different sets. Whichever side you added to, add to the other',
    ).toEqual(declared);
  });

  // ── §F's derived family has ONE source, not two that happen to agree today ────────────────────
  //
  // JagPat, alongside Codex round 1 on PR #289. `commercial-status.ts` shipped
  // `DERIVED_BILL_STATUSES`/`isDerivedBillStatus` as a fresh listing of the same four members the
  // shared contract already declares — while its own comments claimed one family definition. The
  // shared declaration had even left a note saying Task 6 would need it.
  //
  // The failure is concrete and silent in both directions. Add a fifth member to the shared set and
  // it becomes supersedable (the `supersede` guard reads the shared one) and read-visible, while
  // `CommercialStatusService.reDerive` skips it — a bill whose folds move and whose status does not.
  // Add one only locally and it gets derived while the shared lifecycle and read guards reject or
  // omit it. Neither shows up as a type error.
  //
  // They are now the SAME array, and this pins that they stay it — identity, not equality, so a
  // future copy-paste that happens to list the same members still fails here.
  // ── CLOSURE A (PR #289 convergence) — the seal set is DERIVED, never a list ───────────────────
  //
  // `docs/reviews/pr-289-convergence.md`, root A. Four findings in one unit were the same mistake:
  // the code wrote down the members instead of deriving them from what the fold reads. The family
  // was enumerated and the member left to the service; the seal was put on the bill and not its
  // fold tables; then five of the SIX fold tables were enumerated and `BillCertificate` — named in
  // this unit's own mover list — was missed.
  //
  // §B already solved this: `FOLD_INPUTS` derives its mover set from what the fold READS, because a
  // hand-kept list of six sites had gone stale once already. This is that idiom for §F's seals.
  //
  // The tables are read out of the fold queries themselves, so a SEVENTH fold input added to
  // `commercial-deduction.query.ts` without a matching seal fails HERE — at the desk, with no
  // database and no reviewer required — rather than becoming the next bypass.
  it('§F: every table the folds READ carries a derivation seal — the set is derived, not listed', () => {
    const source = readFileSync(join(HERE, 'commercial-deduction.query.ts'), 'utf8');

    // §F'S FOLDS, not "every fold in the file" — Task 6C found this.
    //
    // The first spelling scanned the whole query file, which was exact only while every fold in it
    // fed `derivedBillStatus`. 6C adds `recoverableFor` — §H's VENDOR-scoped advance pool, which is
    // a ceiling on a deduction and NOT one of §F's three folds — and it reads `VendorAdvance`. The
    // closure duly demanded a `_t6b_status_sealed` trigger on a table whose writes cannot move any
    // bill's derived status, and which has no `billId` for the seal's resolver to read: a seal that
    // could not have been installed correctly even if someone tried.
    //
    // So the surface is DERIVED from `foldsFor`, which is what `reDerive` actually calls: take its
    // body, follow every `this.<method>` transitively, and scan only that text. A fourth §F fold
    // added to `foldsFor` is covered automatically; a fold that §F does not read is not demanded.
    // This is the same correction as reading every migration instead of one — the set was derived
    // while the PLACE it was derived from was assumed.
    // Class members here are indented two spaces, so a method runs from its `async name(` to the
    // next line that is exactly `  }`. Brace-counting from the first `{` does NOT work: these
    // signatures return inline object types (`Promise<{ netPayable: … }>`), so the first brace
    // after the name belongs to the RETURN TYPE and the walk would stop inside it — which is
    // exactly how the first draft of this extraction produced a 78-character "fold surface" and
    // would have passed vacuously if the guard below had not been there.
    const methodBody = (name: string): string => {
      const start = source.indexOf(`async ${name}(`);
      if (start < 0) return '';
      const end = source.indexOf('\n  }', start);
      return end < 0 ? '' : source.slice(start, end + 4);
    };
    const foldSurface = (): string => {
      const seen = new Set<string>();
      const pending = ['foldsFor'];
      let out = '';
      while (pending.length > 0) {
        const name = pending.pop()!;
        if (seen.has(name)) continue;
        seen.add(name);
        const body = methodBody(name);
        out += body;
        for (const m of body.matchAll(/this\.(\w+)\(/gu)) pending.push(m[1]!);
      }
      return out;
    };
    const query = foldSurface();
    expect(query.length, '`foldsFor` was not found or resolves to nothing — the §F fold surface is empty, so this closure would pass vacuously').toBeGreaterThan(200);
    // …and the walk really is TRANSITIVE: `foldsFor` calls `positionFor`, which calls `withheldFor`,
    // which is where the deduction tables are read. A one-level extraction would miss them.
    expect(query.includes('billDeductionRelease'), 'the fold surface does not reach `withheldFor` — the walk stopped before the tables two hops down').toBe(true);
    // …and it EXCLUDES the folds §F does not read, which is the whole point of narrowing it
    expect(query.includes('VendorAdvance'), '`recoverableFor` is inside the §F fold surface — it is §H\'s ceiling on a deduction, not an input to `derivedBillStatus`').toBe(false);
    // EVERY migration, not the one file that happened to install the first six seals.
    //
    // Task 6B-ii found this: the seal SET was derived while the PLACE it was derived from was a
    // hand-written path to `20270610000000`. `PaymentReversal_t6b_status_sealed` is installed by
    // `20270620000000`, so the closure reported a correctly-sealed table as unsealed — root A one
    // level up from the version this closure was written to catch, and this time it failed CLOSED
    // (a false alarm rather than a miss), which is the only reason it is a footnote and not a
    // finding. A seal is a seal wherever it is installed; the migrations directory is the fact.
    const migrationsDir = join(SRC, '../prisma/migrations');
    const migration = readdirSync(migrationsDir)
      .filter((d) => !d.endsWith('.toml'))
      .map((d) => {
        try { return readFileSync(join(migrationsDir, d, 'migration.sql'), 'utf8'); } catch { return ''; }
      })
      .join('\n');

    // what the three folds actually touch, extracted GENERICALLY — the first draft of this closure
    // matched delegates with `tx\.(billCertificate|billDeduction|…)\.`, which is the five members
    // written down again inside the closure whose whole point is not to write them down. 6B-ii adds
    // `tx.paymentReversal` to `PAID`, and that alternation would not have matched it: the closure
    // would have stayed green with `PaymentReversal` unsealed. Root A inside the closure for root A,
    // for the third time in this module's history.
    //
    // So: any `tx.<delegate>.` reference, mapped to its model by the same camelCase→PascalCase rule
    // Prisma uses, and INTERSECTED with the real model list from `schema.prisma` so a typo or a
    // non-model property (`tx.$queryRaw` never matches — `$` is not a lowercase letter) cannot
    // invent a requirement that no table could satisfy.
    const sealedTables = (): Set<string> => new Set(
      [...migration.matchAll(/^CREATE CONSTRAINT TRIGGER "(\w+)_t6b_status_sealed"/gmu)].map((m) => m[1]!),
    );
    const models = new Set(
      [...readFileSync(join(SRC, '../prisma/schema.prisma'), 'utf8').matchAll(/^model\s+(\w+)\s*\{/gmu)].map((m) => m[1]!),
    );
    expect(models.size, 'no Prisma models were parsed — the model list is empty, so every delegate would be discarded').toBeGreaterThan(20);

    const fromRaw = [...query.matchAll(/FROM\s+"(\w+)"/gu)].map((m) => m[1]!);
    const fromJoin = [...query.matchAll(/JOIN\s+"(\w+)"/gu)].map((m) => m[1]!);
    // the model set is a PARAMETER so the mutation check below can simulate the schema 6B-ii will
    // have, rather than being unable to name the very addition this closure exists to catch
    const delegatesIn = (source: string, known: ReadonlySet<string> = models): string[] =>
      [...source.matchAll(/\btx\.([a-z][A-Za-z0-9]*)\./gu)]
        .map((m) => `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)}`)
        .filter((model) => known.has(model));
    const readTables = [...new Set([...fromRaw, ...fromJoin, ...delegatesIn(query)])].sort();

    expect(readTables.length, 'no fold table was found — the extraction is matching nothing, so this pin proves nothing').toBeGreaterThan(2);

    // …and the extractor is MUTATION-TESTED against a delegate it has never seen.
    //
    // The 6B-i spelling used `tx.paymentReversal` for this, because that was the addition 6B-ii
    // would make and the alternation it replaced could not have matched. 6B-ii has now made it, and
    // the reversal is genuinely sealed — so keeping it as the mutation case would test nothing: the
    // "unsealed" arm would be vacuously empty. Asserting a fixture that has become true is the
    // defect PR #290's audit is about, one substrate over.
    //
    // So the case is a SYNTHETIC model that is deliberately not in the schema and not sealed. That
    // is the honest shape of the question — "an unseen fold input is seen AND reported" — and it
    // stays a real question for 6C's advance fact and everything after it, rather than expiring the
    // moment the named guess ships.
    const unseen = 'SomeFutureFoldInput';
    const withUnseen = new Set([...models, unseen]);
    expect(
      delegatesIn('await tx.someFutureFoldInput.findMany({ where: { billId } });', withUnseen),
      'the delegate extractor does not see an ordinary `tx.<delegate>.` read — a new fold input would be added to `PAID` unsealed and this closure would stay green',
    ).toEqual([unseen]);
    // …and the consequence is what matters: an unsealed new fold input must be REPORTED, not merely
    // seen. This is the assertion the alternation-based draft could not have made.
    expect(
      delegatesIn('await tx.someFutureFoldInput.findMany();', withUnseen).filter((t) => !sealedTables().has(t)),
      'a table read by a fold with no `_t6b_status_sealed` trigger was not flagged',
    ).toEqual([unseen]);
    // the REAL 6B-ii addition, asserted the other way round: it is seen, and it IS sealed. This is
    // what the previous head's failing arm turned into, kept as evidence rather than deleted.
    expect(
      delegatesIn('await tx.paymentReversal.findMany({ where: { billId } });'),
      '`tx.paymentReversal` is no longer recognised as the `PaymentReversal` model',
    ).toEqual(['PaymentReversal']);
    expect(
      sealedTables().has('PaymentReversal'),
      '`PaymentReversal` is a fold input of `PAID` and carries no `_t6b_status_sealed` trigger',
    ).toBe(true);
    expect(
      delegatesIn('await tx.$queryRaw`SELECT 1`; await tx.notAModel.findMany();'),
      'the extractor invented a table from a non-model property',
    ).toEqual([]);

    const sealed = sealedTables();
    // the bill itself is sealed too, and is not a "read" of the folds — it is the thing they derive
    expect(sealed.has('VendorBill'), 'the bill carries no derivation seal').toBe(true);

    const unsealed = readTables.filter((t) => !sealed.has(t));
    expect(
      unsealed,
      `these tables are READ by §F's folds but carry no \`_t6b_status_sealed\` trigger, so a write to them can move the derivation and leave the stored status behind: ${unsealed.join(', ')}`,
    ).toEqual([]);
  });

  // ── CLOSURE B (Task 6B-ii) — a fold has ONE definition, in both languages ─────────────────────
  //
  // `docs/reviews/pr-289-convergence.md`, root A, at the substrate it had not reached yet. The
  // seal closure above derives WHICH TABLES the folds read. This derives WHICH FUNCTIONS compute
  // `PAID`, and requires each of them to compute the whole of it.
  //
  // The failure it prevents is specific and was live in this unit. §0 defines `PAID(bill)` as
  // Σ payments MINUS Σ payment reversals, and three PL/pgSQL functions compute it: §G bound 5
  // bill-scoped, §G bound 5 approval-scoped, and §F's own truth-table mirror. Widen two and forget
  // the third and nothing looks broken — until a ₹100 reversal fails to unlock the supersession it
  // exists for, because the un-widened bound still reads ₹100 paid. The reversal row is appended,
  // the fold falls everywhere a reader looks, and the correction is still refused.
  //
  // A hand-kept list of those three is the same mistake one level down, so the set is EXTRACTED:
  // any function body that aggregates over `"Payment"` is a `PAID` twin, and must subtract
  // `"PaymentReversal"`. 6C adds `advance-recovery` and will be tempted to write a fourth.
  it('§0: every SQL function that folds `Payment` also subtracts `PaymentReversal`', () => {
    const migrationsDir = join(SRC, '../prisma/migrations');
    const sql = readdirSync(migrationsDir)
      .filter((d) => !d.endsWith('.toml'))
      .sort()
      .map((d) => {
        try { return readFileSync(join(migrationsDir, d, 'migration.sql'), 'utf8'); } catch { return ''; }
      })
      .join('\n');

    // Each `CREATE OR REPLACE FUNCTION` body, keyed by name. LAST definition wins, which is the
    // semantics PostgreSQL itself has: this migration REPLACES 6A's two functions, and a closure
    // that read the first definition would report the pre-widening text forever.
    const bodies = new Map<string, string>();
    for (const m of sql.matchAll(/CREATE OR REPLACE FUNCTION\s+(\w+)\s*\([\s\S]*?\$\$\s+LANGUAGE/gu)) {
      bodies.set(m[1]!, m[0]!);
    }
    expect(bodies.size, 'no PL/pgSQL function bodies were parsed — this closure would pass vacuously').toBeGreaterThan(10);

    // a `PAID` twin is a body that AGGREGATES over the payment table. A body that merely mentions
    // `"Payment"` (a lock, an existence check, an FK diagnostic) is not folding it and is not asked
    // to subtract anything.
    const folds = (body: string): boolean => /SUM\(\s*\w+\."amount"\s*\)[\s\S]{0,400}?FROM\s+"Payment"\s/u.test(body);
    const netsReversals = (body: string): boolean => /FROM\s+"PaymentReversal"/u.test(body);

    const twins = [...bodies.entries()].filter(([, body]) => folds(body)).map(([name]) => name).sort();
    expect(
      twins,
      'no SQL function was recognised as folding `Payment` — the extraction is matching nothing, so this closure proves nothing',
    ).not.toEqual([]);

    const missing = twins.filter((name) => !netsReversals(bodies.get(name)!));
    expect(
      missing,
      `these SQL functions fold \`Payment\` without subtracting \`PaymentReversal\`, so they compute a \`PAID\` that can only rise — §0 defines it as Σ payments MINUS Σ reversals, and a twin that disagrees refuses the correction a reversal exists to permit: ${missing.join(', ')}`,
    ).toEqual([]);

    // the three §0 named twins are present by NAME as well as by count, so a rename that silently
    // dropped one from the extraction cannot leave this green on the survivors
    for (const name of ['phase5_t6a_paid_bound_check', 'phase5_t6a_approval_paid_check', 'phase5_t6b_derive_bill_status']) {
      expect(twins.includes(name), `${name} is no longer recognised as a \`PAID\` fold — either it stopped folding payments, or the extraction stopped seeing it`).toBe(true);
    }

    // …and the detector is MUTATION-TESTED in both directions, because a predicate that answers
    // `true` to everything would make the assertion above meaningless.
    expect(
      folds('SELECT COALESCE(SUM(p."amount"), 0) INTO v INNER\n FROM "Payment" p WHERE 1=1;'),
      'the fold detector does not recognise an ordinary aggregate over "Payment"',
    ).toBe(true);
    expect(
      folds('SELECT p."id" INTO v FROM "Payment" p WHERE p."id" = x FOR UPDATE;'),
      'the fold detector treats a plain row read of "Payment" as a fold, so it would demand a reversal term from a lock',
    ).toBe(false);
    expect(
      netsReversals('SELECT COALESCE(SUM(p."amount"), 0) FROM "Payment" p;'),
      'the netting detector reports a reversal term in a body that has none',
    ).toBe(false);
  });

  // ── CLOSURE C (Task 7A) — §J's announcement seams are DERIVED from what the forecast READS ────
  //
  // Root A once more, at the substrate Task 7A introduces. The cash-forecast projection is stored,
  // so it can go stale, and it goes stale exactly when a commercial write moves a bucket without
  // ANNOUNCING it: the platform's whole staleness machinery — the ordered cursor, the diagnostic's
  // frozen window, the rebuild's catch-up — is driven by events, so a silent write is invisible to
  // all three. CLOSURE E states that precondition at the platform; this is the module's half of
  // it, and the half that is actually sufficient.
  //
  // So the seams are not listed, they are DERIVED: the forecast is exactly what
  // `serializedPositionsFor` + `positionsFor` read, this test extracts the `tx.<model>` reads from
  // those two method bodies, and every model must be CLASSIFIED against the write path that
  // announces it. Two classifications exist and adding a third is meant to be uncomfortable:
  //
  //   'evaluate'  — the model is a §B headroom input, so every writer of it already calls
  //                 `CommercialBudgetService.evaluate` (CLOSURE 2 fails the build otherwise) and
  //                 `evaluate` announces at its end. §B headroom IS `BUDGET − Σ(the six §J
  //                 buckets)`, so this is one predicate, not two lists.
  //   'costHead'  — the model changes what the forecast SAYS while moving no money:
  //                 `commercial.costHead.define` adds an all-zero row or renames one.
  //
  // A model added to the compute path without a classification fails here. A classification whose
  // named site no longer announces fails here too.
  it('§J: every model the cash forecast reads has a write path that announces the move', () => {
    const querySrc = readFileSync(join(HERE, 'commercial-budget.query.ts'), 'utf8');
    const methodBody = (name: string): string => {
      const start = querySrc.indexOf(`async ${name}(`);
      if (start < 0) return '';
      // brace-count from the FIRST `{` fails here — that brace belongs to the RETURN TYPE, not the
      // body. The bodies are class methods at two-space indent, so their closer is unambiguous.
      const end = querySrc.indexOf('\n  }', start);
      return end < 0 ? '' : querySrc.slice(start, end + 4);
    };
    const surface = methodBody('serializedPositionsFor') + methodBody('positionsFor');
    expect(
      surface.length,
      'the compute surface extracted to nothing — this closure would pass vacuously over an empty string',
    ).toBeGreaterThan(1500);

    const readModels = [...new Set([...surface.matchAll(/\btx\.(\w+)\.(?:findMany|findFirst|findUnique|aggregate|groupBy|count)\b/gu)].map((m) => m[1]!))].sort();
    expect(readModels, 'no `tx.<model>` read was extracted from the compute surface').not.toEqual([]);

    // The classification. `commitmentAttribution` is `evaluate`-covered because a re-attribution is
    // itself a headroom mover on BOTH the source and the target head (CLOSURE 3 pins the label).
    const ANNOUNCED_BY: Record<string, 'evaluate' | 'costHead'> = {
      costHead: 'costHead',
      budgetLine: 'evaluate',
      budgetException: 'evaluate',
      commitmentAttribution: 'evaluate',
    };
    const unclassified = readModels.filter((m) => !(m in ANNOUNCED_BY));
    expect(
      unclassified,
      `the cash forecast reads these models and nothing says which write path ANNOUNCES a change to them. A stored forecast whose input moved unannounced is a money page that silently goes stale, and no cursor, diagnostic or rebuild can catch it. Classify each as 'evaluate' (a §B headroom input) or name its own seam: ${unclassified.join(', ')}`,
    ).toEqual([]);
    // and the reverse: a classification for a model the compute no longer reads is dead weight that
    // would let a real gap hide behind a green test
    const stale = Object.keys(ANNOUNCED_BY).filter((m) => !readModels.includes(m));
    expect(stale, `these models are classified as announced but the cash forecast no longer reads them: ${stale.join(', ')}`).toEqual([]);

    // …and each named seam ACTUALLY refreshes. A classification is a claim about code, so it is
    // exercised rather than trusted.
    const budgetSvc = readFileSync(join(HERE, 'commercial-budget.service.ts'), 'utf8');
    const evaluateBody = budgetSvc.slice(budgetSvc.indexOf('  async evaluate('));
    expect(
      evaluateBody.slice(0, evaluateBody.indexOf('\n  }')).includes('announceMoneyMoved(tx, projectId, actor'),
      "`CommercialBudgetService.evaluate` no longer announces the move, so every model classified 'evaluate' above has no announcement at all",
    ).toBe(true);

    // THE WRITER SITES ARE DERIVED, NOT TRUSTED (Codex F4). The first spelling of this closure
    // classified `costHead` as "refreshed by `commercial.costHead.define`" and checked that ONE
    // method — so `CommercialActivationService.activate`, which upserts `CostHead` rows itself and
    // can return without ever reaching `evaluate`, satisfied a green test while leaving the stored
    // forecast holding an empty head list.
    //
    // A classification naming a method is a claim about one site; the obligation is about ALL of
    // them. So every commercial file is scanned for a WRITE to a classified model, and each writing
    // file must announce — through `announceMoneyMoved` or an evaluator that does.
    const commercialFiles = readdirSync(HERE).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    const ANNOUNCERS = /announceMoneyMoved\(|this\.evaluate\(|evaluateHeadsForBill\(|this\.budget\.evaluate\(/u;
    const writeSites: string[] = [];
    for (const file of commercialFiles) {
      const src = readFileSync(join(HERE, file), 'utf8');
      const writes = [...src.matchAll(/\btx\.(\w+)\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\b/gu)]
        .map((m) => m[1]!)
        .filter((model) => model in ANNOUNCED_BY);
      if (writes.length === 0) continue;
      writeSites.push(file);
      expect(
        ANNOUNCERS.test(src),
        `${file} writes ${[...new Set(writes)].join('/')} — a model the cash forecast READS — but never announces the move, directly or through an evaluator. An unannounced write is invisible to the ordered cursor, to the operator diagnostic and to a rebuild's catch-up alike`,
      ).toBe(true);
    }
    expect(
      writeSites.length,
      'no commercial file was found writing a classified model — the writer-site derivation is matching nothing, so it proves nothing',
    ).toBeGreaterThan(1);
    // the two seams this unit names must both be among them, so the scan cannot be passing by
    // having quietly stopped seeing the files it is about
    for (const named of ['commercial.service.ts', 'commercial-activation.service.ts']) {
      expect(writeSites, `${named} no longer registers as a writer of a classified model`).toContain(named);
    }

    // the extraction is MUTATION-TESTED, because a regex that matches nothing would make every
    // assertion above vacuously true
    const probe = 'await tx.someNewFact.findMany({ where: { projectId } });';
    expect(
      [...probe.matchAll(/\btx\.(\w+)\.(?:findMany|findFirst|findUnique|aggregate|groupBy|count)\b/gu)].map((m) => m[1]),
      'the model extraction does not recognise an ordinary `tx.<model>.findMany` read',
    ).toEqual(['someNewFact']);
  });

  /**
   * CLOSURE D (Task 7A, Codex F1) — the forecast's event set is the CATALOG's, not a plausible one.
   *
   * `FORECAST_EVENTS` spelled the labour PO family `labour_po.issued` etc.; the catalog declares
   * `labour.po.issued`. Both read as reasonable, and the consequence was worse than a missed
   * refresh: an unrecognised type produces a NO-OP delivery, and a no-op STILL advances the ordered
   * cursor to the stream head. So the generation stayed SERVABLE while silently omitting every
   * labour commitment, and `readCashForecast` served it as authoritative rather than falling back
   * to the live compute — a money page confidently short by every labour order on the project.
   *
   * The durable fix is the TYPE: the array is `readonly DomainEventType[]`, so a name the catalog
   * does not declare cannot be written there at all. This pins the BEHAVIOUR the type cannot — that
   * each declared type actually resolves to `dispatch` — plus the four names by hand, because a
   * future edit could keep the set well-typed while dropping the family that was wrong.
   */
  it('§J: every forecast event type is catalog-declared AND actually dispatches', () => {
    const consumer = makeCashForecastProjectionConsumer();
    expect(FORECAST_EVENT_TYPES.length, 'the forecast event set is empty — this closure would pass vacuously').toBeGreaterThan(10);
    for (const eventType of FORECAST_EVENT_TYPES) {
      expect(DOMAIN_EVENT_TYPES as readonly string[], `${eventType} is not a declared domain event, so it can never dispatch`).toContain(eventType);
      expect(
        consumer.deliveryFor({ eventType } as never),
        `${eventType} resolves to a NO-OP delivery — which still advances the ordered cursor, so the generation stays SERVABLE while omitting whatever this event moved`,
      ).toEqual({ action: 'dispatch' });
    }
    // the family that was wrong, by name, so a well-typed set that quietly dropped it still fails
    for (const eventType of ['labour.po.issued', 'labour.po.amended', 'labour.po.cancelled', 'labour.po.closed_short']) {
      expect(FORECAST_EVENT_TYPES as readonly string[], `${eventType} left the forecast set — labour commitments would stop reaching the stored money`).toContain(eventType);
    }
    // …and the detector is not vacuous: an event the set does NOT carry must be a no-op
    expect(
      consumer.deliveryFor({ eventType: 'decision.created' } as never),
      'an unrelated event dispatches — the forecast would recompute on every event in the system',
    ).toEqual({ action: 'noop' });
  });

  /**
   * §M (Task 7B-i, Codex round 3) — THE FLAG AND THE WIRING MOVE TOGETHER, OR NEITHER MOVES.
   *
   * Round 2 found that the §M hub's refresh rides the socket `changed` ping, which
   * `makeSocketConsumer` dispatches only on `invalidate` — so a weightless `commercial.money_moved`
   * leaves an open Commercial tab stale after a commercial-only write. I flipped the flag.
   *
   * Round 3 found what flipping it alone actually does: the event then carries an external effect
   * that NO commercial command sends. Every commercial service returns `events: []` and injects no
   * `ExternalEffectDispatcher`, and in the DEFAULT `legacy` sender mode
   * `OutboxRelay.claimExternalRecovery()` deliberately leaves fresh external deliveries alone for
   * the lease window because the immediate dispatcher is expected to have sent them. So the
   * invalidation arrives late — and under `OUTBOX_RELAY_AUTOSTART=false`, never.
   *
   * A half-wired external effect is worse than a weightless one, so the flag went back and the
   * wiring became its own unit (7B-i-a). What closes the trap is this pin: the two facts are
   * asserted TOGETHER, so the next person to flip the flag fails here until the dispatch exists,
   * and the person who wires the dispatch fails here until they flip the flag.
   *
   * 7B-i-a then made "the dispatch exists" a property rather than seventeen copied lines. Every
   * commercial command routes through `CommercialCommandRunner`, which is the one place that hands
   * a committed command's events to the dispatcher — so the second half of this pin is now
   * DERIVED: no commercial service may call `executeCommand` directly, and the runner must
   * dispatch. A new commercial command cannot route around it, and a command added to an
   * already-dispatching service cannot forget a line, because there is no line to forget.
   */
  it('§M: commercial\'s event weight and its post-commit dispatch wiring agree', async () => {
    const entry = EXTERNAL_EFFECTS['commercial.money_moved'];
    const services = readdirSync(HERE).filter((f) => f.endsWith('.service.ts'));
    expect(services.length, 'no commercial services found — this pin would compare nothing').toBeGreaterThan(5);

    // "Wired" is RUN, not read. A source scan for `dispatchCommitted(` matched this file's own doc
    // comment, so deleting the call left the pin green — prose satisfying a scan, which is the
    // failure mode a pin exists to prevent. Driving the runner with a fake dispatcher asserts the
    // behaviour instead. (That the events REACH the runner from a seam below `run` is the platform
    // registry's job and is proven live in `phase5-t7bia-money-invalidation.test.ts` probe 1.)
    const sent: EmittedEventMeta[][] = [];
    const runner = new CommercialCommandRunner(
      { $transaction: (cb: (tx: unknown) => unknown) => cb({}) } as never,
      { dispatchCommitted: async (evs: EmittedEventMeta[]) => { sent.push(evs); } } as never,
    );
    const emitted = { eventId: 'ev-money', eventType: COMMERCIAL_MONEY_EVENT } as EmittedEventMeta;
    await runner.run({
      scope: { scopeKind: 'project', projectId: 'p1' },
      actor: { actorId: 'u1', actorName: 'x', actorRole: 'pmc', actorKind: 'human' },
      commandType: 'commercial.probe', requestHash: 'h',
      run: async () => ({ resultRef: 'r', events: [emitted] }),
    });
    const wired = sent.length === 1 && sent[0]!.some((e) => e.eventId === 'ev-money');

    expect(
      entry.invalidate === wired,
      entry.invalidate
        ? 'commercial.money_moved INVALIDATES but CommercialCommandRunner does not dispatch after commit. '
          + 'In the default `legacy` sender mode the immediate dispatcher is the sender, and the relay '
          + 'deliberately holds fresh external deliveries for the lease window — so the invalidation '
          + 'arrives late or never. Restore the dispatch, or put the flag back.'
        : 'commercial.money_moved is WEIGHTLESS but CommercialCommandRunner dispatches after commit — '
          + 'a dispatch with nothing to send. Flip the catalog entry in the same change.',
    ).toBe(true);

    // …and every commercial command actually goes through it. A service that calls `executeCommand`
    // itself has silently opted out of the only dispatch site the module has, which is exactly the
    // state this whole unit exists to make unreachable.
    const direct = services.filter((f) => /\bexecuteCommand\s*\(/u.test(readFileSync(join(HERE, f), 'utf8')));
    expect(
      direct,
      `${direct.join(', ')} calls executeCommand directly instead of CommercialCommandRunner.run — `
      + 'its commands commit without sending their external effects. Route it through the runner.',
    ).toEqual([]);
    // …and the runner is genuinely the command path, not an unused wrapper: at least one service
    // uses it, so deleting every call site cannot leave this pin green.
    const routed = services.filter((f) => /this\.commands\.run\s*\(/u.test(readFileSync(join(HERE, f), 'utf8')));
    expect(routed.length, 'no commercial service routes through CommercialCommandRunner').toBeGreaterThan(5);

    expect(entry.push, 'money moving is not a notification').toBeNull();
    expect(entry.eventType).toBe('commercial.money_moved');
  });

  it('§F: the derived payment family IS the shared past-certification set, not a copy of it', () => {
    expect(
      DERIVED_BILL_STATUSES as readonly string[],
      'DERIVED_BILL_STATUSES is no longer the shared BILL_STATUSES_PAST_CERTIFICATION array. Alias the shared one rather than restating its members',
    ).toBe(BILL_STATUSES_PAST_CERTIFICATION as readonly string[]);

    // …and the two predicates answer identically across the WHOLE status vocabulary, so an aliased
    // constant with a hand-rolled predicate beside it cannot pass either.
    for (const status of VENDOR_BILL_STATUSES) {
      expect(
        isDerivedBillStatus(status),
        `\`${status}\`: isDerivedBillStatus and isPastCertification disagree — they are one question asked by two callers`,
      ).toBe(isPastCertification(status));
    }
  });

});
