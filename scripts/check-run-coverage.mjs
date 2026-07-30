// Shared rules for reading a head's check-run history.
//
// The battery plan and the review gate both answer "do this head's product jobs
// cover the current attempt?" — and rounds 4-9 of the PR #249 review kept
// finding the same defect implemented differently on the two sides. These rules
// live here once so the two cannot drift apart again.

export const PRODUCT_CHECKS = ['web', 'api', 'e2e', 'api-e2e', 'upgrade-proof'];
export const AUTOMATION_CHECK = 'automation';
export const BATTERY_CHECKS = [...PRODUCT_CHECKS, AUTOMATION_CHECK];
export const DOCS_FAST_CHECKS = ['review-scope', 'battery-plan', AUTOMATION_CHECK];

// The dependency-free jobs the product jobs are gated on via `needs`.
export const GATE_CHECKS = ['review-scope', 'battery-plan'];

export function isBatteryProductCheck(name) {
  return PRODUCT_CHECKS.includes(name) || name === AUTOMATION_CHECK;
}

export function isSkipped(run) {
  return run?.status === 'completed' && run?.conclusion === 'skipped';
}

// Recency key, newest-first. GitHub's own `latest` filter is defined by
// completed_at, so that is the primary key; an unfinished run has none and is
// dated by when it STARTED.
//
// Dating every unfinished run as "newer than everything" instead was wrong for
// a hung straggler: an attempt whose jobs are all still queued has no gate
// stamp either, so the sentinel put its runs ahead of a later attempt that had
// completed the same checks, and the head stayed pending until timeout. A run
// that started at 09:00 and is still going is not more recent activity than one
// that finished at 11:00. Only a run with no timestamp at all keeps the
// sentinel: it cannot be placed, and for an unfinished run the safe placement
// is first, since the gate then waits rather than reporting a verdict for a
// check that is still moving.
export function recency(run) {
  if (typeof run?.completed_at === 'string' && run.completed_at) return run.completed_at;
  if (typeof run?.started_at === 'string' && run.started_at) return run.started_at;
  return run?.status === 'completed' ? '' : '￿';
}

export function newestFirst(a, b) {
  const aKey = recency(a);
  const bKey = recency(b);
  if (aKey !== bKey) return aKey > bKey ? -1 : 1;
  return (Number(b?.id) || 0) - (Number(a?.id) || 0);
}

// Which CI attempt produced this check run. `check_suite.id` is the API's own
// grouping of one workflow run's checks; the Actions URLs
// (.../actions/runs/<runId>/job/<jobId>) are the fallback when it is absent.
export function attemptOf(run) {
  const suite = run?.check_suite?.id;
  if (suite !== undefined && suite !== null) return `suite:${suite}`;
  for (const url of [run?.html_url, run?.details_url]) {
    const match = /\/actions\/runs\/(\d+)\//u.exec(typeof url === 'string' ? url : '');
    if (match) return `run:${match[1]}`;
  }
  return null;
}

// The completion time that product evidence must be at least as recent as.
//
// Product jobs are created AFTER the gates that launch them, so within one
// attempt a product always completes later than its gates. That makes a gate
// completion a watermark — but ONLY for an attempt that produced no product
// runs at all, which is the retarget window: the new base's gates pass, its
// product jobs do not exist yet, and the old base's successes would otherwise
// look like coverage for a merge result they never tested.
//
// An attempt whose products are SKIPPED is the opposite case: the plan
// deliberately decided the head was already covered, and its gates must not
// invalidate the very evidence it chose to keep. Treating those gates as a
// watermark made every second metadata-only edit relaunch the battery, which is
// exactly the duplication this whole design exists to prevent.
//
// A gate run we cannot attribute to an attempt is ignored rather than trusted:
// we cannot tell whether it produced products, and guessing "it did not" would
// resurrect that duplication. Unattributable evidence is handled where it can be
// judged soundly — the gate's skip-attribution rule fails closed on it.
//
// The watermark is computed PER PRODUCT NAME, because an attempt's product
// check runs do not all appear at once. GitHub can expose a newer attempt's
// `web` while `api`, `e2e`, `api-e2e` and `upgrade-proof` have not been created
// yet. Asking only "did this attempt produce any products?" answers yes and
// clears the watermark for all five, so the four names with no run of their own
// fall back to the previous base's successes — and the head is promoted while
// four of its five product jobs have never run against the current merge
// result. An attempt vouches only for the names it actually produced.
// An attempt's product check runs do not have to be visible all at once, so
// "this attempt has no run named N" is ambiguous between "not yet" and "never
// will". What resolves it is the character of the runs the attempt DOES have:
//
//   skipping — every product run it shows is `skipped`, so its battery plan
//              decided this head was already covered. It deliberately kept the
//              older evidence and must never invalidate it, including for the
//              names whose skipped runs have not appeared yet.
//   running  — it shows at least one real product run, so it is producing its
//              own evidence. A name it has no run of is superseded-and-pending,
//              not covered by the previous attempt.
//   unknown  — no product runs at all: the retarget window, where the new
//              base's gates are green and no product job exists yet. Older
//              evidence tested a different merge result, so it is superseded.
function attemptCharactersFor(runs, names) {
  const characters = new Map();
  for (const run of runs) {
    if (!names.includes(run?.name)) continue;
    const attempt = attemptOf(run);
    if (!attempt) continue;
    const seen = characters.get(attempt);
    if (seen === 'running') continue;
    characters.set(attempt, isSkipped(run) ? 'skipping' : 'running');
  }
  return characters;
}

function watermarkRuns(all, gatesPassed) {
  return all.filter((run) => {
    if (!isSkipped(run)) return true;
    if (!BATTERY_CHECKS.includes(run?.name)) return true;
    const attempt = attemptOf(run);
    return attempt !== null && gatesPassed.has(attempt);
  });
}

// The attempts whose gate jobs ALL passed.
//
// EVERY run of every gate, not merely one: the bounded retry reruns a failed
// gate inside the SAME workflow run, so a later success would otherwise
// retroactively legitimise everything the earlier failure caused. A gate that
// failed at any point means the attempt aborted.
export function attemptsWithPassingGates(checkRuns) {
  const byAttempt = new Map();
  for (const run of Array.isArray(checkRuns) ? checkRuns : []) {
    if (!GATE_CHECKS.includes(run?.name)) continue;
    const attempt = attemptOf(run);
    if (!attempt) continue;
    const gates = byAttempt.get(attempt) ?? new Map();
    const passed = run.status === 'completed' && run.conclusion === 'success';
    gates.set(run.name, (gates.get(run.name) ?? true) && passed);
    byAttempt.set(attempt, gates);
  }
  const passing = new Set();
  for (const [attempt, gates] of byAttempt) {
    if (GATE_CHECKS.every((gate) => gates.get(gate) === true)) passing.add(attempt);
  }
  return passing;
}

export function gateWatermarks(checkRuns) {
  const all = Array.isArray(checkRuns) ? checkRuns : [];

  // A skipped product run only means something when the attempt's gates
  // passed: then it IS the plan's deliberate "this head is already covered".
  // If a gate of that attempt failed, the attempt aborted and its skips are
  // evidence of nothing — they neither produce coverage of their own nor
  // preserve anyone else's. Reading them as preservation dropped the aborted
  // attempt's gates from the watermark, so the next metadata edit saw the
  // PREVIOUS attempt's successes as coverage and skipped the battery, while
  // the gate — which judges those same skips as a real non-success — kept
  // failing the head. Nothing then relaunches the products.
  const gatesPassed = attemptsWithPassingGates(all);
  const runs = watermarkRuns(all, gatesPassed);

  const attemptsByName = new Map(BATTERY_CHECKS.map((name) => [name, new Set()]));
  for (const run of runs) {
    if (!BATTERY_CHECKS.includes(run?.name)) continue;
    const attempt = attemptOf(run);
    if (attempt) attemptsByName.get(run.name).add(attempt);
  }

  const completedGates = runs.filter(
    (run) => GATE_CHECKS.includes(run?.name) && run?.status === 'completed',
  );

  const watermarks = new Map();
  for (const name of BATTERY_CHECKS) {
    const scope = name === AUTOMATION_CHECK ? [AUTOMATION_CHECK] : PRODUCT_CHECKS;
    const characters = attemptCharactersFor(runs, scope);
    const producedThisName = attemptsByName.get(name);
    watermarks.set(name, completedGates
      .filter((run) => {
        const attempt = attemptOf(run);
        if (!attempt) return false;
        // Already has its own run of this name: its evidence is the decider.
        if (producedThisName.has(attempt)) return false;
        // A skipping attempt preserves older evidence for every name.
        return characters.get(attempt) !== 'skipping';
      })
      .map((run) => recency(run))
      .reduce((newest, stamp) => (stamp > newest ? stamp : newest), ''));
  }
  return watermarks;
}

export function gateWatermarkFor(checkRuns, name) {
  return gateWatermarks(checkRuns).get(name) ?? '';
}

// When each attempt's gates completed.
//
// An attempt's currency is fixed by its GATES, not by when its product jobs
// happen to finish. Gates run first and launch the products, so the gate stamp
// dates the merge result the whole attempt tested.
export function attemptGateStamps(checkRuns) {
  const stamps = new Map();
  for (const run of Array.isArray(checkRuns) ? checkRuns : []) {
    if (!GATE_CHECKS.includes(run?.name) || run?.status !== 'completed') continue;
    const attempt = attemptOf(run);
    if (!attempt) continue;
    const stamp = recency(run);
    if (stamp > (stamps.get(attempt) ?? '')) stamps.set(attempt, stamp);
  }
  return stamps;
}

// The stamp a product run's coverage claim is judged by.
//
// Comparing the run's own `completed_at` to the watermark is not enough: a
// product job from a SUPERSEDED attempt can still be running when a retarget
// lands, and finish after the new base's gates. Its completion is then the
// newest of its name, but it tested the previous merge result. Dating it by its
// attempt's gates puts it back where it belongs.
//
// A run whose attempt has no visible completed gate cannot be dated that way;
// it falls back to its own recency rather than being declared superseded, which
// would stall a head over missing history rather than over real evidence.
export function coverageStamp(run, stamps) {
  const attempt = attemptOf(run);
  const attemptStamp = attempt ? stamps?.get(attempt) : undefined;
  return attemptStamp ?? recency(run);
}

// Which of a name's runs speaks for the head, newest-first.
//
// Completion time alone picks the wrong one. A product job from a superseded
// attempt can still be running when a retarget lands and finish AFTER the new
// attempt's own run of that name has already failed — so the stale success is
// the newest completion, and a completion-ordered sort selects it and reports
// success over red exact-head CI. Attempt currency has to decide first; within
// one attempt (a rerun-failed-jobs shares its suite) completion decides, so a
// rerun still masks the failure it repaired.
export function coverageOrder(stamps) {
  return (a, b) => {
    const aStamp = coverageStamp(a, stamps);
    const bStamp = coverageStamp(b, stamps);
    if (aStamp !== bStamp) return aStamp > bStamp ? -1 : 1;
    return newestFirst(a, b);
  };
}
