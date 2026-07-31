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

// Path → the suites that path can break. Ordered most specific first; the
// first matching rule wins, so `apps/web/tests/e2e` never falls through to the
// generic `apps/web` rule by accident.
//
// `packages/shared` is deliberately CROSS-CUTTING: both the web app and the
// API import it at runtime, so a change there can break either. Classifying it
// as "web" was the first draft and it was wrong — a shared contract edit is
// exactly the kind of change that breaks the API's typecheck.
const RULES = [
  { prefix: 'apps/api/prisma/', suites: ['api', 'api-e2e', 'upgrade-proof'] },
  { prefix: 'apps/api/', suites: ['api', 'api-e2e'] },
  { prefix: 'apps/web/', suites: ['web', 'e2e', 'api-e2e'] },
  { prefix: 'packages/shared/', suites: SUITES },
  { prefix: 'docs/', suites: [] },
  { prefix: 'scripts/', suites: [] },
  { prefix: '.github/', suites: [] },
];

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

function ruleFor(file) {
  if (ROOT_FILES.has(file)) return { suites: ROOT_FILES.get(file) };
  // A Markdown file ANYWHERE is documentation. `docs/` already covers most of
  // them; this catches `apps/api/README.md` and friends, which cannot change
  // behaviour but would otherwise pull in the whole API battery.
  if (file.endsWith('.md')) return { suites: [] };
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

  const paths = files
    .map((file) => (typeof file === 'string' ? file : file?.filename))
    .filter((file) => typeof file === 'string' && file.length > 0);

  if (paths.length !== files.length) {
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
export function assessQualityGate(results) {
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
