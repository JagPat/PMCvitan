import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { isAutonomousPullRequest } from './autonomous-handoff.mjs';

const repository = 'JagPat/PMCvitan';

function pullRequest(overrides = {}) {
  return {
    state: 'open',
    head: { ref: 'claude/task', repo: { full_name: repository } },
    base: { ref: 'main', repo: { full_name: repository } },
    ...overrides,
  };
}

test('accepts only open same-repository Claude branches', () => {
  assert.equal(isAutonomousPullRequest(pullRequest(), repository, 'main'), true);
  assert.equal(
    isAutonomousPullRequest(pullRequest({ state: 'closed' }), repository, 'main'),
    false,
  );
  assert.equal(
    isAutonomousPullRequest(
      pullRequest({ head: { ref: 'feature/task', repo: { full_name: repository } } }),
      repository,
      'main',
    ),
    false,
  );
  assert.equal(
    isAutonomousPullRequest(
      pullRequest({ head: { ref: 'claude/task', repo: { full_name: 'fork/repo' } } }),
      repository,
      'main',
    ),
    false,
  );
  assert.equal(
    isAutonomousPullRequest(
      pullRequest({ base: { ref: 'release', repo: { full_name: repository } } }),
      repository,
      'main',
    ),
    false,
  );
});

test('handoff workflow is event-driven and runs trusted default-branch code', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/autonomous-handoff.yml', import.meta.url),
    'utf8',
  );

  assert.match(workflow, /pull_request_target:/);
  assert.match(workflow, /push:/);
  assert.match(workflow, /branches:\s*\[main\]/);
  assert.match(workflow, /ref:\s*\$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(workflow, /persist-credentials:\s*false/);
  assert.match(workflow, /scripts\/autonomous-handoff\.mjs/);
  assert.doesNotMatch(workflow, /schedule:/);
  assert.match(workflow, /group:\s*autonomous-handoff/);
  assert.match(workflow, /cancel-in-progress:\s*false/);
});

test('handoff implementation covers both conflicts and behind-base states', async () => {
  const implementation = await readFile(
    new URL('./autonomous-handoff.mjs', import.meta.url),
    'utf8',
  );

  assert.match(implementation, /live\.mergeable !== false/);
  assert.match(implementation, /live\.mergeable_state !== 'behind'/);
  assert.match(implementation, /while \(live\.mergeable === null/);
  assert.match(implementation, /MERGEABILITY_TIMEOUT_MS/);
  assert.match(implementation, /pullRequest\?\.base\?\.ref !== defaultBranch/);
  assert.match(implementation, /mergedPullRequestsSinceEnabled/);
  assert.match(implementation, /HANDOFF_ENABLED_AT/);
  assert.match(implementation, /liveMergedPullRequest/);
  assert.match(implementation, /comments\?per_page=100&page=\$\{page\}/);
  assert.doesNotMatch(implementation, /if \(eventName === 'pull_request_target'\)/);
});
