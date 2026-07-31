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
import { coverageOrder, attemptGateStamps, isSkipped } from './check-run-coverage.mjs';

export function assessPriorEvidence(checkRuns) {
  if (!Array.isArray(checkRuns)) {
    return { ok: false, detail: 'check history unavailable' };
  }
  const stamps = attemptGateStamps(checkRuns);
  const bad = [];
  for (const name of PRODUCT_CHECKS) {
    const runs = checkRuns
      .filter((run) => run.name === name && run.status === 'completed' && !isSkipped(run))
      .sort(coverageOrder(stamps));
    if (runs.length === 0) {
      bad.push(`${name}: no completed run`);
      continue;
    }
    if (runs[0].conclusion !== 'success') {
      bad.push(`${name}: ${runs[0].conclusion}`);
    }
  }
  return bad.length === 0
    ? { ok: true, detail: 'every product check is green on this head' }
    : { ok: false, detail: bad.join('; ') };
}

export async function run({
  eventPath = process.env.GITHUB_EVENT_PATH,
  repository = process.env.GITHUB_REPOSITORY,
  token = process.env.GH_TOKEN,
  outputPath = process.env.GITHUB_OUTPUT,
  fetchImpl = fetch,
} = {}) {
  let verdict;
  try {
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
    verdict = assessPriorEvidence(runs);
  } catch (error) {
    verdict = { ok: false, detail: `evidence unreadable (${error.message})` };
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
