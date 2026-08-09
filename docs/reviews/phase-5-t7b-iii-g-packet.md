# Phase 5 Task 7B-iii-g — the §I authorisation surface, client half

## What this unit is

The APPROVER's own act, on the surface that reports the refusal. Before this, a certifier who had
recorded the evidence under a claim got an accurate §I refusal naming `commercial.sod.grant` — and
no way to reach it. The remedy is now where the problem is stated.

The server half (7B-iii-h, PR #312) is merged and independently cleared, so every fact this surface
pins already EXISTS rather than needing to be invented here.

## Review unit

- **Base SHA:** `f4f2a6e`
- **Changed files / changed lines:** 7 / ~380 — **within both budgets**, no split
- **Schema:** none. No migration, no API change. Client surface over already-cleared facts.

### Scoping, measured before any code

The parked branch `claude/phase5-task7b-iii-f-sod-parked` @ `33b6e68` is 12 files / 341 lines, and
most of it is already gone. Checked file by file against `main` rather than assumed:

| Parked file | Status on `main` |
|---|---|
| `commercial-certification.service.ts`, `contracts.ts`, both integration suites | **SUPERSEDED** by 7B-iii-h |
| `billLifecycle.ts` (`source` field) | **ALREADY SHIPPED** |
| gateway · store · screen · two web suites | **still owed — this unit** |

**The parked code is a reference, never a merge source**, and that is not caution: it predates the
round-5 split AND the round-6 boundary change, so its grant form pins `versionId` + `status` and
knows nothing of `lifecycleVersion` (invented in #312 round 2), while its certify dispatch carries
no revision at all. Merging it would have re-introduced two closed findings.

## The four rules, settled before writing

**1. Who may be picked — and the trap avoided.** There is NO server enumeration of "members with
certify standing": `hasProjectRoleStanding` is a predicate, not a list. Adding one was the obvious
move and is the wrong one — it would be a SECOND implementation of the standing question, which is
root A of this unit's own audit, and it would break the seam the 7B-iii-h/g split was made on.

So the picker **narrows** and the server **decides**: it offers active `pmc` members from the team
roster the client already holds, excludes the caller (`callerActorId` is in `CertifyPreflightDto`
precisely so a self-grant — the one choice §I is certain to refuse — is not queued and reported
saved), and standing is re-checked at the command because a picker is not the only way in.

**2. What the form pins.** All three facts, from the ONE authoritative claim reading, never
re-derived per field: `versionId`, the `status` that version is in, and `lifecycleVersion`.

**3. R5-1 — the finding this unit exists to close.** See below.

**4. What the certifier sees.** The §I state card already names the remedy; the form is now beneath
it, so the loop closes on one surface.

## R5-1 — an authorisation is independent of other GRANTS, not of the CLAIM

The per-PERSON coalesce key was right and stays: two approvers authorising two different actors on
one claim are independent facts, and coalescing them would report both saved and write one.

What was carried one step too far is concluding that a grant therefore conflicts with **nothing**.
An authorisation is not a free-standing note — it PINS the claim's version, status and revision, and
the server refuses it if any has moved. A queued transition is precisely a command that moves them.
Queued behind a pending certify, the grant is written against facts that are already gone, and the
user was told it was saved.

The fix is in `commercialWriteBlocked` — the same function the store refuses with and the screen
disables from, so the two cannot answer differently. It is **one-directional by design**: a pending
grant does not block a transition, because a certify arriving before its authorisation is refused by
the server for a reason that is true and legible ("no authorisation stands"), not silently
mis-pinned.

## Evidence

| Probe | What it holds |
|---|---|
| `a pending claim transition BLOCKS a new authorisation` | the rule AND the dispatcher; **mutation-checked** — deleting the grant clause from `commercialWriteBlocked` turns it red (`expected false to be true`), so it is load-bearing on this fix and not on a neighbour |
| `two authorisations for DIFFERENT people are independent` | the per-person key survives the fix; an equivalent one while pending still coalesces |
| `a pending authorisation does NOT block a claim transition` | the one-directionality is asserted, not assumed |
| `carries the three facts its approver was looking at` | version + status + revision reach the outbox |
| `a role without the granting authority queues NOTHING` | the durable dispatcher refuses, bypassing the screen (Codex J1) |
| `the op type joins the ONE registry` | hydration, pending rebuild and flush reconcile cover it without a second list |
| `offers other active pmc members and never the caller` | self-grant excluded; engineers and removed members excluded |
| `says so plainly when there is nobody with standing` | an empty picker explains itself |
| `will not authorise without both a person and a stated reason` | whitespace is not a reason |
| `blocks authorising while a change is in flight, and says why` | R5-1 in the screen, with the reason legible |
| `is absent entirely for a role without the granting authority` | the form is not merely disabled |

## Also in this PR

`docs/RUNBOOK.md §P5T7BH` completeness, held deliberately during #312's gate rather than pushed as
a doc-only commit mid-promotion. Nothing there was false; two sentences were incomplete about
behaviour #312 changed — the revision counter's guarantee list omitted "opened with the claim" and
"cannot be born below zero", and nothing told an operator that retiring an EVIDENCED grant is
refused by design. An operator meeting that refusal without the note would read it as a bug.

## Invariant matrix

| Invariant | Risk in this change | Reproduce-first / verification evidence |
| --- | --- | --- |
| authorization-tenancy | a picker that enumerated authority would be a second implementation of standing; a form reachable by a role without the granting permission would queue an op the server refuses after reporting it saved | the picker narrows and the server decides (rule 1); `COMMERCIAL_OP_PERMISSION` maps the op to `commercial.sod.grant` so the DURABLE dispatcher refuses; probes for the role-absent form and the role-refused dispatch |
| civil-time-lifecycle | a grant pinned to facts a queued transition is about to move is refused when it lands, after being reported saved | R5-1 closed in `commercialWriteBlocked`, mutation-checked; the form pins version + status + revision from one reading |
| concurrency-idempotency | coalescing two approvers' grants onto the claim would drop one; a fresh key per deliberate action, reused on replay | per-person coalesce key with an independence probe; op joins the one registry so hydration/flush cover it |
| data-integrity-conservation | no schema, no migration, no server change — the facts are 7B-iii-h's, already cleared | stated rather than implied; `git diff` touches no `apps/api/src` or `prisma` |
| offline-reconciliation | an authorisation queued offline must carry what its approver saw, not what is true at flush | the three pins travel in the op payload, asserted directly |
| ui-server-parity | the screen disabling and the dispatcher refusing must not disagree | both call `commercialWriteBlocked` — one function, asserted from both sides |

## Verification

- [x] R5-1's probe reproduced RED by mutation (the fix removed) before being relied on.
- [x] `pnpm check` EXIT 0.
- [x] No schema, migration, or API change — client surface only.

---

## Correction round 1 — six findings, and one of them says the design rule was wrong

| # | Finding | Fix |
|---|---|---|
| F1 (P1) | the client posted `/commercial/sod/grant`; the server exposes `commercial/bills/sod-grant`. Every authorisation would 404, and the outbox treats non-401/408/429 4xx as terminal — so it was discarded **after** telling the user it saved | the real route, plus a source tripwire pinning the client path against the controller's own `@Post` decorator, because a restated constant is what drifted |
| F2 (P2) | no read released `com:sodgrant:` — the op settled, the read landed, and the button stayed disabled until a hydration or scope change | released by the **claim** read, scoped to that bill: the grant's effect is visible in `certifyPreflight`, and nothing about the list row moves |
| F3 (P2) | the picker read `members`, which only `TeamScreen` ever loads — a PMC opening Commercial directly saw "nobody else" | **subsumed by F6**: the candidates now arrive on the claim read the screen already loads, so there is no roster dependency to satisfy |
| F4 (P2) | pinned `status`/`lifecycleVersion` from `claim.bill` while the Certify control beside it arbitrated list-vs-bundle | the same `arbitrateBillCopy` reading, and the form is offered only where that reading is authoritative |
| F5 (P2) | offered on draft/submitted/under-verification, where certification is not legal — the grant becomes `stale-review` the moment the claim reaches the state it was meant for | gated on `BILL_CERTIFY_FROM`, with an explicit reason rather than a silently dead control |
| F6 (P2) | the picker filtered the roster by `role === 'pmc'`, excluding org owners/admins whom the standing rule admits as pmc where they hold no active membership | the candidates are computed **server-side, beside the predicate**, and the caller is removed there |

### F6 is the one worth reading

This unit's stated rule was *"the picker narrows; the server decides — don't build a second
implementation of standing."* I then built one: `role === 'pmc' && status === 'active'` **is** an
implementation of the standing rule, and a wrong one, because the real rule has a second arm (an org
owner/admin with no active membership on the project counts as pmc) and a precedence clause (an
active membership decides, and is never upgraded through the org).

What I got wrong was the location, not the principle. A server-computed candidate list is not a
second implementation — it is the *same* implementation, if it lives beside the predicate and
mirrors its arms. So `OrgsParticipant.projectRoleCandidates` sits next to
`hasProjectRoleStanding` in the module that owns `Membership`, `Project` and `OrgMembership`, and
the claim read publishes its answer.

This makes the unit touch the server, which breaks the "client-only" seam the 7B-iii-h/g split was
made on. That is the right trade and is stated rather than defended: the seam was a scoping
heuristic, and a picker that cannot name a legitimate approver is a broken feature.

`h13` proves both disagreements between a roster filter and the rule: an org owner with no
membership **is** a candidate; the same person given an `engineer` membership here **is not**
(precedence); promoted to `pmc` here they are again (membership arm).

**Gates:** `pnpm check` EXIT 0 — web 700/700, API 781/781; live-PG `phase5-t7bii-claim-read` 24/24
and `phase5-t5b-certification` 48/48.
