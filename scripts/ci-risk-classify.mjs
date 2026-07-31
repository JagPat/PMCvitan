// CI entry point for the risk classification. Reads the pull request's changed
// files and publishes the suites to run.
//
// Every failure path here widens: an unreadable event, an API error, a partial
// page read. A classifier that cannot see the change must not be allowed to
// narrow the battery on a guess.
import { readFile, appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { SUITES, classifyChangedFiles } from './ci-risk-classification.mjs';

export async function run({
  eventPath = process.env.GITHUB_EVENT_PATH,
  repository = process.env.GITHUB_REPOSITORY,
  token = process.env.GH_TOKEN,
  outputPath = process.env.GITHUB_OUTPUT,
  fetchImpl = fetch,
} = {}) {
  let plan;
  try {
    if (!eventPath) throw new Error('GITHUB_EVENT_PATH is required');
    const event = JSON.parse(await readFile(eventPath, 'utf8'));
    const number = event.pull_request?.number;
    if (!number || !repository || !token) {
      throw new Error('pull request number, repository and token are all required');
    }

    // Paginated. A page that fails mid-read leaves a PREFIX of the file list,
    // and a prefix is the dangerous shape: the unread page is exactly where
    // the schema change hides. Partial listing is no listing.
    const headers = {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'pmcvitan-ci-risk-classify',
    };

    // How many files GitHub says changed. The files endpoint stops returning
    // more after 3000, and page 31 then looks exactly like an ordinary short
    // final page — `complete` would be true over a TRUNCATED list, and an
    // omitted root config or API path would narrow the battery. The declared
    // count is the only way to tell a real end from a cap.
    const prResponse = await fetchImpl(
      `https://api.github.com/repos/${repository}/pulls/${number}`, { headers },
    );
    if (!prResponse.ok) throw new Error(`pull request read failed (${prResponse.status})`);
    const declared = (await prResponse.json()).changed_files;
    if (!Number.isInteger(declared)) throw new Error('changed_files count unavailable');

    const files = [];
    let page = 1;
    let complete = false;
    while (true) {
      const response = await fetchImpl(
        `https://api.github.com/repos/${repository}/pulls/${number}`
          + `/files?per_page=100&page=${page}`,
        { headers },
      );
      if (!response.ok) break;
      const batch = await response.json();
      if (!Array.isArray(batch)) break;
      // Keep the ENTRY, not just the name: a rename carries `previous_filename`
      // and both sides have to be classified.
      files.push(...batch);
      if (batch.length < 100) {
        complete = true;
        break;
      }
      page += 1;
    }
    if (!complete) throw new Error('changed-file listing was incomplete');
    if (files.length !== declared) {
      throw new Error(
        `changed-file listing is short (${files.length} of ${declared}); `
          + 'the API cap may have truncated it',
      );
    }

    plan = classifyChangedFiles(files);
  } catch (error) {
    plan = {
      suites: [...SUITES],
      confident: false,
      unknown: [],
      reason: `classification errored (${error.message}); running the full battery`,
    };
  }

  console.log(
    `classify: suites=${plan.suites.join(',') || '(none)'}; `
      + `confident=${plan.confident}; ${plan.reason}`,
  );
  if (outputPath) {
    // A comma-joined list with surrounding commas, so the workflow's
    // `contains(needs.classify.outputs.suites, 'api')` cannot match 'api'
    // inside 'api-e2e'. Without the delimiters, selecting api-e2e alone would
    // silently drag in the api suite — a widening, but a wrong one, and the
    // same trick in reverse would hide a real narrowing bug.
    const encoded = plan.suites.length > 0 ? `,${plan.suites.join(',')},` : '';

    // `reason` embeds UNKNOWN FILENAMES, and a filename may contain a newline.
    // Written raw, a path containing "\nsuites=" would define `suites` a second
    // time — and because a later assignment wins, the attacker-chosen value
    // would replace the real one. The exact case that must run everything (an
    // unrecognised path) is the case that carries the payload, so this is a
    // narrowing primitive, not merely cosmetic corruption.
    //
    // Fixed by construction: `reason` is reduced to a safe alphabet and capped,
    // so no filename can introduce a line break or an `=` assignment at all.
    // `suites` and `confident` come from a closed vocabulary and cannot carry
    // one. It is also emitted LAST, so even a hypothetical escape could not
    // precede and be overridden by the values that matter.
    const safeReason = String(plan.reason)
      .replace(/[^\p{L}\p{N} ,.:;()/'"-]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, 400);
    await appendFile(
      outputPath,
      `suites=${encoded}\nconfident=${plan.confident}\nreason=${safeReason}\n`,
    );
  }
  return plan;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await run();
}
