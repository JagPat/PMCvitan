# Stage 1 units and what remains (16 Oct 2026, updated 17 Oct 03:50 UTC)

Status columns follow the plan: Built, Reviewed, Deployed, Live-tested. "Deployed" names the first commit
that carried the unit live. At 03:45 UTC on 17 Oct `https://pms-api.vitan.in/health` and
`https://pms.vitan.in/version.json` both report 5f81f1b, which holds H0–H3, #944, #948, #949 and #950.

| # | Unit | Built | Reviewed | Deployed | Live-tested | Remaining |
| --- | --- | --- | --- | --- | --- | --- |
| Q0 | QA isolation check (read-only code) | done | n/a | n/a | n/a | none |
| Q1 | Isolate QA (QA-only org, qa-test-d135) | done by monitor + Jagrut | coordinator | live | coordinator 19:46 IST | none |
| Q2 | Live isolation proof (V1–V7) | steps written (qa-isolation-steps.md) | coordinator | live | V5, V6 PASS (coordinator 19:46 IST); V1–V4 and V7 not yet run as written | monitor runs V1–V4; V7 follows from V1 and V2 |
| Q3 | Baseline sweep (C7), switch off | steps written (journeys file, parts R and B) | — | — | pending | taken during the rollback drill |
| H0 | `home-nav` switch + audited off command | #937 | Codex clean | 82d6cbf | on: PASS (Board, 23:02 IST); off: pending (R) | rollback drill |
| H0b | "On" command records the reason | #944 merged | Codex clean | d6c7dda | Board's enable printed changed:true | R3b: read the reason on the audit row |
| H1 | Navigation | #938 | Codex clean | 82d6cbf | N1, N2 PASS (5 roles); N4 PASS after #949 (0dc152c); reload keeps sign-in PASS after #948 (5f81f1b); O1 pending | hi/gu and offline runs |
| H2 | "You have N actions" | #939 | Codex clean | 82d6cbf | A1, A2 PASS (5 roles) before #950; #950's PMC For You "Waiting on" lines (live since 95afa3e) not yet re-run | A1 re-run for qa.pmc on #950; hi/gu, A3 and offline runs (O2) |
| H3 | Tiles say whom they wait on | #943 | Codex clean | 82d6cbf | pending (T1 now, T2 after Q4) | monitor run, twice |
| Q4 | Write journeys C1–C6 | steps written (q4-write-journeys.md) | — | — | V8 after C2 | one monitor run |

## What is left, in order

1. **#944.** Done: merged and deployed (API at d6c7dda, 16 Oct 14:49 UTC).
2. **Switch on for qa-test-d135.** Done by the Board at about 23:00 IST, verified at 23:02 IST.
3. **H1, H2, offline and H3 part 1.** One monitor pass: 5 roles, en/hi/gu, 390 px and 320 px.
4. **Q3 baseline.** It was not taken before the switch went on, so it is taken during the rollback drill
   (journeys file, part R): off, baseline, back on. That needs two operator commands, and R4 compares the
   step 3 results with the baseline.
5. **Q4 write journeys (C0–C6).** Steps are in q4-write-journeys.md; one monitor run.
   - Each record is titled "QA TEST".
   - The refusals (403s) are included.
   - V8 runs after C2, the first write that alerts the PMC: no alert reaches Jagrut, and Portfolio/Brief are
     unchanged.
6. **H3 part 2.** It runs after Q4, once the project holds a client decision, a review and a failed item.
7. **Real projects.** The controller decides, one at a time, after the QA checks pass. Not part of this
   list.

After Stage 1, and not counted here: the clean-up unit that removes the old layout once every project
is on, and D4 server check-in and check-out (migration PR first).
