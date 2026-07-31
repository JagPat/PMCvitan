// Which suites can possibly fail for THIS change?
//
// Every pull request currently runs the whole battery — web, e2e, api,
// api-e2e and upgrade-proof, two PostgreSQL services and two Playwright
// installs — including a pull request that edits only `docs/STATUS.md`. That
// is most of the loop's wall-clock, and none of it can fail for a Markdown
// edit.
//
// This decides, from the changed paths alone, which suites are REACHABLE. It
// is a subtraction: a suite is skipped only when nothing in the diff can
// affect it. Cheaper CI must never mean weaker CI, so:
//
//   Any path this module does not recognise makes the classification
//   UNCONFIDENT, and an unconfident classification runs everything.
//
// That is the whole safety argument. A new top-level directory, a new config
// file, a tool nobody has classified yet — all of them widen to the full
// battery rather than silently narrowing it. The rule is enforced by
// construction below (the `unknown` set is checked before any suite logic) and
// pinned by `R7`/`R8` in the test suite.
//
// This is deliberately NOT "which suites did the last run cover" — that is
// `ci-battery-plan.mjs`, which answers a different question (has this exact
// head already been tested). Both gate the product jobs; they compose by AND.

// The product suites, named exactly as the CI jobs are.
export const SUITES = ['web', 'e2e', 'api', 'api-e2e', 'upgrade-proof'];

// Documentation files that a PRODUCT test actually reads, and the suite that
// reads them. This is the register root cause A kept violating: a path was
// called safe because of where it lives, when something consumed it. The
// enforcement probe scans the real product test sources and fails if any docs
// path is read that is not listed here — so instance five fails CI instead of
// shipping.
export const DOCS_CONSUMERS = new Map([
  ['docs/RUNBOOK.md', ['api']],
]);

// Path → the suites that path can break. Ordered most specific first; the
// first matching rule wins, so `apps/web/tests/e2e` never falls through to the
// generic `apps/web` rule by accident.
//
// `packages/shared` is deliberately CROSS-CUTTING: both the web app and the
// API import it at runtime, so a change there can break either. Classifying it
// as "web" was the first draft and it was wrong — a shared contract edit is
// exactly the kind of change that breaks the API's typecheck.
const RULES = [
  // Runner scripts live OUTSIDE the tree they drive, so the specific rules must
  // come first. Codex found three separate cases where a generic rule called a
  // runner safe; each one could have merged a broken runner with its own job
  // skipped and the gate green.
  { prefix: 'apps/api/scripts/', suites: ['api', 'api-e2e', 'upgrade-proof'] },
  { prefix: 'apps/api/prisma/', suites: ['api', 'api-e2e', 'upgrade-proof'] },
  { prefix: 'apps/api/', suites: ['api', 'api-e2e'] },
  { prefix: 'apps/web/', suites: ['web', 'e2e', 'api-e2e'] },
  { prefix: 'packages/shared/', suites: SUITES },
  // `docs/RUNBOOK.md` is NOT just prose to CI: an API integration test reads it
  // and asserts the operator-repair sections never instruct a destructive
  // DELETE of attendance evidence. Unsafe operator guidance could otherwise
  // merge with the only probe that checks it skipped. DOCS_CONSUMERS below is
  // enforced against the real test sources, so a future consumer cannot be
  // added silently.
  { prefix: 'docs/RUNBOOK.md', suites: ['api'] },
  { prefix: 'docs/', suites: [] },
];

// `scripts/` and `.github/` are NOT blanket-safe, which was the original
// mistake. Both directories mix the loop's own machinery with files that drive
// the product jobs — `scripts/test-api-e2e.sh` IS the api-e2e runner, and
// `.github/workflows/ci.yml` defines every product job's commands and setup.
// Calling either directory safe let a broken runner or a broken job body merge
// with the job that would have caught it skipped.
//
// So safety here is an ALLOWLIST of what is provably covered elsewhere, and
// everything else falls through to unknown and widens:
//
//   - a `scripts/*.mjs` file is loop machinery, covered by `pnpm test:automation`
//     (which is never gated on the classification). A `.sh` is a product runner.
//   - a Markdown file under `.github/` is documentation. A workflow is not.
// Repository-root files that are classified individually. A root file NOT in
// this list is unknown and widens to the full battery — `package.json` and the
// lockfile change what every suite installs, and a new root config could do
// anything, so neither is guessed at.
const ROOT_FILES = new Map([
  ['README.md', []],
  ['AGENTS.md', []],
  ['CLAUDE.md', []],
  ['.gitignore', []],
]);

function machineryRule(file) {
  if (file.startsWith('scripts/')) {
    const rest = file.slice('scripts/'.length);
    return rest.endsWith('.mjs') && !rest.includes('/') ? { suites: [] } : null;
  }
  if (file.startsWith('.github/')) {
    return file.endsWith('.md') ? { suites: [] } : null;
  }
  return null;
}

function ruleFor(file) {
  if (ROOT_FILES.has(file)) return { suites: ROOT_FILES.get(file) };
  // A documentation file WITH A KNOWN CONSUMER is checked first. The blanket
  // Markdown rule below would otherwise swallow it — which is precisely how
  // `docs/RUNBOOK.md` came to skip the API suite that reads it.
  if (DOCS_CONSUMERS.has(file)) return { suites: DOCS_CONSUMERS.get(file) };
  // A Markdown file ANYWHERE is otherwise documentation. `docs/` already covers
  // most of them; this catches `apps/api/README.md` and friends, which cannot
  // change behaviour but would otherwise pull in the whole API battery.
  if (file.endsWith('.md')) return { suites: [] };
  if (file.startsWith('scripts/') || file.startsWith('.github/')) {
    return machineryRule(file);
  }
  return RULES.find((rule) => file.startsWith(rule.prefix)) ?? null;
}

// `files` is the list of paths changed by the pull request.
//
// Returns the suites to run, whether the classification is confident, and the
// reason — which is published on the gate so a skipped suite is always
// explained rather than silently absent.
export function classifyChangedFiles(files) {
  // No file list at all is not "nothing changed" — it is "we could not tell".
  if (!Array.isArray(files) || files.length === 0) {
    return {
      suites: [...SUITES],
      confident: false,
      unknown: [],
      reason: 'no changed-file list available; running the full battery',
    };
  }

  // A RENAME reports the new `filename` and keeps the old path in
  // `previous_filename`. Both sides matter: renaming `apps/api/src/foo.ts` to
  // `docs/foo.md` REMOVES API source, and classifying only the destination
  // would skip the very suites that would notice.
  const paths = [];
  let readable = true;
  for (const file of files) {
    if (typeof file === 'string' && file.length > 0) {
      paths.push(file);
      continue;
    }
    const name = file?.filename;
    if (typeof name !== 'string' || name.length === 0) {
      readable = false;
      break;
    }
    paths.push(name);
    if (typeof file.previous_filename === 'string' && file.previous_filename.length > 0) {
      paths.push(file.previous_filename);
    }
  }

  if (!readable) {
    return {
      suites: [...SUITES],
      confident: false,
      unknown: [],
      reason: 'the changed-file list contained entries this classifier could not read; '
        + 'running the full battery',
    };
  }

  const unknown = paths.filter((file) => ruleFor(file) === null);
  if (unknown.length > 0) {
    return {
      suites: [...SUITES],
      confident: false,
      unknown,
      reason: `${unknown.length} path(s) match no classification rule `
        + `(${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? ', …' : ''}); `
        + 'running the full battery',
    };
  }

  const selected = new Set();
  for (const file of paths) {
    for (const suite of ruleFor(file).suites) selected.add(suite);
  }

  // Preserve the canonical order so the published reason is stable for the
  // same change regardless of the order GitHub lists the files in.
  const suites = SUITES.filter((suite) => selected.has(suite));
  return {
    suites,
    confident: true,
    unknown: [],
    reason: suites.length === 0
      ? 'no changed path can affect a product suite; documentation, automation and '
        + 'workflow checks still run'
      : `changed paths can affect: ${suites.join(', ')}`,
  };
}

// Does the gate pass?
//
// `results` maps job name → GitHub's `needs.<job>.result`, one of
// `success | failure | cancelled | skipped`.
//
// A suite may legitimately be `skipped` for two independent reasons — this
// classifier excluded it, or `ci-battery-plan` found this exact head already
// covered — and the gate cannot tell those apart, nor does it need to: both
// are deliberate. What it must NOT accept is `cancelled`, which is a run that
// never reached a verdict, and `failure`, which includes an upstream gate
// failing and skipping everything below it.
//
// So the rule is a whitelist, not a blacklist: anything that is not an
// explicit success or an explicit skip fails the gate. A result GitHub adds
// later that this code has never seen is therefore a failure, not a pass.
// When `battery-plan` decides this head is already covered, every product job
// AND every twin skips — so the gate sees nothing but skips and would go green
// off the current run alone. But battery-plan deliberately counts a FAILED
// product run as coverage: a title/body edit after a red run produces exactly
// that shape. Once `quality-gate` is the single required status, that would let
// a metadata edit mask failed CI without a new commit.
//
// So a battery-plan skip is only acceptable when the PRESERVED evidence for
// this head is actually green. `priorEvidence` carries that verdict; absent or
// unreadable evidence is not a pass.
export function assessQualityGate(results, { productsSkippedAsCovered = false,
  priorEvidence = null } = {}) {
  if (productsSkippedAsCovered) {
    if (!priorEvidence || priorEvidence.ok !== true) {
      return {
        passed: false,
        reason: 'the product jobs were skipped as already-covered, but the '
          + `preserved evidence for this head is not green (${
            priorEvidence?.detail ?? 'no evidence could be read'})`,
      };
    }
  }
  return assessResults(results);
}

function assessResults(results) {
  const entries = Object.entries(results ?? {});
  if (entries.length === 0) {
    return { passed: false, reason: 'no job results were reported to the gate' };
  }

  const blocking = entries.filter(
    ([, result]) => result !== 'success' && result !== 'skipped',
  );
  if (blocking.length > 0) {
    return {
      passed: false,
      reason: blocking
        .map(([job, result]) => `${job}: ${result || 'no result'}`)
        .join('; '),
    };
  }

  const ran = entries.filter(([, result]) => result === 'success').map(([job]) => job);
  const skipped = entries.filter(([, result]) => result === 'skipped').map(([job]) => job);
  return {
    passed: true,
    reason: skipped.length === 0
      ? `all ${ran.length} required checks passed`
      : `${ran.length} passed (${ran.join(', ')}); `
        + `${skipped.length} not applicable to this change (${skipped.join(', ')})`,
  };
}
