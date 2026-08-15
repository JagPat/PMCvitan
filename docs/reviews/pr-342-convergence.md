# PR #342 — convergence audit (UX Wave 0, unit F-1a)

Owed at the second finding-bearing head per the review-efficiency protocol.

| head | role | findings | outcome |
|---|---|---|---|
| `b9dca1d` | the F-1a unit (staged RED `6a64f52` → GREEN) | 6 (1 P1, 5 P2) | corrected on `bc73cff`: the surface-following `--active-focus-ring` property (nearest ancestor wins); forced-colors outline; opener-gone fallback; unmarked ink surfaces (TopBar/NotificationPanel); the switcher made an honest non-modal popup |
| `3e57c8d` | round-1 fold + the shepherded `origin/main` merge (PR #343) | 4 (1 P1, 3 P2) | corrected on this head: forced-colors `!important` (inline `outline:none` outranks any non-important author rule); internal switcher actions park focus on the trigger BEFORE their row unmounts (so a spawned modal captures the trigger, not body, as opener); the trap's Tab listener moves to DOCUMENT level (focus stranded on body by dynamic content removal is recaptured); `aria-haspopup="menu"` dropped — the trigger carries disclosure semantics (`aria-expanded`) matching its plain Tab-driven rows |

| `b40e50f` | round-2 fold + the owed audit | 4 (1 P1, 3 P2) | corrected on this head: the opener-gone fallback walks PAST emptied ancestors until focus is placed; the popup is a NAMEABLE `role="group"` (an aria-label on a bare div names nothing); `aria-expanded` only when the switcher can actually open; and the parked doc's observed-stakeholder gate gains a dated OWNERSHIP amendment — it is an owner-executed acceptance act, not a loop obligation; the loop's deliverable ends at "ready for observed sessions" and never blocks awaiting them (the owner's requirement itself stands verbatim) |

| `a2d9fa1` | round-3 fold | 2 (2 P2) | corrected on this head: Escape handled at the switcher ROOT (Shift+Tab can land focus back on the trigger with the popup open — a panel-only handler was deaf there); the landed `WAVE_0_FOUNDATION.md` gains a dated amendment recording the chosen NON-MODAL disclosure semantics for `ProjectSwitcher` with matching F-1c acceptance checks (the doc still classified it as a trapped dialog, which would have forced F-1c to undo the correction) |

| `b0ce976` | round-4 fold | 2 (1 P1, 1 P2) | corrected on this head: the DURABLE HANDOFF records F-1a as LANDED — the README amendment supersedes "do not open a PR yet" (owner parallel directive), and the STATUS gated-successor row now says F-1a is implemented (PR #342) with the resume action repointed at F-1b (§6.7-gated) → F-1c, so the post-task-4 runner can never re-schedule the shipped unit; and BOTH five-dialog completion criteria (WAVE_0 "Done when" + the master brief F-1a line) become FOUR dialogs + the ProjectSwitcher disclosure |

| `bfd12f4` | round-5 fold | 2 (2 P2) | corrected on this head: the opener-gone fallback preserves RELATIVE POSITION — per-ancestor anchors captured at open (branch + frozen sibling lists) let close prefer the nearest FOLLOWING control, then the branch's survivors, then a PRECEDING control, then anything the ancestor gained, still walking past emptied ancestors (dismissing the middle card no longer jumps keyboard flow backward to the first); and the surface map catches up with the settled semantics — the `ProjectSwitcher` row becomes the non-modal disclosure, `components/PhotoViewer` (one of the four true dialogs) joins the map, count 23 → 24 surfaces |

| `3b4bf1e` | round-6 fold | 1 (1 P1) | corrected on this head: the F-1b opening gate is no longer owner-only — §6.7 records an AUTONOMOUS default (the shared field primitive, the foundation doc's own preferred option) because F-1b is loop-assigned work and the non-blocking rule forbids gating loop work on a human standing by; every handoff surface stating the gate (WAVE_0, README, STATUS, §6.7) carries the dated amendment, and the owner may override asynchronously |

| `7780684` | round-7 fold | 1 (1 P1) | corrected on this head: the stale post-Phase-6 Wave-0 gate removed — the round-7 handoff opened F-1b on merge while the README's rule 2, its re-audit bullet, and the Wave-0 shared RED step still ordered waiting for Task 4/Phase 6 (a continuation obeying the stricter text would postpone F-1b); the fixed sequencing and the post-Phase-6 re-audit now govern WAVES 1–5 only, Wave 0 is the named owner-directed parallel exception, and each Wave-0 unit re-runs its reproduction step against the CURRENT head at the moment it opens |

## Root analysis — one generative class

All ten findings across both rounds are instances of ONE rule: **a focus
property must be derived from the thing that actually owns it, never from
where the code happens to sit.**

- The ring was applied by ANCESTRY (descendant selector) when it belongs to
  the nearest SURFACE → the inherited custom property.
- The forced-colors rule was applied at author-rule strength when the
  competing declaration is INLINE → `!important`, the only strength that
  outranks it.
- Focus restoration was keyed to the OPENER ELEMENT when the opener can
  die → the nearest surviving ancestor; then keyed to the CONTAINER's
  keydown when focus can be stranded OUTSIDE the container → the document.
- The switcher claimed DIALOG then MENU semantics when its content is a
  plain disclosure → `aria-expanded` alone, with every internal action
  parking focus on the trigger it will return to.

Each correction moved the mechanism to the true owner rather than patching
the symptom; the probes pin every moved mechanism (15 arms).

## Disposition

Twenty-two findings across eight rounds — every one verified real, none
disputed, none refuted. Probes 20/20 at this head; full web suite 784/784;
`pnpm check` EXIT 0. The round-7 and round-8 findings are the PROCESS items — first the
owner-only gate on loop-assigned work (resolved by recording the
autonomous default the owner can override asynchronously), then the
sibling instructions that still carried the superseded sequencing
(resolved by scoping them to Waves 1–5) — the same supersession
discipline the primary track already established, applied until no
contradictory instruction survives. The round-6 fallback finding is another instance of
the one generative class: restoration was keyed to CONTAINER-FIRST-MATCH
when the true owner of "where next" is the opener's POSITION — the anchors
move the mechanism to that owner. The round-3 and round-5/6 doc findings
are the NON-focus items: the human-only completion gate (resolved by
naming its OWNER rather than deleting the owner's mandate) and the durable
handoff/surface map catching up with the settled semantics. No product
write path, schema, or API surface was ever touched; the unit remains
presentation-layer only.
