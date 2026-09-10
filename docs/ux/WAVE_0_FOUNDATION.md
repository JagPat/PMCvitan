# Wave 0 — Foundation (units `F-1a`, `F-1b`, `F-1c`)

**Mandate:** F · **Blocks:** every other wave

Split into three review units, **run in order** — `F-1c` validates what `F-1a` and `F-1b` change, so it must follow both. v1 proposed this as one unit covering 23 surfaces plus dialogs, fields, touch targets, screenshots and screen-reader checks — that exceeds a normal review unit.

---

## Why this wave is first

Every later unit must pass automated accessibility checks plus manual keyboard and screen-reader verification. **None can pass while focus is invisible app-wide.** If it lands later, everything built on top has to be re-verified. The values are shared constants rather than per-screen styles, so coverage is total for a small diff.

---

## Reproduce first (all three units share this RED step)

Run against current `HEAD` **at the moment the unit opens** (amended 2026-08-15: Wave 0 runs under the owner's parallel directive and does not wait for Phase 6 — F-1a re-ran this step at its own opening head, and F-1b re-runs it at ITS head when it opens; expect line numbers to have drifted). If a claim no longer reproduces, note it and drop that part.

1. **Zero focus rules.** Search `apps/web/src` for `:focus-visible`. Expected: **0 matches**.
2. **Outline actively removed.** Search for `outline:\s*['"]?none`. Expected ~12 sites including `DailyLogScreen:401`, `DecisionLogScreen:517`, `InspectionReviewScreen:265`, `ScheduleScreen:519`, `TeamScreen:601`, `ProjectSwitcher:238`, `DrawingsScreen:494`, `TeamAccessScreen:684`, `LocationPicker:22`, `modals/ChangeModal:12`, `EngineerChecklistScreen:150`, `TopBar.module.css:68`.
3. **Sub-16px fields.** Confirm the 8 constants: `CommercialScreen:662` (12.5), `EngineerChecklistScreen:150` (13), `DailyLogScreen:401` / `DecisionLogScreen:517` / `InspectionReviewScreen:265` / `ScheduleScreen:519` (13.5), `TeamScreen:601` / `ProjectSwitcher:238` (14).
4. **Tiny critical type.** `EngineerChecklistScreen:144`, `:166`; `DailyLogScreen:171`, `:182`, `:249` (`padding:0`); `DrawingsScreen:235`.
5. **Failing tests first.** A test asserting a focused control has a visible indicator, and one asserting every field is ≥16px. Both **RED**.

> **The eight field styles are NOT shared constants.** They are separate per-screen style objects (`fldM`, `fldD`, `fld`, `fldS` …), each declared in its own screen. v1 called them shared constants and proposed a source-level test against them — that test cannot be written as described. Choose one:
> - **Preferred:** introduce a real shared field primitive (`components/Field.tsx` or an exported style constant) in F-1b and migrate the eight call sites to it. The diff is larger but the property becomes structurally guaranteed and testable at source.
> - **Otherwise:** assert with **Playwright computed-style checks** on a rendered input per surface, not a source-level test. Slower and per-surface, but honest about what is actually shared.
> Decide before F-1b opens; it changes the unit's size.
>
> **Amendment (2026-08-15, autonomous loop — the decision, recorded):**
> F-1b is loop-assigned implementation work, so per the repository's
> non-blocking rule this choice cannot wait on a human standing by. The
> loop selects the option this document already marks **Preferred**: the
> shared field primitive (`components/Field.tsx` or an exported style
> constant), migrating the eight call sites so the ≥16px property is
> structurally guaranteed and testable at source. The Playwright
> computed-style pass remains F-1c's per-surface verification, not the
> mechanism of the guarantee. The owner may override asynchronously — a
> genuine owner reply choosing otherwise re-plans F-1b at that point.

---

## Unit F-1a — primitives and dialog focus

### Focus tokens — contrast-checked, not assumed

The v1 token was non-compliant. Measured against the real palette:

| Ring colour | On surface | Contrast | Verdict |
|---|---|---|---|
| `--accent` `#b4462e` | `--canvas` `#e9e4d8` | **4.30:1** | passes |
| `--accent` `#b4462e` | `--panel` `#f4f1ea` | **4.83:1** | passes |
| `--accent` `#b4462e` | `--ink` `#23211c` | **2.95:1** | **fails 3:1** |
| `--sidebar-text` `#ede7da` | `--ink` `#23211c` | **13.05:1** | passes comfortably |

So the accent ring is correct on light surfaces and must **not** be used on ink. Add to `styles/tokens.css`:

```
/* light surfaces (canvas, panel, paper) */
--focus-ring: 0 0 0 2px var(--paper), 0 0 0 4px var(--accent);
/* ink surfaces (left rail, dark cards, worker job-card header) */
--focus-ring-dark: 0 0 0 2px var(--ink), 0 0 0 4px var(--sidebar-text);
```

Re-measure if any palette value changes. Do not assume a token passes because it looks strong.

### Apply at the primitive layer

`components/Button.tsx`, the shared field constants, `LeftRail` nav items, `BottomTabs` tabs, interactive `StatusChip`, modal dismiss controls.

- **Never remove `outline` without replacing it.** Where `outline:'none'` stays for visual reasons, a `:focus-visible` box-shadow must be present on the same element.
- Do not attach focus styles per screen. If a screen needs one, the primitive is missing an affordance — fix the primitive.

### Dialog focus traps

`ProjectSwitcher`, `ApproveModal`, `ChangeModal`, `QrModal`, `PhotoViewer`: focus moves in on open, is trapped while open, returns to the trigger on close, `Esc` dismisses. `Modal.tsx` already has `aria-labelledby` and a keydown handler — **extend it there once**, not in each modal.

> **Amendment (2026-08-15, PR #342 review rounds 1–4):** `ProjectSwitcher`
> is NOT a dialog and does not trap — trapping a popup while the page stays
> interactive contradicted both its behavior and its ARIA claims (review
> findings). Its recorded semantics are a **non-modal disclosure**:
> `aria-expanded` on the trigger (only when it can open), a nameable
> `role="group"` panel, focus into the panel on open, `Esc` closes from
> anywhere within the switcher and restores the trigger, internal actions
> park focus on the trigger before their row unmounts, and outside
> interaction light-dismisses without stealing focus. F-1c validates THESE
> semantics for the switcher; the four true dialogs above keep the trap
> contract unchanged.

**Preserve confirmation and attribution wording exactly.** This unit changes focus only — no copy changes.

**Done when:** focus coverage on every interactive primitive; no bare `outline:none` without replacement; both tokens contrast-verified in test; the FOUR dialogs (`ApproveModal`, `ChangeModal`, `QrModal`, `PhotoViewer`) trap and restore focus and dismiss on `Esc`, and `ProjectSwitcher` meets its non-modal disclosure checks (see the amendment above); confirmation wording unchanged.

## Unit F-1b — mobile field and touch corrections

> **Amendment (F-1b's own opening head, `f44e0eba`) — the guarantee is a CSS FLOOR, not the
> primitive; the §6.7 default is superseded by its own reasoning.**
>
> The reproduce-first step was re-run at this head, as this document requires, and two of the
> five claims no longer reproduce: `:focus-visible` has **3** matches, not 0, and the
> `outline:none` sites now sit under F-1a's global replacement rule. Both are F-1a's, and are
> dropped here.
>
> Claim 3 does not reproduce either — but in the other direction. The brief counts **8 field
> constants**. The measured count at this head is **134 text-entry controls across 14 files**
> (`input` other than checkbox/radio/file/range/button-like, `textarea`, `select`), of which
> **45 are inside `CommercialScreen.tsx`** — the 162 KB file Wave 3 must split before anyone
> may touch it.
>
> §6.7 chose the shared primitive *because* it makes the ≥16px property "structurally
> guaranteed and testable at source". At 8 sites that holds. At 134 it does not: a primitive
> guarantees only the call sites that adopt it, nothing stops the 135th, and the migration
> alone would exceed the review-unit limit while forcing a Wave-3 prerequisite. The option was
> chosen for a property, and at the real count it no longer delivers that property.
>
> F-1b therefore delivers the property by a **mobile field floor** in `styles/global.css`: an
> `@media (max-width: 639px)` rule setting `font-size: 16px !important` on every text-entry
> control. `!important` is what makes it work — the screens write their sizes as INLINE style
> attributes, and only an important author declaration outranks an inline one, the same cascade
> fact F-1a's forced-colors rule already depends on. **Verified in Chromium, not assumed:**
> inline 13.5 / 12.5 / 14px controls all compute to 16px at 390px, and at 1280px the rule is
> out of range so every surface keeps its authored desktop density (which this unit's brief
> explicitly permits, and forbids only on mobile).
>
> This covers every control that exists and every control anyone adds later — which is what
> §6.7 wanted. No `components/Field.tsx` is introduced: an unused primitive added to satisfy
> the letter of a decision whose reasoning no longer holds is not a guarantee, it is ceremony.
> **The owner may override asynchronously**, exactly as §6.7's own amendment provides.
>
> Proof lives in `apps/web/tests/e2e/mobile-fields.spec.ts` — a real browser at 390×844, and a
> GENERIC sweep rather than a named list, because a named list is what went stale here.

### Fields to 16px
Raise all 8 field styles to `fontSize: 16` — via the shared primitive if that route was chosen above. Where desktop density genuinely suffers, scale **down** at `min-width: 640px` — never below 16px on mobile.

`EngineerChecklistScreen:150` is the most important: the fail-note input, used one-handed on site mid-inspection, today triggering an iOS zoom the user cannot undo.

### Critical information off metadata type
Anything that changes what a user must **do** goes to ≥13px with real weight. Keep 8–9px strictly for decorative eyebrows. Specifically: the fail-evidence requirement, the server-refused photo list, the presence proof, the issued-to status.

### Touch targets
`DailyLogScreen:249` — the mismatch control — becomes a **44×44** button: full-width, bordered, thumb-reachable. It currently has a hit area of roughly 84 × 12 px, and it is the control that blocks wrong material reaching the wall.
Audit every action target against the 44×44 floor in the same pass.

**Done when:** all 8 field styles ≥16px on mobile (verified by computed style, or by source if the primitive was introduced); no safety- or evidence-critical text below 13px; every action target ≥44×44; iOS Safari focuses every field without zooming.

> **Amendment (2026-09-10, PR #584 review round 1 — four accepted findings):**
>
> 1. **The floor is not a WIDTH.** `max-width: 639px` releases in phone
>    LANDSCAPE — an iPhone 14 rotated is 844 × 390 CSS px — at exactly the
>    moment the device is still a phone and Safari still zooms. Worse, the
>    app's own shell has already switched to `LeftRail` at that width, so the
>    surface is serving authored desktop density to a phone. The rule gains a
>    second condition on the SHORT side: `(max-height: 549px) and
>    (orientation: landscape) and (pointer: coarse)` — the height excludes a
>    landscape iPad (768px tall, and iPadOS does not zoom), the pointer test
>    excludes a desktop window dragged short.
> 2. **The action-target sweep must enter every STATE**, not measure the one
>    that happens to render. Two undersized controls sat behind states the
>    first sweep never entered: `Check out` (30px, visible only while checked
>    IN) and the stale-data `Retry`.
> 3. **This section's four named labels are the contract**, not examples: the
>    fail-evidence requirement, the server-refused photo list, the presence
>    proof and the issued-to status all leave metadata type for the 13px floor
>    with real weight. The first head raised the material verdict alone.
> **Amendment (2026-09-10, PR #584 review round 2):** the action-target audit is EVERY
> reachable surface, not the one this section names. Round 1 swept the Daily Log only, which let
> the unit claim a generic audit while three shipped controls stayed under the floor — the worker
> and mistri sign-out buttons (34×34, 36×36) and the Places photo thumbnails (34×34). All three
> are raw `button` elements the `Button` primitive's minimum never reaches; all three are fixed.
>
> **Retraction (2026-09-10, PR #584 review round 3, finding 2):** the paragraph below claimed a
> **~0.982 ancestor content scale** on Schedule, "measured" at 43.2px on controls whose CSS box is
> 44px, and deferred it to F-1c as a layout blocker. **There is no such scale, and the measurement
> was an artifact of when it was taken.** `ScheduleRow` carries `animation: 'vpop .3s'`
> (`ScheduleScreen.tsx`), and the `vpop` keyframe (`global.css`) runs `scale(0.98)` to
> `transform: none`. A row sampled just after mount is mid-animation: 44 × 0.982 = 43.2, which is
> the number that was recorded as permanent. A third of a second later the same control is 44px.
> Left standing, this entry would have sent F-1c to remove a layout constraint that does not
> exist. The controls this unit raised to 44 CSS px are at 44 real px.
>
> **Correction to the correction (2026-09-10, PR #584 review round 4, finding 2):** the retraction
> above was right that there is no ancestor content scale and wrong about what followed. 43.2px was
> a real measurement of a real thumb target: `vpop` scaled the whole ROW, so its 44×44 buttons were
> ~43.1×43.1 for the animation's 300ms — undersized exactly while the row is arriving under a thumb
> already reaching for it. Round 3 answered that by freezing animation in the test, which stopped
> the inventory seeing it and changed nothing for the user. `scale()` is now gone from the `vpop`
> keyframe — `translateY` moves a box without resizing it, so the rise and fade stay and the floor
> holds from the first frame — and the sweep deliberately does NOT freeze motion, so a future entry
> animation that shrinks a control fails here instead of hiding. This applies to every `vpop`
> container with controls in it, not only Schedule: the Toast, the Modal and the notification panel
> were all scaling their own buttons.
>
> **And the per-surface sweeps were measuring one dev-only control** (round 4, finding 1). Schedule's
> and Drawings' own fields live behind dialogs, so those arms measured the TopBar persona `<select>`
> — present on every screen, dev-only, and enough to make an empty sweep look populated. Each sweep
> now states how many fields it must find, dev affordances are excluded from the count, and the
> dialogs that hold the fields are opened.
>
> **Amendment (2026-09-10, PR #584 review round 5): the deferral is WITHDRAWN and the targets are
> raised.** Round 2 parked three known sub-floor groups in F-1c as "density decisions" — the
> Schedule breadcrumbs (`sched-place-*-crumb-*`, ~18px), the drawing chips (`sched-dwg-*`, ~21px)
> and the decision register's group-by row (26px). That was the wrong unit to send them to. F-1c is
> defined in this document as validation that "applies F-1a/b and proves them", with no new design
> decisions in it, while F-1b's completion criterion above says "every action target >=44x44" with
> no exception written into it. A known violation deferred to a unit that cannot decide anything is
> deferred nowhere, and F-1b would have been cleared with the rule it states unmet.
>
> All three are at the floor now, and raising them is a real density change to two dense surfaces —
> which is the trade this unit is the one entitled to make. The drawing chip keeps its 9.5px mono
> label: the floor governs the HIT AREA, and shrinking a governing drawing number to satisfy a
> touch rule would trade one rule for another.
>
> **And the inventory that named those three was itself incomplete.** Sweeping the decision
> register — rather than reading it — turned up four status filter chips at 24px, three collapsible
> group headers at 35px, and `groupby-flat` at 37px WIDE after the height fix, because the floor is
> 44 in BOTH axes and the round-2 note had only ever looked at one. All are raised, and
> `mobile-fields.spec.ts` sweeps both surfaces so the claim rests on a measurement. The lesson is
> the one this unit keeps relearning: an inventory written from a reading lists what the author
> noticed; only a sweep lists what is there.
>
> F-1c still owns the sweep of every surface this unit did not touch. What it no longer inherits is
> a set of known violations it was never allowed to fix.
>
> **Amendment (2026-09-10, PR #584 review round 6): two more targets, and the limit of a sweep.**
> The breadcrumb was given a height and not a WIDTH — the same omission this unit had already
> caught on the register's `All` chip one round earlier and failed to carry one file over — and a
> location name may be a single character (`createNodeSchema` accepts `min(1)`). The override
> REVOKE control, an 11px glyph with no padding, was never measured by anything. Both are at
> 44×44 now.
>
> **And neither is provable by the e2e sweep, for two different reasons that are worth separating.**
> The revoke control needs a STATE the suite cannot reach: recording an override goes through
> `overrideGate`, which refuses without a server, and this suite runs the API-less demo. The
> breadcrumb is reachable but needs DATA the fixture does not contain: the demo's names are
> "Ground Floor" and the like, so its crumbs are comfortably past 44px and the arm stays green
> with the minimum removed — measured, not assumed. Both are therefore guarded at the DECLARATION
> in `ux-consistency.test.tsx`, which this document's own criterion allows ("verified by computed
> style, or by source"), and each guard was confirmed to fail when its minimum is deleted.
>
> A sweep proves the states it drives over the data it has. That is a smaller claim than it looks,
> and it is the fifth distinct way this unit has now been caught overstating one.

> 4. **A desktop-parity assertion must name a value.** `expect(sizes.every((s)
>    => s > 0))` is true whether the rule is scoped or has escaped to every
>    width, so it passed in the world it existed to rule out. It now asserts a
>    known dense control keeps its authored sub-16px size.

---

## Unit F-1c — per-surface validation

**Depends on F-1a and F-1b — do not start until both have cleared.** The sweep and the evidence, across all surfaces. No new design decisions here; it applies F-1a/b and proves them.

- Playwright at **360×800, 390×844, tablet, desktop**: screenshots plus a **tab-through interaction check** proving a visible indicator on every interactive element.
- Automated accessibility scan, **plus manual keyboard and screen-reader passes**. Automated alone does not satisfy the directive.
- No overflow, overlap or clipped controls at any supported viewport.
- Full CI + exact-current-head Codex clearance.

**Non-colour cues.** Gate dots (`GateDot.tsx`), material shortages, labour forecast verdicts and pass/fail states must not rely on colour alone. Add a shape, icon or text cue. Where a surface is otherwise untouched, log it for its own wave rather than expanding this diff.

**Done when:** every surface in the (re-derived) map passes at all four viewports, with automated *and* manual verification recorded.

---

## Settle during this wave — longest lead time in the programme

**Worker and mistri experiences.** Both identities already exist: `Worker` is a first-class domain entity (`packages/shared/src/domain/types.ts:504`) and mistri responsibility is modelled as crew in-charge (`packages/shared/src/contracts/labour.ts:162`). What is missing is a dedicated experience for each.

**Do not widen the shell `Role` union** — that would grant navigation and authority neither persona should have. Instead settle: what surface each gets, how they authenticate (see master brief §6.2 — the reported worker-token gap must be reproduced and fixed as a security question first), and what authority each carries.

Wave 4 depends on this, and the Wave 5 sessions for those two personas cannot run without it.
