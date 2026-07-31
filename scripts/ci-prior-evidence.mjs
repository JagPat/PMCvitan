// Reads the PRESERVED product evidence for this head.
//
// Used only when `battery-plan` skipped the product jobs as already covered.
// That decision deliberately counts a FAILED product run as coverage, which is
// safe while each product check is independently required — and unsafe the
// moment `quality-gate` becomes the single required status, because a title or
// body edit would then publish green over a red head with no new commit.
//
// Every failure path here reports NOT-ok. Evidence that cannot be read is not
// evidence of success.
import { readFile, appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { PRODUCT_CHECKS } from './ci-battery-plan.mjs';
import {
  attemptGateStamps,
  attemptOf,
  coverageOrder,
  isSkipped,
} from './check-run-coverage.mjs';

// THREE outcomes, not two.
//
// `battery-plan` also skips the products when the first battery for this head
// is still QUEUED or IN PROGRESS — "coverage already in flight". A two-state
// reader collapses that into "no completed run" and the gate publishes a
// TERMINAL failure, even though those very jobs may go green moments later,
// blocking exact-head review until some other event happens to fire.
//
// That is the same mistake `assessQualityGate` exists to prevent: it carefully
// separates "never reached a verdict" from "failed", and this reader — written
// in the same change — did not. So `pending` is a first-class outcome here, and
// the caller waits it out rather than converting it into a verdict.
export function assessPriorEvidence(checkRuns) {
  if (!Array.isArray(checkRuns)) {
    return { ok: false, pending: false, detail: 'check history unavailable' };
  }
  const stamps = attemptGateStamps(checkRuns);
  const bad = [];
  const inFlight = [];
  for (const name of PRODUCT_CHECKS) {
    const mine = checkRuns.filter((run) => run.name === name && !isSkipped(run));
    // Order by ATTEMPT CURRENCY first, then ask about unfinished runs. Asking
    // first meant one hung job from a SUPERSEDED attempt pinned the suite to
    // `pending` forever, even after a newer attempt had completed all five
    // green — the gate then failed the wait on evidence that was already good.
    const decider = mine
      .filter((run) => run.status === 'completed')
      .sort(coverageOrder(stamps))[0];
    const deciderStamp = decider ? (stamps.get(attemptOf(decider)) ?? '') : '';

    // An unfinished run only matters when it belongs to the decider's attempt
    // or a NEWER one. Older unfinished runs are stale and cannot change what
    // the current attempt already concluded.
    const current = mine.some((run) => run.status !== 'completed'
      && (stamps.get(attemptOf(run)) ?? '') >= deciderStamp);

    if (!decider) {
      (current ? inFlight : bad).push(current ? name : `${name}: no completed run`);
      continue;
    }
    if (decider.conclusion !== 'success') {
      bad.push(`${name}: ${decider.conclusion}`);
      continue;
    }
    if (current) inFlight.push(name);
  }

  // A REAL failure decides immediately — waiting for a sibling to finish cannot
  // turn an already-red check green, and reporting pending there would delay a
  // verdict that is already knowable.
  if (bad.length > 0) return { ok: false, pending: false, detail: bad.join('; ') };
  if (inFlight.length > 0) {
    return {
      ok: false,
      pending: true,
      detail: `still running: ${inFlight.join(', ')}`,
    };
  }
  return { ok: true, pending: false, detail: 'every product check is green on this head' };
}

export async function run({
  eventPath = process.env.GITHUB_EVENT_PATH,
  repository = process.env.GITHUB_REPOSITORY,
  token = process.env.GH_TOKEN,
  outputPath = process.env.GITHUB_OUTPUT,
  fetchImpl = fetch,
  waitMs = Number(process.env.EVIDENCE_WAIT_MS ?? 10 * 60_000),
  pollMs = Number(process.env.EVIDENCE_POLL_MS ?? 15_000),
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
} = {}) {
  const read = async () => {
    const event = JSON.parse(await readFile(eventPath, 'utf8'));
    const headSha = event.pull_request?.head?.sha;
    if (!headSha || !repository || !token) throw new Error('head, repo and token required');

    const runs = [];
    let page = 1;
    let complete = false;
    while (true) {
      const response = await fetchImpl(
        `https://api.github.com/repos/${repository}/commits/${headSha}`
          + `/check-runs?filter=all&per_page=100&page=${page}`,
        {
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/vnd.github+json',
            'user-agent': 'pmcvitan-ci-prior-evidence',
          },
        },
      );
      if (!response.ok) break;
      const batch = (await response.json()).check_runs ?? [];
      runs.push(...batch);
      if (batch.length < 100) {
        complete = true;
        break;
      }
      page += 1;
    }
    if (!complete) throw new Error('check history was incomplete');
    return assessPriorEvidence(runs);
  }

  // Poll while the preserved battery is still in flight. Waiting is what makes
  // the verdict TERMINAL and correct: the in-flight jobs are the evidence, and
  // converting "not finished" into "failed" is precisely the defect.
  let verdict;
  const deadline = now() + waitMs;
  try {
    for (;;) {
      verdict = await read();
      if (!verdict.pending || now() >= deadline) break;
      await sleep(pollMs);
    }
    if (verdict.pending) {
      // Bounded and honest: still undecided, so fail closed rather than guess.
      // A re-run resolves it once the battery lands.
      verdict = {
        ok: false,
        pending: true,
        detail: `${verdict.detail} — still undecided after the wait`,
      };
    }
  } catch (error) {
    verdict = { ok: false, pending: false, detail: `evidence unreadable (${error.message})` };
  }

  console.log(`prior-evidence: ok=${verdict.ok}; ${verdict.detail}`);
  if (outputPath) {
    await appendFile(outputPath, `verdict=${JSON.stringify(verdict)}\n`);
  }
  return verdict;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await run();
}
