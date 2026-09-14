import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Phase 6 unit 4d-i — the STATEMENT-ENUMERATING tripwire for the three sealed decision registers.
 *
 * `DecisionEvent`, `Notification` and `ChangeRequest` each carry seals 4d-i installs or 4d-iii
 * will: the audit register is append-only NOW, the notice's event binding is frozen NOW, and the
 * change request gains its closure seals with the trailing unit. A reset that mutates one of them
 * must therefore go through a NAMED helper that disables the relevant seals for exactly that wipe
 * and re-enables them in the same transaction. `DecisionEvent` has one today
 * (`wipeDecisionEvents`), because it is sealed today. `Notification` and `ChangeRequest` carry no
 * row-level DELETE seal yet, so their teardowns are still scoped deletes — classified below, and
 * swept into helpers by 4d-iii, the unit that installs the seals which make helpers necessary.
 * Writing those helpers now would be dead code the day it landed.
 *
 * THE POINT IS THE ENUMERATION. Every file that mutates one of the three is listed here with a
 * classification a reviewer can check. A NEW file that mutates one and is not classified FAILS —
 * which is the only way a rule like this survives contact with 24 existing call sites and
 * however many arrive next.
 *
 * HONEST SCOPE, stated the way `readiness-lock-coverage.test.ts` states its own, and stated
 * here because the limit was MEASURED rather than guessed. This is a FILE-level check. It
 * cannot see an unguarded statement inside a file that is already classified, and an arm that
 * claimed otherwise was written, driven, and REMOVED: `phase6-t4b-decider.test.ts` disables
 * `DecisionEvent` wholesale in its `afterAll` while three bare `deleteMany` calls sat in TEST
 * BODIES where no disable was active, and no file-level predicate can tell those apart.
 *
 * Those three were caught by the DATABASE — the append-only seal refused them the moment the
 * integration suite ran — which is the mechanism that actually holds for per-statement
 * correctness. What this check guarantees is the thing a live suite cannot: that no file starts
 * mutating these registers UNNOTICED, and that no classification outlives the statement it
 * describes.
 */

const API = join(__dirname, '..', '..');
const ROOTS = [join(API, 'test'), join(API, 'prisma'), join(API, 'src')];

/** A mutation of one of the three sealed registers. Reads are not the subject. */
const MUTATIONS =
  /\.(decisionEvent|notification|changeRequest)\.(delete|deleteMany|update|updateMany|upsert)\b/;

/** A hand-rolled seal bypass — the thing the helpers exist to replace. */
const HAND_DISABLE = /ALTER TABLE "(DecisionEvent|Notification|ChangeRequest)" (DISABLE|ENABLE) TRIGGER/;

type Class = 'helper' | 'owner' | string;

/** file (relative to apps/api) → 'helper', 'owner', or the exemption reason. */
const COVERAGE: Record<string, Class> = {
  // The helpers themselves, and the sanctioned reset they are built on.
  'test/integration/fixtures.ts': 'helper',
  'prisma/seed.ts': 'helper',

  // PRODUCTION owners. These are not resets — they are the commands whose writes the seals
  // exist to admit, and they must NOT route through a test helper.
  'src/decisions/decisions.service.ts': 'owner',

  // Suites whose mutation is a scoped teardown of rows they created themselves. Each is
  // exempt while the table it touches carries no row-level DELETE seal; 4d-iii, which
  // installs the trailing ChangeRequest seals, is the unit that must sweep them into
  // `wipeChangeRequests` / `wipeNotifications` and delete these entries.
  'test/integration/activities-idempotency.test.ts': 'scoped notice teardown; no DELETE seal on Notification',
  'test/integration/activities-projection.test.ts': 'scoped notice teardown; no DELETE seal on Notification',
  'test/integration/change-control.test.ts': 'scoped request/notice teardown; swept by 4d-iii with the trailing ChangeRequest seals',
  'test/integration/command-ledger.test.ts': 'scoped notice teardown; no DELETE seal on Notification',
  'test/integration/daily-log-idempotency.test.ts': 'scoped notice teardown; no DELETE seal on Notification',
  'test/integration/decisions-projection.test.ts': 'scoped request/notice teardown; swept by 4d-iii',
  'test/integration/derived-readiness.test.ts': 'scoped notice teardown; no DELETE seal on Notification',
  'test/integration/inspections-correction-r2.test.ts': 'scoped notice teardown; no DELETE seal on Notification',
  'test/integration/inspections-idempotency.test.ts': 'scoped notice teardown; no DELETE seal on Notification',
  'test/integration/inspections-owned-facts.test.ts': 'scoped notice teardown; no DELETE seal on Notification',
  'test/integration/inspections-projection.test.ts': 'scoped notice teardown; no DELETE seal on Notification',
  'test/integration/phase1-baseline.test.ts': 'scoped request/notice/audit teardown; the audit deletes go through wipeDecisionEvents',
  'test/integration/phase2-consequences.test.ts': 'scoped notice teardown; no DELETE seal on Notification',
  'test/integration/phase2-snapshot-shape.test.ts': 'scoped notice teardown; no DELETE seal on Notification',
  'test/integration/phase6-t2-modules.test.ts': 'scoped notice teardown; no DELETE seal on Notification',
  'test/integration/phase6-t4a-withdraw.test.ts': 'the withdrawal suite: its audit deletes go through wipeDecisionEvents; the notice deletes are scoped teardown',
  'test/integration/phase6-t4b-approval-attribution.test.ts': 'audit deletes through wipeDecisionEvents',
  'test/integration/phase6-t4b-decider.test.ts': 'audit deletes through wipeDecisionEvents; notice deletes scoped teardown',
  // #582's review round 24. The seal-stripped harness disables `DecisionEvent` seals BY NAME
  // inside one psql transaction, on a SCRATCH database it builds and drops itself — never the
  // shared one. It is here because the claim this tripwire makes is the ENUMERATION: a file
  // that hand-disables must be visible, whichever database it points at.
  'test/integration/phase6-t4d-i-seal-stripped.test.ts': 'scratch-database probe: disables a no-truncate seal by name, in one transaction, to prove the sanctioned bypass still reaches the register',
  'test/integration/phase6-t4c-ii-consultation.test.ts': 'audit deletes through wipeDecisionEvents; notice deletes scoped teardown',
  'test/integration/platform-command-receipt.test.ts': 'scoped notice teardown; no DELETE seal on Notification',
  'test/integration/start-readiness-race.test.ts': 'scoped notice teardown; no DELETE seal on Notification',

  // Unit tests over a MOCKED client. No database, no seal, nothing to bypass.
  'src/decisions/decisions.service.test.ts': 'mocked Prisma client — no database and no seal',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'migrations') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const SELF = 'src/platform/decision-register-mutation-coverage.test.ts';

describe('phase 6 unit 4d-i — every mutation of a sealed decision register is classified', () => {
  const files = ROOTS.flatMap((r) => walk(r))
    .map((f) => relative(API, f).split('\\').join('/'))
    .filter((f) => f !== SELF)
    .sort();

  it('no file mutates DecisionEvent, Notification or ChangeRequest without a classification', () => {
    const unclassified = files.filter(
      (f) => MUTATIONS.test(readFileSync(join(API, f), 'utf8')) && !(f in COVERAGE),
    );
    expect(
      unclassified,
      'these files mutate a sealed decision register and are not classified — route them through '
        + 'the named helper (wipeDecisionEvents) or add an exemption with a reason a reviewer can '
        + 'check',
    ).toEqual([]);
  });

  it('every classification names a file that really does mutate one — no stale entries', () => {
    // The converse arm, and it is not symmetry for its own sake: a classification left behind
    // after its statement was removed makes the list look complete while covering nothing, and
    // the next reader trusts it.
    // EITHER of the two things this list covers (#582's review round 24). The arm below classifies
    // hand-DISABLES as well as mutations, and the two sets are not the same: the seal-stripped
    // harness disables a no-truncate seal by name on its own scratch database and mutates nothing.
    // Asking only about mutations called its classification stale while the disable it describes
    // was still there — which would have pushed the next reader to delete the entry and leave that
    // disable unclassified, the exact silence the arm below exists to refuse. A classification is
    // stale when the file does NEITHER.
    const stale = Object.keys(COVERAGE).filter((f) => {
      const src = readFileSync(join(API, f), 'utf8');
      return !MUTATIONS.test(src) && !HAND_DISABLE.test(src);
    });
    expect(stale, 'these classifications no longer describe any statement — remove them').toEqual([]);
  });

  it('every hand-disable of a seal on these three tables is by a CLASSIFIED file', () => {
    // The claim is the ENUMERATION, not the absence. Several suites hand-disable inside ONE
    // `$transaction([...])`, which is the property that actually matters — PostgreSQL DDL is
    // transactional, so a wipe that throws rolls the DISABLE back with it and no failure path
    // leaves a seal off. What must never happen is a file doing it UNNOTICED.
    const rogue = files.filter(
      (f) => HAND_DISABLE.test(readFileSync(join(API, f), 'utf8')) && !(f in COVERAGE),
    );
    expect(
      rogue,
      'these files disable a seal on a sealed decision register and are not classified — every '
        + 'disable must be inside ONE transaction with its matching enable, and named here so a '
        + 'reviewer can see it',
    ).toEqual([]);
  });

  it('every hand-disable names the seal it turns off, or disables the table WHOLESALE', () => {
    // A disable naming ONE seal is the shape that rots: `DecisionEvent` carried one seal, then
    // three, and the sites naming only the first would have started failing on the wipe they
    // were written to perform. Either name EVERY seal on the table, or use `DISABLE TRIGGER
    // USER`, which covers whatever the table carries today and tomorrow.
    //
    // Concretely, for `DecisionEvent`: a file that names `DecisionEvent_no_withdrawn_approval`
    // must also name the two 4d-i seals.
    const partial = files.filter((f) => {
      const src = readFileSync(join(API, f), 'utf8');
      if (!src.includes('DecisionEvent_no_withdrawn_approval')) return false;
      return !src.includes('DecisionEvent_t4d_append_only')
          || !src.includes('DecisionEvent_t4d_correspondence');
    });
    expect(
      partial,
      'these files disable SOME of the seals on "DecisionEvent" — the wipe they perform is '
        + 'refused by the ones they missed',
    ).toEqual([]);
  });

  it('the scan is non-trivial — a regex that matched nothing would pass every arm above', () => {
    const matching = files.filter((f) => MUTATIONS.test(readFileSync(join(API, f), 'utf8')));
    expect(matching.length).toBeGreaterThan(15);
  });
});
