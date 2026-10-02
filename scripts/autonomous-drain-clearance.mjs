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
// So the review-scope gate reads it here. A PR whose diff REMOVES the drain directive from the Now
// block of docs/STATUS.md is admitted only when the PR's own tree carries the committed evidence
// record — the JSON `rollout:drain-evidence` prints — and that record is a `drained` verdict for THIS
// directive and THIS minimum release, recorded after the directive was set. Anything else (no record,
// `not-drained`, `unclassified`, another directive, another minimum, a verdict older than the directive,
// an unreadable record, an unreadable STATUS diff) refuses. The CLI itself still changes nothing: the
// operator runs it where the platform token is held and commits its stdout at the evidence path.
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

const SHA_PREFIX = /^[0-9a-f]{7,40}$/u;

/** Does this STATUS diff remove the drain directive from a yaml line? `null` when the diff carries no
 *  patch text (GitHub omits `patch` for very large diffs), which the caller treats as unknown. */
export function statusPatchRemovesDirective(patch) {
  if (typeof patch !== 'string') return null;
  return patch.split('\n').some((line) => /^-blocking_directive:[\t ]*phase-6-4d-previous-release-drained[\t ]*$/u.test(line));
}

/** Validate a committed evidence record. Returns `{ ok: true, evidence }` or `{ ok: false, reason }`. */
export function parseDrainEvidence(text, { minimumRelease = DRAIN_MINIMUM_RELEASE, setAt = DRAIN_DIRECTIVE_SET_AT } = {}) {
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
  return { ok: true, evidence };
}

/**
 * The pure judgement. `headNow` is the PR tree's parsed Now block; `statusPatch` the STATUS file's diff
 * text (or undefined); `evidenceText` the committed record's text (or null when the tree has none).
 *
 * Returns `{ applies: false, allowed: true }` when the PR does not clear the drain directive, else the
 * verdict on the evidence. Unknown provenance fails closed: when the diff text is missing and the head
 * no longer carries the directive, the record is required.
 */
export function assessDirectiveClearance({ headNow, statusPatch, evidenceText, now } = {}) {
  const headDirective = String(headNow?.blocking_directive ?? '').trim();
  const headCarries = !isNoneValue(headDirective) && headDirective === DRAIN_DIRECTIVE;
  if (headCarries) return { applies: false, allowed: true, detail: `the head still carries ${DRAIN_DIRECTIVE}` };
  const removed = statusPatchRemovesDirective(statusPatch);
  if (removed === false) return { applies: false, allowed: true, detail: `this diff does not remove ${DRAIN_DIRECTIVE}` };
  const provenance = removed === null
    ? `the STATUS diff carries no patch text, so a clearance of ${DRAIN_DIRECTIVE} cannot be ruled out`
    : `this diff removes ${DRAIN_DIRECTIVE} from the Now block`;
  if (evidenceText === null || evidenceText === undefined) {
    return {
      applies: true,
      allowed: false,
      detail: `${provenance}, and the tree carries no ${DRAIN_EVIDENCE_DOCUMENT}: the directive clears only on a committed `
        + `\`drained\` verdict from rollout:drain-evidence (docs/POLICY.md), never on a STATUS edit alone`,
    };
  }
  const parsed = parseDrainEvidence(evidenceText, now ? { setAt: DRAIN_DIRECTIVE_SET_AT } : undefined);
  if (!parsed.ok) {
    return { applies: true, allowed: false, detail: `${provenance}, but ${DRAIN_EVIDENCE_DOCUMENT} does not clear it: ${parsed.reason}` };
  }
  return {
    applies: true,
    allowed: true,
    evidence: parsed.evidence,
    detail: `${provenance}; ${DRAIN_EVIDENCE_DOCUMENT} records a drained verdict for minimum release `
      + `${parsed.evidence.minimumRelease} at ${parsed.evidence.recordedAt}`,
  };
}

/**
 * The review-scope wiring: null when the PR does not touch STATUS. Reads the head Now block and the
 * evidence record from THIS module's repository (the PR tree the job checked out), like the
 * committed-status check beside it; the STATUS diff text comes from the PR files listing.
 */
export async function assessCommittedDirectiveClearance(pullRequest, changedFiles, readImpl = readFile) {
  if (!Array.isArray(changedFiles)) return null;
  const statusFile = changedFiles.find((file) =>
    file?.filename === STATUS_DOCUMENT || file?.previous_filename === STATUS_DOCUMENT);
  if (!statusFile) return null;

  let headNow;
  try {
    headNow = parseStatusNow(await readImpl(new URL(`../${STATUS_DOCUMENT}`, import.meta.url), 'utf8'));
  } catch (error) {
    return {
      applies: true,
      allowed: false,
      detail: `${STATUS_DOCUMENT} is changed by this PR but could not be read (${error.message}), so whether it clears ${DRAIN_DIRECTIVE} cannot be checked`,
    };
  }
  let evidenceText = null;
  try {
    evidenceText = await readImpl(new URL(`../${DRAIN_EVIDENCE_DOCUMENT}`, import.meta.url), 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return { applies: true, allowed: false, detail: `${DRAIN_EVIDENCE_DOCUMENT} could not be read (${error.message})` };
    }
  }
  return assessDirectiveClearance({ headNow, statusPatch: statusFile.patch, evidenceText });
}
