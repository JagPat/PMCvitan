# UX Wave 0, unit F-1a — review packet (focus foundation)

## Provenance and scheduling

The owner's UX Completion Programme handoff was parked verbatim on branch
`claude/ux-programme-docs` at `fe2a0f6` (v2). This PR lands its three
authoritative text documents as `docs/ux/*.md` byte-for-byte and implements
**unit F-1a only** (`docs/ux/WAVE_0_FOUNDATION.md`, "primitives and dialog
focus"). The `docs/ux/visual/` artifacts (two rendered design HTML pages +
support.js, ~2,500 lines, non-authoritative per the README) stay parked at
`fe2a0f6` to keep this review unit inside the standard budget.

**Scheduling provenance:** the parked docs and `docs/STATUS.md`'s
gated-successor table record Wave 0 as gated on task 4 completing. On
2026-08-15 the owner directed: *run independent activities in parallel to
speed things up*. This unit is that directive's first parallel track — it is
independent of the decision-workflow unit (no decisions-domain surface is
touched; the one shared file class is the modal primitives, which 4b's
screens consume unchanged). `docs/STATUS.md` deliberately stays untouched:
`open_pr` continues to name the primary task-4 PR #340, and the drift
shepherd's predicate (`open_pr` must name a LIVE PR) remains satisfied.

## Reproduce first (re-run at this head, per the parked README's re-audit rule)

The parked audit was taken at `a354394`. Re-reproduced on `main` `8415e2b`:

- `:focus-visible` in `apps/web/src`: **0 matches** (claim holds).
- `outline: none` sites: **14** — the parked audit's 12, MINUS none, PLUS two
  the audit predates: `screens/modals/WithdrawModal.tsx:12` (added by task
  4a) and `screens/TeamAccessScreen.tsx:181` (inline PIN field). Line
  numbers drifted on four (DailyLogScreen 401→403, DecisionLogScreen
  517→543, ScheduleScreen 519→521, EngineerChecklistScreen unchanged at
  150).
- The 8 sub-16px field constants: confirmed present (F-1b's scope, not
  corrected here).
- No dialog managed focus: `Modal.tsx` had Esc + `aria-modal` but no
  focus-in, no trap, no restore; `PhotoViewer` and the `ProjectSwitcher`
  dropdown likewise (the dropdown had no Esc at all).

## The staged-red probes

`apps/web/tests/focus-foundation.test.tsx`, committed RED first (shape
commit `6a64f52`): **7 of 9 probes failed on behavior** — ring tokens
absent, global replacement rule absent, no ink-surface opt-in, no focus
movement in `Modal`/`PhotoViewer`, no Esc/trap/restore on the
`ProjectSwitcher` dropdown. The 2 green-at-shape probes are honest
pre-existing truths: the contrast MATH over the existing palette (the
tokens it validates did not exist yet — that probe was red), and `Modal`'s
pre-existing Escape. `useFocusTrap` existed as a documented no-op so every
red was a behavior failure, never a missing symbol.

## What F-1a ships

1. **The two contrast-verified ring tokens** (`styles/tokens.css`):
   `--focus-ring` (paper inset + accent) for light surfaces and
   `--focus-ring-dark` (ink inset + sidebar-text) for ink surfaces — the
   doc's measured table reproduced in test: accent ≥3:1 on canvas/panel/
   paper, sidebar-text ≥3:1 on ink, and accent on ink ASSERTED < 3:1
   (2.95:1), the measured failure that forces the two-token design.
2. **The global replacement rule** (`styles/global.css`): `:focus-visible
   { outline: none; box-shadow: var(--focus-ring) }` with a
   `[data-surface='ink'] :focus-visible` override — every interactive
   element in the app gains a visible keyboard-focus ring through the ONE
   rule, so the 14 `outline:none` call sites keep their pointer visuals
   legally: the replacement exists at the layer above them. No per-screen
   focus styles were added anywhere (the doc's rule: if a screen needs one,
   the primitive is missing an affordance).
3. **Ink surfaces opt in**: the left rail (`background: var(--ink)`) carries
   `data-surface="ink"`, as does the `PhotoViewer` overlay (near-black
   backdrop). Other dark cards join in F-1c's per-surface sweep.
4. **The dialog focus discipline, extended ONCE** (`lib/useFocusTrap.ts`):
   focus moves to the first focusable on open, Tab/Shift+Tab wrap at the
   boundaries (mid-list Tab keeps native order — the trap never fights the
   browser), and close returns focus to the opener. Wired into `Modal.tsx`
   (so ApproveModal, ChangeModal, WithdrawModal, QrModal, CreateProjectModal
   and every other `<Modal>` consumer inherit it), into `PhotoViewer`, and
   into the `ProjectSwitcher` dropdown — which also gains its missing
   Escape-to-close. Confirmation and attribution wording untouched (the
   unit's own constraint: focus only, no copy changes).
5. **One tsconfig line** (`apps/web/tsconfig.app.json`): `"node"` joins the
   `types` array so the probe file can read the stylesheets as FILES —
   vitest stubs `.css` imports to empty strings regardless of `?raw`/
   `?inline`, which would have made the CSS seals vacuously green (probed
   and rejected during development; the test carries the comment).

## Verification

- `apps/web/tests/focus-foundation.test.tsx`: RED 7/9 at shape `6a64f52` →
  **GREEN 9/9** at this head.
- Full web suite: **773/773** across 48 files (764 pre-existing + 9 new) —
  the Modal trap changed focus behavior in EVERY modal and regressed
  nothing.
- `pnpm check` EXIT 0 (web 773/773, API 793/793 — the API is untouched).
- No schema, no migration, no API change, no copy change.

## Deliberately NOT in this unit

- **F-1b** (16px fields, critical-type, 44×44 touch targets) — at
  delivery, gated on the §6.7 field-primitive decision (superseded in
  round 7: §6.7 now records an AUTONOMOUS default — the shared field
  primitive — because F-1b is loop-assigned work and the non-blocking
  rule forbids waiting on a human; the owner may override
  asynchronously) (shared
  `Field` primitive vs Playwright computed-style assertions; it changes the
  unit's size). The doc's shared RED step names a fields-≥16px test; that
  probe ships WITH F-1b, since a red test cannot merge.
- **F-1c** (per-surface validation at four viewports, manual keyboard +
  screen-reader passes) — depends on F-1a AND F-1b by design.
- The `docs/ux/visual/` artifacts (parked, non-authoritative).
- The worker/mistri experience questions (§6 of the master brief; Wave 4/5
  lead time — flagged to the owner, not decided here).

## Round 1 — six Codex findings on head `b9dca1d`, folded as one batch

All six verified real; none disputed. The class: the first head applied the
ring by ANCESTRY and trapped a popup that is not a dialog.

1. **(P1) forced-colors mode** — box-shadows are suppressed under Windows
   High Contrast, so the global `outline: none` erased the only indicator.
   `@media (forced-colors: active)` now restores a system-color outline
   (`2px solid Highlight`), asserted in test.
2. **(P2) the ink scope bled into nested light surfaces** — the descendant
   selector gave `CreateProjectModal` (light, inside the ink rail) the dark
   ring at ~1.09:1. The ring now follows the SURFACE through the inherited
   `--active-focus-ring` custom property: the nearest ancestor that sets it
   wins; `Modal` marks its dialog `data-surface="light"`, so every nested
   light modal resolves correctly.
3. **(P2) unmarked ink containers** — the mobile-only top bar and the
   notification panel set `--active-focus-ring: var(--focus-ring-dark)`
   directly in their module CSS, inside the same rules as their ink
   backgrounds (the property mechanism exists precisely so responsive/module
   surfaces can do this).
4. **(P2) the opener-gone fallback** — when a dialog's own action removes
   its opener (approve dismisses the pending card), close now focuses the
   first focusable in the nearest SURVIVING ancestor of where the opener
   lived, never body; probed with a removed-opener render.
5. **(P2/P2 pair) the switcher was a trapped non-dialog** — trapping focus
   while claiming `role="dialog"` without `aria-modal`, with an escape hatch
   a container-scoped listener could never see. Resolved by making it an
   honest NON-MODAL popup: no trap, no dialog role, `aria-haspopup`/
   `aria-expanded` on the trigger, focus into the panel on open, Escape
   closes and restores the trigger, and any outside interaction (mousedown
   or focus departure) light-dismisses WITHOUT stealing focus back. Probed:
   the no-modal-claim assertion + the outside-dismiss arm.

Probes 13/13 (9 original + 4 new); full web suite 777/777; `pnpm check`
EXIT 0 (API 793/793 untouched). The `useFocusTrap` boundary-wrap behavior
for true modals (`Modal`, `PhotoViewer`) is unchanged.

## Round 2 — four Codex findings on head `3e57c8d`, folded as one batch

1. **(P1)** the forced-colors outline gains `!important` — the field styles
   carry INLINE `outline:none`, which outranks any non-important author
   rule; without it, High Contrast still had no indicator.
2. **(P2)** every internal switcher action routes through `closeToTrigger()`
   — focus parks on the trigger BEFORE the clicked row unmounts, so focus
   never falls to body and the New-project modal captures the trigger (not
   body) as its opener.
3. **(P2)** the trap's Tab listener moves to DOCUMENT level — when dialog
   content removes the focused control, focus lands on body and a
   container-scoped listener can never recapture the next Tab.
4. **(P2)** `aria-haspopup="menu"` dropped — the switcher's rows are plain
   Tab-driven buttons, so the honest semantics are a disclosure
   (`aria-expanded` on the trigger), not a menu the popup never implements.

Probes 15/15 (3 new arms: stranded-body Tab recapture, internal-action
focus parking, the no-menu-claim assertion); full web 779/779; `pnpm check`
EXIT 0. Convergence audit added per protocol:
`docs/reviews/pr-342-convergence.md`.

## Round 3 — four Codex findings on head `b40e50f`, folded as one batch

1. **(P2)** the opener-gone fallback walks the WHOLE ancestor chain until
   focus is successfully placed — the nearest survivor can be an emptied
   container (the last pending card approved away), and stopping there
   stranded focus on body.
2. **(P2)** the popup carries `role="group"` — an `aria-label` on a bare
   div names nothing, so "Switch project" was never announced.
3. **(P2)** `aria-expanded` renders only when `canSwitch` — a single-
   membership user no longer hears a disclosure that never opens.
4. **(P1)** the parked programme doc's observed-stakeholder gate gains a
   dated OWNERSHIP amendment: it is an owner-executed acceptance act, not
   a loop obligation — the loop delivers "ready for observed sessions" and
   never blocks awaiting them. The owner's requirement stands verbatim;
   only the actor is named (removing an owner mandate is not the loop's to
   do).

Probes 17/17 (2 new arms + 2 extended); full web 781/781; `pnpm check`
EXIT 0.

## Round 4 — two Codex findings on head `a2d9fa1`, folded as one batch

1. **(P2)** Escape moves to the switcher ROOT: Shift+Tab from the first row
   lands focus back on the trigger with the popup still open, where a
   panel-only handler was deaf. One handler on the shared root covers the
   trigger and the panel alike (new probe arm).
2. **(P2)** the landed `WAVE_0_FOUNDATION.md` still classified
   `ProjectSwitcher` as a trapped dialog — F-1c's acceptance would have
   demanded undoing rounds 1–3. A dated amendment records the chosen
   NON-MODAL disclosure semantics and their acceptance checks; the four
   true dialogs keep the trap contract unchanged.

Probes 18/18; full web 782/782; `pnpm check` EXIT 0.

## Round 8 — one Codex finding on head `7780684`, folded

1. **(P1)** the round-7 handoff said F-1b opens on merge, but THREE
   sibling instructions still ordered the runner to wait for Task 4 and
   Phase 6: the README's non-negotiable rule 2 ("Task 4 → Phase 6
   collaborator units → this programme"), its re-audit bullet ("against
   the post-Phase-6 head"), and the Wave-0 shared RED step ("after
   Phase 6 closes"). A continuation obeying the STRICTER instruction
   would postpone F-1b indefinitely. The correction scopes the old
   sequencing to WAVES 1–5 (rule 2 names Wave 0 as the owner-directed
   parallel exception; the post-Phase-6 re-audit governs Waves 1–5
   only) and makes Wave-0 reproduction timing unambiguous: each unit
   re-runs the RED step against the CURRENT head at the moment it
   opens — F-1a did; F-1b does the same on opening.

Docs-only round; probes 20/20 and `pnpm check` EXIT 0 re-run at this
head.

## Round 7 — one Codex finding on head `3b4bf1e`, folded

1. **(P1)** the F-1b opening gate was OWNER-ONLY: the handoff let the
   next Wave-0 unit open only after "the owner's §6.7 field-primitive
   decision", so no repository event could ever advance the programme —
   the same non-blocking-rule violation class as the PR #340 stop-rule
   supersession. Unlike the round-3 observed-stakeholder amendment
   (a genuinely owner-executed acceptance act), F-1b is implementation
   work ASSIGNED TO THE LOOP. The correction records an autonomous
   default in §6.7 itself and in every handoff surface that stated the
   gate (`WAVE_0_FOUNDATION.md` — the full dated amendment;
   `docs/ux/README.md` — both gate statements; `docs/STATUS.md` — the
   gated-successor row): the loop selects the option the foundation doc
   already marks **Preferred** (the shared field primitive, migrating
   the eight call sites so ≥16px is structurally guaranteed and
   testable at source; Playwright computed-style checks remain F-1c's
   per-surface verification, not the mechanism of the guarantee), and
   the owner may override asynchronously — a genuine owner reply
   choosing otherwise re-plans F-1b at that point. F-1b now opens on
   PR #342 merging, with no human standing by required.

Docs-only round; probes 20/20 and `pnpm check` EXIT 0 re-run at this
head.

## Round 6 — two Codex findings on head `bfd12f4`, folded as one batch

1. **(P2)** the opener-gone fallback preserves RELATIVE POSITION: the flat
   ancestor-wide `querySelector` picked the FIRST control in the surviving
   container, jumping keyboard flow backward across earlier cards when a
   MIDDLE card was approved away. The trap now captures per-ancestor
   position anchors at open (the branch the opener lived under plus its
   frozen sibling lists — a removed node loses its live sibling links, so
   they cannot be walked after the fact) and on close walks each connected
   ancestor in order: FOLLOWING siblings nearest-first, then the branch's
   own survivors, then PRECEDING siblings only as a fallback, then
   anything the ancestor gained since open — still walking past emptied
   ancestors (the round-3 behavior is preserved). Two new arms: dismissing
   the middle of three cards focuses the NEXT card's control (RED on the
   pre-fix walk, which chose the first card), and the earlier card is
   chosen only when the following card is also gone.
2. **(P2)** the surface map caught up with the settled semantics: the
   `ProjectSwitcher` row no longer prescribes "focus trap (it is a
   dialog)" — it now records the non-modal disclosure (2026-08-15) —
   `components/PhotoViewer`, one of the four true dialogs, joins the map,
   and the count is 24 surfaces (18 screens + 6 shared dialogs/pickers).

Probes 20/20; full web 784/784; `pnpm check` EXIT 0.

## Round 5 — two Codex findings on head `b0ce976`, folded as one batch

1. **(P1)** the durable handoff now records F-1a as LANDED: the README's
   "do not open a PR yet / task 4 first" is superseded by a dated
   amendment (the owner's parallel directive), and `docs/STATUS.md`'s
   Wave-0 gated-successor row records F-1a implemented (PR #342) with the
   resume action repointed at F-1b (§6.7-gated) → F-1c — the post-task-4
   runner can never re-schedule the already-shipped unit. (The STATUS edit
   is the NARRATIVE gated table only; the machine block is untouched and
   the automation pins pass.)
2. **(P2)** both remaining five-dialog completion criteria (the Wave-0
   "Done when" and the master brief's F-1a line) now name the FOUR true
   dialogs plus the ProjectSwitcher non-modal disclosure, so F-1c's
   acceptance matches the corrected semantics.

Probes 18/18; full web 782/782; `pnpm check` EXIT 0.
