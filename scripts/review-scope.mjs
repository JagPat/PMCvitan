import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { assessReviewScope } from './review-efficiency.mjs';

export async function run({ eventPath = process.env.GITHUB_EVENT_PATH } = {}) {
  if (!eventPath) throw new Error('GITHUB_EVENT_PATH is required');
  const event = JSON.parse(await readFile(eventPath, 'utf8'));
  if (!event.pull_request) {
    console.log('review-scope: no pull request in this event; nothing to assess');
    return { state: 'not_applicable', allowed: true };
  }

  const result = assessReviewScope(event.pull_request);
  console.log(
    `review-scope: ${result.state}; ${result.changedFiles} files, ${result.changedLines} changed lines`,
  );
  if (!result.allowed) {
    console.error(`::error title=Review unit is too broad::${result.detail}`);
    process.exitCode = 1;
  }
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await run();
}
