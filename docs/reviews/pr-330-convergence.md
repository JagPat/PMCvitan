# PR #330 — convergence audit (space model plan)

Owed from the second finding-bearing head, per `CLAUDE.md`: after two distinct rounds, the next
correction is not another isolated patch but an architectural audit of what the rounds have in
common. This is that audit.

| round | head | findings | outcome |
|---|---|---|---|
| 1 | `c87ee29` | 7 (6×P1, 1×P2) | all verified against code, all corrected on `922e67b` |
| 2 | `6700171` | 4 (4×P1) | all verified, corrected on `aa1a604` |
| 3 | `aa1a604` | 2 (2×P1) | all verified, corrected on this head |

Thirteen findings on a document that changes no code. That number is the finding, and the audit
below is about why.

## The one defect underneath most of them

Nine of the eleven are the same mistake wearing different clothes: **a rule was stated about one
place, when the system has more than one place that rule must hold.**

| # | round | the rule as first written | the place it forgot |
|---|---|---|---|
| F2 | 1 | migrate `ProjectNode.kind` | `TemplateModule.payload` JSON, `anchorKind` |
| F3 | 1 | bound the moved node's depth | the moved subtree's descendants |
| F4 | 1 | `isDescendant` guards reparenting | it runs outside the transaction it guards |
| F5 | 1 | validate at the node endpoints | `writeInitializationSource` also creates nodes |
| F7 | 1 | S1 and S2 deploy as one release | web and API are separate deploy units |
| R2-F2 | 2 | migrate the stored `anchorKind` | `anchorKindOf` derives it; `loadModuleCopies` consumes it |
| R2-F3 | 2 | S3 switches the web to `space` | its bundle may arrive before the migration runs |
| R2-F4 | 2 | after S3 nothing sends `room` | a stale tab still does, indefinitely |
| R3-F1 | 3 | anchor code changes with the migration (S3) | S2 already accepts `space`, so a space-root module is persistable a step earlier |
| R3-F2 | 3 | the migration rewrites the `room` rows | writes continue after it; `create` persists the literal kind |
| bonus | 1 | (unreported) tree reads are project-scoped | `subtreeIds`/`ancestorIds` scan every project |

The remaining two are different in kind: F1 (the plan asserted a filing target the model does not
have, and should not) and F6/R2-F1 (STATUS was internally inconsistent with the plan shipped beside
it — twice).

### Round 3 sharpened the pattern into two named traps

Round 3's findings are the same defect at a finer grain, and both are worth naming because they
generalize past this plan:

- **A capability opens before the code that interprets it.** S2 widened the *contract* to accept
  `space` while leaving anchor derivation on `room`. The gap between "the system accepts X" and "the
  system understands X" is a window in which bad data is not merely possible but *invited*, through a
  public endpoint. The rule: **the code that interprets a value must land in the same step that
  starts accepting it, or earlier — never later.**
- **A migration is a point in time; writes are a duration.** Sweeping the `room` rows does not stop
  new ones arriving from clients that have not reloaded. The rule: **a data migration must be paired
  with a write-path rule that keeps the invariant true afterwards** — here, canonicalizing an
  accepted `room` to `space` — otherwise the sweep's guarantee expires the moment it finishes.

Round 3 also surfaced a third `anchorKind` consumer that rounds 1 and 2 both missed, and it is the
most dangerous kind: the placement guards at `orgs.service.ts:418,592` compare `anchorKind ===
'room'` to *refuse* element modules. After the rename that comparison is simply never true, so the
guard stops firing without erroring — protection that evaporates silently rather than breaking
loudly. Enumerating "everywhere this value is written" is not sufficient; the enumeration must cover
**everywhere it is compared**, including comparisons whose purpose is to say no.

## Why a docs-only change kept reproducing it

A plan describes intent. Intent has no compiler, so a claim like "the depth is bounded" or "the data
is migrated" reads as complete without naming *where* it must hold. Every one of the nine above was
true of the place the plan was looking at and false of a second place the plan had not enumerated.

The three second places that actually bit:

1. **The second write path.** `NodesService` is not the only thing that creates a `ProjectNode`;
   project initialization does too, through its own validator.
2. **The second store.** `ProjectNode.kind` is not the only place a node kind is persisted; template
   payloads carry it in JSON, and code derives an anchor from it.
3. **The second deploy unit.** The web SPA and the API are separate Coolify applications, and a
   browser bundle is effectively a third: it persists in an open tab past any deploy.

## What changed structurally, not just textually

- **§A** now names the transaction boundary the cycle guard must live inside, the subtree height the
  depth cap must count, the initialization path that must enforce both, and the project scoping the
  tree reads lack. Each is a *place*, not a restatement of the rule.
- **§B** was narrowed rather than extended. `DailyLog` has no location and should not — the located
  things are its materials and photos. A plan that had grown a `DailyLog.nodeId` would have shipped
  the same category error the plan exists to remove.
- **§D** lists the migration's stores AND the two functions that derive and consume them.
- **§E** carries the rule the deployment findings share: *every step must tolerate the previous
  step's client, and no step may assume a client has been replaced.* The contraction is gated on a
  measured quiet window rather than an inference.

## The delivery shape, and why it changed

The plan's original promise — S1 and S2 "deploy as one release" — was not merely unenforced but
impossible: no PR boundary contains both applications. That was put to the owner rather than
resolved unilaterally, since the clean break was their decision; they chose expand → migrate →
contract. Decision 4's end state is unchanged and still delivered. Only the route moved, and the
removal step (S4) keeps its own unit and its own probe so the transitional alias cannot become the
permanent one that was rejected.

## What this predicts for S1–S4

The audit's value is only in what it changes about the implementation rounds. Concretely:

- Every invariant S1 claims must be stated **per write path**, and project initialization is a write
  path. The Task-4 acceptance shape from Phase 4 applies: assert the rule against the live
  registry/validator, not against one caller.
- Every migration S3 claims must be stated **per store**, and a JSON column is a store. A `.parse()`
  on a read path is a write-time constraint in disguise — it turns unmigrated data into a 400 on an
  unrelated screen.
- Every step S2–S4 claims must be stated **per client generation**, and an open tab is a client
  generation.
- Every value the changeover renames must be traced to **everywhere it is compared**, not only
  everywhere it is written — a guard that tests for the old value stops guarding silently.
- Every migration must ship with the **write-path rule that keeps its result true**, or its
  guarantee lapses the moment it completes.
- The cycle-safety probe must be **seen to fail** before the guard is trusted. This is the standing
  rule; R4 on #329 needed three attempts before it could fail at all, and a green concurrency probe
  proves nothing until reverting the fix turns it red.

## Status

Round-2 corrections are on this head. No finding from either round is dismissed or deferred; each is
either implemented in the plan or narrowed with its reason stated (F1 only).

Review-Convergence: complete
