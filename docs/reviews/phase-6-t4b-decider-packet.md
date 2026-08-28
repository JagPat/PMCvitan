# Phase 6 unit 4b — the decider takes authority (review packet)

**Plan:** `docs/superpowers/plans/2026-08-14-decision-workflow-4b.md`
**Base:** `main` `2aee172`
**Branch:** `claude/decision-workflow-unit-4b-9mtki3`
**Correction owner:** claude

## Vision alignment

One fact has one canonical owner, and attributable human approvals are preserved.

Until this unit, every decision in the register was the CLIENT's to make. `approve`
hard-coded `onBehalfOf: 'client'`, the route allowlist WAS the authority, and AUTH-02
hid every pending decision from anyone who was not pmc or client. That is wrong for
the questions this practice actually asks: a sequencing call belongs to the
contractor, a services clash to the consultant, and a great many "decisions" are
really the practice's own. The owner asked for the decision to name who decides it.

This unit makes the designation real end to end: the practice states it when issuing
(or corrects it on a draft), the database freezes it at publication, the service — not
the route — is the authority that narrows approval to that party, and the approval act
keeps its own frozen record of the exact holder it was exercised for.

## What this unit ships, and what it deliberately does not

`docs/superpowers/plans/2026-08-14-decision-workflow-4b.md` designs unit 4b as three
threads: §A.1 the decider, §A.2 the record-only (`none`/`recorded`) issue, and §A.3 the
audience/targeted-push spine. Delivering all three in one PR is not reviewable at the
mandated budget — the §A.3 push thread alone reaches the outbox, `PushSubscription`
ownership, credential/session validity, `countPending`, the portfolio caller, three
store selectors, `screensFor`/`RouteBridge` and the bell-stripping predicate. The
unit's DATABASE shape already landed on its own for the same reason (PR #349).

**This PR is §A.1 — the holder spine — plus exactly the §A.3 arm that §A.1 cannot be
correct without.**

| plan thread | this PR | why |
|---|---|---|
| §A.1 the decider designation, standing, authority, on-behalf evidence | **shipped** | the unit's architectural concern |
| §A.1 `decisions.updateDraft` (round 8) | **shipped, holder field only** | publish REFUSES a stranded draft and names this door; a refusal with no exit is a trap. Title/location/option editing is not what the refusal strands, and widening a newly-opened write door beyond its justifying case is how doors stop being reviewable |
| §A.3 the per-viewer audience rule (live + projected + rebuild) | **shipped** | without it the service would AUTHORISE a named contractor to approve a decision the register never shows them. Authority without visibility is not a product path |
| §A.3 targeted push, bell stripping, `countPending` viewer, action items, nav badge, approval ROUTE | **not in this PR** | its own unit — see "Carried forward" |
| §A.2 `none` / `recorded` (the record-only issue) | **not in this PR** | its own unit — independent of the holder spine |
| §A.1 the holder-orphan removal guard + §B.1/§B.2 DB seal architecture | **not in this PR** | its own unit; the publish/reopen standing checks here are the service half, and are stated as such below |

## Review unit

- Base SHA: `2aee172`
- Scope: one architectural concern — "a decision names who decides it, and only that party (or the PMC on their behalf) approves it"
- Split considered: yes, and taken twice — the DB shape shipped separately as PR #349, and §A.2/§A.3-push are separate units above
- Migration/service seam: **inseparable.** The only migration is two additive read-model columns on `DecisionProjection` (`deciderKind`, `deciderUserId`). They exist solely so the projected slice can apply the SAME per-viewer rule the live slice applies. Shipping the column alone would add a column nothing writes and nothing reads; shipping the rule alone would make the projection path hide the decider's own decision while the live path shows it — a live-vs-projection divergence, which is the one thing this projection's design exists to prevent. There is no canonical table, constraint, trigger or seal in the diff.

Replaces: none

## Pre-review checks

- **`concurrency-serialization`** — every new read is taken under a lock the write already holds, and in the order every other decisions writer uses. `publish` and `updateDraft` take `lockProjectReadiness` FIRST, then the decision row `FOR UPDATE`, then the holder read; `publish` derives its notice, event and push body from the LOCKED head rather than from the pre-transaction read, so a draft edit committing in between can no longer put another revision's title in the client's bell (plan round 16). The holder standing read is `lockActiveMembershipById`, which locks the `Membership` row, so a concurrent removal serializes behind the publication instead of racing it. `requestChange` re-validates under the readiness lock it already takes.
- **`old-release-migration-compatibility`** — the migration is two `ADD COLUMN IF NOT EXISTS` on a read-model table, one with a default that equals what every existing row already represents (`'client'`) and one nullable. The old release does not know the columns exist and keeps writing valid projection rows; the projection is rebuildable and its consumer refreshes the whole project's row set from canonical on every applied decision event, so existing generations converge with no backfill. No deployed migration bytes change.
- **`trigger-alternate-writers`** — the invariants this unit relies on are enforced by the seals PR #349 already installed, and this PR does not weaken them: the `member ⟺ membershipId` CHECK, the same-project composite FK, the holder freeze from publication, the approval-tuple freeze and its "may first be written only by an approval transition" arm, and the `Membership.userId`/`projectId` identity freeze. The probes drive all of them through a SECOND PrismaClient issuing raw SQL, so they test the database rather than the service. The projection consumer, the rebuild seed and the operator diagnostic all go through ONE `refreshRows`, so no alternate projection writer can produce a row with a stale holder — and `computeDecisionRows`/`storedDecisionRows` now compare the holder columns too, so a drifted generation is diagnosed rather than served.
- **`authorization-tenancy`** — the approve narrowing is the point of the unit: the route allowlist widened to a CEILING and the SERVICE became the authority. The named-member check compares the decider membership's USER against the actor, so a same-role peer is refused (probed). A member from another project cannot even be named — the composite FK forbids it (probed at the database, not only at the service). The per-viewer rule widens the pending audience by exactly one person, the decider's own user id, on BOTH the live and the projected path through the same function.
- **`ci-reproduce-first`** — the first commit on this branch stages the shape with the behaviour deliberately absent and the probes RED: **9 of 14** integration probes and **6 of 6** web probes fail there, on behaviour rather than on a missing symbol. The five that pass at the shape are the three P15 byte-identity arms (nothing has changed for a client-held decision — that is the guarantee) and the two probes pinning seals PR #349 already installed. All 20 are GREEN at the implementation commit.

## Invariant matrix

| Invariant | Risk in this change | Reproduce-first / verification evidence |
| --- | --- | --- |
| authorization-tenancy | Widening `ROLE_POLICY['decision.approve']` to a ceiling could let any engineer/contractor/consultant approve any decision if the service narrowing were missing or wrong; the per-viewer widening could leak a pending decision to a same-role peer; a decider could be named from another project | P16 "the NAMED contractor approves; a same-role NON-decider is refused at the SERVICE" (403, and the decision is still `pending` afterwards — the refusal leaves nothing behind); P22 live + projected "a same-role peer does not see it"; P17 "a membership from ANOTHER project can never be named" (service AND raw-SQL FK arm); `discipline.test.ts` and `policy.test.ts` restate the ceiling explicitly rather than silently loosening |
| civil-time-lifecycle | None: this unit introduces no date, deadline or timezone-dependent value | The approval act's `date` column is written by the pre-existing `ddMmmYyyy(new Date())` path, unchanged |
| concurrency-idempotency | The create idempotency preimage did not cover the decider, so reusing a key after changing the intended holder would REPLAY the first decision and silently preserve the wrong authority (plan round 13); publish deriving evidence from a pre-transaction read could publish another revision's title; `updateDraft` could land on a decision published mid-flight | the create request hash now covers the decider tuple (a pre-4b payload hashes the same `('client', null)` pair its state already carries, so no existing key changes meaning); publish takes the row lock and derives from the locked head; `updateDraft`'s CAS guard IS `publishedAt: null`, so a publication in between is a deterministic 409, probed as "the draft edit is refused once the decision is PUBLISHED" |
| data-integrity-conservation | An approval act could record a designation that later stops being attributable; a published decision's holder could be rewritten; a draft could publish into the zero-holder state | P16 "the PMC on-behalf act freezes the EXACT holder — and a re-approval still names the FIRST holder" (approve → requestChange → re-approve; the frozen tuple is the first consent, not the latest state); P17 hostile post-publish `UPDATE` refused by the database; P17 "publishing a ROLE-held decision into a project with nobody in that role is refused" and "publishing a draft whose named member has LEFT is refused" |
| offline-reconciliation | The web create payload could change shape for callers who never opt in, breaking replay of a queued pre-4b decision | the picker's default sends NO decider keys at all — asserted directly in `decision-decider.test.tsx` ("leaving the picker alone sends NO decider keys — the pre-4b payload, byte for byte"); the store's spread is conditional on a non-`client` kind |
| ui-server-parity | The server could enforce a designation no screen can state (a contract field with no product path — plan round 7); the register could show a holder the server does not hold; the projected read could disagree with the live read | the create modal's picker and the Drafts screen's re-point control are both probed, including the departed-holder case the publish refusal points at; the serializer omits the decider keys entirely for a client-held decision so the pre-4b DTO is byte-identical; P22 asserts `storedDecisionRows == computeDecisionRows` field-for-field across the new columns and that a REBUILD preserves the audience |

## Probes

`apps/api/test/integration/phase6-t4b-decider.test.ts` — 14, live PostgreSQL through the real service:

| # | probe | thread |
|---|---|---|
| 1 | a create naming no decider is client-held and serializes the pre-4b shape (no decider keys, the exact pre-4b bell text) | P15 |
| 2 | the client approving a client-held decision keeps `Client approved …` and no on-behalf marker | P15 |
| 3 | a PMC approving a client-held decision still records `onBehalfOf: 'client'`, verbatim | P15 |
| 4 | the named contractor approves; a same-role peer is refused at the SERVICE with no side effects | P16 |
| 5 | the PMC on-behalf act freezes kind + membership + display identity; a re-approval after a change request still names the FIRST holder | P16 |
| 6 | a PMC-held decision is approved by the PMC directly, with no on-behalf marker | P16 |
| 7 | publishing a draft whose named member has LEFT is refused, and the named fix (re-point the draft, then publish) works | P17 |
| 8 | the draft edit is refused once published, and hostile SQL cannot re-home the holder either | P17 |
| 9 | the `member ⟺ membershipId` pair is coherent at the DATABASE, both directions | P17 |
| 10 | a membership from another project can never be named — service and raw-SQL FK arms | P17 |
| 11 | `Membership.userId` is frozen — a named holder cannot silently move to another user | P17 |
| 12 | publishing a role-held decision into a project with nobody in that role is refused | P17 |
| 13 | the named contractor SEES their pending decision; a same-role peer does not (live slice) | P22 |
| 14 | the PROJECTED slice draws the same line, `stored == canonical` field-for-field, and a rebuild preserves it | P22 |

`apps/web/tests/decision-decider.test.tsx` — 6: the picker's candidate list (a removed member is not offered), the byte-identical default payload, the member and pmc payloads, and the Drafts re-point including the departed-holder option the author must be able to see in order to change it.

## Gates

- `pnpm check` — **EXIT 0** (automation 292/292, web 948/948, API 793/793, build clean)
- focused: `phase6-t4b-decider.test.ts` 14/14 · `decision-decider.test.tsx` 6/6
- RED at the staged shape (first commit on this branch): 9/14 integration, 6/6 web
- full API integration suite on a migrated database
- `upgrade-proof.sh`
- tripwires advanced in the same commits: mutating routes 168 → 169, external-effect dispatch sites 81 → 82, the decisions controller's ordered route signatures, the decisions service's dispatch count, and the pinned migration corpus 91 → 92

## Carried forward (named, not dismissed)

These are the plan's own §A.2/§A.3 threads, each landing as its own unit:

1. **The targeted push spine** (§A.3) — the user-level dispatch target, the `PushSubscription` → user linkage with its credential-version and token-expiry validity, the sign-out unlink, the claim-time per-family predicate, and the class-level "still actionable for THIS target" rule. Until it lands, a decider-held decision's `decision.published` push still goes to the catalog's role audience; the decision itself is correctly scoped by the audience rule this PR ships, and the bell notice still carries the demand.
2. **The remaining audience surfaces** (§A.3) — `countPending` and its portfolio caller, `selectActionItems`, the nav badge, the bell-notice stripping predicate, `selectLogDecisions`/`selectVisibleDecisions`, and the approval ROUTE (`screensFor`/`RouteBridge`) so a named engineer-decider's Inbox CTA lands and stays on an approval surface.
3. **The record-only issue** (§A.2) — `deciderKind: 'none'`, the terminal `recorded` status and its evidence seals, the zero-option create path, and the gate's `recorded` arm.
4. **The holder-orphan guard and the §B seal architecture** (§A.1/§B) — `decisions.holdsOpenDecisions` through the `orgs ⇄ decisions` participant channel, the org-membership write arm, and the DB-layer re-judgement under the §B.1 try-advisory protocol through §B.2's owned SQL primitives. This PR ships the SERVICE half at the two transitions that can BIRTH a holderless open decision (publish and `approved → change`); it does not yet stop a removal from orphaning one that is already open.
