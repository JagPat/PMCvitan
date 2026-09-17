# HEAD-bound correction-owner trailer (parsing/resolution primitive)

This is the first sequential unit of the ownership-admission split (the preserved source is PR #601;
see issue #482). It installs **only** the pure, git-faithful primitives that read the correction owner
from the exact HEAD commit. It changes no gate, wake, merge, handoff, watchdog, continuation, or other
authoritative consumer; no caller in this unit routes on the primitives. Admission (three-valued holds,
the `codex` candidate), exact-head merge authorization, and conflict/watchdog routing are the later units
that will consume this merged primitive.

## Contract

Authority is the exact HEAD commit's **single terminal `Correction-Owner:` trailer**, read as
`git interpret-trailers --parse` reads it — never an ancestor trailer, a branch name, or a marker in prose
or a code fence. `scripts/correction-owner.mjs` exposes:

- `parseCommitCorrectionOwner(commitMessage)` → `{ state, owner, declared }`, where `state` is:
  - `declared` — exactly one terminal `Correction-Owner:` trailer naming an admitted owner
    (`CORRECTION_OWNERS`); `owner` is the lower-cased value.
  - `missing` — no terminal trailer block, or none named `Correction-Owner`.
  - `conflicting` — more than one `Correction-Owner` trailer, or disagreeing values.
  - `invalid` — a malformed value, or one that is not an admitted correction owner.
  - `declared` (the array) always carries the raw trailer value(s) found, so a later consumer can inspect
    a value this loop does not route to.
- `headBoundOwnerAgreement(commitMessage, body)` → `{ headOwner, bodyOwner, consistent, trailerState }`,
  a pure resolution helper for the later gate/handoff/watchdog consumers. `consistent` is true only when
  the HEAD trailer names a valid owner that agrees with the PR body marker; it fails closed for a
  missing/invalid/disagreeing trailer, or (passing a null message for) an unreadable commit.

## Git fidelity

The parser reproduces git's terminal-trailer interpretation, verified by a **differential test** that runs
real `git interpret-trailers --parse` over an adversarial matrix and asserts the raw trailer value(s)
agree (`scripts/autonomous-correction-owner.test.mjs`). The matrix covers: the plain trailer, a missing
trailing newline, case-insensitive keys, horizontal whitespace before the separator, git `#` comment
lines (leading and trailing), the bare `---` and emailed-patch `--- a/file` dividers, the non-divider
`---foo`, an indented ` ---` (text, not a divider), a divider before the trailer (patch content),
duplicate and conflicting trailers, a continuation before the first trailer (voids the block), and
"blank" separator lines that are ASCII whitespace (git-blank) versus vertical-tab / form-feed / NBSP /
em-space (NOT git-blank). Keeping the primitive proven against git directly is what lets later units
consume one authoritative owner verdict instead of re-deriving it.
