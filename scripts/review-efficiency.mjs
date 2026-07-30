export const REVIEW_SCOPE_ENFORCE_AFTER_PR = 246;
export const STANDARD_MAX_FILES = 20;
export const STANDARD_MAX_CHANGED_LINES = 1_500;
export const CONVERGENCE_AFTER_FINDING_HEADS = 2;

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
const CONVERGENCE_PACKET = /^docs\/reviews\/[^/]*convergence[^/]*\.md$/iu;

function finiteCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : 0;
}

export function assessReviewScope(
  pullRequest,
  {
    enforceAfterPr = REVIEW_SCOPE_ENFORCE_AFTER_PR,
    maxFiles = STANDARD_MAX_FILES,
    maxChangedLines = STANDARD_MAX_CHANGED_LINES,
  } = {},
) {
  const additions = finiteCount(pullRequest?.additions);
  const deletions = finiteCount(pullRequest?.deletions);
  const changedFiles = finiteCount(pullRequest?.changed_files);
  const changedLines = additions + deletions;
  const large = changedFiles > maxFiles || changedLines > maxChangedLines;
  const common = {
    changedFiles,
    changedLines,
    large,
    limits: { maxFiles, maxChangedLines },
  };

  if (!large) {
    return { ...common, state: 'standard', allowed: true, missingInvariants: [] };
  }

  if (finiteCount(pullRequest?.number) <= enforceAfterPr) {
    return {
      ...common,
      state: 'grandfathered',
      allowed: true,
      missingInvariants: [],
    };
  }

  const body = String(pullRequest?.body ?? '');
  const sizeDeclaration = /^<!--\s*review-size:\s*(standard|justified-large)\s*-->/iu
    .exec(body.trimStart());
  const justified = sizeDeclaration?.[1]?.toLowerCase() === 'justified-large';
  const tableRows = body
    .split(/\r?\n/u)
    .filter((line) => line.trimStart().startsWith('|'))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
  const missingInvariants = REQUIRED_INVARIANTS.filter(
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
    return {
      ...common,
      state: 'blocked',
      allowed: false,
      missingInvariants,
      detail: `Large review unit requires a justified-large marker and complete invariant matrix; missing ${missing.join('; ')}`,
    };
  }

  return {
    ...common,
    state: 'justified_large',
    allowed: true,
    missingInvariants: [],
  };
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
const TASK_REFERENCE = /^phase-\d+-(?:task-\d+|planning)$/iu;

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
    const trailer = /^([A-Za-z0-9][A-Za-z0-9-]*):[\t ]+(.+)$/u.exec(line);
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

// Does the packet record the handoff the trailer claims?
//
// The trailer is the author's ASSERTION that the remaining questions moved to probes; the
// packet ledger is the assertion's content. Accepting the trailer alone made the deferral
// exactly the bare marker the bare-marker rule refuses — a task name and nothing scheduled.
//
// This check was rebuilt three times by ADDING an exclusion — a keyword, then a row shape,
// then a header exclusion — and each time a new input slipped through, because each version
// tested a weaker PROXY for the artifact instead of the artifact. So the artifact is defined
// once, completely, straight from the rule in AGENTS.md ("each still-open question is
// converted into a named probe IN THE PLAN … the deferral LEDGER in the convergence packet
// records each question with the probe that will adjudicate it"):
//
//   A deferral ledger is a SECTION of the packet whose heading names it, containing at least
//   one ENTRY (table row, bullet, or numbered item) that names a probe by IDENTIFIER, where
//   every identifier so named is DEFINED in the plan at this head. The section, or the packet
//   around it, names the task the trailer defers to.
//
// Each clause answers a way the previous versions failed:
//   - SECTION, because scanning the whole packet let an ordinary `## Probes` bullet stand in
//     for a ledger — a list of probes is not a mapping from questions to probes.
//   - ENTRY, because prose naming the task and the word "probes" records no mapping.
//   - IDENTIFIER, because `| Question | Probe | Settled by |` is a row that mentions the word
//     and labels a column rather than naming anything.
//   - DEFINED IN THE PLAN, because the rule requires the probe to exist where it will run.
//     `| open question | probe 5w | phase-5-task-1 |` next to a plan with no 5w schedules
//     nothing.
//   - the TASK as a token, because `phase-5-task-1` is a prefix of `phase-5-task-10` and the
//     two artifacts must describe the SAME review stop.
//
// What this deliberately does NOT do is judge whether the ledger is adequate — whether the
// questions are the right questions, or the probes really settle them. That is the whole
// lesson of PR #250, where a mechanism that scored SUBSTANCE would have suppressed a correct
// finding on its first real case. Every clause above is a question about the document's shape
// and cross-references, answerable without an opinion. Structure is mechanical; adequacy is
// the reviewer's.
//
// Table, bullet, and numbered entries all count. Pinning one markdown format would block an
// author who wrote a perfectly good ledger the other way, which is a false refusal and the
// same class of defect as this PR's first finding.
const LEDGER_HEADING = /^(?<hashes>#{1,6})[\t ]*(?<title>.*)$/u;
const LEDGER_TITLE = /\bdeferral[\t ]+ledger\b/iu;
const LEDGER_ROW = /^[\t ]*(?:\|(?<cells>.*)\||(?:[-*+]|\d+[.)])[\t ]+(?<item>\S.*))$/u;
// The identifier is the token following the word — a bare `Probe` matches nothing and so
// names no probe. A ledger row often cites several (`probe 5y, 5u`), so a comma list
// continues, but ONLY while the next token starts with a DIGIT: `probe 5w, settled by
// phase-5-task-1` is prose after the identifier, and swallowing `settled` as a second probe
// made a perfectly good bulleted ledger fail. Every probe in this repo's plans is numbered,
// and no English continuation starts with a digit, so the digit is what separates the two.
const PROBE_REF = /\bprobes?[\t ]+(?<first>[\p{L}\p{N}]+)(?<rest>(?:[\t ]*,[\t ]*\d[\p{L}\p{N}]*)*)/giu;
const SEPARATOR_CELL = /^[\t :|-]*$/u;

// The ledger section: from its heading to the next heading at the same or a higher level.
function deferralLedgerSection(packetText) {
  const lines = String(packetText).split(/\r?\n/u);
  let level = 0;
  const section = [];
  for (const line of lines) {
    const heading = LEDGER_HEADING.exec(line);
    if (heading) {
      const depth = heading.groups.hashes.length;
      if (level > 0 && depth <= level) break;
      if (level === 0 && LEDGER_TITLE.test(heading.groups.title)) {
        level = depth;
        continue;
      }
    }
    if (level > 0) section.push(line);
  }
  return level > 0 ? section : null;
}

function probeIdsIn(text) {
  const ids = [];
  for (const match of String(text).matchAll(PROBE_REF)) {
    ids.push(match.groups.first);
    for (const id of (match.groups.rest ?? '').split(',')) {
      const trimmed = id.trim();
      if (trimmed.length > 0) ids.push(trimmed);
    }
  }
  return ids;
}

// A ledger entry is a row/bullet that names at least one probe identifier. Separator rows
// (`|---|---|`) carry no cells and are not entries.
function entryProbeIds(line) {
  const row = LEDGER_ROW.exec(line);
  if (!row) return [];
  if (row.groups.item !== undefined) return probeIdsIn(row.groups.item);
  const cells = row.groups.cells.split('|');
  if (cells.every((cell) => SEPARATOR_CELL.test(cell))) return [];
  return cells.flatMap((cell) => probeIdsIn(cell));
}

function tokenPattern(value) {
  const token = String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_-])${token}(?![\\p{L}\\p{N}_-])`, 'iu');
}

// The plan DEFINES a probe when a line starts with its identifier as a list marker — the form
// the plans already use (`5w. §0 COMMITTED close-short: …`). A passing mention elsewhere is
// not a definition, which is the whole point of the rule.
function planDefinesProbe(planText, id) {
  const token = String(id).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`^[\\t ]*${token}[.)][\\t ]`, 'imu').test(planText);
}

function packetRecordsDeferral(packetText, target, planText) {
  if (typeof packetText !== 'string' || packetText.length === 0) return false;
  if (!tokenPattern(target).test(packetText)) return false;
  const section = deferralLedgerSection(packetText);
  if (!section) return false;
  const ids = section.flatMap((line) => entryProbeIds(line));
  if (ids.length === 0) return false;
  if (typeof planText !== 'string' || planText.length === 0) return false;
  return ids.every((id) => planDefinesProbe(planText, id));
}

const CONVERGENCE_MARKER = /^[\t ]*review-convergence:[\t ]+complete[\t ]*$/imu;

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
    const trailer = /^([A-Za-z0-9][A-Za-z0-9-]*):[\t ]+(.+)$/u.exec(line);
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
  packetText,
  planText,
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
  // A cumulative diff we could not read is not evidence of anything, so it falls to the
  // CODE path: the ordinary convergence obligations stand and no deferral is demanded on
  // a review that may well be provable.
  const deferralRequired = Array.isArray(pullRequestFiles)
    && isDocsOnlyDiff(pullRequestFiles)
    && findingHeadCount >= PLAN_REVIEW_ROUND_CAP;
  const deferral = deferralRequired ? deferredToProbes(headMessage) : undefined;

  const missing = [
    ...(!hasTrailer ? [convergenceTrailerHint(headMessage)] : []),
    ...(!hasPacket ? ['packet'] : []),
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
    // A trailer naming a task, with a packet that records no handoff, is the bare marker
    // wearing a task name: nothing is actually scheduled. The obligation has always been
    // trailer AND ledger (AGENTS.md, and this repo's own packets say so); only the trailer
    // half was enforced.
    ...(deferralRequired && typeof deferral === 'string'
      && !packetRecordsDeferral(packetText, deferral, planText)
      ? [!(typeof packetText === 'string' && packetText.length > 0)
        ? 'the convergence packet could not be read, so the deferral ledger it must contain '
          + 'is unverified. This is not evidence that the ledger is missing — re-run once the '
          + 'packet is readable'
        : !(typeof planText === 'string' && planText.length > 0)
          ? 'the plan could not be read, so whether the ledger\'s probes are actually defined '
            + 'in it is unverified. This is not evidence that they are missing — re-run once '
            + 'the plan is readable'
          : `the convergence packet must record the deferral ledger it claims: a section named `
            + `"deferral ledger" whose entries name "${deferral}" and, per still-open question, `
            + 'the probe that adjudicates it — and every probe named there must be DEFINED in '
            + 'the plan at this head. The trailer asserts a handoff; the ledger and the plan '
            + 'are where the handoff is written down']
      : []),
  ];
  return {
    required: true,
    allowed: missing.length === 0,
    findingHeadCount,
    findingHeads,
    hasTrailer,
    hasPacket,
    deferralRequired,
    deferredTo: deferral ?? null,
    missing,
  };
}
