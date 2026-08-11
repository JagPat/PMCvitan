# PR #324 — convergence audit (Phase 6 architecture plan)

Eight finding-bearing heads, forty findings, on a docs-only plan — and the count did not fall:
**5 · 4 · 5 · 5 · 6.** The review lifecycle reached its limit on head `3f7e35d` and recommended
splitting the unit. **It is right, and this audit's conclusion is that the unit was never one unit.**

The evidence is in the distribution, not the total. §A (identity) drew ONE finding across five
rounds and has been stable since round 1. §B/§C/§D (authority) drew almost all the rest, and seven
findings across rounds 3–5 are damage from the correction immediately before them — a fix in one of
those sections repeatedly creating the next round's finding in another. That is the signature of two
concerns sharing one review, not of a careless document.

| # | Head | Finding | Root |
|---|---|---|---|
| 1 | `e222981` | derive the closed set through the permission mapping, not `ROLE_POLICY` | **A — built on `ROLE_POLICY`** |
| 2 | `e222981` | commit the §A/§C/§E decisions before handoff | scope of a plan stop |
| 3 | `e222981` | do not advance while Phase 5 remains open (STATUS) | **C — folded STATUS** |
| 4 | `e222981` | use the closed set as a deny list, not an intersection | **A — built on `ROLE_POLICY`** |
| 5 | `e222981` | keep canonical parties out of procurement ownership | layering |
| 6 | `f9a4125` | land the plan in the merged handoff shape (STATUS) | **C — folded STATUS** |
| 7 | `f9a4125` | include READ routes in the default-deny surface | **B — class named, not carried** |
| 8 | `f9a4125` | define how scoped evidence upload is allowed | **B — class named, not carried** |
| 9 | `f9a4125` | do not widen shared permissions for scoped routes | **A — built on `ROLE_POLICY`** |
| 10 | `c431904` | include SERVICE backstops in the `ROLE_POLICY` replacement | **A — built on `ROLE_POLICY`** |
| 11 | `c431904` | keep identity/session routes out of the collaborator complement | **D — created by fix 7** |
| 12 | `c431904` | do not make 6.3 prove every future scope | **D — created by the round-2 tripwire** |
| 13 | `c431904` | refuse grantless bindings, not merely unbound ones | **D — created by the round-2 activation fix** |
| 14 | `c431904` | do not expose the flag before the cutover guard | staging |
| 15 | `5a92ed2` | keep off-state staging possible | **D — created by fix 13** |
| 16 | `5a92ed2` | apply the cutover guard to later memberships | **E — the cutover cluster** |
| 17 | `5a92ed2` | refuse grants that cover no allow-listed route | **E — the cutover cluster** |
| 18 | `5a92ed2` | classify portfolio reads before exempting identity routes | **B — enumeration, again** |
| 19 | `5a92ed2` | defer to the task that can RUN the probes | the deferral itself |
| 20 | `3f7e35d` | filter portfolio COUNTERS by grant, not just the project row | **F — probe ledger** |
| 21 | `3f7e35d` | cover grant mutation/revocation in P3, not only membership | **E — the cutover cluster** |
| 22 | `3f7e35d` | put the deferred probes in the PLAN, not only the audit | **F — probe ledger** |
| 23 | `3f7e35d` | keep evidence uploads possible before the citing fact exists | **D — created by fix 8** |
| 24 | `3f7e35d` | bind labour rows to a party, or the `labour` scope cannot resolve | §C vs the data model |
| 25 | `3f7e35d` | reserve the capability NAME before 6.3 | **finding 14, not actually fixed** |
| 26 | `db2c64d` | pin the party links to the SAME ORG | §A tenancy |
| 27 | `db2c64d` | assign parties on FUTURE vendor/company writes | §A completeness |
| 28 | `db2c64d` | keep the runner from re-entering planning | **G — two gate rules in conflict** |
| 29 | `f208076` | put the deferred probes in an ACTUAL plan | **H — the split line was wrong** |
| 30 | `f208076` | move grants behind the boundary vocabulary | **H — the split line was wrong** |
| 31 | `f208076` | scrub/abort on stale `collaboration` capability rows | finding 25, only half done |
| 32 | `f208076` | schedule the party reconciliation command before grants | §A gap |
| 33 | `f208076` | guard `ProjectCompany` association removal | §A gap |
| 34 | `f208076` | declare the procurement → orgs creation edge | created by fix 27 |
| 35 | `5ca3719` | say the boundary plan blocks **6.2** in every gate, not just the table | inconsistent restatement |
| 36 | `5ca3719` | keep the deferral ledger identical to the plan's probes | **one fact in two places** |
| 37 | `5ca3719` | put the delete guard in the unit whose tables it checks | created by fix 33 |
| 38 | `5ca3719` | repoint or REFUSE authority rows during a party merge | created by fix 32 |
| 39 | `5ca3719` | serialize opposite-direction party merges | created by fix 32 |
| 40 | `5ca3719` | bind `ProjectCompany.orgId` back to `Project` | created by fix 26 |

Two more were **self-caught between heads** and are listed because a correction that only counts the
findings someone else made is measuring the reviewer, not the work: the vacuous-conjunct-2 gap
(fixed on `f9a4125` before review) and the capability activation trap (§L's shape, found while
scouting `capabilities.service.ts` during the gate wait, folded into this head).

## Root A — I kept adjusting the rule's relationship to `ROLE_POLICY` instead of removing it

Findings 1, 4 and 9 are all the same mistake at increasing depth, and each correction moved one
level without reaching the bottom:

- **Round 0** derived the closed set *from* `ROLE_POLICY`. Finding 1: it is keyed by permission, not
  command, and 33 of 167 mutating routes carry no permission at all.
- **Round 0** also wrote the allow rule as `ROLE_POLICY ∩ closed set`. Finding 4: the forbidden set
  was inside the allow calculation, so the one command an accidental policy edit made reachable is
  exactly the one that survives.
- **Round 1** fixed both by deriving over routes and making the rule default-deny — but left
  conjunct 2 reading `ROLE_POLICY[route.permission]`. Finding 9: satisfying that for one
  party-scoped route means adding `contractor` to a shared permission like `procurement.read`,
  which widens **every** route behind it — and `ROLE_POLICY` is global while the capability is
  per-project, so capability-OFF projects silently gain reads that are refused today.

Round 1 even *measured* the thing that should have ended it. It counted the 33 permission-less
routes, concluded "a `ROLE_POLICY`-only derivation is blind to a fifth of the surface", and then
kept `ROLE_POLICY` as conjunct 2 anyway — adding a rule ("only a `@RolesFor` route may be
allow-listed") whose only purpose was to make the surviving dependency tenable. That rule *is*
finding 9: it forced the widening.

**What replaces it.** A separate `COLLABORATOR_ROUTE_POLICY` mapping route → `{scope, roles}`, which
**replaces** the `ROLE_POLICY` decision for a collaborator principal rather than adding to it.
`ROLE_POLICY` is never widened and never consulted for one, pinned by a tripwire asserting no
`ROLE_POLICY` entry gains a collaborator role. That single change closes findings 1, 4 and 9, closes
the self-caught conjunct-2 gap (the map is total over the allow-list by construction), and makes the
allow-list able to cover the `@AllowAnyRole` routes it previously had to exclude.

> **When three successive findings are all about how your rule relates to an existing artefact, the
> finding is the dependency, not the relation.** The question round 0 never asked was not "how
> should this read `ROLE_POLICY`" but "should `ROLE_POLICY` be in this rule at all". It should not:
> it is the *internal* authority map, and the whole phase is about not widening internal authority.
> The answer was in the section heading the entire time.

Worth noting what "replaces, not adds" buys, because it is the difference between a boundary and a
decoration: an AND with `ROLE_POLICY` cannot narrow anything a collaborator can already do — a
contractor already passes `project.read` — so the phase would have closed money writes while leaving
the project snapshot reachable. Which is finding 7.

### Round 3 — root A a fourth time, one layer below where I stopped looking

Finding 10 is the same root at the layer I never checked. Round 2 removed the `ROLE_POLICY`
dependency from the ROUTE guard and wrote a confident paragraph about it. It did not ask **who else
reads `ROLE_POLICY`**. The answer, measured: **20 non-controller files, roughly 48 call sites**,
including `procurement.service.ts:458` and `purchase-orders.service.ts:747` on `procurement.read` —
exactly the paths §C's `procurement` scope needs. An allow-listed collaborator would have passed the
new resolver and been rejected by the service; and the obvious repair, widening `ROLE_POLICY`,
recreates the capability-off defect round 2 existed to remove.

So the round-2 correction was not wrong, it was **partial** — and it read as complete because it had
a measurement attached. The measurement covered routes. Nobody asked what it did not cover.

> Root A restated with what round 3 adds: **removing a dependency at the layer where you found it is
> not removing the dependency.** The search that pays is for every *reader* of the artefact, not
> every *use* of it in the layer under discussion.

This is also practice 6 (enumerate the complement) failing on its own first outing — practice 6 was
added in round 2, and round 2's own correction is what finding 10 caught.

## Root D — the round-2 correction generated three of round 3's five findings

Findings 11, 12 and 13 are each a defect in something round 2 added, and the shape is identical in
all three: **a rule stated at the strength that fixes the finding, without asking what else it now
catches.**

| Round-2 addition | What it fixed | What it broke |
|---|---|---|
| complement over **all** routes (fix 7) | reads were outside the boundary | `GET me/memberships` and `POST auth/switch` fell in — a collaborator could not list or switch projects. Not a narrowing, a lockout (11) |
| tripwire "every §C scope has a map entry" | a scope that grants nothing is a dead word | at 6.3 **no** scope has routes, so it either fails outright or forces nine premature entries — each one reachable before its own 6.4 review stop (12) |
| enablement refuses while a membership is **unbound** | the §L activation cutoff | a membership bound to a party with no grant passes the check and is cut off anyway (13) |

Each is over-strength in the same direction: I wrote the rule against the case in front of me and
did not test it against the cases beside it. The fixes are correspondingly narrow — the complement
is over *project-scoped* routes with an enumerated identity exception; the scope-completeness check
moves from 6.3 to *phase exit*; the cutover requires party **and** live grant.

Finding 14 is not root D but is adjacent: staging put the `collaboration` capability in 6.1 and its
enablement guard in 6.3, and `capability:enable` upserts any name — so between those units an
operator could switch it on with no refusal to stop them. The capability moves into 6.3, with its
guard, as one unit.

### Round 4 — the deferral head drew five more, and one of them was the deferral

**15** is the flattest of the nineteen: §B said capability-off means "no collaborator table carries a
row", while the cutover four paragraphs later requires parties, bindings and grants to exist *before*
the flag is turned on. Two sentences written in different rounds, contradicting each other, forbidding
the staging that makes the cutover safe. Nobody re-read them together — including me, twice.

**18** is root B on the very list that was written to fix root B. Round 3 replaced a vague
"identity/session routes" gesture with an enumeration and called it "closed rather than open-ended".
It was assembled from `auth.controller.ts` plus `me/memberships`, and missed `GET me/portfolio` —
project-wide activity, review and pending-decision counts across every active membership. That route
is precisely the case the list existed to reason about. **An enumeration I write is not a closed set
just because I call it one**, which is the same sentence as rule 1, now paid for a fourth time. It is
replaced by a four-class RULE plus a totality probe: classification is checkable, my lists are not.

**19** is a defect in the deferral I had just added. It named `phase-6-task-1` — I chose the
*contiguous* next stop over the stop that can *settle* the questions, and four of the five probes are
scheduled in 6.3. A handoff to a review stop that cannot adjudicate the thing handed to it is not a
handoff. Retargeted to `phase-6-task-3`; P5 lands earlier in 6.1, which is fine — settled sooner is
not a problem, settled never is.

## Root E — one cluster that prose has now failed to settle three times

Findings 13, 16 and 17 are the same question — *what does enablement mean on a project that already
has collaborators?* — and each round's answer was correct and incomplete in a new way:

| Round | Predicate | What the next round found |
|---|---|---|
| 2 | refuse while a membership is **unbound** | a membership bound to a party with no grant passes, and is cut off (13) |
| 3 | refuse unless **party AND live grant** | guards only the flip; the next membership created or re-roled is unguarded (16) |
| 3 | (same) | a grant covering no allow-listed route passes, and with an empty map at 6.3 that is *every* grant (17) |

Three predicates, three rounds, three correct refutations. The pattern is not carelessness in any
one of them — each is a reasonable reading of the requirement — it is that **the requirement is an
outcome and I kept encoding it as a test.** A test can be spelled correctly and still measure the
wrong thing, and the only way to know is to run it.

So round 4 stops writing predicates for it. §B now states the INVARIANT — *no active collaborator
membership is ever left with zero reachable routes, at enablement or afterwards* — and hands the
enforcing predicate to `P3` in 6.3, where it can be executed against a running resolver. That is what
the deferral mechanism is for, applied to the one cluster that has earned it.

It also forced out a fact worth having early: with an empty route map at 6.3, the invariant cannot be
satisfied for anyone, so **`collaboration` ships un-enablable until the first 6.4 surface exists.**

## Round 5 — and the decision to split

Six findings, and the shape of them is why this audit stops recommending another prose round:

- **25** is finding 14 again. Round 3 "fixed" the flag-before-guard window by moving the capability
  from 6.1 to 6.3 — but `capability:enable` upserts **any** string, so an operator can create
  `ProjectCapability(p, 'collaboration')` today regardless of which unit declares the constant. I
  fixed where the name is *declared* and not where it can be *created*. The real fix is a
  reservation: **6.1 makes `capability:enable` refuse the name**, and 6.3 replaces the refusal with
  the enablement rule. That fix lives in this document because it is a staging decision about 6.1.
- **21** extends the cutover cluster to a fifth operation (grant revocation/narrowing) — the same
  root E that three prose predicates already failed to settle.
- **20** and **22** are defects in the probe ledger I wrote one round earlier: P2 checked project
  inclusion but not the counters inside the row, and P1/P4/P5 existed only in this audit while
  implementation units read the *plan*.
- **23** is fix 8 rebounding: making an uncited upload inexpressible removed the only legal sequence,
  since `recordAttendanceSchema` takes an `evidenceMediaId` that must already exist.
- **24** is the deepest and is not a correction defect at all: §C promises party-scoped `labour`
  access, but `Worker`/`LabourAttendance`/`LabourWorkFact` carry no party owner and §A only adds
  party references to `Vendor`/`ProjectCompany`, so conjunct 3 has nothing to evaluate.

**Findings 20–24 all live in §B/§C/§D. Finding 25 lives in staging.** That distribution is the split
argument in one line: the boundary material keeps generating findings while the identity material
sits still.

### What the split is, and what it is NOT

`docs/superpowers/plans/2026-08-11-phase-6-external-collaboration.md` is reduced to the FOUNDATION —
§A canonical party, §E promotion seam, §F tenancy, and units 6.1/6.2 — plus finding 25's capability
reservation, which is a 6.1 staging decision. §B/§C/§D become a **separate boundary plan with its own
review stop, which 6.3 is blocked on.** Findings 20–24 travel with that material and are answered
there.

**This is not the PR #318 round-8 mistake repeated.** That was a *replacement* PR for the same
content, opened to dodge a deferral obligation, and it reset the finding-head counter for nothing.
The difference here is measurable: this splits one unit into two smaller ones along a seam the
findings themselves marked, at the explicit recommendation of the review lifecycle, and **the finding
history travels** — this audit stays in the reduced PR, keeps all twenty-five findings, and the
boundary plan cites it rather than starting from zero. Nothing is dismissed; five findings change
which document answers them.

> **When corrections in section X keep breaking section Y, the finding is not in X or Y. It is that
> X and Y are one review unit and should not be.** Five rounds is a long time to take to notice
> something the diff shape said at round 2: §B/§C/§D were 284 of 544 lines and carried nearly every
> finding.

## Round 6 — the split worked, and the last finding is a rule conflict

**Three findings, down from six.** First fall in the trajectory (5 · 4 · 5 · 5 · 6 · **3**), and the
composition changed too: 26 and 27 are ordinary §A gaps found on their merits, not damage from the
previous correction. That is what the split was for.

- **26** — `Vendor.partyId` and `ProjectCompany.partyId` had to be SAME-ORG composite FKs. A
  globally-valid reference lets org B's party own org A's rows, and §F's cross-tenant proof would
  fail on a shape PostgreSQL still accepted. Now the containment pattern every prior phase used
  (Phase 4's same-project FKs on worker/device/crew, Phase 3's on vendor/requisition lines) applied
  one level up at the org.
- **27** — 6.1 backfilled existing rows and left the CREATE paths minting party-less firms until the
  boundary shipped. Practice 6 again, in miniature: I enumerated the rows that exist and not the ones
  that arrive next. Fixed by updating both create paths and making `partyId` NOT NULL after backfill,
  so "a firm with no canonical identity" stops being representable.

## Root G — two gate rules that cannot both be satisfied in one diff

Finding **28** is not a defect in the plan. It is a conflict between two rules that are each correct:

| Rule | Requires |
|---|---|
| `PLAN_REVIEW_ROUND_CAP` (3 finding heads, docs-only) | the head carries `Review-Deferred-To-Probes` |
| `assessConvergence`'s phase check | a deferral head's diff does **not** touch `docs/STATUS.md` |
| the handoff (`AGENTS.md`) | the merged commit's STATUS resolves past the work item it completes |

Satisfying the first two forces STATUS out of the PR; satisfying the third needs it in. Round 5
resolved this with a prose promise to land STATUS afterwards, and finding 28 is the correct
refutation: after #324 merges with STATUS unchanged, `assessRunnerState` reads
`next_task:phase-6-planning` and the loop **re-enters the planning item it just finished**. A promise
is not a state transition.

The resolution is the one the refusal text and finding 28 both name — a **pre-existing** status-only
handoff. **PR #325 is open before #324 merges**, carrying findings 3 and 6 with the same
mutation-tested resolver evidence. The deferral stays admissible because #324's diff still does not
touch STATUS, and the handoff is machine-actionable because the transition exists as a real PR rather
than as an intention.

> **A process rule that says "do X afterwards" is not satisfied by writing "we will do X
> afterwards".** Where two gates conflict, the resolution has to be a third artefact that exists,
> not a sentence in the artefact that cannot carry it.

This also closes what process change #37 (fold STATUS into the work PR) left unstated: folding is
right for an ordinary work PR, and **wrong for any head that must carry a deferral trailer** — those
need the separate status PR the fold was meant to eliminate, opened before the work PR merges.

## Root H — the split was right and I drew the line in the wrong place

Round 7 returned six findings, and **29 and 30 are both the split itself, not the material.**

I moved §B (what a principal is) and §C (what a grant can name) into the boundary plan, and left
**6.2 — party bindings and GRANTS — in the foundation.** A grant row written against an unsettled
vocabulary can later have no route or scope meaning, and because the rows exist, 6.3 would have to
reinterpret or migrate them. Finding 30 is exactly right: *a grant cannot be stored before the
vocabulary that gives it meaning is settled.* The line now runs between IDENTITY (6.1) and
EVERYTHING THAT AUTHORISES (6.2+), which is where it should have been drawn.

Finding 29 is the same error in the other direction: the probe ledger went out with the boundary
material, into a document that does not exist yet, leaving the probes named only in this audit. **A
probe named only in a review packet is a probe nobody runs**, because implementation units read the
plan. The ledger now lives in the foundation plan as the handoff record, and the boundary plan will
carry it forward.

> **Splitting a unit is a design act, and the seam has to be drawn where the DEPENDENCIES are, not
> where the prose happens to divide.** §B/§C/§D read as one block of text, so I cut there; 6.2
> depended on them and stayed behind. The check I skipped: for each unit left behind, does anything
> it builds depend on what I just moved?

**31 is finding 25 half-fixed** — the reservation refused FUTURE `capability:enable` calls and did
nothing about a row an operator already created. The forward half without the backward half is the
same shape as root A's "removing a dependency at the layer where you found it". 6.1's migration now
ABORTS on a pre-existing row, naming the projects, and never deletes it.

**32, 33 and 34 are ordinary §A gaps**, each a consequence I owned and had not scheduled: two parties
for one firm with no command to reconcile them (32); `ProjectCompany` deletion silently stranding
grants once the row became an association (33); and the `Vendor` create path needing a declared
procurement → orgs participant edge to assign a party in-transaction (34, created by fix 27).

## Round 8 — the findings moved from structure to depth

Six findings, and what changed is their KIND. None is about the split, the deferral, the probe
placement or the review shape; all six are §A design detail, and four are consequences of round 7's
own fixes:

| # | What round 7 added | What it missed |
|---|---|---|
| 40 | same-org composite FK on `ProjectCompany.partyId` (fix 26) | a copied `orgId` seals nothing unless the copy is itself bound to the project — `(orgId, projectId) → Project(orgId, id)` was needed too, or a forged row keeps `projectId` on org A while pointing at an org-B party and both FKs pass |
| 38 | the merge/repoint command (fix 32) | it outlives 6.1; after 6.2 a merge moves the FACTS and leaves BINDINGS and GRANTS on the absorbed party |
| 39 | (same) | one transaction is not serialization — concurrent A→B and B→A each commit and reconcile the duplicate into a different duplicate |
| 37 | the `ProjectCompany` removal guard (fix 33) | 6.1 cannot check binding/grant rows that 6.2 introduces, so the guard ships INERT |

**37 is the sharpest of the four and generalises.** I wrote a guard into the unit that owns the
TABLE BEING PROTECTED rather than the unit that creates the tables that make protection necessary. It
would have passed review, shipped, and been indistinguishable from a working guard until 6.2 landed.
*An inert check is worse than no check, because it looks like coverage.* The guard now ships with
6.2, stated here as a constraint on that unit.

**38 resolved toward refusal rather than repointing**, and the reason is §D: moving a grant is an
authority decision, so a merge that silently repointed authority rows would move authority as a side
effect of a data-cleanup command. The merge is a pre-grant operation; after grants exist the operator
revokes first.

**36 is one fact in two places** — the audit kept its own copy of the probe table and drifted behind
the plan when findings 20/21 widened P2 and P3. The audit now reproduces the plan's table and names
the plan as authoritative, which is the same fix root B has been pointing at all along.

## Root B — a class measured in one section and not carried into the others

Three instances, one shape:

| Where the class was named | Where it was not carried | Finding |
|---|---|---|
| §D measured **167 mutating** routes | it never asked about the other **58 reads** — 9 of which already admit a collaborator, including `GET snapshot` and `GET shell` | 7 |
| §C excluded `media` as a scope for **reading** evidence | it never asked how evidence gets **created** — `MediaController.upload` is media-owned and `pmc`/`engineer` only | 8 |
| §D measured the **33 permission-less** routes | §B's conjunct 2 did not account for them | self-caught |

**This is rule 1 from the plan's own carried-forward list**, and the plan's own text already says
round 0 committed it — "it named hand-kept lists as the root of Phase 5's last unit, then proposed a
hand-reachable derivation for §D one paragraph later". So it happened again, in the correction
written to record it. Naming a root in prose is not the same act as searching for its other
instances, and writing the sentence down does not perform the search.

The concrete practice that would have caught all three: after measuring any set, **enumerate the
complement in the same breath** — 167 mutating implies 58 not-mutating; read-media implies
write-media; permissioned implies permission-less. Every one of these findings is a complement
nobody looked at.

## Root C — folding STATUS into the work PR removed the PR that wrote the post-merge shape

Findings 3 and 6 are both STATUS, and both are consequences of process change #37 (fold STATUS into
the work PR rather than shipping a separate flip PR).

- **3** is the historical half: the `Now` block advanced to Phase 6 while the Phase 5 table still
  carried `not_started` on parent Tasks 7 and 7B and a narrative sentence reading "PHASE 5 IS THE
  ACTIVE PHASE".
- **6** is the forward half: the block recorded `task_state: in_progress`, `work_item:
  phase-6-planning`, `open_pr: 324` — the shape it has *while the PR is open*. After merge,
  `assessRunnerState` returns `task:0` and the loop re-enters the already-merged planning item
  instead of starting 6.1.

The old separate-flip PR existed precisely to write the post-merge shape *after* the work merged.
Folding it in removed that PR without recording what it was for.

> **A folded STATUS must be committed in the shape it will have AFTER this PR merges, not the shape
> it has while the PR is open.** PR #323 is the precedent — it committed `task_state: merged`,
> `work_item: none`, `open_pr: none` while itself being an open PR.

This does sit in tension with `CLAUDE.md`'s instruction to set `open_pr` to the PR number, and with
the hourly drift shepherd that posts when live open PRs disagree with `open_pr: none`. The tension
is real and the resolution is the one #323 already took: a transient disagreement during the PR's
own life is the accepted cost of folding, because the alternative — a correct-while-open file that
is wrong the instant it merges — is a state no later PR exists to fix.

## Verification

- `assessRunnerState` on the committed file returns `next_task:phase-6-task-1`, and is
  **mutation-tested**: restoring `work_item: phase-6-planning` yields
  `work_item:phase-6-planning`, restoring `task_state: in_progress` yields `task:0`, restoring
  `open_pr: 324` yields `pr:324`. Three different wrong answers, so the check could have failed.
- The route measurements are taken by walking the same controller metadata `route-policy.test.ts`
  walks — 225 handlers, 167 mutating (134 `@RolesFor` / 22 `@AllowAnyRole` / 11 `@Public`), 58 reads
  (45 `@RolesFor`), 9 reads already admitting a collaborator role. Counted, not estimated.
- Every §A layering claim is checked against the live manifests: `orgs.dependsOn`,
  `procurement.dependsOn`, and that nothing in the graph depends on `orgs`.
- `test:automation` 200/200 on every head.

## The trajectory, stated plainly

| Head | Findings | Of which, created by the previous correction |
|---|---|---|
| `e222981` | 5 | — |
| `f9a4125` | 4 | 0 |
| `c431904` | 5 | **3** |
| `5a92ed2` | 5 | **4** (15, 16, 17, 18 — and 19 was a defect in the deferral itself) |
| `3f7e35d` | 6 | **4** (20, 22, 23 from the round before it; 25 was finding 14 never actually fixed) |
| `db2c64d` | **3** | **0** — 26/27 are §A gaps on their merits, 28 is a rule conflict. The split worked |
| `f208076` | 6 | **3** (29, 30 from the split line; 34 from fix 27) — the split was right, its SEAM was not |
| `5ca3719` | 6 | **4** (37 from fix 33; 38/39 from fix 32; 40 from fix 26) — all §A DEPTH now, no structural findings |

**There is no declining rate**, and round 3's findings are increasingly *self-inflicted*. That
combination is the exact measurement `scripts/review-efficiency.mjs` was written from — its header
records PR #252 taking four finding-bearing heads at 8, 8, 7, 7, every finding correct and none
contradicted, and concludes that a plan has no executable surface, so a finding on it can only be
answered with more prose, and more prose is more surface.

### A correction to this audit's own previous round

Head `4eb607a` claimed the deferral was a judgement I was declining to make — *"this head does not
take the deferral, and the reason is not pride"* — and recorded a rule for when I would take it
later. **That was wrong about the mechanism.** `PLAN_REVIEW_ROUND_CAP` is 3, and past it a docs-only
review **owes** the trailer; `assessConvergence` fails closed without it. The gate refused
`4eb607a` on exactly that, and it was right to. There was no choice to decline.

The reasoning underneath was not wrong — all five round-3 findings *are* answered on this head, from
counted facts, and none is left open. But the deferral is not a way of declining to answer. Its own
header says so: *"Nothing here discounts, filters, or downgrades a finding."* It moves the
**verification** of an answer from prose to an executable probe, which is a different act from
leaving the question open, and the distinction is the whole point of the mechanism. I read it as an
escape hatch and it is a handoff.

### The deferral and the folded STATUS cannot both be in this PR

Past the cap, `assessConvergence` refuses a deferral from a PR whose diff touches
`docs/STATUS.md` — the gate reads the DEFAULT-BRANCH copy to check the deferral's phase, so a PR
that edits STATUS is not its own phase truth. Its refusal names the remedy: *"Land the STATUS change
on its own."* This lineage has hit the same wall before (`docs/reviews/pr-318-convergence.md`, round
8), and the first time it was resolved wrongly, by opening a replacement PR — which reset the
finding-head counter rather than satisfying the obligation.

So `docs/STATUS.md` is reverted out of this PR and lands on its own immediately after it merges.
**This is a real cost and it is stated rather than glossed:** findings 3 and 6 were both STATUS
findings, and removing the file removes their fixes from this diff. The corrected content is not
lost — it is `git show 4eb607a:docs/STATUS.md` — and the follow-up PR restores exactly that:

| Restored by the follow-up STATUS PR | Finding |
|---|---|
| the Phase 5 table's three stale state tokens, the stale `6B` narrative, and the "PHASE 5 IS THE ACTIVE PHASE" sentence, plus the paragraph marking per-row prose as historical | 3 |
| the merged handoff shape (`task_state: merged`, `work_item: none`, `open_pr: none`) that makes `assessRunnerState` reach `next_task:phase-6-task-1` | 6 |

Neither finding is reopened or disputed; only the vehicle changes.

### The probe ledger — what each deferred question becomes

`Review-Deferred-To-Probes: phase-6-task-3` — the stop that can RUN them (finding 19 corrected the
first attempt, which named the contiguous next stop instead). Every round-3 and round-4 answer is prose, and prose is exactly
what the cap says can no longer be the verification. Each becomes a probe in the unit that can
execute it:

**The canonical probe table lives in the PLAN**, in
`docs/superpowers/plans/2026-08-11-phase-6-external-collaboration.md` under "Probes handed to the
boundary plan". It is reproduced here for the review record, and the plan is authoritative if the
two ever differ — an earlier round kept a second copy here that drifted behind the plan after
findings 20 and 21 widened P2 and P3, which is the same one-fact-two-places defect this lineage
keeps paying for.

| # | Question | Probe | Unit |
|---|---|---|---|
| P1 | do service backstops still leak? | a tripwire RED-flags an allow-listed handler with a `ROLE_POLICY[...]` gate on its path, mutation-tested against the 20 measured files | 6.3 |
| P2 | is every route classified, and rollups filtered? | every route resolves to exactly one class; `me/memberships` and `auth/switch` reachable with the resolver ON; `me/portfolio` returns grant-reachable projects **AND grant-scoped counters**, not project-wide ones | 6.3 |
| P3 | is the §B invariant held? | no active collaborator membership with zero reachable routes — at enablement, on membership create/reactivate/re-role, **and on grant create/update/revoke or binding revocation** | 6.3 |
| P4 | is scope-completeness asserted where it misfires? | 6.3 passes with scopes that have no entries; the phase-exit check fails when one never gains any | 6.3 / exit |
| P5 | does §A's layering hold in the real graph? | the module-graph test shows no `orgs → procurement` edge after `ExternalParty` lands | 6.1 |

Nothing is dismissed, and the exact-head gate still fails closed on every current-head finding. What
moves is where each answer is proven.

## What this audit does not claim

Fourteen correct findings on a plan is not, on its own, a sign the plan was written carelessly, and
treating it that way would produce the wrong correction. Roots A and B are failures of
*follow-through* rather than of judgement — a measurement taken and not used, a dependency
questioned once and not again.

Root D is different and should not be softened: three of round 3's five findings are damage from
round 2's own repairs. The mechanism is that I wrote each rule at exactly the strength that closed
the finding in front of me, and never tested it against the cases beside it. The practice that
follows is the third mechanical one, and it is the one this lineage most needed:

> **After writing a rule to close a finding, state what else it now catches, and check that each of
> those is intended.** A complement over "all routes" catches the login switcher. A completeness
> assertion at 6.3 catches nine unbuilt scopes. "Unbound" misses "bound with no grant."

The fix for all four roots is not more caution; it is the three mechanical practices, which are
checkable in a way "be more careful" is not.
