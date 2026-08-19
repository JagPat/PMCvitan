// The deferral-phase check shares docs/STATUS.md's own state vocabulary rather than keeping
// a second copy of it — see phaseHasOpenWork.
import { OPEN_TASK_STATES } from './autonomous-status-state.mjs';
// Correction ownership is checked HERE, in the one assessment both the PR-side
// `review-scope` job and the trusted controller's `enforceReviewScope` call, so
// the cheap gate and the merge boundary cannot disagree about who owns a fix.
import { correctionOwnerProblem } from './correction-owner.mjs';

export const REVIEW_SCOPE_ENFORCE_AFTER_PR = 246;
export const PRE_REVIEW_ENFORCE_AFTER_PR = 345;
export const STANDARD_MAX_FILES = 20;
export const STANDARD_MAX_CHANGED_LINES = 1_500;
export const REVIEW_RESET_AFTER_FINDING_HEADS = 2;
export const REPLACEMENT_REQUIRED_LABEL = 'review-replacement-required';
/**
 * The labels the PREVIOUS rule left behind, and why each is already settled.
 *
 * Until this change the label stayed on the exhausted unit and a merged pull
 * request naming it discharged the debt. Reading a label as a live obligation
 * without migrating that state would block every `Replaces: none` unit in the
 * repository for good: a source whose replacement already merged still holds
 * its label, and that merged replacement can never run the transfer path.
 *
 *   #344 — replaced by #349, merged 2026-08-17.
 *   #357 — replaced by #358, merged 2026-08-18.
 *   #367 — replaced by #373, and #373 by #374, in turn replaced here.
 *   #373 — as above; the chain's scope ships in this change.
 *   #374 — the unit this change replaces; its scope ships here.
 *
 * An explicit list rather than a rule, because every rule that could recognise
 * these is the forgery this change exists to remove — pull request bodies and
 * merge states are both reachable by anyone who can edit a pull request, so a
 * "merged claimant settles it" clause would stay open forever. Four reviewed
 * numbers cannot grow on their own. Every entry is a label the OLD controller
 * applied — it still runs on `main` until this merges, so a unit closed under it
 * joins the list — and once this is live the obligation is handed over when a
 * claim is admitted, and nothing is added here again.
 */
export const LEGACY_SETTLED_OBLIGATIONS = new Set([344, 357, 367, 373, 374]);
// Retained for the legacy convergence-evidence parser below. The trusted
// controller now applies REVIEW_RESET_AFTER_FINDING_HEADS before that older
// evidence shape can authorize another correction head.
export const CONVERGENCE_AFTER_FINDING_HEADS = REVIEW_RESET_AFTER_FINDING_HEADS;

export const REQUIRED_PRE_REVIEW_CHECKS = [
  'concurrency-serialization',
  'old-release-migration-compatibility',
  'trigger-alternate-writers',
  'authorization-tenancy',
  'ci-reproduce-first',
];

// How many finding-bearing heads a DOCS-ONLY review may take before the still-open
// questions must be handed to probes.
//
// The convergence protocol was written for code. On code it terminates, because every
// finding is answered by a RED→GREEN probe and a fix that either works or does not. A
// PLAN has no executable surface: a finding on it can only be answered with more prose,
// and a plan can always be specified further, so the protocol demands a batched audit
// after two heads and then never says when the review is done.
//
// PR #252 is the measurement. Four finding-bearing heads — 8, 8, 7, 7 — every finding
// correct, none contradicted by a later round, and no declining rate. Every finding in
// rounds 2-4 was of the form "the plan does not yet say how X is handled", which is
// always true of a plan at some depth.
//
// THIS IS NOT A DISMISSAL MECHANISM. A finding-dismissal engine was built for this
// repository in PR #250 and withdrawn, because on the first real case it would have
// suppressed a CORRECT finding. Nothing here discounts, filters, or downgrades a finding,
// and the `codex-current-head` status still fails closed on every current-head finding.
// What this bounds is only WHERE the remaining questions get verified: past the cap the
// author must convert each one into a named probe in the plan and name the task whose
// review stop will settle it. The finding is kept and its verification is moved to the
// one place a verification can exist.
export const PLAN_REVIEW_ROUND_CAP = 3;

export const REQUIRED_INVARIANTS = [
  'authorization-tenancy',
  'civil-time-lifecycle',
  'concurrency-idempotency',
  'data-integrity-conservation',
  'offline-reconciliation',
  'ui-server-parity',
];

const CODEX_LOGIN = 'chatgpt-codex-connector[bot]';
const LARGE_MARKER = '<!-- review-size: justified-large -->';
const INSEPARABLE_MIGRATION_MARKER = '<!-- migration-scope: inseparable -->';
const CONVERGENCE_PACKET = /^docs\/reviews\/[^/]*convergence[^/]*\.md$/iu;
const MIGRATION_FILE = /^apps\/api\/prisma\/migrations\/[^/]+\/migration\.sql$/u;
const SERVICE_OR_UI_FILE = /^(?:apps\/api\/src|apps\/web\/src|packages\/shared\/src)\//u;
const REPLACES_DECLARATION = /^[\t ]*replaces:[\t ]*(none|#\d+)[\t ]*$/gimu;
// The state file `deferralPhases` reads. Named here because the gate must also notice when a
// PR CHANGES it — see the phase check in assessConvergence.
export const STATUS_DOCUMENT = 'docs/STATUS.md';

function finiteCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : 0;
}

export function replacementDeclaration(body) {
  const source = typeof body === 'string' ? body : '';
  const matches = [...source.matchAll(REPLACES_DECLARATION)];
  if (matches.length !== 1) return { kind: 'invalid', source: null };
  if (matches[0][1].toLowerCase() === 'none') {
    return { kind: 'none', source: null };
  }
  const number = Number(matches[0][1].slice(1));
  return Number.isInteger(number) && number > 0
    ? { kind: 'source', source: number }
    : { kind: 'invalid', source: null };
}

export function replacementSource(body) {
  const declaration = replacementDeclaration(body);
  return declaration.kind === 'source' ? declaration.source : null;
}

/**
 * Who owes the unresolved scope of an exhausted review unit.
 *
 * The obligation MOVES. When the trusted controller admits a `Replaces: #N`
 * declaration it hands the label to the claiming unit and takes it off #N, and
 * the label is then the record of who owes the work. That transfer is written
 * by the controller at the moment it admits the claim; it is a timeline event,
 * not a line of prose, so nothing that happens to a pull request BODY
 * afterwards can move it.
 *
 * The alternative — leaving the label on the original and re-deriving lineage
 * later from the bodies of closed pull requests — cannot be made sound. Matching
 * only a merge that names the original strands the debt the moment a
 * replacement dies unmerged: #354 exhausted, #360 replaced it and exhausted too,
 * #361 replaced #360, and nothing would ever name #354 again, so every
 * `Replaces: none` unit in the repository was refused until the label was
 * cleared by hand, three times in one night. Following the chain instead trusts
 * the bodies, and bodies are editable by anyone who can edit a pull request: an
 * unrelated unit that exhausted its own rounds can have `Replaces: #354` written
 * into it afterwards, and a merged replacement of THAT unit discharges scope it
 * never carried. Ordering by number or by closing time narrows the window but
 * proves nothing about when the declaration was written.
 *
 * Transferring at admission removes the question. There is no chain to walk: at
 * every moment exactly one live unit holds each obligation, and it holds it
 * because the controller put it there.
 *
 * A MERGED unit owes nothing — the work landed — so its label is history rather
 * than a live debt. Everything else that holds one blocks fresh work, including
 * a replacement still open: work in flight is not work merged.
 */
export function assessReplacementLineage({
  pullRequest,
  requiredReplacements,
  replacementPullRequests,
  // Did THIS unit reach the review-round limit on its own heads? It separates
  // the only two states the label cannot tell apart — see the claim branch
  // below. Defaults to the refusing answer, because a caller that does not know
  // must not be able to complete a transfer that may never have started.
  claimantExhausted = true,
}) {
  const declaration = replacementDeclaration(pullRequest?.body);
  if (!Array.isArray(requiredReplacements) || !Array.isArray(replacementPullRequests)) {
    return {
      allowed: false,
      detail: 'required replacement lineage could not be read from GitHub',
    };
  }

  const owed = ({ pullRequest: source }) => Number.isInteger(source?.number)
    && !source.merged_at
    && !LEGACY_SETTLED_OBLIGATIONS.has(source.number);
  const pending = requiredReplacements.filter((requirement) =>
    requirement?.pullRequest?.number !== pullRequest?.number && owed(requirement));
  // This unit already holds an obligation: either it was handed one when its
  // claim was admitted, or it exhausted its own review rounds. Both mean the
  // same thing — the unresolved scope is its debt until it merges.
  const holdsObligation = requiredReplacements.some((requirement) =>
    requirement?.pullRequest?.number === pullRequest?.number && owed(requirement));

  if (declaration.kind === 'source') {
    const requirement = pending.find(
      ({ pullRequest: source }) => source?.number === declaration.source,
    );
    if (!requirement) {
      // The obligation this declaration claims has already been handed over, and
      // this unit is holding it. Refusing here would strand the unit that the
      // controller itself admitted.
      if (holdsObligation) return { allowed: true, detail: null, transferFrom: null };
      return {
        allowed: false,
        detail: `Replaces: #${declaration.source} does not name a review unit awaiting replacement`,
      };
    }
    if (holdsObligation) {
      // Both this unit and the source it names hold the label, and the label is
      // a boolean: two different histories arrive here identically.
      //
      // Either the transfer was interrupted — the label reached this unit and
      // the removal from the source did not, because a label write is two calls
      // and the second can fail — or this unit owes its OWN scope and its body
      // was edited to claim a second obligation, which would collapse both into
      // one boolean and let a single merge discharge scope it never carried.
      //
      // What separates them is durable and already recorded: a unit that owes
      // its own scope reached the review-round limit on its own heads, and a
      // claimant midway through a transfer has not.
      if (claimantExhausted) {
        return {
          allowed: false,
          detail: `PR #${pullRequest?.number} already carries a replacement obligation; `
            + `one unit cannot also take on #${declaration.source}`,
        };
      }
      // An interrupted transfer. Naming the source again lets the caller finish
      // the removal, so the state converges to one holder instead of blocking
      // the loop until someone repairs the labels by hand.
      return { allowed: true, detail: null, transferFrom: declaration.source };
    }
    if (requirement.pullRequest.state !== 'closed') {
      return {
        allowed: false,
        detail: `Replaces: #${declaration.source} is not closed; close the exhausted unit before reviewing its replacement`,
      };
    }
    const competing = replacementPullRequests.find((candidate) =>
      candidate?.number !== pullRequest?.number
      && candidate?.state === 'open'
      && replacementSource(candidate.body) === declaration.source);
    if (competing) {
      return {
        allowed: false,
        detail: `Replaces: #${declaration.source} is already claimed by open PR #${competing.number}`,
      };
    }
    // Admitted. The caller with write access hands the obligation over; every
    // later evaluation of this unit takes the `holdsObligation` path above.
    return { allowed: true, detail: null, transferFrom: declaration.source };
  }

  if (pending.length > 0) {
    const source = pending[0].pullRequest;
    return {
      allowed: false,
      detail: `exhausted PR #${source.number} still requires a replacement; declare Replaces: #${source.number} before starting fresh work`,
    };
  }
  return { allowed: true, detail: null, transferFrom: null };
}

export function assessReviewScope(
  pullRequest,
  {
    enforceAfterPr = REVIEW_SCOPE_ENFORCE_AFTER_PR,
    preReviewEnforceAfterPr = PRE_REVIEW_ENFORCE_AFTER_PR,
    maxFiles = STANDARD_MAX_FILES,
    maxChangedLines = STANDARD_MAX_CHANGED_LINES,
    changedFiles,
    requireChangedFiles = false,
    requireReplacementLineage = false,
    requiredReplacements,
    replacementPullRequests,
    claimantExhausted = true,
  } = {},
) {
  const additions = finiteCount(pullRequest?.additions);
  const deletions = finiteCount(pullRequest?.deletions);
  const changedFileCount = finiteCount(pullRequest?.changed_files);
  const changedLines = additions + deletions;
  const large = changedFileCount > maxFiles || changedLines > maxChangedLines;
  const number = finiteCount(pullRequest?.number);
  const body = String(pullRequest?.body ?? '');
  const preReviewRequired = number > preReviewEnforceAfterPr;
  const replaces = replacementDeclaration(body);
  const missingChecklist = preReviewRequired
    ? REQUIRED_PRE_REVIEW_CHECKS.filter((key) => {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      return !new RegExp(
        '^[\\t ]*- \\[x\\] `' + escaped + '`(?:[\\t ]|$)',
        'imu',
      ).test(body);
    })
    : [];
  const fileListUnreadable = preReviewRequired
    && requireChangedFiles
    && !Array.isArray(changedFiles);
  const paths = Array.isArray(changedFiles)
    ? changedFiles.flatMap((file) => changedPaths(file))
    : [];
  const migrationServiceMix = paths.some((path) => MIGRATION_FILE.test(path))
    && paths.some((path) => SERVICE_OR_UI_FILE.test(path));
  const migrationScope = /<!--\s*migration-scope:\s*(separated|inseparable)\s*-->/iu
    .exec(body)?.[1]?.toLowerCase();
  const seam = /^[\t ]*- Migration\/service seam:[\t ]*(.+?)[\t ]*$/imu.exec(body)?.[1]?.trim();
  const meaningfulSeam = typeof seam === 'string'
    && seam.length > 0
    && !/^(?:n\/?a|none|not applicable|separated|tbd|todo|to do|pending|unknown|fixme)(?:\b.*)?$/iu
      .test(seam)
    && !/^[-?.]+$/u.test(seam)
    && !/^<[^>]+>$/u.test(seam);
  const lineage = preReviewRequired && requireReplacementLineage
    ? assessReplacementLineage({
      pullRequest,
      requiredReplacements,
      replacementPullRequests,
      claimantExhausted,
    })
    : { allowed: true, detail: null };
  const preReviewProblems = [
    ...(missingChecklist.length > 0
      ? [`pre-review checklist items: ${missingChecklist.join(', ')}`]
      : []),
    ...(fileListUnreadable
      ? ["the PR's cumulative file list could not be read"]
      : []),
    ...(preReviewRequired && replaces.kind === 'invalid'
      ? ['the PR body needs exactly one `Replaces: none` or `Replaces: #<closed-pr>` declaration']
      : []),
    ...(!lineage.allowed ? [lineage.detail] : []),
    ...(migrationServiceMix && migrationScope !== 'inseparable'
      ? [`migration and service/UI changes must use separate review units when a viable seam exists; `
        + `use ${INSEPARABLE_MIGRATION_MARKER} only when they cannot be reviewed safely apart`]
      : []),
    ...(migrationServiceMix && migrationScope === 'inseparable' && !meaningfulSeam
      ? ['an inseparable migration/service unit needs a concrete "Migration/service seam" explanation']
      : []),
  ];
  const common = {
    changedFiles: changedFileCount,
    changedLines,
    large,
    limits: { maxFiles, maxChangedLines },
    missingChecklist,
    migrationServiceMix,
    // The unit this PR's declaration claims, for a caller with write access to
    // hand the obligation over. Only meaningful once the whole assessment is
    // allowed: a claim admitted alongside some other scope refusal has not been
    // admitted at all, and the debt must not move until it has.
    replacementTransferFrom: lineage.transferFrom ?? null,
  };
  let state = 'standard';
  let missingInvariants = [];
  let sizeProblem = null;

  if (large && number <= enforceAfterPr) {
    state = 'grandfathered';
  } else if (large) {
    const sizeDeclaration = /^<!--\s*review-size:\s*(standard|justified-large)\s*-->/iu
      .exec(body.trimStart());
    const justified = sizeDeclaration?.[1]?.toLowerCase() === 'justified-large';
    const tableRows = body
      .split(/\r?\n/u)
      .filter((line) => line.trimStart().startsWith('|'))
      .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
    missingInvariants = REQUIRED_INVARIANTS.filter(
      (invariant) => !tableRows.some(
        (cells) => cells[0]?.toLowerCase() === invariant
          && Boolean(cells[1])
          && Boolean(cells[2]),
      ),
    );
    if (!justified || missingInvariants.length > 0) {
      const missing = [
        ...(!justified ? [`the ${LARGE_MARKER} marker`] : []),
        ...(missingInvariants.length > 0
          ? [`invariant matrix rows: ${missingInvariants.join(', ')}`]
          : []),
      ];
      sizeProblem = `Large review unit requires a justified-large marker and complete invariant matrix; missing ${missing.join('; ')}`;
    } else {
      state = 'justified_large';
    }
  }

  // Deliberately outside the pre-review block, which is gated on
  // `preReviewEnforceAfterPr`: ownership is required at EVERY pull request
  // number, with no exemption. An earlier draft carried its own threshold; the
  // carve-out let a PR inside it pass this gate with no owner and then route to
  // nobody on its first finding, so it was deleted rather than raised.
  const ownerProblem = correctionOwnerProblem(pullRequest);
  const problems = [
    ...(sizeProblem ? [sizeProblem] : []),
    ...(ownerProblem ? [ownerProblem] : []),
    ...preReviewProblems,
  ];
  if (problems.length > 0) {
    return {
      ...common,
      state: 'blocked',
      allowed: false,
      missingInvariants,
      detail: problems.join('; '),
    };
  }

  return { ...common, state, allowed: true, missingInvariants };
}

// Which finding heads carry a CRITICAL finding.
//
// Codex tags every finding with a severity badge. Matching the BADGE markup is
// structural; matching a bare "P1" would fire on any prose that mentions it,
// including a comment explaining the rule itself.
const BADGE = /!\[P(\d) Badge\]|badge\/P(\d)-/gu;

// Severity per finding head, as one of:
//   'very-critical' — a P0 finding
//   'critical'      — a P1 finding
//   'minor'         — findings present, all badged, none P0/P1
//   'unknown'       — a finding whose severity could not be read
//
// 'unknown' is a first-class outcome, not a synonym for 'minor'. The obvious
// shape — "critical means some head shows a P1" — silently reclassifies an
// unparseable head as harmless, so a badge format change would turn a safety
// signal permissive exactly when it had lost the ability to see.
export function findingHeadSeverity(comments, reviews = []) {
  // Per head: the lowest severity seen, AND whether any finding on it was
  // unreadable. Tracking only "was a badge seen anywhere" let one badged comment
  // vouch for an unbadged sibling on the same head — the head came back minor
  // while carrying a finding of unknown severity. Any unreadable finding taints
  // its whole head.
  const worst = new Map(); // head -> { lowest: number|null, unreadable: boolean }

  const note = (head, body, { container = false } = {}) => {
    if (typeof head !== 'string' || head.length === 0) return;
    const entry = worst.get(head) ?? { lowest: null, unreadable: false };
    const text = String(body ?? '');
    let lowest = null;
    for (const match of text.matchAll(BADGE)) {
      const level = Number(match[1] ?? match[2]);
      if (Number.isFinite(level)) lowest = lowest === null ? level : Math.min(lowest, level);
    }
    if (lowest !== null) {
      entry.lowest = entry.lowest === null ? lowest : Math.min(entry.lowest, lowest);
    } else if (!container) {
      // A Codex REVIEW is posted as a container — "here are some automated review
      // suggestions" — with the findings themselves as inline review comments, so
      // its body never carries a badge. Counting that as an unreadable finding
      // would taint every reviewed head as unknown.
      entry.unreadable = true;
    }
    worst.set(head, entry);
  };

  for (const comment of comments ?? []) {
    if (comment?.user?.login !== CODEX_LOGIN) continue;
    note(comment.original_commit_id ?? comment.commit_id, comment.body);
  }
  for (const review of reviews ?? []) {
    if (review?.user?.login !== CODEX_LOGIN) continue;
    note(review.commit_id, review.body, { container: true });
  }

  const severity = new Map();
  for (const [head, entry] of worst) {
    // UNREADABLE outranks a readable P1. Ordering the P1 check first classified a
    // head carrying both a P1 and an unbadged finding as merely `critical`, which
    // understates it. P0 stays first only for accurate reporting.
    if (entry.lowest === 0) severity.set(head, 'very-critical');
    else if (entry.unreadable || entry.lowest === null) severity.set(head, 'unknown');
    else if (entry.lowest === 1) severity.set(head, 'critical');
    else severity.set(head, 'minor');
  }
  return severity;
}

// The review gate's own retryable terminal failures, by the description it
// publishes. ONE definition, because two consumers read it: the gate decides
// whether to re-dispatch, and the correction watchdog decides whether anyone
// owes a correction at all. An earlier draft recognised only the timeout, so the
// other three drew an actionable "push a new head" for a failure a new head
// cannot fix — it would invalidate the exact head the gate is trying to recover.
// The review gate's own retryable terminal failures, by the description it
// publishes. ONE definition, because two consumers read it: the gate decides
// whether to re-dispatch, and the correction watchdog decides whether anyone
// owes a correction at all — for these, nobody does, so it opens no lease.
const RETRYABLE_REVIEW_FAILURES = [
  'Codex review timed out',
  'Codex evidence changed during final verification',
  'review: Required CI changed during current-head Codex review',
  'review: bootstrap exact-head review requested',
];

export function isRetryableReviewFailureDescription(description) {
  const text = String(description ?? '');
  return RETRYABLE_REVIEW_FAILURES.some((marker) => text.includes(marker));
}

export function codexFindingHeads(comments, reviews = []) {
  const heads = new Set();
  for (const comment of comments ?? []) {
    if (comment?.user?.login !== CODEX_LOGIN) continue;
    const head = comment.original_commit_id ?? comment.commit_id;
    if (typeof head === 'string' && head.length > 0) heads.add(head);
  }
  for (const review of reviews ?? []) {
    if (review?.user?.login !== CODEX_LOGIN) continue;
    const head = review.commit_id;
    if (typeof head === 'string' && head.length > 0) heads.add(head);
  }
  return [...heads];
}

function changedFilename(file) {
  return typeof file === 'string' ? file : file?.filename;
}

// Documentation, for the purpose of "can a finding on this be proven?". Anything that
// runs — a script, a schema, a migration, a test, a workflow, application source — makes
// the diff provable and puts it back under the ordinary code protocol.
//
// A directory name cannot decide that. `docs/probes/x.test.mjs`, `docs/schema.prisma` and
// `docs/ci/deploy.yml` run exactly as they would anywhere else, and a rule that admitted
// everything under `docs/` would hand the deferral escape to a diff whose findings are
// perfectly provable. So a file is documentation only when BOTH its extension and its
// location say so.
//
// The extension test is an ALLOWLIST, deliberately. A blocklist of runnable extensions
// has to anticipate every one that exists and silently admits the ones it missed; an
// allowlist treats an unrecognised extension as code, which is the direction that fails
// closed. An empty diff is not a plan review either; it is a broken read, and it also
// fails toward the strict path.
const DOCS_EXTENSION = /\.(?:md|mdx|txt|rst|svg|png|jpe?g|gif|webp|pdf)$/iu;
const DOCS_LOCATION = /^(?:docs\/.+|\.github\/.+|[^/]+)$/u;

function isDocumentation(name) {
  return DOCS_EXTENSION.test(name) && DOCS_LOCATION.test(name);
}

// Every path a diff entry TOUCHES. A rename touches two: GitHub reports it as
// `status: 'renamed'` with `filename` set to the new path and `previous_filename` to the
// old one, so reading only `filename` let `scripts/old-gate.mjs` → `docs/old-gate.md`
// present as pure documentation while runnable code was removed. A rename is a removal
// plus an addition, and both sides have to be classified.
function changedPaths(file) {
  if (typeof file === 'string') return [file];
  return [file?.filename, file?.previous_filename]
    .filter((name) => typeof name === 'string' && name.length > 0);
}

export function isDocsOnlyDiff(changedFiles) {
  // Every entry, INCLUDING removals and renames. Deleting `scripts/old-gate.mjs` — or
  // moving it out from under that name — changes what runs just as surely as editing it,
  // so such a diff is provable and is not a plan review. (The convergence-PACKET check
  // below keeps its own `removed` filter and reads only `filename`: there the question is
  // whether the head ADDS the audit at that path, which the surviving name answers.)
  const names = (changedFiles ?? []).flatMap((file) => changedPaths(file));
  return names.length > 0 && names.every((name) => isDocumentation(name));
}

// The deferral names the TASK that will settle the deferred findings, so the handoff is
// schedulable rather than an assertion that the review is over. A bare marker ("yes",
// "complete", "done") schedules nothing and is refused.
const DEFERRAL_TRAILER = 'review-deferred-to-probes';
// The trailer names THE TASK whose review stop settles the deferred questions, so the value
// must be a task reference. This was a BLOCKLIST of bare words, which is the exact mistake
// this PR's own round-2 remedy argued against for file extensions: a blocklist has to
// anticipate every placeholder that exists and silently admits the ones it missed, so
// `Review-Deferred-To-Probes: later` was accepted as a scheduled handoff. An ALLOWLIST treats
// an unrecognised value as no task at all — the direction that fails closed. The two shapes
// are this repository's own task vocabulary, the same strings `docs/STATUS.md` uses for
// `next_task`/`work_item`.
//
// The SPLIT UNIT suffixes are part of that vocabulary and were missing, which made the comment
// above false rather than merely incomplete: `docs/STATUS.md` has named lettered units since Task
// 5A (`5A`/`5B`/`5C`, then `6A`/`6B`), so `phase-5-task-6b` was already rejected before any
// finer-grained id existed — a deferral trailer naming the unit actually under review could never
// parse. The roman suffix admits the second level the 6B split introduced (`6b-i`, `6b-ii`).
//
// THIRD LEVEL, and the same lesson a third time. The 7B-ii split coined `7B-ii-a`/`7B-ii-b` —
// both now merged and independently cleared — so a lettered unit below a roman one is not a
// hypothetical shape, it is the vocabulary `docs/STATUS.md` has been writing since PR #299.
// `phase-5-task-7b-ii-b` sat in STATUS as `work_item` and never parsed; the mismatch stayed
// LATENT only because that entry coincided with `task_state: in_progress`, which makes
// `phaseHasOpenWork` supply the phase from `phase:` and the unparseable id irrelevant.
//
// It stops being latent in the BETWEEN-WORK shape (`task_state: merged`, `work_item: none`),
// where `next_task` is the ONLY source of an eligible phase: an unparseable id there collapses
// `deferralPhases` to `[]`, which the contract below reads as "no phase has an open review stop"
// — so a correctly-formed deferral naming a REAL upcoming stop is refused, and a scheduled
// review stop fails closed. The vocabulary is extended rather than the STATUS id blunted,
// because naming the parent split when the next unit is `7b-iii-a` would trade a parse error
// for a wrong answer.
const TASK_REFERENCE = /^phase-(?<phase>\d+)-(?:task-\d+[a-z]?(?:-[iv]+)?(?:-[a-z])?|planning)$/iu;

// A shape-valid value can still name a review stop that does not exist:
// `phase-999-task-999` parses and schedules nothing. The PHASE is checkable against
// `docs/STATUS.md`, which is a machine-readable state file with an existing parser — so this is
// a structured-field read, not the prose parsing withdrawn below. Acceptable phases are the
// CURRENT one and the one `next_task` names: a deferral belongs to the phase under review, and
// pointing at a later phase is a scope change disguised as a deferral, not a handoff.
//
// The task INDEX inside a valid phase is NOT checked. It lives in the plan's markdown task
// table, and reading that is the prose parsing this PR withdrew. AGENTS.md asks the reviewer to
// flag a deferral naming a task the plan does not define.
// A phase is eligible only while it can still SETTLE something. The current phase qualifies
// only when it has open work: with `task_state: merged` and no `work_item` — the between-work
// shape STATUS uses — every phase-4 review stop is already closed, so `phase-4-task-99` names a
// stop that cannot adjudicate anything. `next_task`'s phase is always eligible, because that is
// the phase whose stops are about to exist.
const NO_WORK_ITEM = new Set(['', 'none', 'null', '-']);
// The states STATUS uses for a task that is DONE. Recognized, so a named work_item against
// one still counts; distinct from a state this repository has no vocabulary for at all.
const TERMINAL_TASK_STATES = new Set(['merged', 'complete', 'completed', 'cleared']);

function phaseHasOpenWork(now) {
  const state = String(now?.task_state ?? '').trim().toLowerCase();
  const item = String(now?.work_item ?? '').trim().toLowerCase();
  // An ALLOWLIST, sharing docs/STATUS.md's own vocabulary. A blocklist of closed words
  // treats every state it has not heard of as open — `task_state: somewhere-new`, or an
  // absent field — and authorizes a deferral on evidence STATUS never gave. Round 6 of
  // this PR replaced exactly such a blocklist (BARE_DEFERRAL) with the TASK_REFERENCE
  // allowlist for the same reason; this is that lesson at a second site.
  if (OPEN_TASK_STATES.has(state)) return true;
  // A recognized terminal state can still carry a named work item — a follow-up recorded
  // against a merged task. Anything UNRECOGNIZED is unverified, not open.
  if (!TERMINAL_TASK_STATES.has(state)) return false;
  return !NO_WORK_ITEM.has(item);
}

// undefined means "STATUS told us nothing" — no constraint. An empty ARRAY is a different
// answer: STATUS was readable and no phase has an open review stop, so there is nothing a
// deferral could hand work to. Collapsing the two would make an unreadable STATUS refuse every
// deferral, or a closed phase authorize any of them.
export function deferralPhases(now) {
  const current = Number.parseInt(String(now?.phase ?? '').trim(), 10);
  const next = TASK_REFERENCE.exec(String(now?.next_task ?? '').trim());
  if (!Number.isInteger(current) && !next) return undefined;
  const phases = new Set();
  if (Number.isInteger(current) && phaseHasOpenWork(now)) phases.add(current);
  if (next) phases.add(Number.parseInt(next.groups.phase, 10));
  return [...phases];
}

function messageTrailers(message) {
  const blocks = String(message ?? '').trimEnd().split(/\n[\t ]*\n/u);
  if (blocks.length < 2) return [];
  const trailers = [];
  for (const line of blocks.at(-1).split('\n')) {
    if (/^[\t ]+\S/u.test(line)) {
      if (trailers.length === 0) return [];
      trailers.at(-1)[1] += ` ${line.trim()}`;
      continue;
    }
    const trailer = /^([A-Za-z0-9][A-Za-z0-9-]*):[\t ]*(.+)$/u.exec(line);
    if (!trailer) return [];
    trailers.push([trailer[1].toLowerCase(), trailer[2].trim()]);
  }
  return trailers;
}

export function deferredToProbes(message) {
  for (const [key, value] of messageTrailers(message)) {
    if (key !== DEFERRAL_TRAILER) continue;
    const target = value.trim();
    if (!TASK_REFERENCE.test(target)) return null;
    return target;
  }
  return undefined;
}

// The deferral LEDGER is deliberately NOT gate-verified. Read this before adding it back.
//
// Four rounds of this PR tried to verify it mechanically — a keyword, then a row shape, then a
// header exclusion, then a complete artifact definition with a plan cross-reference. Each was
// defeated by a new input, and the round that defeated the "complete" definition settled the
// question rather than adding a fifth clause:
//
//   - a ledger is a mapping from QUESTIONS to probes, and the definition specified only the
//     probe side, so `- probe 5w` under the heading passed with no question anywhere;
//   - `planDefinesProbe` could not tell a probe declaration from an ordinary numbered list
//     item, so `probe 5` matched the plan line `5. **Task 5 — frontend surfaces**`.
//
// Neither is answerable without reading for MEANING. Is this row a question? Is that numbered
// line a probe or a task heading? Those are judgements, which puts them on the reviewer's side
// of the line this repository already draws — the PR #250 line, where a mechanism that scored
// substance was withdrawn because on its first real case it would have suppressed a correct
// finding. The line was right; I had drawn it in the wrong place and defended it for four
// rounds.
//
// And the check was guarding a door that opens onto a wall. `guardAgainstCurrentHeadFinding`
// runs AFTER convergence and fails closed on every current-head finding, so a deferral buys an
// author NOTHING that a clean review would not already give them. There is no incentive to
// forge a ledger, and no outcome a forged one changes.
//
// So what remains is the one thing that is mechanically decidable without interpretation: the
// trailer must name a TASK (see TASK_REFERENCE). The ledger itself is an author obligation
// stated in AGENTS.md and judged by the reviewer, which is where a question about whether
// enough thinking happened belongs.

// The separator is ':' with OPTIONAL whitespace after it — `git interpret-trailers --parse`
// normalizes `Key:value` to `Key: value`, so a head spelled without the space carries a VALID
// trailer. Requiring the space made the gate report a present trailer as missing. All three
// parsers in this file had the same too-strict separator; all three are fixed together.
const CONVERGENCE_MARKER = /^[\t ]*review-convergence:[\t ]*complete[\t ]*$/imu;

function hasConvergenceTrailer(message) {
  const blocks = String(message ?? '').trimEnd().split(/\n[\t ]*\n/u);
  if (blocks.length < 2) return false;
  const lines = blocks.at(-1).split('\n');
  const trailers = [];
  for (const line of lines) {
    if (/^[\t ]+\S/u.test(line)) {
      if (trailers.length === 0) return false;
      trailers.at(-1)[1] += ` ${line.trim()}`;
      continue;
    }
    const trailer = /^([A-Za-z0-9][A-Za-z0-9-]*):[\t ]*(.+)$/u.exec(line);
    if (!trailer) return false;
    trailers.push([trailer[1].toLowerCase(), trailer[2].trim().toLowerCase()]);
  }
  return trailers.some(
    ([key, value]) => key === 'review-convergence' && value === 'complete',
  );
}

// Git reads trailers from the LAST paragraph only, and only when every line in
// it is a `Key: value` trailer. So the marker can be present and still not be a
// trailer — a blank line above it demotes it to body text, and a prose line
// anywhere in that final block invalidates the whole block. Both are ordinary
// authoring mistakes, and "missing trailer" alone reads as "you forgot it" when
// the line is right there. Naming the real cause turns a wasted round into a
// one-line fix. The hint states the rule rather than guessing which of the two
// it is, so it is never wrong about the cause.
export function convergenceTrailerHint(message) {
  if (hasConvergenceTrailer(message)) return null;
  return CONVERGENCE_MARKER.test(String(message ?? ''))
    ? 'trailer (the line is present but git does not parse it as a trailer: it '
      + 'must be in the final block of the message, and every line in that '
      + 'block must be a "Key: value" trailer)'
    : 'trailer';
}

export function assessConvergence({
  comments,
  reviews,
  headMessage,
  changedFiles,
  pullRequestFiles,
  activePhases,
}) {
  const findingHeads = codexFindingHeads(comments, reviews);
  const findingHeadCount = findingHeads.length;
  if (findingHeadCount < CONVERGENCE_AFTER_FINDING_HEADS) {
    return {
      required: false,
      allowed: true,
      findingHeadCount,
      findingHeads,
      missing: [],
    };
  }

  const hasTrailer = hasConvergenceTrailer(headMessage);
  const hasPacket = (changedFiles ?? [])
    .some((file) => {
      const filename = changedFilename(file);
      return file?.status !== 'removed'
        && typeof filename === 'string'
        && CONVERGENCE_PACKET.test(filename);
    });
  // Past the cap, a docs-only review also owes the probe deferral: each still-open
  // question named, with the probe and the task that will settle it. See
  // PLAN_REVIEW_ROUND_CAP — this adds an obligation, it never removes one.
  //
  // Judged on the PR's CUMULATIVE diff, not on `changedFiles` (this head's commit). A
  // code PR's convergence head is very often the packet alone, and reading that one
  // commit would classify the whole review as a plan review and block it pending a
  // deferral trailer that means nothing for it. `changedFiles` keeps its own meaning
  // above — whether THIS head carries the audit — which is a per-head question.
  //
  // An UNREADABLE cumulative diff is not evidence either way, and it must not silently pick a
  // path. Resolving it toward "code" drops the deferral obligation on a docs-only PR; resolving
  // it toward "docs" demands a meaningless trailer from a code PR. So past the cap it BLOCKS
  // with its own reason and the gate re-runs on the next event — the same self-healing shape the
  // packet read used. Below the cap it is irrelevant, because no deferral is owed.
  const cumulativeUnreadable = !Array.isArray(pullRequestFiles)
    && findingHeadCount >= PLAN_REVIEW_ROUND_CAP;
  const deferralRequired = Array.isArray(pullRequestFiles)
    && isDocsOnlyDiff(pullRequestFiles)
    && findingHeadCount >= PLAN_REVIEW_ROUND_CAP;
  const deferral = deferralRequired ? deferredToProbes(headMessage) : undefined;

  const missing = [
    ...(!hasTrailer ? [convergenceTrailerHint(headMessage)] : []),
    ...(!hasPacket ? ['packet'] : []),
    ...(cumulativeUnreadable
      ? ["the PR's cumulative diff could not be read, so whether this review is docs-only — and "
        + 'therefore whether it owes a probe deferral — is unverified. This is not evidence '
        + 'either way; re-run once the file list is readable']
      : []),
    ...(deferralRequired && deferral === undefined
      ? [`a "Review-Deferred-To-Probes: <task>" trailer — after ${PLAN_REVIEW_ROUND_CAP} `
        + 'finding-bearing heads a docs-only review must hand its remaining open '
        + 'questions to named probes instead of answering them with more prose']
      : []),
    ...(deferralRequired && deferral === null
      ? ['the Review-Deferred-To-Probes value must name the TASK that will settle the '
        + 'deferred findings, in this repository\'s own task vocabulary '
        + '("phase-<n>-task-<m>" or "phase-<n>-planning"); a bare marker or a word like '
        + '"later" schedules nothing']
      : []),
    // A shape-valid task needs a PROVABLE phase, and "unprovable" is not "proven". Round 9
    // made an unreadable cumulative diff block rather than pick a path, then left the phase
    // check resolving an unreadable STATUS toward "no constraint" — the same defect, two
    // fields apart, in one commit. Both now fail closed. This never touches a head that
    // claims no deferral.
    ...(deferralRequired && typeof deferral === 'string' && !Array.isArray(activePhases)
      ? [`"${deferral}" names a task, but docs/STATUS.md could not be read, so whether that `
        + 'phase still has a review stop ahead of it is unverified. An unprovable phase is not '
        + 'a proven one; re-run once STATUS parses']
      : []),
    // And the phase set must be ABOUT this PR. The gate runs from the trusted default branch,
    // so it reads main's STATUS — which is not this PR's phase truth when the PR itself edits
    // STATUS. A head that closes phase 5 while deferring into phase-5-task-1 would otherwise
    // pass on the pre-merge state. Reading the head's STATUS would fix it too, and would mean
    // fetching PR-authored content into a write-capable workflow — the boundary this loop does
    // not cross, and the content read round 7 withdrew. The FILE LIST is metadata the gate
    // already has, and it is sufficient: if STATUS is in the diff, the phase is unverifiable.
    ...(deferralRequired && typeof deferral === 'string' && Array.isArray(activePhases)
      && (pullRequestFiles ?? []).some(
        // BOTH paths, via the same helper the docs-only classifier uses. A rename AWAY from
        // docs/STATUS.md carries the new path in `filename` and the old one in
        // `previous_filename`, so reading `filename` alone misses a PR that moved the phase
        // truth out from under the gate. Round 2 of this PR established the two-path rule
        // and built changedPaths for it; this new check simply has to USE it.
        (file) => changedPaths(file).includes(STATUS_DOCUMENT),
      )
      ? ['this PR changes docs/STATUS.md, so the default-branch copy the gate reads is not this '
        + "PR's own phase truth and cannot verify the deferral's phase. Land the STATUS change "
        + 'on its own, or defer to a phase the current STATUS already shows has work ahead']
      : []),
    // A shape-valid task in a phase this repository is not working on schedules nothing
    // either. An empty set is readable evidence: no phase has an open review stop, so no
    // deferral can hand work to one.
    ...(deferralRequired && typeof deferral === 'string'
      && Array.isArray(activePhases)
      && !activePhases.includes(
        Number.parseInt(TASK_REFERENCE.exec(deferral).groups.phase, 10),
      )
      ? [`"${deferral}" names phase `
        + `${Number.parseInt(TASK_REFERENCE.exec(deferral).groups.phase, 10)}, but `
        + (activePhases.length > 0
          ? `docs/STATUS.md puts this repository in phase ${activePhases.join(' or ')}. A `
            + 'deferral hands work to a review stop in the phase under review; a later phase '
            + 'is a scope change, not a handoff'
          : 'docs/STATUS.md records no phase with open work, so there is no review stop left '
            + 'to settle these questions. Advance STATUS to the phase that will answer them, '
            + 'or answer them on this head')]
      : []),
    // A trailer naming a task, with a packet that records no handoff, is the bare marker
    // wearing a task name: nothing is actually scheduled. The obligation has always been
    // trailer AND ledger (AGENTS.md, and this repo's own packets say so); only the trailer
    // half was enforced.
  ];
  return {
    required: true,
    allowed: missing.length === 0,
    findingHeadCount,
    findingHeads,
    hasTrailer,
    hasPacket,
    deferralRequired,
    cumulativeUnreadable,
    deferredTo: deferral ?? null,
    missing,
  };
}
