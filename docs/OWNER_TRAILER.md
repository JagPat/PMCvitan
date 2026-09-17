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
  - `unreadable` — git could not be run (binary missing or non-zero exit), so the commit's owner cannot be
    determined; a consumer must fail closed and grant no merge authority.
  - `declared` (the array) always carries the raw trailer value(s) found, so a later consumer can inspect
    a value this loop does not route to.
- `headBoundOwnerAgreement(commitMessage, body, { headRef })` → `{ headOwner, bodyOwner, consistent, trailerState }`,
  a resolution helper for the later gate/handoff/watchdog consumers. `consistent` is true only when
  the HEAD trailer names a valid owner that agrees with the PR body marker; it fails closed for a
  missing/invalid/disagreeing trailer or an `unreadable` commit. `headRef` is passed through to the body
  parse so a `claude/**` branch declaring another owner reads as `contradictory` (the branch-reservation
  rule the scope gate applies) rather than being accepted.

## Git fidelity

Terminal-trailer extraction is **delegated to real `git interpret-trailers --parse --unfold`**, not
reimplemented: the primitive feeds the commit message to git on stdin (never as an argument, so no content
is read as a flag) and reads back git's own `Key: value` lines, with folded continuations already joined.
The primitive is therefore git itself for the extraction step, and cannot diverge from git as further edge
cases surface. The subprocess **pins the ambient config that changes `--parse` output** — `trailer.separators`
(which decides both the accepted separators and the output separator, so a runner configured with e.g. `=:`
would otherwise emit `Correction-Owner= claude`) and `core.commentChar` (which decides which comment lines
`--parse` strips) — with command-line `-c`, which overrides global, local, and env config, so the read is
deterministic on any runner. On top of git's output it applies only this loop's own admission logic: it filters for the
`Correction-Owner` key (case-insensitive), ASCII-trims the value (git preserves non-ASCII whitespace in the
value, so an NBSP/VT/em-space-padded value stays malformed and fails validation), and maps to the states
above. If git cannot be run the primitive returns `unreadable` rather than reading the commit as owning
nothing.

Delegation replaced a hand-rolled reproduction of git's trailer grammar that repeatedly diverged from git
on adversarial input — the `#` comment/continuation interaction, the exact recognized-token spelling
(`Signed-off-by` only, and not when space-padded), the `(cherry picked from commit …)` provenance suffix,
the trailer-token grammar (`-X:` is a valid token), and continuation reset after a dropped non-trailer
line. Each divergence was a fresh review finding; delegating to git eliminated the whole class at once.

A **differential test** (`scripts/autonomous-correction-owner.test.mjs`) remains the regression guard: it
runs real git as the oracle over an adversarial matrix and asserts the extraction/resolution mapping
agrees, and it keeps every case a previous reimplementation got wrong — the plain trailer, a missing
trailing newline, case-insensitive keys, whitespace before the separator, `#` comment lines, the `---` and
`--- a/file` dividers, `---foo`, an indented ` ---`, a divider before the trailer, duplicate/conflicting
trailers, a leading continuation, ASCII- vs non-ASCII-"blank" separator lines, NBSP-padded values, lone-CR
vs CRLF, the `Signed-off-by` recognized-block cases, the space-padded token, the cherry-pick suffix, the
`-X:` token, and continuation reset after dropped prose — plus a fail-closed `unreadable` case. Keeping the
primitive proven against git directly is what lets later units consume one authoritative owner verdict
instead of re-deriving it.
