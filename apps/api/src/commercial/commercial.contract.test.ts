import { readFileSync } from 'node:fs';
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
  };
  const querySite: Record<(typeof COMMERCIAL_QUERIES)[number], string> = {
    'commercial.costHeads': "Get('commercial/cost-heads')",
    'commercial.attributions': "Get('commercial/attributions')",
    'commercial.budget': "Get('commercial/budget')",
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
   * CLOSURE 2 — EVERY HEADROOM-MOVING WRITE EVALUATES (audit root 2).
   *
   * §B's rule is "the exception is raised from EVERY write that can move headroom". The section
   * NAMES three, and the first implementation copied the three and lost the rule — so when the
   * received-value fold changed, ACCEPTANCE became a fourth mover and nothing noticed. The list
   * cannot be the rule's only home; this table is, and it is checked mechanically.
   *
   * A write is a mover when it can change `BUDGET − Σ exposure` for a head. Adding one without an
   * `evaluate`/`evaluateForPoLine` call in its transaction fails here, not in review.
   */
  const HEADROOM_MOVERS: Array<{ label: string; file: string; method: string; why: string }> = [
    // authority down: revising a live budget can breach with NO commitment write anywhere
    { label: 'budget_revision', file: 'commercial/commercial-budget.service.ts', method: 'setBudget', why: 'the live budget amount IS the ceiling' },
    // exposure onto a new head: the standalone reclassification, and every PO lifecycle site,
    // all reach the register through the participant, so evaluating there closes eight sites
    { label: 'commitment / reattribution', file: 'commercial/commercial.participant.ts', method: 'attribute', why: 'a newly live PO line adds exposure' },
    { label: 'commitment (amend / close-short)', file: 'commercial/commercial.participant.ts', method: 'replaceAttribution', why: 'an amended obligation changes size' },
    { label: 'commitment (cancel)', file: 'commercial/commercial.participant.ts', method: 'releaseAttribution', why: 'a cancelled obligation FREES headroom and must clear' },
    // exposure up with no PO write at all: §G authorises accepting more than the ordered quantity
    // and §J values the overage at the frozen rate, so the receipt itself raises exposure
    { label: 'acceptance', file: 'inventory/inventory.service.ts', method: 'accept', why: 'accepted OVERAGE raises exposure with no commitment released' },
    { label: 'acceptance (reversal)', file: 'inventory/inventory.service.ts', method: 'reverse', why: 'withdrawing accepted material must CLEAR what the overage raised' },
  ];

  for (const mover of HEADROOM_MOVERS) {
    it(`${mover.label} re-evaluates the affected cost head (${mover.why})`, () => {
      const src = readFileSync(join(SRC, mover.file), 'utf8');
      const start = src.indexOf(`async ${mover.method}(`);
      expect(start, `${mover.file}#${mover.method} not found — the headroom-mover table drifted from the code`).toBeGreaterThan(-1);
      const next = src.indexOf('\n  async ', start + 1);
      const body = src.slice(start, next === -1 ? undefined : next);
      expect(
        /evaluateHeads\(|evaluateBudgetForLine\(|this\.evaluate\(/u.test(body),
        `${mover.label} (${mover.file}#${mover.method}) can move headroom but never re-evaluates — §B requires raise-or-clear in the SAME transaction`,
      ).toBe(true);
    });
  }

  it('enumerates every headroom-moving write (6 sites, 4 labelled movers)', () => {
    // Completeness is the guard: the DB CHECK on `BudgetException.raisedBy` pins the four labels,
    // and this pins the sites that produce them. Adding a mover is then a visible, reviewed change.
    expect(HEADROOM_MOVERS).toHaveLength(6);
    const migration = readFileSync(
      join(SRC, '..', 'prisma/migrations/20270410000000_phase5_t2_budget_exception/migration.sql'),
      'utf8',
    );
    for (const label of ['commitment', 'budget_revision', 'reattribution', 'acceptance']) {
      expect(
        migration.includes(`'${label}'`),
        `${label} is a headroom mover but PostgreSQL would refuse to record it (raisedBy CHECK)`,
      ).toBe(true);
    }
  });
});
