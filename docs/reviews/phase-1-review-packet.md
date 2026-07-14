# Phase 1 Review Packet

Evidence package for the independent (Codex) review of Phase 1 — completing the
existing product pillars
([plan](../superpowers/plans/2026-07-13-phase-1-existing-pillars.md) ·
[spec](../superpowers/specs/2026-07-12-modular-construction-control-platform-design.md)).
Written on 2026-07-13 AFTER every merge it cites and refreshed on 2026-07-14
twice — after the gate round-1 remediations (PRs #112–#114) merged, and again
after the gate round-2 narrow-re-review remediations (PRs #116–#118) merged;
the Verification section's command outputs are the Task 7 runs on `main` at
`60f69c8` plus the Task 7 changes, and each remediation PR body (both rounds)
records its own fresh full-battery runs. Timestamps are UTC. Repository `JagPat/PMCvitan`, working branch
`claude/vitan-pmc-design-epa2rp`.

## Revisions

- Phase base (Phase 0 closure): `5d6f08b4c39737972b115dcfabf1bebbb25e0e10` (merge of the Phase 0 docs correction, [PR #96](https://github.com/JagPat/PMCvitan/pull/96))
- Gate round 1 reviewed `main` at `95ad1daf60eb84e6c98855ff68904a7a25ae50bb` (merge of [PR #111](https://github.com/JagPat/PMCvitan/pull/111)) and returned **BLOCKED** with four findings — all remediated in PRs #112–#114 (see "Independent Review — Phase 1 gate round 1" below).
- Gate round 2 (the narrow re-review) reviewed `main` at `eb977898a7e7524f20884da844f6edccaad85ada` (merge of [PR #115](https://github.com/JagPat/PMCvitan/pull/115), the round-1 packet refresh) and returned **BLOCKED** with three new P2 findings — all remediated in PRs #116–#118 (see "Independent Review — Phase 1 gate round 2" below).
- **Effective reviewed head for the round-2 narrow re-review**: `main` at `a0b256326c9d98f59ba2ff4c1afeb5c8d04cba18` (merge of [PR #119](https://github.com/JagPat/PMCvitan/pull/119) — the round-2 runtime remediations end at PR #118's merge `03f415a`; #119 is a test-harness seed fix, no product code), plus the docs-only packet-refresh PR this revision ships in.
- Every Phase 1 PR, in landing order. A **head** is the reviewed branch tip; a **merge** is the immutable merge commit on `main`. Bases are the `main` tip each merge was made against (first parent).

  | PR | Scope | Base | Head | Merge |
  |---|---|---|---|---|
  | [#97](https://github.com/JagPat/PMCvitan/pull/97) | Phase 1 plan (docs only) | `5d6f08b` | `558e520d83d6c7a0bec8078f3767a66e4598676b` | `104c0bd94f743690e4a00df7212c3d023475a79d` |
  | [#98](https://github.com/JagPat/PMCvitan/pull/98) | plan correction per the independent plan review | `104c0bd` | `79f7dc98d8360ed69e50f0ce703a098197426a18` | `f82e0f47803f8f642e8ed8269d6bffcbe6fc4736` |
  | [#99](https://github.com/JagPat/PMCvitan/pull/99) | plan correction per the narrow correction review | `f82e0f4` | `c757105bdd6d4414825e59024fb7be9b8dad5b2e` | `5b101d6e1fffd9882aa0bbd7430023ce3bbccc39` |
  | [#100](https://github.com/JagPat/PMCvitan/pull/100) | Task 1: baseline + characterization tests | `5b101d6` | `3a47b694f5508123017072762958b681ec2038da` | `f0d5ad1d7af6bb5e8aa8215afc55b4da7fc8c5f2` |
  | [#101](https://github.com/JagPat/PMCvitan/pull/101) | Task 1 correction: drawing pillar + deterministic race (gate cleared at the merge) | `f0d5ad1` | `12624294d971339dd1f701d34a6d1f96e55f396f` | `1407900afc9df3c44482171597f7f9f061e43b0e` |
  | [#102](https://github.com/JagPat/PMCvitan/pull/102) | Task 2: decision change-control + mandatory re-approval | `1407900` | `88ed4ee5e3573b9702e211bc487d85b2fe9b3602` | `14c397fadedddcd11a23fc36f128482f08dbcb89` |
  | [#103](https://github.com/JagPat/PMCvitan/pull/103) | Task 3: controlled drawing lifecycle | `14c397f` | `d29287b0710802386427111c6e29179099b1cc7a` | `4a552e7b23b5bfab9b80743b3850d018357daba1` |
  | [#104](https://github.com/JagPat/PMCvitan/pull/104) | Task 2 gate remediation (findings 1, 6, 7) | `4a552e7` | `cfd3e95192abfa86cd08b0c374b94b6ce08a48f4` | `f126f3759b38de0a6002c8d9b44a5b4c39301156` |
  | [#105](https://github.com/JagPat/PMCvitan/pull/105) | Task 3 gate remediation (findings 2, 3, 4, 5) — Tasks 2+3 re-review CLEARED | `f126f37` | `c49a59c7cbcf3b01af6a8df17859c4d6008ba2fa` | `05dc1af97109478a771a7d8be98200ee93dd721d` |
  | [#106](https://github.com/JagPat/PMCvitan/pull/106) | Task 4: inspection evidence, requirement link, linked reinspections | `05dc1af` | `68d40f406bc04f11074fd877ffb497037b13d012` | `1ceccf71b16f086ca55b6e4395fbcb94ef6fa1f1` |
  | [#107](https://github.com/JagPat/PMCvitan/pull/107) | Task 5: closing sign-off controls activity completion | `1ceccf7` | `fdec520e06deda0f413c38557ae9683920a97645` | `8d4aadb1ee10761ded22ced66668a9ee48f2a331` |
  | [#108](https://github.com/JagPat/PMCvitan/pull/108) | Task 5 gate P1 remediation: membership validated INSIDE the lifecycle transactions — gate CLEARED | `8d4aadb` | `490296626418a4978344dd061e5128c69d6ea2c8` | `9d71868881b2224a4b7014f48d4dc7763c263600` |
  | [#109](https://github.com/JagPat/PMCvitan/pull/109) | Task 6: readiness derived from explicit links + truth tables + expiring overrides | `9d71868` | `3a18224db0d7a308d9947cf5c80e2b8ad9dce49a` | `011f820d0e552e607d357d7cce61ea243d5ba923` |
  | [#110](https://github.com/JagPat/PMCvitan/pull/110) | Task 6 follow-up: fix the readiness suite teardown FK ordering that failed CI on #109 | `011f820` | `dfe475d78d628b0dd2307be9cc321826a1fa5377` | `60f69c8581330dd663a932da3cea56e8553046d3` |
  | [#111](https://github.com/JagPat/PMCvitan/pull/111) | Task 7: pillar-chain acceptance suite, upgrade proof, this packet (+3 product fixes the suite surfaced) | `60f69c8` | `4f53299e31fe82db11322d22283bcdb15220428e` | `95ad1daf60eb84e6c98855ff68904a7a25ae50bb` |
  | [#112](https://github.com/JagPat/PMCvitan/pull/112) | Gate round-1 finding 1 (P1): start serialized against every readiness write | `95ad1da` | `96a1746eadb2976935952dc3fd34867daacd2441` | `38efcd9028762569918ca7297d3e287779431fa6` |
  | [#113](https://github.com/JagPat/PMCvitan/pull/113) | Gate round-1 finding 2 (P1): IndexedDB-canonical offline evidence queue | `38efcd9` | `a932a07cfff363c3c45f55ffd4a57ca5d110cfde` | `7963b207460e706dece9ef3f5a648ddcb1e2360f` |
  | [#114](https://github.com/JagPat/PMCvitan/pull/114) | Gate round-1 finding 3 (P2): inspection items addressed by row id | `7963b20` | `ce360ae5c7ef55aef96e63c5f685999da1ab986b` | `3380f758a7c544b059ea34f023f34b619535b12d` |
  | [#115](https://github.com/JagPat/PMCvitan/pull/115) | Gate round-1 finding 4 (P2): packet records the reviewed artifact + remediation SHAs (docs only) | `3380f75` | `a585a5fb7edfab8449704a0ee81d436a6b0597d4` | `eb977898a7e7524f20884da844f6edccaad85ada` |
  | [#116](https://github.com/JagPat/PMCvitan/pull/116) | Gate round-2 finding 1 (P2): the material-mismatch writer joins the readiness lock | `eb97789` | `0bb3e15ef57ac4e9cbe4a3a935b7533374e69621` | `91d133fe3aa428a545fdd9492d7d6e74abd99553` |
  | [#117](https://github.com/JagPat/PMCvitan/pull/117) | Gate round-2 finding 2 (P2): scope-safe, ordered evidence reconciliation | `91d133f` | `7b47eac4e14516c5867e710b0798f6ac2dfc68ad` | `e2a3fd983c355f30310109c050c216e56b3003f9` |
  | [#118](https://github.com/JagPat/PMCvitan/pull/118) | Gate round-2 finding 3 (P2): online evidence refresh keeps marks by item ID | `e2a3fd9` | `f5c3eaf0edb15fefcc3eebbdf9bd6c161b5d2178` | `03f415a4be11815eab82033d8320450cbd8758a5` |
  | [#119](https://github.com/JagPat/PMCvitan/pull/119) | Test harness: the seed wipe order holds for a fully populated database (api-e2e re-runnable; no product code) | `03f415a` | `44b331a434d0b2ca6cddebbf5c4c7e07eb75e282` | `a0b256326c9d98f59ba2ff4c1afeb5c8d04cba18` |

## Vision Alignment

- User decisions improved: the **client's** approval is final until they re-approve — a reopened decision blocks dependent site work automatically and re-approval is one attributable act (Tasks 2, 6); the **PMC** issues drawings to a frozen, acknowledged distribution and signs off completed work explicitly — nothing becomes `done` on a contractor's say-so (Tasks 3, 5); the **engineer's** failed checklist item always carries photo evidence and returns as owned, dated corrective work in their Inbox (Task 4); the **site** starts an activity only when every readiness gate derives clean or a reasoned, expiring, evidenced override says otherwise (Task 6).
- Canonical fact owners: the `ChangeRequest` row owns a reopening (at most one open per decision, database-enforced); the governing `DrawingRevision` + its frozen `DrawingRecipient` rows own who must build from what; `Media` rows own evidence (containment-chained to project → inspection → item); the completion claim (`Activity.completionRequestedBy*`) and the linked closing `Inspection` own "who finished it and who accepted it"; derived readiness owns "can this start" (stored `gateInspection` is deprecated, no route writes it).
- Information flows protected: decision status → activity readiness (derived at read time, change ⇒ `wait`); governing revision + frozen recipients → drawing gate (worst-wins across every linked drawing); inspection chain tip → inspection gate (open corrective work fails the gate); closing-inspection approval → `done` + `doneAt` (the only writer); offline capture → durable IndexedDB queue → exactly-once replay per project-scoped key (dead-letter with Retry/Delete on terminal non-dedupe failure).
- Human approvals preserved: the client (or the PMC `onBehalfOf`, recorded) approves and re-approves; the PMC decides inspections, grants overrides and performs sign-off — every one an attributed act (actorId + actorName + actorRole); no evidence upload, backfill or migration transitions any approval state.
- Trust invariant: one project's records never leak — every new table/edge (`DrawingRecipient`, evidence chain, completion claim, `GateOverride`) is composite-FK tenant- and containment-constrained, proven by raw-SQL forgery probes and the browser-level isolation re-proof.

## Schema and Migration Evidence

- Migrations (Phase 1, ledger order — sha256 of each `migration.sql`):
  - `20260910000000_phase1_change_control` — `ebd2a938ad3830d48f21b5d191db843d1475e69248f3cd52b11e94338bd12666`
  - `20260915000000_phase1_drawing_control` — `543d27e642a5530d64edb2973e756ef1a3f8e05c5c633f3fd63fdf24f6bb842d`
  - `20260920000000_phase1_change_control_diagnostic` — `f8694e818aa861dc153157d53cb37842437d036fbdabb807445ca3c829f982f8`
  - `20260925000000_phase1_drawing_governing` — `050f1acd0072494289acdfd247fbf7e4510745621725e4209a7cef641088e589`
  - `20260930000000_phase1_inspection_evidence` — `237c40f430e5170c2b7dc0528484906fa0ce54a7dd942a3363e31f8d6c80a98f`
  - `20261005000000_phase1_closing_signoff` — `4baa33bc8ca226b3a84114f9e714ed47b82216f3a8925a9b6502628edd5b8c1b`
  - `20261010000000_phase1_derived_readiness` — `9a5eb1861aaf3df171dde472e58ef6dd90b37775b78971b57ab7096ed45b1b97`
  (Slot renumbering vs the plan — Task 4 → `20260930`, Task 5 → `20261005`, Task 6 → `20261010` — was instructed by the gate re-review after the remediation migrations took `20260920`/`20260925`; recorded per task in `docs/ROADMAP.md`.)
- Fresh-database result: `prisma migrate deploy` onto empty `pmcvitan_e2e` — all **28** migrations applied (`0_init` through `20261010000000_phase1_derived_readiness`), exit 0 (2026-07-13, inside `pnpm test:e2e:api`; the same runs green in CI's `api` and `api-e2e` jobs).
- **Upgraded-database result** (Task 7 Step 2): `apps/api/scripts/upgrade-proof.sh` (new CI job `upgrade-proof`) rebuilds a database from the 21 pre-Phase-1 migrations, plants the legacy fixture (a reopened decision with a `pending` change request + a stale `pending` request on an approved decision; drawing revisions without `projectId` across two projects, one already `for_construction`; a counter-only checklist item with `photos=3` and no Media; a `done` activity with its zero-item `INSP-ACT-1-close` closing; a stray `INSP-GHOST-close` naming no activity; a stored `gateInspection='fail'`), applies all 7 Phase 1 migrations Prisma-style (one transaction each, stop on error) and asserts **17/17** legacy-meaning checks — exit 0 (2026-07-13, local PostgreSQL 16; the job runs on every push). Diagnostics emitted during the run, verbatim:

  ```text
  psql:.../20260930000000_phase1_inspection_evidence/migration.sql:42: NOTICE:
    phase1_inspection_evidence: 1 legacy INSP-*-close id(s) match no activity (informational; Task 5 resolves)
  psql:.../20261005000000_phase1_closing_signoff/migration.sql:93: NOTICE:
    phase1_closing_signoff: 1 legacy closing inspection(s) marked+linked; 1 INSP-*-close id(s) match no
    activity and were left unmarked (they cannot govern any activity)
  ```

  Key assertions (all pass): the reopened decision's request became the ONE open request and the stale one closed as `resolved` with resolution NOT invented; decision statuses untouched; revision `projectId` backfilled from each revision's own parent and locked NOT NULL; `recipientsFrozenAt` stays NULL on legacy revisions and no recipient rows were invented; the one-open-request and one-construction-revision partial unique indexes exist; the counter-only item keeps `photos=3` with zero Media rows; the done activity stays `done`; the zero-item closing is `closing=true` linked to its activity and still item-less; the stray close-pattern id is left alone; `awaiting_signoff` exists in the enum with zero rows moved into it; the stored `gateInspection` flag is preserved verbatim; `GateOverride` exists with zero rows.
- STOP-condition proofs (ambiguous legacy data must ABORT, never guess) were shipped per task with each migration PR (#102, #103, #106, #107); the composite upgrade proof covers the representative happy path.
- Rollback boundary: application rollback = prior build + kept additive schema; invariant-bearing unique indexes are never auto-reverted; Task 5 documents the operator-reviewed forward migration required if rolled back after `awaiting_signoff` rows exist (`docs/DEPLOY.md`).

## Security and Tenancy Evidence

- Change control: double-open under concurrency is impossible (partial unique index + integration races in `change-control.test.ts`); re-approval without an open request 409s; a non-client cannot approve (permission matrix).
- Drawing control: two concurrent `for_construction` issues serialize on the parent row — one wins, one 409s (`drawing-lifecycle.test.ts` races + the DB backstop index); acknowledgements count only against the frozen set; recipients of a foreign project are rejected by composite FK (raw SQL).
- Evidence containment: raw-SQL forgeries — evidence naming another project's inspection, or an item outside its inspection, or an item with a NULL inspection (the MATCH SIMPLE escape) — are all rejected by the database (`inspection-evidence.test.ts`); upload idempotency is per project-scoped `clientKey`.
- Completion authority: membership is read `FOR UPDATE` and validated INSIDE the claim/decide transactions (Task 5 gate P1 remediation, reproduce-first probes in `closing-signoff.test.ts` — a mid-window removal or role change now yields 400 with NO claim, decision, child inspection, audit or notification side effects).
- Override authority: `GateOverride` is PMC-only (403 for others, route-policy pinned), reason required, expiry always future, evidence must be same-project (service 400 + raw-SQL probes in `derived-readiness.test.ts`).
- Browser-level isolation re-proof (Task 7): the seeded Ambli project's snapshot contains NO marker of the chain project (names, drawing number, checklist titles); a member of another project gets 401/403 on the chain snapshot (`pillar-chain.spec.ts › ISOLATION re-proof`).

## Verification

Fresh runs on the Task 7 working tree (2026-07-13, local; PostgreSQL 16):

- `pnpm check` — exit 0: web lint + typecheck + **218** unit tests (21 files) + build; api generate + typecheck + **372** unit tests (33 files) + build.
- `pnpm --filter api test:integration` — exit 0: **75/75** (12 files) against live PostgreSQL (`pmcvitan_test`), including the change-control/drawing/reinspection/claim races and the Task 5 P1 barrier probes.
- `pnpm --filter web test:e2e` — exit 0: **21/21** demo-mode Playwright scenarios.
- `pnpm test:e2e:api` — exit 0: **18/18** API-backed browser scenarios in 44s — `pillar-chain.spec.ts` (9: authored chain, attributed client approval, frozen-distribution acks, fail-with-photo → reject → Inbox, pass-with-evidence → accept → start → complete → sign-off → done, change loop, negatives, isolation re-proof, offline evidence incl. oversized-refusal and the 4xx dead-letter/Retry path) + `project-scope.spec.ts` (8) + `canonical-dates.spec.ts` (1).
- `bash apps/api/scripts/upgrade-proof.sh` — exit 0: **17/17** legacy-meaning assertions (see Schema evidence).
- 10× race-stability runs were executed and recorded per task in the PR bodies of #102, #103, #106, #107, #108 and #109 (concurrency suites stable across repetition).
- CI runs per revision (all four jobs — `web`, `e2e`, `api-e2e`, `api`; the new `upgrade-proof` job exists from PR #111 onward):

  | PR | Head CI | Merge CI |
  |---|---|---|
  | #97 | [`558e520` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29228025433) | [`104c0bd` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29228417428) |
  | #98 | [`79f7dc9` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29230146948) | [`f82e0f4` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29232489971) |
  | #99 | [`c757105` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29233646142) | [`5b101d6` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29234053729) |
  | #100 | [`3a47b69` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29235316476) | [`f0d5ad1` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29235903238) |
  | #101 | [`1262429` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29237675867) | [`1407900` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29237791464) |
  | #102 | [`88ed4ee` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29240476524) | [`14c397f` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29240569241) |
  | #103 | [`d29287b` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29242064820) | [`4a552e7` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29242224932) |
  | #104 | [`cfd3e95` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29246022804) | [`f126f37` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29246212776) |
  | #105 | [`c49a59c` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29246992348) | [`05dc1af` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29247111284) |
  | #106 | [`68d40f4` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29251124589) | [`1ceccf7` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29251638395) |
  | #107 | [`fdec520` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29254395678) | [`8d4aadb` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29260735904) |
  | #108 | [`4902966` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29262808412) | [`9d71868` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29265899141) |
  | #109 | [`3a18224` ✗](https://github.com/JagPat/PMCvitan/actions/runs/29269900470) | [`011f820` ✗](https://github.com/JagPat/PMCvitan/actions/runs/29270010436) |
  | #110 | [`dfe475d` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29270180744) | [`60f69c8` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29270861992) |
  | #111 | [`4f53299` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29274296167) | [`95ad1da` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29287146256) |
  | #112 | [`96a1746` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29289457262) | [`38efcd9` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29298920949) |
  | #113 | [`a932a07` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29299097852) | [`7963b20` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29299207348) |
  | #114 | [`ce360ae` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29299225140) | [`3380f75` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29299325637) |
  | #115 | [`a585a5f` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29299481639) | [`eb97789` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29299567427) |
  | #116 | [`0bb3e15` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29305220847) | [`91d133f` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29305721625) |
  | #117 | [`7b47eac` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29306172085) | [`e2a3fd9` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29306341706) |
  | #118 | [`f5c3eaf` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29306379220) | [`03f415a` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29306479544) |
  | #119 | [`44b331a` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29307103158) | [`a0b2563` ✓](https://github.com/JagPat/PMCvitan/actions/runs/29307205943) |

  **Honest note on #109:** its `api` job failed AFTER all 75 integration tests passed — the new readiness suite's teardown deleted `Media` before dependent `GateOverride` rows and tripped the containment FK (the very constraint Task 6 added). The failure was masked locally by verifying a piped `vitest … | tail` instead of the exit code. [PR #110](https://github.com/JagPat/PMCvitan/pull/110) fixed the teardown ordering the same day; head and merge are green, and no product code changed between `3a18224` and `dfe475d` besides that test file.

## Independent Reviews Within the Phase

- **Plan review** — the Phase 1 plan was corrected twice before implementation began ([review](https://github.com/JagPat/PMCvitan/pull/97#issuecomment-4955048088); correction PRs #98, #99). Implementation started only after clearance.
- **Task 1 stop** — cleared at merge `1407900` after the correction PR #101 (drawing-pillar characterization + a deterministic race barrier).
- **Task 3 stop (Tasks 2+3 reviewed together)** — 7 findings, remediated in PR #104 (change-control: diagnostic gap, actor role columns, audit attribution) and PR #105 (drawing lifecycle: governing-revision DB backstop, frozen-set semantics, revision tenancy, ack containment); re-review CLEARED.
- **Task 5 stop** — BLOCKED with one P1: membership eligibility was validated OUTSIDE the lifecycle transaction (TOCTOU) — a member removed or demoted mid-window could still claim completion or receive corrective work ([finding](https://github.com/JagPat/PMCvitan/pull/107#issuecomment-4959531194)). Remediated in PR #108: the membership row is read `FOR UPDATE` and validated FIRST inside both `complete()` and `decide()` transactions, with reproduce-first live-PostgreSQL race probes (red 201 at the pre-fix SHA → 400 with zero side effects after). [Gate cleared](https://github.com/JagPat/PMCvitan/pull/108#issuecomment-4960362431) on merged `main` @ `9d71868`.
- **Task 7 stop** — the phase-closing gate ran against merged `main` @ `95ad1da` (round 1 below); its four findings were remediated in PRs #112–#115.
- **Gate round 2 (narrow re-review)** — ran against merged `main` @ `eb97789` (the round-1 packet refresh) and returned **BLOCKED** with three new P2 findings (round 2 below); remediated in PRs #116–#118, and the next narrow re-review runs against the effective reviewed head above.

## Independent Review — Phase 1 gate round 1 (Codex) and Remediation

The gate reviewed `main` at `95ad1daf60eb84e6c98855ff68904a7a25ae50bb` (merge of PR #111) and returned **BLOCKED** with four findings (full verdict on [PR #111](https://github.com/JagPat/PMCvitan/pull/111#issuecomment-4963118843)); it independently verified all suites green at that head (web 218, api 372, integration 75, demo 21, api-browser 18, migrations 28, upgrade assertions 17, checksums matching). Every finding was remediated reproduce-first in a focused PR:

| Finding | Remediation | Reproduce-first proof |
|---|---|---|
| 1 (P1) — `start()` evaluated readiness OUTSIDE its write transaction and updated unconditionally: two simultaneous starts both returned 201 (both audited), and a gate flip landing between the evaluation and the commit was silently overrun | [PR #112](https://github.com/JagPat/PMCvitan/pull/112), head `96a1746`, merged `38efcd9`: ONE database-level protocol — a per-project `pg_advisory_xact_lock` (`src/common/readiness-lock.ts`). `start()` takes the lock, re-reads the activity, evaluates the five gates on the transaction client and CAS-commits + audits in the same transaction; every readiness-affecting write (decision approve/change/withdraw; drawing issue/publish/ack/delete; inspection create/submit/decide; membership activation/removal; override grant/revoke; the activity gate/linkage PATCH) takes the same lock first, uniformly ordered before all row locks | `test/integration/start-readiness-race.test.ts` — the reviewer's two probes red at `95ad1da` (double-start both 201; a PATCH and an override revoke both settled inside the held start window) → 4/4 green: `[201,409]` with exactly ONE audit; both write classes wait for start's commit; the committed-flip control shows 409 with zero side effects. 10× stable |
| 2 (P1) — evidence bytes committed to IndexedDB but the replay op lived only in localStorage; a swallowed `setItem` failure orphaned the photo permanently ("saved offline" shown, reload restores no op, Retry only surfaces FAILED rows) | [PR #113](https://github.com/JagPat/PMCvitan/pull/113), head `a932a07`, merged `7963b20`: IndexedDB is the CANONICAL evidence queue — `reconcileEvidence` merges every pending row back into the replay outbox idempotently per clientKey on every hydration (even with localStorage entirely unavailable); a failed dead-letter write rethrows transient so the flush KEEPS the only replay op | `tests/evidence.test.ts` — the reviewer's `Storage.setItem`-throws probe red (outbox `[]` after reload, row stranded pending) → green (op reconstructed, uploaded exactly once, cleaned up); the dead-letter-write-failure probe red (op dropped) → green (op retained, next flush dead-letters into FAILED + Retry); idempotence probe |
| 3 (P2) — submit/reject addressed items by non-unique NAMES: duplicate labels collapsed into one payload (a valid mixed-outcome submission 400'd; the exact evidenced row was not addressable; a foreign item id was silently accepted by name-match) | [PR #114](https://github.com/JagPat/PMCvitan/pull/114), head `ce360ae`, merged `3380f75`: the contracts speak in row ids — submit items carry a required `id` validated to belong to THIS inspection and written by `(id, inspectionId)`; `rejectedItemIds` replaces `rejectedItemNames` with the same containment refusal; the review DTO / shared types expose item ids and the web reject flow sends them | `test/integration/item-identity.test.ts` — the reviewer's duplicate-label mixed-outcome probe red (400) → green (201, per-row results, exactly the evidenced row rejected, ONE child with ONE item, passed twin untouched); foreign ids on submit AND reject → 400 with zero writes |
| 4 (P2) — this packet omitted PR #111's immutable base/head/merge SHAs and CI rows | [PR #115](https://github.com/JagPat/PMCvitan/pull/115), head `a585a5f`, merged `eb97789` (docs only): PR #111's row and CI runs recorded above, plus the remediation PRs' rows and this section | — |

Fresh full-battery runs after each remediation (recorded in each PR body): unit 372/372 · integration 79/79 → 81/81 (the new probe suites) on live PostgreSQL 16 · web 218/218 → 221/221 · `pnpm check` exit 0 · demo e2e 21/21 · api-e2e 18/18 · upgrade proof 17/17 · 10× stability on the new race suite.

## Independent Review — Phase 1 gate round 2 (Codex narrow re-review) and Remediation

The narrow re-review ran against `main` at `eb977898a7e7524f20884da844f6edccaad85ada` (merge of PR #115, the round-1 packet refresh) and returned **BLOCKED** with three new P2 findings (full verdict on [PR #115](https://github.com/JagPat/PMCvitan/pull/115#issuecomment-4964703113)). Every finding was remediated reproduce-first in a focused PR:

| Finding | Remediation | Reproduce-first proof |
|---|---|---|
| 1 (P2) — `flagMismatch` wrote readiness state (`gm='fail'` + blocked) OUTSIDE the round-1 readiness-lock protocol: a mismatch landing inside a held start window was silently overrun, so the start committed against gates it never evaluated | [PR #116](https://github.com/JagPat/PMCvitan/pull/116), head `0bb3e15`, merged `91d133f`: `flagMismatch` is ONE interactive transaction that takes `lockProjectReadiness` FIRST and re-reads the daily log, material and linked activities inside it; a source-scan coverage tripwire (`readiness-lock-coverage.test.ts`) now classifies EVERY service writer as `locked` or exempt-with-reason, so no future writer can drift out of the protocol unnoticed | `start-readiness-race.test.ts` — the reviewer's both-orderings probes on live PostgreSQL: a mismatch inside a held start window red at `eb97789` (settled without waiting) → green (it WAITS for start's commit; final state blocked + `gateMaterial` fail + exactly ONE start audit); the committed-first control (start 409s with zero side effects). 10× stable |
| 2 (P2) — `reconcileEvidence` applied a stale IndexedDB read across a project switch, a completed flush, or a dead-letter: another project's replay op could land in the current queue (in memory AND persisted), confirmed uploads were resurrected, and dead-lettered rows re-queued behind the user's Retry/Delete | [PR #117](https://github.com/JagPat/PMCvitan/pull/117), head `7b47eac`, merged `e2a3fd9`: a reconciliation captures its coordinates (epoch, user scope, project id, `(projectId, generation)` scope, outbox storage key) BEFORE the read and rejects the result unless every coordinate is still live; an epoch makes truth single-winner (every flush start / retry / delete / newer reconciliation invalidates in-flight reconciles); replay refuses non-`pending` rows; the evidence tests' fixed-tick waits became condition-based — the reviewer's 2-of-3 suite flake | `tests/evidence.test.ts` — three deterministic held-read probes (project switch mid-read; completed-flush resurrection; dead-letter re-queue + replay-refuses-non-pending) red at `eb97789` → green; the FULL web suite repeated 10× — 0 failures |
| 3 (P2) — the online evidence upload's snapshot refresh preserved the engineer's unsubmitted marks by item NAME: two rows sharing a label collapsed into one row's facts, silently corrupting a mixed-state checklist | [PR #118](https://github.com/JagPat/PMCvitan/pull/118), head `f5c3eaf`, merged `03f415a`: the preservation map is keyed by inspection-item ID (rows without a server id are skipped rather than guessed), completing the identity contract PR #114 established for submit/reject | `tests/evidence.test.ts` — the reviewer's duplicate-label mixed-state probe (two "Slope" rows, `pass`/"dry" vs `fail`/"ponding", evidence onto row 2) red at `eb97789` → green (each row keeps its OWN `state`+`note`) |

Fresh runs after the round (per-PR evidence in each PR body, plus a composite battery on `main` at `03f415a`'s tree): `pnpm check` exit 0 · integration 83/83 on live PostgreSQL 16 · the FULL web suite repeated 10× at the finding-2 head and 6× at the finding-3 head — 0 failures (the reviewer's flake reproducer) · demo e2e 21/21 · api-e2e 18/18 twice consecutively · upgrade proof exit 0 (all 17 assertions) · CI green on every head and merge (table above).

**Honest note on the composite battery:** re-running `pnpm test:e2e:api` against the same disposable database (rather than CI's always-fresh service) exposed a harness defect — the seed's wipe deleted `Membership` and `InspectionItem` before their NO ACTION children (frozen `DrawingRecipient` rows, assigned inspections, completion claims, evidence `Media`; `GateOverride` was never wiped at all), so a lived-in database failed the next seed. Fixed harness-only in [PR #119](https://github.com/JagPat/PMCvitan/pull/119) (same class as PR #110's teardown ordering): the wipe order now holds for a fully populated database, verified by a static check of every `@relation` in the schema plus two consecutive green 18/18 runs against the same database. No product code changed.

## Acceptance Criteria (spec §25 rows this phase covers)

| §25 row | Status | Evidence |
|---|---|---|
| readiness changes automatically from evidence | **Partial by design** — decision/inspection/drawing gates derive at read time from explicit links (truth tables, worst-wins aggregation, override precedence); material/team remain stored site flags until the material and workforce phases | `domain/transitions.ts` + pinned `packages/shared/src/domain/readiness.ts` (identical 26-row table tests both sides); `derived-readiness.test.ts` (8 integration scenarios); `pillar-chain.spec.ts` gates flip live in the browser |
| inspection rejection produces assignable corrective work and reinspection | **Done** | exactly one linked reinspection per rejection (partial unique), assigned + due-dated to an active eligible member validated in-tx; Inbox delivery proven in the browser (`pillar-chain.spec.ts › the ENGINEER fails an item…`) |
| completion requires closing sign-off | **Done** | `complete()` claims `awaiting_signoff` + linked closing inspection; ONLY closing approval writes `done`+`doneAt`; rejection reverts and routes corrective work to the recorded completer (`closing-signoff.test.ts`, 11 scenarios incl. concurrency and churn; browser proof in the chain test) |
| cross-project and cross-company access tests pass | **Cross-project: done** (raw-SQL forgery probes on every new edge; browser isolation re-proof; membership revocation) — cross-company portals remain out of Phase 1 scope | `tenant-constraints`/`inspection-evidence`/`derived-readiness` integration probes; `pillar-chain.spec.ts › ISOLATION re-proof`; `project-scope.spec.ts` |

The remaining §25 rows (material ledger, resource requirements, receipts/stock, shortage forecasting, dashboard counts, weekly drafts, commercial traceability) belong to later phases per the roadmap.

## Product Defects Surfaced by the Acceptance Suite (fixed in PR #111)

Writing the browser-level chain surfaced three real defects unit and integration layers had missed — the suite doing its job:

1. **Submit guard counted only the deprecated `photos` counter** — an online evidence upload (which the server records as linked `Media`, never incrementing the counter) could not enable checklist submission. The guard now accepts linked evidence (`store.ts submitInspection`).
2. **A snapshot refresh mid-capture wiped unsubmitted field marks** — the successful-upload refresh replaced the checklist and discarded the engineer's not-yet-submitted pass/fail/note marks. Marks are re-applied across `applySnapshot` (`store.ts addChecklistEvidence`) — PR #111 keyed the preservation by item name; gate round-2 finding 3 corrected the key to the inspection-item ID (PR #118).
3. **Re-issuing a revision of an existing drawing silently unlinked it** — an issue that omitted `activityId`/`decisionId`/`nodeId` overwrote the drawing's recorded linkage with NULL, flipping readiness to `na` (a governed activity silently lost its drawing gate). An existing drawing now keeps its linkage unless the issue explicitly names one (`drawings.service.ts`).

## Known Residual Risks

| Risk | Owner | Follow-up |
|---|---|---|
| After a page reload, the persisted offline outbox replays on the next connectivity change or queued action — not automatically at boot. Bytes are durable in IndexedDB throughout (nothing is lost or falsely reported saved); the acceptance test exercises the real trigger. | PMCvitan maintainer | Add a flush-on-boot (post-auth) pass in a later housekeeping change |
| `Activity.gateInspection` is deprecated but still present; no route writes it and the read path ignores it. Stored-vs-derived deltas are enumerable via `apps/api/scripts/readiness-delta-report.ts` (all fixture delta classes explainable). | PMCvitan maintainer | Operator-reviewed forward migration to drop the column after a bake period |
| 10× race-stability evidence is recorded per task in PR bodies, not re-executed on every CI push (CI runs each race once). | PMCvitan maintainer | Consider a scheduled stability job if flakes appear |
| The upgrade-proof CI job covers the representative happy path; STOP-condition (abort-on-ambiguity) proofs live in the per-task PR evidence and are not re-executed in CI. | PMCvitan maintainer | Fold STOP scenarios into the script if migrations are ever edited |
| Phase 0 residual risks stand: memory-only web session token (refresh returns to sign-in; deep links survive), demo/seed credentials are dev/test-only, `start:dev` uses the compiled build. | PMCvitan maintainer | Unchanged from the Phase 0 packet |
