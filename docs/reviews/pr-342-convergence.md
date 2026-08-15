# PR #342 — convergence audit (UX Wave 0, unit F-1a)

Owed at the second finding-bearing head per the review-efficiency protocol.

| head | role | findings | outcome |
|---|---|---|---|
| `b9dca1d` | the F-1a unit (staged RED `6a64f52` → GREEN) | 6 (1 P1, 5 P2) | corrected on `bc73cff`: the surface-following `--active-focus-ring` property (nearest ancestor wins); forced-colors outline; opener-gone fallback; unmarked ink surfaces (TopBar/NotificationPanel); the switcher made an honest non-modal popup |
| `3e57c8d` | round-1 fold + the shepherded `origin/main` merge (PR #343) | 4 (1 P1, 3 P2) | corrected on this head: forced-colors `!important` (inline `outline:none` outranks any non-important author rule); internal switcher actions park focus on the trigger BEFORE their row unmounts (so a spawned modal captures the trigger, not body, as opener); the trap's Tab listener moves to DOCUMENT level (focus stranded on body by dynamic content removal is recaptured); `aria-haspopup="menu"` dropped — the trigger carries disclosure semantics (`aria-expanded`) matching its plain Tab-driven rows |

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

Ten findings across two rounds — every one verified real, none disputed,
none refuted. Probes 15/15 at this head; full web suite 779/779; `pnpm
check` EXIT 0. No product write path, schema, or API surface was ever
touched; the unit remains presentation-layer only.
