# Wave 0 — Foundation (units `F-1a`, `F-1b`, `F-1c`)

**Mandate:** F · **Blocks:** every other wave

Split into three review units, **run in order** — `F-1c` validates what `F-1a` and `F-1b` change, so it must follow both. v1 proposed this as one unit covering 23 surfaces plus dialogs, fields, touch targets, screenshots and screen-reader checks — that exceeds a normal review unit.

---

## Why this wave is first

Every later unit must pass automated accessibility checks plus manual keyboard and screen-reader verification. **None can pass while focus is invisible app-wide.** If it lands later, everything built on top has to be re-verified. The values are shared constants rather than per-screen styles, so coverage is total for a small diff.

---

## Reproduce first (all three units share this RED step)

Run against current `HEAD` — **after Phase 6 closes**, since the surface inventory will have changed. If a claim no longer reproduces, note it and drop that part.

1. **Zero focus rules.** Search `apps/web/src` for `:focus-visible`. Expected: **0 matches**.
2. **Outline actively removed.** Search for `outline:\s*['"]?none`. Expected ~12 sites including `DailyLogScreen:401`, `DecisionLogScreen:517`, `InspectionReviewScreen:265`, `ScheduleScreen:519`, `TeamScreen:601`, `ProjectSwitcher:238`, `DrawingsScreen:494`, `TeamAccessScreen:684`, `LocationPicker:22`, `modals/ChangeModal:12`, `EngineerChecklistScreen:150`, `TopBar.module.css:68`.
3. **Sub-16px fields.** Confirm the 8 constants: `CommercialScreen:662` (12.5), `EngineerChecklistScreen:150` (13), `DailyLogScreen:401` / `DecisionLogScreen:517` / `InspectionReviewScreen:265` / `ScheduleScreen:519` (13.5), `TeamScreen:601` / `ProjectSwitcher:238` (14).
4. **Tiny critical type.** `EngineerChecklistScreen:144`, `:166`; `DailyLogScreen:171`, `:182`, `:249` (`padding:0`); `DrawingsScreen:235`.
5. **Failing tests first.** A test asserting a focused control has a visible indicator, and one asserting every field is ≥16px. Both **RED**.

> **The eight field styles are NOT shared constants.** They are separate per-screen style objects (`fldM`, `fldD`, `fld`, `fldS` …), each declared in its own screen. v1 called them shared constants and proposed a source-level test against them — that test cannot be written as described. Choose one:
> - **Preferred:** introduce a real shared field primitive (`components/Field.tsx` or an exported style constant) in F-1b and migrate the eight call sites to it. The diff is larger but the property becomes structurally guaranteed and testable at source.
> - **Otherwise:** assert with **Playwright computed-style checks** on a rendered input per surface, not a source-level test. Slower and per-surface, but honest about what is actually shared.
> Decide before F-1b opens; it changes the unit's size.

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

### Fields to 16px
Raise all 8 field styles to `fontSize: 16` — via the shared primitive if that route was chosen above. Where desktop density genuinely suffers, scale **down** at `min-width: 640px` — never below 16px on mobile.

`EngineerChecklistScreen:150` is the most important: the fail-note input, used one-handed on site mid-inspection, today triggering an iOS zoom the user cannot undo.

### Critical information off metadata type
Anything that changes what a user must **do** goes to ≥13px with real weight. Keep 8–9px strictly for decorative eyebrows. Specifically: the fail-evidence requirement, the server-refused photo list, the presence proof, the issued-to status.

### Touch targets
`DailyLogScreen:249` — the mismatch control — becomes a **44×44** button: full-width, bordered, thumb-reachable. It currently has a hit area of roughly 84 × 12 px, and it is the control that blocks wrong material reaching the wall.
Audit every action target against the 44×44 floor in the same pass.

**Done when:** all 8 field styles ≥16px on mobile (verified by computed style, or by source if the primitive was introduced); no safety- or evidence-critical text below 13px; every action target ≥44×44; iOS Safari focuses every field without zooming.

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
