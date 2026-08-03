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
  };
  const querySite: Record<(typeof COMMERCIAL_QUERIES)[number], string> = {
    'commercial.costHeads': "Get('commercial/cost-heads')",
    'commercial.attributions': "Get('commercial/attributions')",
    'commercial.budget': "Get('commercial/budget')",
    'commercial.measurements': "Get('commercial/labour-po-lines/:labourPoLineId/measurements')",
    'commercial.bills': "Get('commercial/bills')",
    'commercial.bill': "Get('commercial/bills/:billId')",
    'commercial.verification': "Get('commercial/bills/:billId/verification')",
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

  for (const input of FOLD_INPUTS) {
    for (const writer of input.writers) {
      it(`${writer.file.split('/').pop()}#${writer.method} evaluates — it writes ${input.owner}.${input.field}`, () => {
        const src = readFileSync(join(SRC, writer.file), 'utf8');
        const start = src.indexOf(`async ${writer.method}(`);
        expect(start, `${writer.file}#${writer.method} not found — FOLD_INPUTS drifted from the code`).toBeGreaterThan(-1);
        const next = src.indexOf('\n  async ', start + 1);
        const body = src.slice(start, next === -1 ? undefined : next);
        expect(
          /evaluateBudgetForLine\(|this\.evaluate\(|this\.evaluateHeads\(|evaluateForTarget\(/u.test(body),
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
