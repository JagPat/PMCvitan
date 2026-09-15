// Weekly review metrics: read-only GitHub REST collection into a timestamped snapshot, then a pure
// aggregation with explicit definitions. `--week 2026-09-07 --output docs/METRICS.md [--from-cache]`
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CODEX_LOGIN } from './review-policy.mjs';

export const FAMILIES = [
  ['missing-counterpart', /\bno (?:event|audit row|claim|receipt)\b|without (?:its|the|an?) (?:event|audit|claim)|absen|omits (?:both|the)/iu],
  ['identity-recipient-actor', /\bactor|recipient|audience|target(?:ed|s)? |identity|attributed|tenant|cross-project/iu],
  ['no-op-transition', /no-op|xmin|touch|stand in|not (?:a|the) transition|state, not/iu],
  ['alternate-writer-coverage', /alternate writer|shared function|other branch|only (?:the|for) .*branch|bypass|coverage/iu],
  ['lock-order-concurrency', /\block|race|concurren|interleav|deadlock|serializ/iu],
  ['migration-immutability-replay', /migration bytes|replay|re-?run|idempot|baseline|rewrit/iu],
  ['whitespace-input', /whitespace|btrim|non-?blank|CHECK constraint/iu],
  ['previous-generation-compat', /previous release|prior generation|drain|legacy|old writer|4d-i writer/iu],
];
export function classify(body) {
  for (const [family, pattern] of FAMILIES) if (pattern.test(String(body ?? ''))) return family;
  return 'unclassified';
}
export function weekBounds(week) {
  const start = new Date(`${week}T00:00:00Z`);
  // an impossible date (2026-02-30) would be normalised forward by Date: refuse unless it round-trips
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(week)) || Number.isNaN(start.getTime()) || start.toISOString().slice(0, 10) !== week) throw new Error('--week must be a real UTC date, YYYY-MM-DD');
  return { start: start.toISOString(), end: new Date(start.getTime() + 7 * 86_400_000).toISOString() };
}
const hours = (from, to) => (Date.parse(to) - Date.parse(from)) / 3_600_000;
const mergedInWeek = (pr, bounds) => Boolean(pr.merged_at) && Date.parse(pr.merged_at) >= Date.parse(bounds.start) && Date.parse(pr.merged_at) < Date.parse(bounds.end);
const median = (values) => { const s = [...values].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const isCodex = (item) => item?.user?.login === CODEX_LOGIN;

/** Pure: `snapshot` is what `collect` writes. */
export function aggregate(snapshot) {
  const bounds = weekBounds(snapshot.week);
  const merged = snapshot.pulls.filter((pr) => mergedInWeek(pr, bounds));
  const open = snapshot.pulls.filter((pr) => pr.state === 'open' && Date.parse(pr.created_at) < Date.parse(bounds.end));
  const per = [];
  const families = {};
  let ciHours = 0; let jobsMissing = 0; let missingEvidence = 0;
  for (const pr of merged) {
    const before = (at) => !at || Date.parse(at) <= Date.parse(pr.merged_at);
    const comments = [...new Map((snapshot.comments[pr.number] ?? []).filter((c) => isCodex(c) && before(c.created_at)).map((c) => [c.id, c])).values()];
    const reviews = (snapshot.reviews[pr.number] ?? []).filter((r) => isCodex(r) && before(r.submitted_at));
    const heads = new Set([...comments.map((c) => c.original_commit_id ?? c.commit_id), ...reviews.map((r) => r.commit_id)].filter(Boolean));
    const findingHeads = new Set(comments.map((c) => c.original_commit_id ?? c.commit_id).filter(Boolean));
    const first = comments.map((c) => c.created_at).sort()[0] ?? null;
    const cleanReactions = (snapshot.reactions[pr.number] ?? []).filter((r) => isCodex(r) && r.content === '+1').length;
    if (comments.length === 0 && reviews.length === 0 && cleanReactions > 0) missingEvidence += 1; // a reaction binds no SHA; a review does
    const jobs = snapshot.jobs[pr.number];
    if (!Array.isArray(jobs)) jobsMissing += 1;
    const seen = new Set();
    const prHours = (jobs ?? []).reduce((sum, job) => {
      if (!job.started_at || !job.completed_at || seen.has(job.id)) return sum; // each attempt is its own job id
      seen.add(job.id); return sum + hours(job.started_at, job.completed_at);
    }, 0);
    ciHours += prHours;
    for (const c of comments) (families[classify(c.body)] ??= []).push(c.id);
    per.push({ number: pr.number, reviewedHeads: heads.size, findingHeads: findingHeads.size, findings: comments.length,
      firstFindingToMergeHours: first ? hours(first, pr.merged_at) : null, ciHours: prHours });
  }
  return {
    week: snapshot.week, bounds, fetchedAt: snapshot.fetchedAt, repository: snapshot.repository,
    merges: merged.length, pulls: per,
    findingHeadsTotal: per.reduce((n, p) => n + p.findingHeads, 0),
    findingsTotal: per.reduce((n, p) => n + p.findings, 0),
    medianFirstFindingToMergeHours: median(per.map((p) => p.firstFindingToMergeHours).filter((h) => h !== null)),
    ciHoursPerMerge: merged.length ? ciHours / merged.length : null, ciHours,
    families, missingEvidence, jobsMissing,
    backlog: open.map((pr) => ({ number: pr.number, ageDays: Math.round(hours(pr.created_at, bounds.end) / 24) })),
  };
}

export function render(report) {
  const fmt = (n) => (n === null ? 'n/a' : Number(n).toFixed(1));
  return [
    '# Weekly review metrics', '',
    `Generated by \`scripts/review-metrics.mjs\` from a snapshot fetched at ${report.fetchedAt} for ${report.repository}.`,
    `Week (UTC): ${report.bounds.start.slice(0, 10)} to ${report.bounds.end.slice(0, 10)} (end exclusive).`, '',
    '## Definitions', '',
    '- **Cohort**: pull requests whose `merged_at` falls inside the week. Pull requests still open at the snapshot and opened before the week ended are reported as backlog age at week end, never as a merge duration.',
    '- **Finding-bearing heads**: distinct `original_commit_id` values among Codex inline review comments (author replies and reviews without inline findings excluded; comments deduplicated by id). Reviewed heads add clean Codex reviews by `commit_id`.',
    '- **First finding to merge**: `merged_at` minus the earliest Codex finding timestamp, in hours; `n/a` when the PR received no finding.',
    '- **CI hours per merge**: runner-job elapsed hours (`completed_at` minus `started_at`) over every workflow run on the PR heads, each attempt counted once by job id, divided by merges. Workflow durations are not summed on top of job durations. PRs whose job data could not be fetched are counted under `jobs missing`.',
    '- **Missing evidence**: a merged PR whose only Codex signal is a thumbs-up reaction, which binds no SHA; nothing is guessed.',
    '- **Recurrence by family**: each finding is classified by the first matching keyword pattern in `FAMILIES`; unmatched findings stay `unclassified` and keep their comment ids.', '',
    '## Summary', '', '| Metric | Value |', '| --- | --- |',
    `| Merges in cohort | ${report.merges} |`, `| Finding-bearing heads (total) | ${report.findingHeadsTotal} |`,
    `| Findings (total) | ${report.findingsTotal} |`, `| Median first finding to merge (h) | ${fmt(report.medianFirstFindingToMergeHours)} |`,
    `| CI hours per merge | ${fmt(report.ciHoursPerMerge)} |`, `| Merged PRs missing evidence | ${report.missingEvidence} |`,
    `| Merged PRs missing job data | ${report.jobsMissing} |`, `| Open backlog | ${report.backlog.length} |`, '',
    '## Per merged pull request', '', '| PR | Reviewed heads | Finding heads | Findings | First finding to merge (h) | CI hours |', '| --- | --- | --- | --- | --- | --- |',
    ...report.pulls.map((p) => `| #${p.number} | ${p.reviewedHeads} | ${p.findingHeads} | ${p.findings} | ${fmt(p.firstFindingToMergeHours)} | ${fmt(p.ciHours)} |`), '',
    '## Recurrence by family (comment ids)', '',
    ...Object.entries(report.families).sort().map(([family, ids]) => `- **${family}**: ${ids.length} — ${ids.join(', ')}`),
    ...(Object.keys(report.families).length === 0 ? ['- none'] : []), '',
    '## Open backlog', '', ...(report.backlog.length ? report.backlog.map((b) => `- #${b.number}: ${b.ageDays} days old at week end`) : ['- none']), '',
    '## Comparison note', '',
    'These definitions differ from the supplied historical audit (588 PRs, 911 reviews, 3,108 findings): that audit counted every review and comment over the repository\'s life; this report counts one UTC week, deduplicates inline comments by id, attributes rounds to original reviewed heads, and classifies by keyword. Totals are not tuned to reconcile.', '',
  ].join('\n');
}

export async function collect({ week, repository, token, fetchImpl = globalThis.fetch, log = () => {} }) {
  const bounds = weekBounds(week);
  const api = async (path, stopWhen = () => false) => {
    const items = [];
    for (let page = 1; ; page += 1) {
      const response = await fetchImpl(`https://api.github.com${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
        { headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
      if (!response.ok) throw new Error(`GitHub ${path} page ${page}: HTTP ${response.status}${response.status === 403 || response.status === 429 ? ' (rate limited; snapshot incomplete, nothing written)' : ''}`);
      const batch = await response.json();
      const list = Array.isArray(batch) ? batch : (batch.jobs ?? batch.workflow_runs ?? null);
      if (!Array.isArray(list)) throw new Error(`GitHub ${path}: unexpected payload`);
      items.push(...list);
      if (list.length < 100 || stopWhen(list.at(-1))) return items;
      if (page > 200) throw new Error(`GitHub ${path}: pagination did not terminate`);
    }
  };
  // merged: newest-updated first, stopping before the week; open: the WHOLE listing (a dormant backlog item predates it)
  const closed = await api(`/repos/${repository}/pulls?state=closed&sort=updated&direction=desc`, (pr) => Date.parse(pr.updated_at) < Date.parse(bounds.start));
  const relevant = [...await api(`/repos/${repository}/pulls?state=open`), ...closed.filter((pr) => mergedInWeek(pr, bounds))];
  const snapshot = { week, fetchedAt: new Date().toISOString(), repository, pulls: relevant, comments: {}, reviews: {}, reactions: {}, jobs: {} };
  for (const pr of relevant) {
    if (!pr.merged_at) continue; // an open entry is backlog by its creation time only: no evidence feeds are spent on it
    log(`collecting #${pr.number}`);
    snapshot.comments[pr.number] = await api(`/repos/${repository}/pulls/${pr.number}/comments`);
    snapshot.reviews[pr.number] = await api(`/repos/${repository}/pulls/${pr.number}/reviews`);
    snapshot.reactions[pr.number] = await api(`/repos/${repository}/issues/${pr.number}/reactions`);
    const commits = await api(`/repos/${repository}/pulls/${pr.number}/commits`);
    const jobs = [];
    for (const commit of commits) {
      for (const run of await api(`/repos/${repository}/actions/runs?head_sha=${commit.sha}`)) {
        jobs.push(...(await api(`/repos/${repository}/actions/runs/${run.id}/jobs?filter=all`)).map((j) => ({ id: j.id, started_at: j.started_at, completed_at: j.completed_at })));
      }
    }
    snapshot.jobs[pr.number] = jobs;
  }
  return snapshot;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const option = (flag, fallback) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback);
  const week = option('--week'); const output = option('--output', 'docs/METRICS.md');
  const repository = option('--repo', 'JagPat/PMCvitan');
  // the raw snapshot lives outside the tree: reruns use --from-cache, nothing is committed by accident
  const cacheDir = join(tmpdir(), 'review-metrics', repository.replace('/', '__')); const cache = join(cacheDir, `${week}.json`);
  if (!week) { console.error('usage: review-metrics.mjs --week YYYY-MM-DD [--output docs/METRICS.md] [--repo owner/name] [--from-cache]'); process.exit(2); }
  let snapshot;
  if (args.includes('--from-cache')) snapshot = JSON.parse(readFileSync(cache, 'utf8'));
  else {
    // a read-only token, or none where an authenticating proxy serves api.github.com
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
    snapshot = await collect({ week, repository, token, log: console.error });
    mkdirSync(cacheDir, { recursive: true }); writeFileSync(cache, JSON.stringify(snapshot));
  }
  writeFileSync(output, render(aggregate(snapshot)));
  console.error(`review-metrics: wrote ${output} (snapshot ${cache})`);
}
