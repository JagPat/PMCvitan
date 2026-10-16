# Stage 1 H1–H3 live journeys on the QA project (qa-test-d135)

Written 16 Oct 2026 for the monitor; updated 17:45 UTC. Project: **qa-test-d135** only. Never touch a real
project's switch. Web https://pms.vitan.in, API https://pms-api.vitan.in (no /api prefix). H0–H3 have been live
since 82d6cbf; #944 (the reason on the "on" audit row) since d6c7dda.

**State at 17:35 UTC:** the Board turned `home-nav` on for qa-test-d135 at about 23:00 IST (`changed:true`) and
verified it read-only: on for all five qa.* accounts, off on ambli.

Evidence goes in `notes/stage1/probes/2026-10-16-h1-h3/`: one screenshot per step named
`<step>-<role>-<lang>-<width>.png`, and one `results.md` with each line marked PASS or FAIL.

Accounts: qa.pmc, qa.client, qa.engineer, qa.contractor, qa.consultant @vitan.in. The password stays
with the monitor and is never written here or put in the cloud environment.

Language: change it from the app's language picker. Phone widths: 390 px and 320 px.

## Order

The baseline (B) was meant to be taken before the switch went on. It was not, so it is taken during the
rollback drill (R), which also proves the H0 off-switch live.

1. **N: H1 navigation**, **A: H2 actions line**, **O: Offline**, **T1: H3 tiles, part 1** (switch on now).
2. **R: Rollback drill with the baseline.** The operator turns the switch off, the monitor takes the baseline
   (B), and the operator turns it back on.
3. **T2: H3 tiles, part 2.** It runs after the Q4 write journeys (q4-write-journeys.md), once the project holds
   records.

Wherever a check below says "the same as in the baseline", record what is seen now and compare it once B exists.

## E. Switch on (done by the Board, 16 Oct about 23:00 IST)

E1 (done, Board): as each qa.* account, `GET /projects/qa-test-d135/shell` lists `"home-nav"`.
E2 (done, Board): a real project (ambli) does not.
E3. Reload the app for every account before the checks below; the layout changes only when the app opens or
reloads.

## N. H1 navigation (switch on)

Check en, hi and gu at 390 px. At 320 px check en, and also gu, which has the longest labels.

| Role | Expected bottom bar, left to right |
| --- | --- |
| qa.pmc | Home · For You · **Site Log** · Site Map · More |
| qa.engineer | Home · Today · Site · **Site Map** · More |
| qa.client | the same as in the baseline |
| qa.contractor | the same as in the baseline (Home · For You · Site Map · Drawings · More) |
| qa.consultant | the same as in the baseline (Drawings stays) |

N1. Each bar matches the table.
- PMC Site Log in hi reads "साइट लॉग" and in gu "સાઇટ લોગ".
- Engineer Today/Site in hi reads "आज"/"साइट" and in gu "આજે"/"સાઇટ".

N2. No label is cut off or overlapping at 320 px.

N3. Every screen the role had in the baseline is still on the bar or under More. Open each one once.

N4. Desktop width (1280 px), qa.pmc and qa.engineer: the side menu shows the same five main items.

## A. H2 "You have N actions" (switch on)

A1. For each role, the Dashboard's top line reads "You have N actions". In hi it reads
"आपके लिए N काम" and in gu "તમારા માટે N કામ". N must equal the For You badge on the bar.
When N is 0, it reads "Nothing needs you" / "अभी आपके लिए कुछ नहीं" / "હમણાં તમારા માટે કંઈ નથી".

A2. Tapping the line opens For You.

A3. Throttle the network to "Slow 3G" and reload. The line shows "—" until the data arrives, and
never shows a 0 that later changes.

## O. Offline (switch on)

O1. As qa.pmc and as qa.engineer, open the app online, then go offline in DevTools and reload.
- The bar keeps the new layout (Site Log / Site Map).
- Badges show the last known counts.

O2. Still offline, the actions line shows the last known N or "—", never a false 0.

O3. Tiles read as before going offline.

O4. Go back online; nothing flips mid-screen.

## T. H3 tiles (switch on)

T1. These run straight away, for every role.
- Tile numbers equal the baseline (B1).
- Each tile opens the same screen as in the baseline.
- A tile with nothing in it reads as in the baseline ("All cleared", "Nothing pending", "None").
- The site photo tile's label reads "दर्ज साइट फ़ोटो" in hi and "નોંધાયેલા સાઇટ ફોટા" in gu.

T2 runs after the Q4 write journeys, when the project holds records. With a client-held decision, a
PMC review and a failed item all open:
- qa.pmc: the decisions tile line starts "Waiting on the client ·", the review tile "Waiting on you ·",
  and the failed-items tile "Waiting on you ·" (sent for review) or "Waiting on the engineer ·" (still
  being re-inspected).
- qa.client: the decisions tile starts "Waiting on you ·" (hi "आपकी राह ·", gu "તમારી રાહ ·").
- No tile says "act now"; counts equal the For You badge and tile numbers without the switch.

## R. Rollback drill with the baseline (operator + monitor)

R1. The operator (the Board, from the Coolify API terminal) runs:

```
pnpm --filter api capability:disable --project qa-test-d135 --capability home-nav --operator <your email> --reason "Stage 1 rollback drill and Q3 baseline"
```

PASS when it prints `"changed":true`.

R2. The monitor reloads and takes the baseline (B1 to B3 below). Every role must now show today's app:
- the PMC's tab reads "Daily",
- the engineer has no Site Map tab,
- there is no "You have N actions" line,
- there are no "Waiting on" words.

R3. The operator turns it back on:

```
pnpm --filter api capability:enable --project qa-test-d135 --capability home-nav --operator <your email> --reason "Stage 1 live check resumes after the rollback drill"
```

R4. The monitor reloads as qa.pmc; the bar shows Site Log again. Then compare the N, A and T1 results
against B. The client, contractor and consultant bars, every tile number and every tile's destination must
match B.

## B. Baseline (Q3, read-only, taken while the switch is off during the rollback drill)

B1. For each of the 5 accounts, in en, hi and gu, at 390 px, take a screenshot of:
- the Dashboard,
- the For You screen,
- the bottom bar.

Write down the For You badge number and each Dashboard tile's number.

B2. Repeat the bottom bar screenshot at 320 px, in en only.

B3. As qa.pmc, call `GET /projects/qa-test-d135/shell`. PASS when `capabilities` does **not** contain
`"home-nav"` (the H0 off-switch working live).

## Per-unit evidence to report

| Unit | Built | Reviewed | Deployed | Live-tested |
| --- | --- | --- | --- | --- |
| H0 switch | #937 | Codex clean | 82d6cbf | E1, E2 done (Board); R pending |
| H0 reason on enable | #944 | Codex clean | d6c7dda | Board's enable printed changed:true; R3's audit row carries the reason |
| H1 navigation | #938 | Codex clean | 82d6cbf | N1–N4, O1 |
| H2 actions line | #939 | Codex clean | 82d6cbf | A1–A3, O2 |
| H3 tiles | #943 | Codex clean | 82d6cbf | T1 now, T2 after Q4 |
