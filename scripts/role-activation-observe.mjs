import { appendFileSync, readFileSync } from 'node:fs';

import { GitHubClient } from './autonomous-review-gate.mjs';
import { LINEAGE_BASE_REF } from './review-policy.mjs';
import { readRoleActivationEvidence } from './role-activation-evidence.mjs';
import { roleTransferActivationVerdict } from './role-activation.mjs';

/**
 * Role-transfer OBSERVER (manual, read-only, non-activating).
 *
 * Runs the trusted evidence reader (scripts/role-activation-evidence.mjs) over ONE correction cycle — one PR and
 * the `codex-fix-probe` request comment that started it — and judges it with the pure verdict
 * (scripts/role-activation.mjs). It reports the verdict, every proof, the reader's diagnostics and the
 * normalized evidence to the job summary. It writes nothing to GitHub: no status, comment, label, branch,
 * setting or merge, and it applies nothing — an `activate` verdict is a readiness decision that a later,
 * operator-authorized installer must re-read and bind to. `codex-current-head` stays the required gate.
 *
 * `workflow_dispatch` only, from the trusted default branch only, with a read-only token.
 */

export async function observeRoleActivation({ client, pullRequest, requestCommentId, now }) {
  const evidence = await readRoleActivationEvidence(client, { pullRequest, requestCommentId, now });
  const verdict = roleTransferActivationVerdict(evidence, { repository: client.repository, pullRequest });
  return { repository: client.repository, pullRequest, requestCommentId, verdict, evidence };
}

const list = (items) => (items.length === 0 ? '- none' : items.map((item) => `- \`${item}\``).join('\n'));

/** The observation as a job-summary page: verdict first, then proofs, diagnostics and the raw evidence. */
export function renderObservation({ repository, pullRequest, requestCommentId, verdict, evidence }) {
  const lines = [
    `## Role-transfer observation: ${repository}#${pullRequest}, request ${requestCommentId}`,
    '',
    `**Verdict: \`${verdict.state}\`** (activate: ${verdict.activate}; keep \`codex-current-head\`: `
      + `${verdict.keepCodexCurrentHead}; retire it: ${verdict.retireCodexCurrentHead}).`,
    '',
    'This is an observation only. Nothing was installed, routed or retired, and no GitHub state was written. '
      + 'An `activate` verdict is a readiness decision: the switch needs the operator-authorized installer.',
    '',
    `### Missing proofs (${verdict.missing.length})`,
    list(verdict.missing),
    '',
    `### Proven (${verdict.proven.length})`,
    list(verdict.proven),
    '',
    `### Reader diagnostics (${evidence.problems?.length ?? 0})`,
    list(evidence.problems ?? []),
    '',
  ];
  if (verdict.install) {
    lines.push('### Install binding (data only)', '', '```json', JSON.stringify(verdict.install, null, 2), '```', '');
  }
  lines.push(
    '<details><summary>Normalized evidence</summary>',
    '',
    '```json',
    JSON.stringify({ schema: evidence.schema, cycle: evidence.cycle, records: evidence.records }, null, 2),
    '```',
    '',
    '</details>',
    '',
  );
  return lines.join('\n');
}

/** The dispatch seam: guards first (no API call before them), then one observation. */
export async function runObserve({ env, loadEvent, makeClient, writeSummary = () => {}, now }) {
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch') throw new Error('not_workflow_dispatch');
  if (env.GITHUB_REF !== `refs/heads/${LINEAGE_BASE_REF}`) throw new Error('untrusted_ref');
  const repository = loadEvent()?.repository?.full_name;
  const pullRequest = Number(String(env.OBSERVE_PR_NUMBER ?? '').trim());
  const requestCommentId = Number(String(env.OBSERVE_REQUEST_COMMENT_ID ?? '').trim());
  if (typeof repository !== 'string' || repository.length === 0) throw new Error('no repository');
  if (!Number.isInteger(pullRequest) || pullRequest <= 0) throw new Error('pr_number must be a positive integer');
  if (!Number.isInteger(requestCommentId) || requestCommentId <= 0) {
    throw new Error('request_comment_id must be a positive integer');
  }
  const observation = await observeRoleActivation({ client: makeClient(repository), pullRequest, requestCommentId, now });
  writeSummary(renderObservation(observation));
  return observation;
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is required');
  const observation = await runObserve({
    env: process.env,
    loadEvent: () => JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')),
    makeClient: (repository) => new GitHubClient({ repository, token }),
    writeSummary: (text) => {
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
      else process.stdout.write(text);
    },
  });
  console.log(`role-activation-observe: ${observation.verdict.state}; missing ${JSON.stringify(observation.verdict.missing)}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}
