// The drain directive's clearance rule, made executable.
//
// `phase-6-4d-previous-release-drained` is the one blocking directive whose clearing is a PRODUCTION
// fact: every serving process older than the release carrying A8b is stopped or drained. Until the
// owner's decision of 2026-10-01 (#482 comment 5929472784) that fact was supplied by a human
// `OPERATOR-ATTESTATION`; `rollout:drain-evidence` (apps/api/src/platform/rollout/drain-evidence.ts)
// recorded corroboration beside it. With the attestation withdrawn, the corroboration IS the gate — and
// a gate nothing trusted reads is not a gate (PR #686, Codex finding 4157323191: a STATUS-only PR could
// have set `blocking_directive: none` and unlocked 4d-iii without a fresh `drained` verdict).
//
// So two trusted readers run this rule on every PR that changes docs/STATUS.md: the PR-side
// `review-scope` job (the PR's own tree on disk, the base read from the base SHA) and the default-branch
// merge controller (`enforceReviewScope`, both trees read from the exact SHAs through the API, so a PR
// cannot admit itself by editing this file in its own checkout — #686 finding 4163577352). A PR whose
// head Now block no longer carries the directive the BASE Now block carries is a clearance (the base and
// head VALUES are compared, never only the diff text, so appending a second `blocking_directive: none`
// line is caught: a Now block that repeats any key is refused outright — #686 finding 4163577340). A
// clearance is admitted only when the PR itself adds or changes the committed evidence record — the
// JSON `rollout:drain-evidence` prints — at docs/rollout/phase-6-4d-drain-evidence.json (a record
// already in the tree is a snapshot of an earlier fleet and is not reused — #686 finding 4163577348),
// and that record is a `drained` verdict for THIS directive and THIS minimum release, recorded after
// the directive was set and not in the future. The record must be REGENERATED ON THE CLEARING HEAD: the
// head commit itself must change the evidence file, and the record cannot be dated after that commit
// (#686 finding 4163934196 — a record added on an early head of a long-open PR stays "changed in this
// PR" while the fleet moves on; the cumulative diff is not freshness, the head commit is). Anything else
// (no record, a reused or stale record, `not-drained`, `unclassified`, another directive, another
// minimum, a verdict older than the directive, an unreadable record, an unreadable STATUS or head
// commit) refuses. The CLI itself still changes nothing: the operator runs it where the platform token
// is held and commits its stdout at the evidence path, in the commit that clears the directive.
//
// The record's SHAPE is not trusted (#686's shadow review, round 1): a `verdict` field can be edited. The
// gate RE-DERIVES the verdict from the inventory the same record carries — the persisted generation
// fence, the application's status, classification and in-progress deployments, every live lease's
// catalog version and classification — by `judgeDrain`'s rules (pinned against the real `judgeDrain` in
// apps/api/src/platform/rollout/drain-evidence.test.ts, so the two cannot drift), and admits the record
// only when that derivation is `drained` AND agrees with the stated verdict. Editing `verdict` and
// `findings` on a not-drained record therefore changes nothing: the lease or image it still carries
// re-derives to not-drained.
//
// What this module does NOT establish is that the record came from a real run against production, or who
// produced it: a wholly fabricated, internally consistent record is a provenance question the gate cannot
// answer from the tree alone (the PR's `correction-owner` marker names who fixes review findings, not who
// authored the change, so it is no handle for "the producer cannot clear the directive it landed"), and it
// is recorded as such in STATUS, open for the owner's decision.
import { readFile } from 'node:fs/promises';

import { isNoneValue, parseStatusNow } from './autonomous-status-state.mjs';
import { STATUS_DOCUMENT } from './review-efficiency.mjs';

export const DRAIN_DIRECTIVE = 'phase-6-4d-previous-release-drained';
export const DRAIN_EVIDENCE_MARKER = 'DRAIN-EVIDENCE';
/** Where the operator commits `rollout:drain-evidence`'s JSON (its stdout) for the gate to read. */
export const DRAIN_EVIDENCE_DOCUMENT = 'docs/rollout/phase-6-4d-drain-evidence.json';
/** The drain's minimum release: `main` at A8b (#673) — the server release carrying the bumped consumer
 *  contracts and the persisted server-generation minimum. 4d-ii-b was client-only, so it is unchanged. */
export const DRAIN_MINIMUM_RELEASE = 'f8274f411191dbbd626cab9bc74468325951674a';
/** When the directive was set on `main` (#685 merged as 4707c5d). A verdict recorded before the directive
 *  existed cannot be the fresh one that clears it. */
export const DRAIN_DIRECTIVE_SET_AT = '2026-10-01T03:19:21Z';
/** Clock skew tolerated between the recording host and the judging host. */
export const RECORDED_AT_SKEW_MS = 5 * 60 * 1000;

const SHA_PREFIX = /^[0-9a-f]{7,40}$/u;

/** Does this STATUS diff remove the drain directive from a yaml line? `null` when the diff carries no
 *  patch text (GitHub omits `patch` for very large diffs), which the caller treats as unknown. Secondary
 *  evidence only: the base and head VALUES decide (`assessDirectiveClearance`). */
export function statusPatchRemovesDirective(patch) {
  if (typeof patch !== 'string') return null;
  return patch.split('\n').some((line) => /^-blocking_directive:[\t ]*phase-6-4d-previous-release-drained[\t ]*$/u.test(line));
}

/**
 * The keys the Now fence repeats, sliced exactly as `parseStatusNow` slices it. `parseStatusNow` keeps
 * the LAST value of a repeated key, so `blocking_directive: <directive>` followed by
 * `blocking_directive: none` parses as cleared while the diff shows no removed line (#686 finding
 * 4163577340); a Now block that repeats any key encodes two states at once and is refused.
 */
export function nowBlockDuplicateKeys(markdown, heading$ = '\n## Now') {
  const source = typeof markdown === 'string' ? markdown : '';
  const heading = source.indexOf(heading$);
  if (heading < 0) return [];
  const fenceStart = source.indexOf('```yaml', heading);
  if (fenceStart < 0) return [];
  const bodyStart = source.indexOf('\n', fenceStart);
  const fenceEnd = source.indexOf('\n```', bodyStart);
  if (bodyStart < 0 || fenceEnd < 0) return [];
  const seen = new Map();
  for (const rawLine of source.slice(bodyStart + 1, fenceEnd).split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, count]) => count > 1).map(([key]) => key).sort();
}

/** Validate a committed evidence record. Returns `{ ok: true, evidence }` or `{ ok: false, reason }`. */
export function parseDrainEvidence(text, { minimumRelease = DRAIN_MINIMUM_RELEASE, setAt = DRAIN_DIRECTIVE_SET_AT, now = Date.now() } = {}) {
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, reason: 'the evidence record is empty' };
  let evidence;
  try {
    evidence = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `the evidence record is not JSON (${error.message})` };
  }
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return { ok: false, reason: 'the evidence record is not an object' };
  if (evidence.marker !== DRAIN_EVIDENCE_MARKER) return { ok: false, reason: `the record's marker is ${JSON.stringify(evidence.marker)}, not ${DRAIN_EVIDENCE_MARKER}` };
  if (evidence.directive !== DRAIN_DIRECTIVE) return { ok: false, reason: `the record names directive ${JSON.stringify(evidence.directive)}, not ${DRAIN_DIRECTIVE}` };
  if (evidence.verdict !== 'drained') return { ok: false, reason: `the record's verdict is ${JSON.stringify(evidence.verdict)}, not "drained"` };
  if (!Array.isArray(evidence.findings) || evidence.findings.length !== 0) return { ok: false, reason: 'a drained verdict carries no findings; this record does' };
  const release = String(evidence.minimumRelease ?? '').trim().toLowerCase();
  if (!SHA_PREFIX.test(release) || !minimumRelease.startsWith(release)) {
    return { ok: false, reason: `the record's minimum release ${JSON.stringify(evidence.minimumRelease)} is not the directive's minimum ${minimumRelease}` };
  }
  if (!evidence.platform || evidence.platform.available !== true) return { ok: false, reason: 'the record was judged without the platform inventory' };
  if (!Array.isArray(evidence.leases)) return { ok: false, reason: 'the record carries no lease register read' };
  const recordedAt = Date.parse(String(evidence.recordedAt ?? ''));
  if (!Number.isFinite(recordedAt)) return { ok: false, reason: `the record's recordedAt ${JSON.stringify(evidence.recordedAt)} is not a timestamp` };
  if (recordedAt < Date.parse(setAt)) return { ok: false, reason: `the record was recorded at ${evidence.recordedAt}, before the directive was set (${setAt}); a clearing verdict must be fresh` };
  if (recordedAt > now + RECORDED_AT_SKEW_MS) return { ok: false, reason: `the record was recorded at ${evidence.recordedAt}, in the future of the judging clock (${new Date(now).toISOString()})` };
  const derived = rederiveDrainVerdict(evidence);
  if (derived.verdict !== 'drained') {
    return { ok: false, reason: `the record says "drained" but its own inventory re-derives to ${derived.verdict}: ${derived.findings.join('; ')}` };
  }
  return { ok: true, evidence };
}

/**
 * The verdict the record's OWN inventory supports, by `judgeDrain`'s rules (apps/api/src/platform/
 * rollout/drain-evidence.ts): `not-drained` on anything provably older than the minimum, `unclassified` on
 * anything that cannot be placed or that makes the fleet unjudgeable, else `drained`. A record whose stated
 * verdict disagrees with this is not evidence of anything. Kept rule-for-rule with `judgeDrain` — an empty
 * lease register adds no finding there and adds none here (#686's shadow review, round 3) — and pinned
 * against it in drain-evidence.test.ts; the only additions are shape checks an honest record always passes
 * (integer catalog versions and generations, the three known classifications).
 */
export function rederiveDrainVerdict(evidence) {
  const findings = [];
  let notDrained = false;
  let unclassified = false;
  const refuse = (f) => { notDrained = true; findings.push(f); };
  const cannot = (f) => { unclassified = true; findings.push(f); };

  const minimumCatalog = Number(evidence?.minimumCatalogVersion?.value);
  if (!Number.isInteger(minimumCatalog) || minimumCatalog < 1) cannot(`minimum catalog version ${JSON.stringify(evidence?.minimumCatalogVersion?.value)} is not a registered generation`);

  // the fence
  const generation = evidence?.generation;
  const compiled = Number(generation?.compiled);
  const persisted = generation?.persistedMinimum;
  if (!persisted || !Number.isInteger(Number(persisted.minimumGeneration))) cannot('no persisted server-generation minimum was read');
  else if (!Number.isInteger(compiled) || Number(persisted.minimumGeneration) > compiled) cannot(`the judging build compiles generation ${JSON.stringify(generation?.compiled)}, below the persisted minimum ${persisted.minimumGeneration}`);

  // (ii) the platform inventory
  const platform = evidence?.platform;
  if (!platform || platform.available !== true) {
    cannot('the platform inventory was not read');
  } else {
    const app = platform.application ?? {};
    if (!/^running\b/u.test(String(app.status ?? ''))) cannot(`application status ${JSON.stringify(app.status)} is not running`);
    if (!Array.isArray(platform.deploymentsInProgress)) cannot('the deployments in progress were not recorded');
    else if (platform.deploymentsInProgress.length > 0) cannot(`${platform.deploymentsInProgress.length} deployment(s) in progress`);
    if (app.classification === 'before') refuse(`application image ${app.gitCommitSha} is BEFORE the minimum release`);
    else if (app.classification !== 'at-or-after') cannot(`application image classification ${JSON.stringify(app.classification)} is not at-or-after`);
  }

  // (i) the lease register: judged lease by lease, as `judgeDrain` does — no lease, no finding
  const leases = Array.isArray(evidence?.leases) ? evidence.leases : null;
  if (!leases) {
    cannot('the lease register was not read');
  } else {
    for (const lease of leases) {
      const version = Number(lease?.catalogVersion);
      if (!Number.isInteger(version) || version < minimumCatalog) refuse(`live lease ${lease?.instanceId} serves at catalog version ${JSON.stringify(lease?.catalogVersion)}, below the minimum ${minimumCatalog}`);
      else if (lease?.classification === 'before') refuse(`live lease ${lease?.instanceId} names a release BEFORE the minimum`);
      else if (lease?.classification !== 'at-or-after') cannot(`live lease ${lease?.instanceId} classification ${JSON.stringify(lease?.classification)} is not at-or-after`);
    }
  }

  return { verdict: notDrained ? 'not-drained' : unclassified ? 'unclassified' : 'drained', findings };
}

const carriesDirective = (now) => {
  const value = String(now?.blocking_directive ?? '').trim();
  return !isNoneValue(value) && value === DRAIN_DIRECTIVE;
};

/**
 * The pure judgement. `baseNow` is the BASE tree's parsed Now block (undefined/null when it could not be
 * read); `headNow` the head tree's; `duplicateNowKeys` the keys the head Now fence repeats; `statusPatch`
 * the STATUS file's diff text (or undefined); `evidenceText` the committed record's text in the head tree
 * (or null when it has none); `evidenceChanged` whether this PR's cumulative diff adds or changes the
 * record; `headCommit` the exact head commit — `{ sha, files: [paths it changes], committedAt }` — or
 * undefined when it could not be read.
 *
 * Returns `{ applies: false, allowed: true }` when the PR does not clear the drain directive, else the
 * verdict on the evidence. Unknown provenance fails closed: when the head no longer carries the directive
 * and the base could not be read, the record is required; when the head commit could not be read, the
 * record cannot be shown fresh and is refused.
 */
export function assessDirectiveClearance({
  baseNow, headNow, duplicateNowKeys = [], statusPatch, evidenceText, evidenceChanged = false, headCommit, now = Date.now(),
} = {}) {
  if (Array.isArray(duplicateNowKeys) && duplicateNowKeys.length > 0) {
    return {
      applies: true,
      allowed: false,
      detail: `the head Now block repeats ${duplicateNowKeys.map((key) => `\`${key}\``).join(', ')}; parseStatusNow keeps the last value, so a `
        + 'repeated key encodes two states at once and is refused — one line per key',
    };
  }
  if (carriesDirective(headNow)) return { applies: false, allowed: true, detail: `the head still carries ${DRAIN_DIRECTIVE}` };

  const baseKnown = Boolean(baseNow) && typeof baseNow === 'object';
  const baseCarries = baseKnown && carriesDirective(baseNow);
  const patchRemoves = statusPatchRemovesDirective(statusPatch);
  if (baseKnown && !baseCarries && patchRemoves !== true) {
    return { applies: false, allowed: true, detail: `neither the base Now block nor this diff carries ${DRAIN_DIRECTIVE}` };
  }
  const provenance = baseCarries
    ? `the base Now block carries ${DRAIN_DIRECTIVE} and this head does not`
    : patchRemoves === true
      ? `this diff removes ${DRAIN_DIRECTIVE} from the Now block`
      : `the base STATUS could not be read and this head does not carry ${DRAIN_DIRECTIVE}, so a clearance cannot be ruled out`;

  if (evidenceText === null || evidenceText === undefined) {
    return {
      applies: true,
      allowed: false,
      detail: `${provenance}, and the tree carries no ${DRAIN_EVIDENCE_DOCUMENT}: the directive clears only on a committed `
        + `\`drained\` verdict from rollout:drain-evidence (docs/POLICY.md), never on a STATUS edit alone`,
    };
  }
  if (evidenceChanged !== true) {
    return {
      applies: true,
      allowed: false,
      detail: `${provenance}, but this PR does not add or change ${DRAIN_EVIDENCE_DOCUMENT}: the drained verdict must be `
        + 'committed in the clearance PR itself (RUNBOOK §P6T4D); a record already in the tree is a snapshot of an earlier fleet',
    };
  }
  const parsed = parseDrainEvidence(evidenceText, { now });
  if (!parsed.ok) {
    return { applies: true, allowed: false, detail: `${provenance}, but ${DRAIN_EVIDENCE_DOCUMENT} does not clear it: ${parsed.reason}` };
  }
  const freshness = evidenceFreshAtHead(parsed.evidence, headCommit);
  if (!freshness.ok) {
    return { applies: true, allowed: false, detail: `${provenance}, but ${DRAIN_EVIDENCE_DOCUMENT} ${freshness.reason}` };
  }
  return {
    applies: true,
    allowed: true,
    evidence: parsed.evidence,
    detail: `${provenance}; ${DRAIN_EVIDENCE_DOCUMENT} records a drained verdict for minimum release `
      + `${parsed.evidence.minimumRelease} at ${parsed.evidence.recordedAt}, regenerated in head ${String(headCommit.sha).slice(0, 7)}`,
  };
}

/**
 * Is the record REGENERATED ON THE CLEARING HEAD? The head commit must itself change the evidence file
 * (GitHub lists a file in a commit only when its content changed, so an unchanged re-add does not count),
 * and the record cannot be dated after the commit that carries it. A merge of the base into the branch,
 * or any later push, is a new head: the operator re-runs `rollout:drain-evidence` for it. The cumulative
 * PR diff says nothing about freshness (#686 finding 4163934196).
 */
export function evidenceFreshAtHead(evidence, headCommit) {
  if (!headCommit || typeof headCommit !== 'object' || !Array.isArray(headCommit.files)) {
    return { ok: false, reason: 'cannot be shown fresh: the head commit could not be read' };
  }
  const sha = String(headCommit.sha ?? '').slice(0, 7) || 'head';
  if (!headCommit.files.includes(DRAIN_EVIDENCE_DOCUMENT)) {
    return {
      ok: false,
      reason: `was not regenerated on the clearing head: commit ${sha} does not change it, so the record is a snapshot of an earlier `
        + 'head\'s fleet; re-run rollout:drain-evidence and commit its output in the head that clears the directive',
    };
  }
  const committedAt = Date.parse(String(headCommit.committedAt ?? ''));
  if (!Number.isFinite(committedAt)) return { ok: false, reason: `cannot be shown fresh: commit ${sha} carries no committer date` };
  const recordedAt = Date.parse(String(evidence.recordedAt));
  if (recordedAt > committedAt + RECORDED_AT_SKEW_MS) {
    return { ok: false, reason: `is dated ${evidence.recordedAt}, after the commit ${sha} that carries it (${new Date(committedAt).toISOString()})` };
  }
  return { ok: true };
}

/** A reader over the checked-out tree beside this module: text, or null when the path does not exist. */
export function fileSystemReader(readImpl = readFile) {
  return async (path) => {
    try {
      return await readImpl(new URL(`../${path}`, import.meta.url), 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  };
}

/** A reader over one exact ref through the GitHub contents API (raw media type, so STATUS's size is no
 *  limit): text, or null on 404; any other failure throws. */
export function githubContentsReader({ fetchImpl = globalThis.fetch, repository, token, ref } = {}) {
  return async (path) => {
    if (typeof fetchImpl !== 'function' || !repository || !token) throw new Error('repository, GITHUB_TOKEN and fetch are required to read the base tree');
    if (!/^[0-9a-f]{40}$/u.test(String(ref ?? ''))) throw new Error(`no exact ref to read ${path} from`);
    const response = await fetchImpl(
      `https://api.github.com/repos/${repository}/contents/${path}?ref=${ref}`,
      {
        headers: {
          accept: 'application/vnd.github.raw+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': '2022-11-28',
        },
      },
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub contents request for ${path}@${ref.slice(0, 7)} failed with HTTP ${response.status}`);
    return response.text();
  };
}

/** The shape `assessDirectiveClearance` needs from a GitHub commit object with its (paginated) `files`. */
export function headCommitFromGitHub(sha, commit) {
  if (!commit || typeof commit !== 'object') return undefined;
  return {
    sha: commit.sha ?? sha,
    files: Array.isArray(commit.files) ? commit.files.map((file) => file?.filename).filter((name) => typeof name === 'string') : undefined,
    committedAt: commit.commit?.committer?.date ?? commit.commit?.author?.date,
  };
}

/** A reader of one exact commit through the API — its changed files (all pages) and committer date. */
export function githubCommitReader({ fetchImpl = globalThis.fetch, repository, token, sha } = {}) {
  return async () => {
    if (typeof fetchImpl !== 'function' || !repository || !token) throw new Error('repository, GITHUB_TOKEN and fetch are required to read the head commit');
    if (!/^[0-9a-f]{40}$/u.test(String(sha ?? ''))) throw new Error('no exact head SHA to read');
    let commit;
    const files = [];
    for (let page = 1; ; page += 1) {
      const response = await fetchImpl(
        `https://api.github.com/repos/${repository}/commits/${sha}?per_page=100&page=${page}`,
        {
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${token}`,
            'x-github-api-version': '2022-11-28',
          },
        },
      );
      if (!response.ok) throw new Error(`GitHub commit request for ${sha.slice(0, 7)} failed with HTTP ${response.status}`);
      const batch = await response.json();
      commit ??= batch;
      const pageFiles = Array.isArray(batch?.files) ? batch.files : [];
      files.push(...pageFiles);
      if (pageFiles.length < 100) break;
    }
    return headCommitFromGitHub(sha, { ...commit, files });
  };
}

/**
 * The gate's wiring, shared by the review-scope job and the controller: null when the PR does not touch
 * STATUS. `readHead(path)` reads the head tree, `readBase(path)` the base tree; each returns text, or
 * null when the path is absent, or throws. `readHeadCommit()` returns the exact head commit's shape
 * (`headCommitFromGitHub`) or throws. The STATUS diff text comes from the PR files listing.
 */
export async function assessCommittedDirectiveClearance(pullRequest, changedFiles, { readHead, readBase, readHeadCommit } = {}) {
  if (!Array.isArray(changedFiles)) return null;
  const statusFile = changedFiles.find((file) =>
    file?.filename === STATUS_DOCUMENT || file?.previous_filename === STATUS_DOCUMENT);
  if (!statusFile) return null;
  if (typeof readHead !== 'function') throw new Error('assessCommittedDirectiveClearance needs a head reader');

  let headText;
  try {
    headText = await readHead(STATUS_DOCUMENT);
  } catch (error) {
    return {
      applies: true,
      allowed: false,
      detail: `${STATUS_DOCUMENT} is changed by this PR but could not be read (${error.message}), so whether it clears ${DRAIN_DIRECTIVE} cannot be checked`,
    };
  }
  if (headText === null || headText === undefined) {
    return {
      applies: true,
      allowed: false,
      detail: `${STATUS_DOCUMENT} is removed or renamed by this PR, so whether it clears ${DRAIN_DIRECTIVE} cannot be checked`,
    };
  }
  const headNow = parseStatusNow(headText);
  const duplicateNowKeys = nowBlockDuplicateKeys(headText);
  // The common case — the directive stands on the head — needs no base read.
  if (duplicateNowKeys.length === 0 && carriesDirective(headNow)) {
    return assessDirectiveClearance({ headNow, duplicateNowKeys });
  }

  let baseNow;
  if (typeof readBase === 'function') {
    try {
      const baseText = await readBase(STATUS_DOCUMENT);
      baseNow = typeof baseText === 'string' ? parseStatusNow(baseText) : undefined;
    } catch {
      baseNow = undefined; // unknown: fails closed below
    }
  }
  let evidenceText = null;
  try {
    evidenceText = await readHead(DRAIN_EVIDENCE_DOCUMENT);
  } catch (error) {
    return { applies: true, allowed: false, detail: `${DRAIN_EVIDENCE_DOCUMENT} could not be read (${error.message})` };
  }
  const evidenceChanged = changedFiles.some((file) => file?.filename === DRAIN_EVIDENCE_DOCUMENT && file?.status !== 'removed');
  let headCommit;
  if (evidenceText !== null && evidenceChanged && typeof readHeadCommit === 'function') {
    try {
      headCommit = await readHeadCommit();
    } catch {
      headCommit = undefined; // unknown: the record cannot be shown fresh, refused below
    }
  }
  return assessDirectiveClearance({
    baseNow,
    headNow,
    duplicateNowKeys,
    statusPatch: statusFile.patch,
    evidenceText,
    evidenceChanged,
    headCommit,
  });
}
